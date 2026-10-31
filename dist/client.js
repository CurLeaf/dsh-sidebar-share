/**
 * Browser half of `dsh-sidebar-share`.
 *
 * Model (v2) — one workspace, one canonical sidebar, and the canonical is only
 * ever a copy of a *live* session's own store:
 *
 *   - A live, non-archived session that changes its layout/browser state writes
 *     the workspace canonical and mirrors it to the other live sessions of the
 *     same workspace.
 *   - A workspace with no canonical adopts the first live session that has
 *     content, exactly once. Nothing is ever re-adopted later, and no persisted
 *     per-session store is ever read to pick a template.
 *   - An empty canonical is authoritative: closing every tab is a decision, not
 *     a corrupted template. It is applied to the other live sessions and to
 *     sessions opened later, and it is never rebuilt from stale locations.
 *   - Archived sessions neither seed nor receive anything.
 *   - The old v1 canonical (the "repair the empty template from the richest
 *     session" era) is deleted on load and replaced with an explicit reset, so
 *     a polluted template cannot come back after the upgrade.
 *
 * Docking layouts still belong to each session: workspace-file addresses are
 * rewritten to the receiving session, and every window keeps its own
 * expanded/mode presentation. A workspace that is empty is always applied
 * closed, so "nothing open" never turns into an empty panel popping open.
 *
 * It also contributes four right-sidebar tab-menu entries:
 *
 *   - 「关闭其他标签页」 and 「关闭右侧标签页」 close the clicked tab's siblings in
 *     its own dock pane, right to left. They go through the sidebar controller's
 *     `closeIn` so the tab kind's teardown still runs (a terminal's cleanup),
 *     and they only appear when the pane actually has tabs to close.
 *   - A file tab offers to reveal itself in the Host's file manager
 *     (「在访达中显示」/「在文件资源管理器中显示」/「在文件管理器中显示」). The Host
 *     resolves the tab's verified absolute path and hands it to the same
 *     native opener the Open In control uses. The label follows the Host's
 *     platform, not the browser's, and a failed launch is announced with a
 *     short toast instead of a silent no-op.
 *   - Any tab offers 「引用到对话」: it drops the tab's workspace file path,
 *     browser URL or visible terminal screen into the composer. When the
 *     composer's `inputActions` face is mounted it inserts an undoable edit;
 *     otherwise it copies the reference to the clipboard and says so.
 *
 * Every entry works with only the `{ tab, dismiss }` props the tab-menu slot
 * guarantees; every extra face (`inputActions`, `sessionId`, the Remote
 * namespaces) is read from services, so a host that stops passing one cannot
 * make an entry vanish.
 */
window.__ModuleLoader__.load({
	id: 'dsh-sidebar-share',
	factory(require) {
		const dockkit = (() => {
			try {
				return require('@deepseek-ai/dsh-client-ui-dockkit');
			} catch {
				return undefined;
			}
		})();
		const EMPTY_HISTORY = dockkit && dockkit.EMPTY_HISTORY
			? dockkit.EMPTY_HISTORY
			: { entries: [], cursor: 0 };

		const PLUGIN_VERSION = '0.1.7';
		const TAG = '[sidebar-share]';
		const CANONICAL_PREFIX = 'dsh.sidebar-share.v2.';
		const LEGACY_PREFIX = 'dsh.sidebar-share.v1.';
		const DISABLED_KEY = 'dsh.sidebar-share.disabled';
		const CANONICAL_VERSION = 2;
		const SAVE_DEBOUNCE_MS = 250;
		const ENTRY_ID = 'sidebar-share';
		const BUNDLE_NAME = 'dsh-sidebar-share';
		const SCOPE_FIELD = 'scope';
		const SCOPE_SLOT = 'plugins.bundle.config';

		/** 'workspace' mirrors the sidebar; 'session' leaves DSH's per-session default. */
		let scopeMode = 'workspace';

		const info = (...args) => {
			try {
				console.info(TAG, ...args);
			} catch {}
		};
		const warn = (...args) => {
			try {
				console.warn(TAG, ...args);
			} catch {}
		};
		const isObject = (value) => value !== null && typeof value === 'object';

		const clone = (value) => {
			if (value === undefined || value === null) return value;
			try {
				return structuredClone(value);
			} catch {
				try {
					return JSON.parse(JSON.stringify(value));
				} catch {
					return value;
				}
			}
		};

		const storage = () => {
			try {
				return typeof window === 'undefined' ? undefined : window.localStorage;
			} catch {
				return undefined;
			}
		};
		const readRaw = (key) => {
			try {
				const value = storage()?.getItem(key);
				return value === undefined ? null : value;
			} catch {
				return null;
			}
		};
		const writeRaw = (key, value) => {
			try {
				storage()?.setItem(key, value);
				return true;
			} catch {
				return false;
			}
		};
		const removeRaw = (key) => {
			try {
				storage()?.removeItem(key);
			} catch {}
		};

		/* ------------------------------------------------------------------ */
		/* Surface / browser-state parsing                                     */
		/* ------------------------------------------------------------------ */

		const surfaceOfSnapshot = (snapshot, sessionId) => {
			const saved = isObject(snapshot) && isObject(snapshot.bySession)
				? snapshot.bySession[sessionId]
				: undefined;
			if (!isObject(saved) || !isObject(saved.layout)) return undefined;
			return {
				layout: saved.layout,
				minted: typeof saved.minted === 'number' ? saved.minted : 0,
				history: saved.history,
			};
		};

		const browserStateOf = (snapshot) => {
			if (!isObject(snapshot) || !isObject(snapshot.byTab)) return undefined;
			return { byTab: snapshot.byTab };
		};

		const layoutScore = (surface) => {
			if (!surface || !isObject(surface.layout) || !isObject(surface.layout.tabs)) return 0;
			let score = 0;
			for (const tab of Object.values(surface.layout.tabs)) {
				if (!isObject(tab) || tab.kind === 'guide') continue;
				score += 1;
			}
			return score;
		};

		const browserScore = (state) => {
			if (!state || !isObject(state.byTab)) return 0;
			let score = 0;
			for (const tab of Object.values(state.byTab)) {
				if (!isObject(tab) || !Array.isArray(tab.entries)) continue;
				if (tab.entries.some((entry) => isObject(entry) && typeof entry.url === 'string')) score += 1;
			}
			return score;
		};

		/**
		 * Compare layouts while ignoring the session id embedded in workspace-file
		 * resource addresses, and while ignoring the presentation (expanded/mode)
		 * and focus (active tab/pane) that belong to each window.
		 */
		const presentationNeutral = (layout) => {
			if (!isObject(layout) || !isObject(layout.nodes)) return layout;
			const nodes = {};
			for (const [id, node] of Object.entries(layout.nodes)) {
				if (!isObject(node)) {
					nodes[id] = node;
					continue;
				}
				const { activeTabId, ...rest } = node;
				nodes[id] = rest;
			}
			const { activePaneId, expanded, mode, ...rest } = layout;
			return { ...rest, nodes };
		};

		const layoutKey = (surface) => {
			if (!surface) return '';
			try {
				const json = JSON.stringify(presentationNeutral(surface.layout));
				return json.replace(
					/dsh-resource:\/\/([^/\\"]+)\/session\/[^/\\"]+/g,
					'dsh-resource://$1/session/*',
				) + '|' + (surface.minted | 0);
			} catch {
				return '';
			}
		};
		const sameLayout = (left, right) => layoutKey(left) === layoutKey(right);

		const rewriteTabForSession = (tab, sessionId) => {
			if (!isObject(tab) || typeof tab.contentId !== 'string') return tab;
			const match = /^(dsh-resource:\/\/[^/]+\/session\/)[^/]+(\/.*)$/.exec(tab.contentId);
			if (!match) return tab;
			return { ...tab, contentId: match[1] + sessionId + match[2] };
		};

		const rewriteLayoutForSession = (layout, sessionId) => {
			if (!isObject(layout) || !isObject(layout.tabs)) return layout;
			let changed = false;
			const tabs = {};
			for (const [id, tab] of Object.entries(layout.tabs)) {
				const next = rewriteTabForSession(tab, sessionId);
				tabs[id] = next;
				if (next !== tab) changed = true;
			}
			return changed ? { ...layout, tabs } : layout;
		};

		/**
		 * URL-level signature for Browser state. Navigation revisions and titles
		 * churn on every render; the page address is what has to stay in sync.
		 */
		const browserKey = (state) => {
			if (!state || !isObject(state.byTab)) return '';
			const ids = Object.keys(state.byTab).sort();
			const parts = [];
			for (const id of ids) {
				const tab = state.byTab[id];
				if (!isObject(tab)) continue;
				const entries = Array.isArray(tab.entries) ? tab.entries : [];
				const index = typeof tab.index === 'number' ? tab.index : 0;
				const entry = entries[index];
				parts.push([
					id,
					isObject(entry) && typeof entry.url === 'string' ? entry.url : '',
				].join('\u0001'));
			}
			return parts.join('\u0002');
		};
		const sameBrowser = (left, right) => browserKey(left) === browserKey(right);

		/**
		 * The empty layout a reset leaves behind, derived from the session's own
		 * (valid) layout: every tab goes, floating panes go with their tabs, and the
		 * column is collapsed. Derived rather than fabricated so it always satisfies
		 * the docking schema of the running build.
		 */
		const stripLayout = (layout) => {
			if (!isObject(layout) || !isObject(layout.nodes) || !isObject(layout.tabs)) return undefined;
			const nodes = {};
			for (const [id, node] of Object.entries(layout.nodes)) {
				if (!isObject(node)) return undefined;
				if (node.kind !== 'pane') {
					nodes[id] = node;
					continue;
				}
				if (node.host === 'float') continue;
				const { activeTabId, ...rest } = node;
				nodes[id] = { ...rest, tabs: [] };
			}
			const rootId = layout.rootId;
			const root = nodes[rootId];
			if (!isObject(root)) return undefined;
			let activePaneId;
			if (root.kind === 'pane') {
				activePaneId = rootId;
			} else if (Array.isArray(root.children)) {
				for (const childId of root.children) {
					const child = nodes[childId];
					if (isObject(child) && child.kind === 'pane') {
						activePaneId = childId;
						break;
					}
				}
			}
			if (!activePaneId) return undefined;
			return {
				...layout,
				nodes,
				tabs: {},
				floats: [],
				activePaneId,
				expanded: false,
				mode: 'push',
			};
		};

		/* ------------------------------------------------------------------ */
		/* Workspace mapping                                                   */
		/* ------------------------------------------------------------------ */

		let mapping = { dirty: true, bySession: new Map(), byWorkspace: new Map(), archived: new Set() };
		let sessionService;
		let workspaceService;

		const snapshotOf = (service) => {
			try {
				return service && service.list ? service.list.getSnapshot() : undefined;
			} catch {
				return undefined;
			}
		};
		const normalizePath = (value) => {
			if (typeof value !== 'string' || value.length === 0) return '';
			return value.replace(/[\\/]+$/, '').toLowerCase();
		};

		const rebuildMapping = (workspaces, sessions) => {
			mapping.dirty = false;
			mapping.bySession = new Map();
			mapping.byWorkspace = new Map();
			const workspaceSnapshot = snapshotOf(workspaces);
			mapping.archived = new Set(
				workspaceSnapshot && Array.isArray(workspaceSnapshot.archivedSessionIds)
					? workspaceSnapshot.archivedSessionIds
					: [],
			);
			const items = workspaceSnapshot && Array.isArray(workspaceSnapshot.items)
				? workspaceSnapshot.items
				: [];
			for (const item of items) {
				if (!isObject(item)) continue;
				const workspaceId = item.workspaceId ?? item.id;
				if (typeof workspaceId !== 'string') continue;
				mapping.byWorkspace.set(workspaceId, item);
				const sessionIds = Array.isArray(item.sessionIds) ? item.sessionIds : [];
				for (const sessionId of sessionIds) {
					// Archived sessions are shared by nobody: they neither seed the
					// workspace nor receive its layout.
					if (typeof sessionId !== 'string' || mapping.archived.has(sessionId)) continue;
					mapping.bySession.set(sessionId, workspaceId);
				}
			}
			// Fallback: sessions carry their cwd, workspaces carry their path. This
			// covers the window between the session list arriving and the workspace
			// membership projection catching up.
			const sessionSnapshot = snapshotOf(sessions);
			const byId = sessionSnapshot && isObject(sessionSnapshot.byId) ? sessionSnapshot.byId : undefined;
			if (byId) {
				const entries = byId instanceof Map ? byId.entries() : Object.entries(byId);
				for (const [sessionId, session] of entries) {
					if (mapping.bySession.has(sessionId) || mapping.archived.has(sessionId) || !isObject(session)) continue;
					const cwd = typeof session.cwd === 'string'
						? session.cwd
						: isObject(session.header) && typeof session.header.cwd === 'string'
							? session.header.cwd
							: undefined;
					if (!cwd) continue;
					for (const [workspaceId, item] of mapping.byWorkspace) {
						const path = item.path ?? item.cwd;
						if (normalizePath(path) === normalizePath(cwd)) {
							mapping.bySession.set(sessionId, workspaceId);
							break;
						}
					}
				}
			}
		};

		const workspaceOf = (sessionId) => {
			if (mapping.dirty) rebuildMapping(workspaceService, sessionService);
			return mapping.bySession.get(sessionId);
		};

		/* ------------------------------------------------------------------ */
		/* Workspace canonical                                                 */
		/* ------------------------------------------------------------------ */

		const groups = new Map();

		const canonicalKey = (workspaceId) => CANONICAL_PREFIX + workspaceId;

		/**
		 * A canonical is either a real surface (possibly empty) or an explicit
		 * reset (`reset: true`, no layout) left by the v1 migration.
		 */
		const readCanonical = (workspaceId) => {
			const raw = readRaw(canonicalKey(workspaceId));
			if (!raw) return undefined;
			try {
				const parsed = JSON.parse(raw);
				if (!isObject(parsed)) return undefined;
				const layout = isObject(parsed.layout) && isObject(parsed.layout.layout)
					? {
						layout: parsed.layout.layout,
						minted: typeof parsed.layout.minted === 'number' ? parsed.layout.minted : 0,
					}
					: undefined;
				const browser = isObject(parsed.browser) && isObject(parsed.browser.byTab)
					? { byTab: parsed.browser.byTab }
					: undefined;
				const reset = parsed.reset === true && layout === undefined;
				if (!reset && !layout && !browser) return undefined;
				return { reset, layout, browser };
			} catch {
				return undefined;
			}
		};

		const writeCanonical = (group) => {
			if (!group.initialized) return;
			const reset = group.reset === true && group.layout === undefined;
			writeRaw(canonicalKey(group.workspaceId), JSON.stringify({
				version: CANONICAL_VERSION,
				savedAt: Date.now(),
				reset,
				layout: group.layout
					? { layout: group.layout.layout, minted: group.layout.minted }
					: null,
				browser: group.browser ? { byTab: group.browser.byTab } : null,
			}));
		};

		const saveGroup = (group) => {
			if (group.saveTimer !== undefined) clearTimeout(group.saveTimer);
			group.saveTimer = setTimeout(() => {
				group.saveTimer = undefined;
				writeCanonical(group);
			}, SAVE_DEBOUNCE_MS);
		};

		/**
		 * Delete every v1 canonical and leave an explicit reset in its place. The v1
		 * template is not carried over: it is exactly the value the old repair logic
		 * kept rebuilding from archived sessions, so the only safe migration is to
		 * start from "nothing open" once.
		 */
		const migrateLegacy = () => {
			const store = storage();
			if (!store) return 0;
			const found = [];
			try {
				for (let index = 0; index < store.length; index += 1) {
					const key = store.key(index);
					if (typeof key !== 'string' || !key.startsWith(LEGACY_PREFIX)) continue;
					found.push([key, key.slice(LEGACY_PREFIX.length)]);
				}
			} catch {
				return 0;
			}
			for (const [key, workspaceId] of found) {
				if (!readRaw(canonicalKey(workspaceId))) {
					writeRaw(canonicalKey(workspaceId), JSON.stringify({
						version: CANONICAL_VERSION,
						savedAt: Date.now(),
						reset: true,
						layout: null,
						browser: { byTab: {} },
					}));
				}
				removeRaw(key);
			}
			return found.length;
		};

		const getGroup = (workspaceId) => {
			let group = groups.get(workspaceId);
			if (group) return group;
			const saved = readCanonical(workspaceId);
			group = {
				workspaceId,
				initialized: saved !== undefined,
				reset: saved ? saved.reset : false,
				layout: saved ? saved.layout : undefined,
				browser: saved ? saved.browser : undefined,
				layoutInstances: new Map(),
				browserInstances: new Map(),
				saveTimer: undefined,
			};
			groups.set(workspaceId, group);
			if (saved) info('restored workspace', workspaceId, saved.reset ? '(reset)' : '');
			return group;
		};

		/* ------------------------------------------------------------------ */
		/* Applying + propagating                                             */
		/* ------------------------------------------------------------------ */

		const applySurface = (instance, sessionId, surface) => {
			instance.__sidebarShareApplying = true;
			try {
				instance.store.set({ bySession: { [sessionId]: surface } });
			} finally {
				instance.__sidebarShareApplying = false;
			}
		};

		const applyLayout = (instance, sessionId, surface) => {
			if (!surface || !isObject(surface.layout)) return;
			try {
				const current = surfaceOfSnapshot(instance.getSnapshot(), sessionId);
				const empty = layoutScore(surface) === 0;
				let layout = rewriteLayoutForSession(surface.layout, sessionId);
				if (empty) {
					// Nothing to show: the column is closed everywhere. An empty panel
					// that pops open is the bug this release exists to remove.
					layout = { ...layout, expanded: false, mode: 'push' };
				} else if (current && isObject(current.layout)) {
					// The receiving window owns whether its column is open and in which
					// presentation mode. A shared tab change must not pop it open.
					layout = {
						...layout,
						expanded: current.layout.expanded,
						mode: current.layout.mode,
					};
				}
				const next = {
					layout,
					minted: typeof surface.minted === 'number' ? surface.minted : 0,
					history: EMPTY_HISTORY,
				};
				if (current
					&& sameLayout(current, next)
					&& current.layout.expanded === layout.expanded
					&& current.layout.mode === layout.mode) {
					return;
				}
				applySurface(instance, sessionId, next);
			} catch (error) {
				warn('apply layout failed', sessionId, error);
			}
		};

		/** Strip one session's own layout down to a closed, empty column. */
		const clearLayout = (instance, sessionId) => {
			try {
				const current = surfaceOfSnapshot(instance.getSnapshot(), sessionId);
				if (!current || !isObject(current.layout)) return;
				const stripped = stripLayout(current.layout);
				if (!stripped) return;
				const next = { layout: stripped, minted: current.minted, history: EMPTY_HISTORY };
				if (sameLayout(current, next)) return;
				applySurface(instance, sessionId, next);
			} catch (error) {
				warn('reset layout failed', sessionId, error);
			}
		};

		const applyBrowser = (instance, state) => {
			if (!state || !isObject(state.byTab)) return;
			try {
				const current = browserStateOf(instance.getSnapshot());
				if (current && sameBrowser(current, state)) return;
				instance.__sidebarShareApplying = true;
				try {
					instance.store.set({ byTab: clone(state.byTab) });
				} finally {
					instance.__sidebarShareApplying = false;
				}
			} catch (error) {
				warn('apply browser failed', error);
			}
		};

		const propagateLayout = (group, sourceSessionId) => {
			if (group.reset && group.layout === undefined) {
				for (const [sessionId, record] of group.layoutInstances) {
					if (sessionId === sourceSessionId) continue;
					clearLayout(record.instance, sessionId);
				}
				return;
			}
			if (!group.layout) return;
			for (const [sessionId, record] of group.layoutInstances) {
				if (sessionId === sourceSessionId) continue;
				applyLayout(record.instance, sessionId, group.layout);
			}
		};

		const propagateBrowser = (group, sourceSessionId) => {
			if (!group.browser) return;
			for (const [sessionId, record] of group.browserInstances) {
				if (sessionId === sourceSessionId) continue;
				applyBrowser(record.instance, group.browser);
			}
		};

		const onLayoutChange = (group, sessionId, instance) => {
			if (scopeMode !== 'workspace') return;
			const surface = surfaceOfSnapshot(instance.getSnapshot(), sessionId);
			if (!surface) return;
			const next = { layout: surface.layout, minted: surface.minted };
			const nextScore = layoutScore(next);

			if (group.reset) {
				// Nobody opened anything yet: keep the workspace empty. The first tab
				// a user opens is what releases the reset, and becomes the canonical.
				if (nextScore === 0) return;
				group.reset = false;
				group.initialized = true;
				group.layout = clone(next);
				saveGroup(group);
				propagateLayout(group, sessionId);
				info('reset released', group.workspaceId, sessionId);
				return;
			}

			if (group.layout && sameLayout(group.layout, next)) {
				// Content is unchanged; only this window's presentation moved. Record
				// the new default for sessions that have no presentation of their own,
				// but never push it to the other windows.
				if (nextScore === 0) return;
				const current = group.layout.layout;
				if (current.expanded !== next.layout.expanded || current.mode !== next.layout.mode) {
					group.layout = {
						...group.layout,
						layout: {
							...current,
							expanded: next.layout.expanded,
							mode: next.layout.mode,
						},
					};
					saveGroup(group);
				}
				return;
			}

			const previousScore = layoutScore(group.layout);
			// An empty-to-empty change (guide tab mounting, for instance) is noise.
			if (nextScore === 0 && previousScore === 0) return;
			group.initialized = true;
			group.layout = clone(next);
			saveGroup(group);
			propagateLayout(group, sessionId);
		};

		const onBrowserChange = (group, sessionId, instance) => {
			if (scopeMode !== 'workspace') return;
			const state = browserStateOf(instance.getSnapshot());
			if (!state) return;
			// While a workspace is reset, the Browser store is being cleared as well;
			// stale pages must not leak into the next canonical.
			if (group.reset) return;
			if (group.browser && sameBrowser(group.browser, state)) return;
			const previousScore = browserScore(group.browser);
			const nextScore = browserScore(state);
			if (nextScore === 0 && previousScore === 0) return;
			group.initialized = true;
			group.browser = clone(state);
			saveGroup(group);
			propagateBrowser(group, sessionId);
		};

		/* ------------------------------------------------------------------ */
		/* Seeding newly materialised instances                                */
		/* ------------------------------------------------------------------ */

		const seedLayout = (group, sessionId, instance) => {
			if (group.reset) {
				clearLayout(instance, sessionId);
				return;
			}
			if (!group.initialized) {
				// First use of this workspace: the live session in front of the user is
				// the only template we ever accept. A workspace with nothing open stays
				// uninitialised until someone opens something.
				const incoming = surfaceOfSnapshot(instance.getSnapshot(), sessionId);
				if (!incoming || layoutScore(incoming) === 0) return;
				group.initialized = true;
				group.layout = clone(incoming);
				saveGroup(group);
				propagateLayout(group, sessionId);
				info('adopted layout', group.workspaceId, sessionId);
				return;
			}
			applyLayout(instance, sessionId, group.layout);
		};

		const seedBrowser = (group, sessionId, instance) => {
			if (group.reset) {
				applyBrowser(instance, { byTab: {} });
				return;
			}
			if (!group.initialized) {
				const incoming = browserStateOf(instance.getSnapshot());
				if (!incoming || browserScore(incoming) === 0) return;
				group.initialized = true;
				group.browser = clone(incoming);
				saveGroup(group);
				propagateBrowser(group, sessionId);
				info('adopted browser', group.workspaceId, sessionId);
				return;
			}
			if (group.browser) applyBrowser(instance, group.browser);
		};

		/* ------------------------------------------------------------------ */
		/* Store discovery                                                     */
		/* ------------------------------------------------------------------ */

		const kindOfHandle = (handle) => {
			try {
				const spec = handle && handle.spec;
				if (!isObject(spec)) return undefined;
				if (spec.persist === 'dsh.sidebar-browser.v1') return 'browser';
				const actions = spec.actions;
				if (isObject(actions)
					&& typeof actions.open === 'function'
					&& typeof actions.setExpanded === 'function'
					&& typeof actions.splitPane === 'function') {
					return 'layout';
				}
			} catch {}
			return undefined;
		};

		const dropSession = (group, sessionId) => {
			for (const map of [group.layoutInstances, group.browserInstances]) {
				const record = map.get(sessionId);
				if (!record) continue;
				try {
					record.unsubscribe?.();
				} catch {}
				map.delete(sessionId);
			}
		};

		const observeHandle = (handle, sessionId, instance) => {
			if (scopeMode !== 'workspace') return;
			if (typeof sessionId !== 'string' || !instance || typeof instance.subscribe !== 'function') return;
			const kind = kindOfHandle(handle);
			if (!kind) return;
			if (mapping.archived.has(sessionId)) {
				// Archived after it was observed: stop mirroring it in either direction.
				for (const group of groups.values()) dropSession(group, sessionId);
				return;
			}
			const workspaceId = workspaceOf(sessionId);
			if (!workspaceId) return;

			const group = getGroup(workspaceId);
			const map = kind === 'layout' ? group.layoutInstances : group.browserInstances;
			const existing = map.get(sessionId);
			if (existing && existing.instance === instance) return;
			if (existing) {
				try {
					existing.unsubscribe?.();
				} catch {}
			}

			const record = { instance, unsubscribe: undefined };
			map.set(sessionId, record);

			if (kind === 'layout') seedLayout(group, sessionId, instance);
			else seedBrowser(group, sessionId, instance);

			const unsubscribe = instance.subscribe(() => {
				if (instance.__sidebarShareApplying) return;
				try {
					if (kind === 'layout') onLayoutChange(group, sessionId, instance);
					else onBrowserChange(group, sessionId, instance);
				} catch (error) {
					warn('mirror failed', sessionId, error);
				}
			});
			record.unsubscribe = unsubscribe;
			info('observing', kind, sessionId, 'workspace=' + workspaceId);
		};

		/* ------------------------------------------------------------------ */
		/* Sidebar tab menu                                                    */
		/*                                                                    */
		/* Two entries on a right-sidebar tab's actions menu:                  */
		/*                                                                    */
		/*  - File tabs get 「在访达中显示」 (macOS) / 「在文件资源管理器中显示」   */
		/*    (Windows) / 「在文件管理器中显示」 (Linux). The Host resolves the  */
		/*    tab's verified absolute path and reveals it with the native       */
		/*    opener the Open In control already uses.                          */
		/*  - Any tab gets 「引用到对话」, which drops its file path, browser URL  */
		/*    or terminal screen into the composer — or the clipboard when the  */
		/*    composer insertion face is not mounted.                           */
		/*                                                                    */
		/* Both entries work with only `{ tab, dismiss }`; extra faces come from */
		/* services, so an entry cannot silently disappear when a prop changes.  */
		/* ------------------------------------------------------------------ */

		const BROWSER_PREFIX = 'dsh.sidebar-browser.v1.';
		const MENU_STYLE_ID = 'dsh-sidebar-share/tab-menu.css';
		const TOAST_CLASS = 'dsh-sidebar-share-toast';
		const CLOSE_OTHERS_MENU_ID = 'sidebar-share:close-others';
		const CLOSE_OTHERS_MENU_LABEL = '关闭其他标签页';
		const CLOSE_OTHERS_MENU_ORDER = 60;
		const CLOSE_RIGHT_MENU_ID = 'sidebar-share:close-right';
		const CLOSE_RIGHT_MENU_LABEL = '关闭右侧标签页';
		const CLOSE_RIGHT_MENU_ORDER = 70;
		const CHAT_MENU_ID = 'sidebar-share:chat-reference';
		const CHAT_MENU_LABEL = '引用到对话';
		const REVEAL_MENU_ID = 'sidebar-share:reveal-in-file-manager';
		const REVEAL_MENU_ORDER = 90;
		const CHAT_MENU_ORDER = 100;
		const TERMINAL_MAX_LINES = 60;
		const TOAST_MS = 3200;
		const FILE_ADDRESS_PREFIX = 'dsh-resource://file/';
		/** The three desktop behaviours the Host can reveal a path with. */
		const FILE_MANAGER_LABELS = {
			finder: '在访达中显示',
			explorer: '在文件资源管理器中显示',
			directory: '在文件管理器中显示',
		};
		const FILE_MANAGER_TITLES = {
			finder: '在 Finder 中显示这个文件的位置',
			explorer: '在文件资源管理器中显示这个文件的位置',
			directory: '在文件管理器中显示这个文件的位置',
		};

		/** The event guards every menu item uses before acting. */
		const stopEvent = (event) => {
			try {
				if (event && typeof event.preventDefault === 'function') event.preventDefault();
				if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
			} catch {}
		};

		const messageOf = (error) => {
			if (error === undefined || error === null) return '';
			if (typeof error === 'string') return error;
			if (typeof error.message === 'string' && error.message.length > 0) return error.message;
			return String(error);
		};

		/** A short, non-blocking notice; the menu has already closed when this runs. */
		const showMenuToast = (text) => {
			try {
				if (typeof document === 'undefined' || !document.body) return;
				const previous = document.querySelector('.' + TOAST_CLASS);
				if (previous && typeof previous.remove === 'function') previous.remove();
				const node = document.createElement('div');
				node.className = TOAST_CLASS;
				node.setAttribute('role', 'alert');
				node.textContent = String(text);
				document.body.appendChild(node);
				setTimeout(() => {
					try {
						node.remove();
					} catch {}
				}, TOAST_MS);
			} catch {}
		};

		const decodeSegment = (value) => {
			try {
				return decodeURIComponent(value);
			} catch {
				return value;
			}
		};

		/**
		 * Split a `dsh-resource://file/…` address into its scope and path.
		 *
		 * `session` scope carries a workspace-relative path, or an absolute one
		 * when the file sits outside the workspace / the root was unknown. The
		 * empty leading segment an absolute path produces survives the split, so
		 * the path stays absolute exactly when its address says so.
		 */
		const parseFileAddress = (address) => {
			if (typeof address !== 'string' || !address.startsWith(FILE_ADDRESS_PREFIX)) return undefined;
			const end = address.search(/[?#]/);
			const body = end === -1 ? address.slice(FILE_ADDRESS_PREFIX.length) : address.slice(FILE_ADDRESS_PREFIX.length, end);
			const parts = body.split('/');
			const scope = parts.shift();
			if (scope === 'session') {
				const sessionId = parts.shift();
				if (sessionId === undefined || sessionId === '') return undefined;
				return {
					scope,
					sessionId: decodeSegment(sessionId),
					path: parts.map(decodeSegment).join('/'),
				};
			}
			if (scope === 'absolute') {
				const unc = parts[0] === '' && parts.length > 1;
				const segments = (unc ? parts.slice(1) : parts).map(decodeSegment);
				if (segments.length === 0 || segments[0] === '') return undefined;
				const joined = segments.join('/');
				if (unc) return { scope, path: '//' + joined };
				return { scope, path: /^[A-Za-z]:$/.test(segments[0]) ? joined : '/' + joined };
			}
			return undefined;
		};

		/** Whether a path is already absolute in either spelling the Host accepts. */
		const isAbsoluteHostPath = (path) =>
			typeof path === 'string' &&
			(path.startsWith('/') || /^[A-Za-z]:[/\\]/.test(path) || path.startsWith('\\\\'));

		/** The file path behind a file tab, or undefined for every other tab. */
		const filePathOfTab = (tab) => {
			const parsed = parseFileAddress(tab && tab.contentId);
			if (!parsed) return undefined;
			return parsed.path.length > 0 ? parsed.path : undefined;
		};

		const isFileTab = (tab) => isObject(tab) && filePathOfTab(tab) !== undefined;

		/** Serialize a path the way the `@` reference source expects it. */
		const fileMention = (path) => {
			if (typeof path !== 'string' || path.length === 0) return '';
			if (!/\s/.test(path)) return '@' + path + ' ';
			if (path.includes('"')) return path + ' ';
			return '@"' + path + '" ';
		};

		const readBrowserUrl = (sessionId, tabId) => {
			if (typeof sessionId !== 'string' || typeof tabId !== 'string') return undefined;
			const raw = readRaw(BROWSER_PREFIX + sessionId);
			if (!raw) return undefined;
			try {
				const parsed = JSON.parse(raw);
				const state = isObject(parsed) && isObject(parsed.byTab) ? parsed.byTab[tabId] : undefined;
				if (!isObject(state) || !Array.isArray(state.entries)) return undefined;
				const index = typeof state.index === 'number' ? state.index : 0;
				const entry = state.entries[index];
				if (!isObject(entry) || typeof entry.url !== 'string' || entry.url.length === 0) return undefined;
				return entry.url;
			} catch {
				return undefined;
			}
		};

		/** Visible rows of the terminal the user is looking at (xterm's DOM renderer). */
		const visibleTerminalText = () => {
			try {
				if (typeof document === 'undefined') return '';
				const roots = [...document.querySelectorAll('.xterm-rows')].filter((node) => node.getClientRects().length > 0);
				const root = roots[roots.length - 1];
				if (!root) return '';
				const lines = [...root.children].map((row) => (row.textContent || '').replace(/\s+$/u, ''));
				while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
				return lines.slice(-TERMINAL_MAX_LINES).join('\n').trim();
			} catch {
				return '';
			}
		};

		const chatReferenceKind = (tab) => {
			if (!isObject(tab)) return undefined;
			if (filePathOfTab(tab) !== undefined) return 'file';
			if (tab.kind === 'browser') return 'browser';
			if (tab.kind === 'terminal') return 'terminal';
			if (typeof tab.contentId === 'string' && tab.contentId.startsWith('sidebar://terminal/')) return 'terminal';
			return undefined;
		};

		/** What lands in the composer when the user picks 「引用到对话」. */
		const chatReferenceText = (tab, sessionId) => {
			const kind = chatReferenceKind(tab);
			if (kind === 'file') {
				const path = filePathOfTab(tab);
				return path ? fileMention(path) : '';
			}
			if (kind === 'browser') {
				const url = readBrowserUrl(sessionId, tab && tab.id);
				return url ? url + '\n' : '';
			}
			if (kind === 'terminal') {
				const title = isObject(tab) && typeof tab.title === 'string' && tab.title.length > 0 ? tab.title : '终端';
				const body = visibleTerminalText();
				if (body.length === 0) {
					return '侧边栏终端「' + title + '」：没有读到屏幕内容，请手动复制关键输出。\n';
				}
				return '侧边栏终端「' + title + '」最近输出：\n```text\n' + body + '\n```\n';
			}
			return '';
		};

		/** The visible composer editor, or undefined when no session is on screen. */
		const composerEditor = () => {
			if (typeof document === 'undefined') return undefined;
			const editors = [...document.querySelectorAll('[data-conversation-region="composer"] [contenteditable="true"]')];
			return editors.filter((node) => node.getClientRects().length > 0).pop() ?? editors.pop();
		};

		const focusComposer = () => {
			try {
				const editor = composerEditor();
				if (editor && typeof editor.focus === 'function') editor.focus();
			} catch {}
		};

		/** The pre-permission copy path; the Clipboard API is not available everywhere. */
		const legacyCopyText = (text) => {
			try {
				if (typeof document === 'undefined' || !document.body) return false;
				const area = document.createElement('textarea');
				area.value = text;
				area.setAttribute('readonly', '');
				area.style.position = 'fixed';
				area.style.top = '0';
				area.style.opacity = '0';
				document.body.appendChild(area);
				if (typeof area.select === 'function') area.select();
				const copied = typeof document.execCommand === 'function' && document.execCommand('copy') === true;
				area.remove();
				return copied;
			} catch {
				return false;
			}
		};

		/** Copy text, reporting whether it reached the clipboard. */
		const copyText = async (text) => {
			try {
				const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
				if (clipboard && typeof clipboard.writeText === 'function') {
					await clipboard.writeText(text);
					return true;
				}
			} catch {}
			return legacyCopyText(text);
		};

		/**
		 * The composer's public insertion face: capture the caret span, put the
		 * caret back into the editor, then insert one undoable plain-text edit.
		 *
		 * The order matters. The tab menu is what the user clicked, so the editor
		 * is blurred and its DOM caret would land at the start if it were focused
		 * after the edit; focusing first keeps Lexical's caret where the user left
		 * it and lets the edit move it to the end of the inserted text.
		 */
		const insertIntoComposer = (inputActions, text) => {
			if (typeof text !== 'string' || text.length === 0) return false;
			try {
				const span = inputActions.captureInsertion();
				focusComposer();
				if (span && inputActions.insertText(text, span)) return true;
			} catch (error) {
				warn('composer insertion failed', error);
			}
			return false;
		};

		/** A `remote.‹namespace›` service, or undefined when the Host lacks it. */
		const remoteNamespace = (ctx, name) => {
			try {
				const remote = ctx.get('remote');
				const namespace = remote ? remote[name] : undefined;
				if (namespace) return namespace;
			} catch {}
			try {
				return ctx.get('remote.' + name);
			} catch {
				return undefined;
			}
		};

		/** The Session the right sidebar is currently showing, when one is. */
		const onScreenSessionId = (ctx) => {
			try {
				const right = ctx.get('sidebarRight');
				const mounted = right && right.mounted;
				const value = mounted && typeof mounted.getSnapshot === 'function' ? mounted.getSnapshot() : undefined;
				return typeof value === 'string' && value.length > 0 ? value : undefined;
			} catch {
				return undefined;
			}
		};

		const sessionIdOfReference = (props, ctx, tab) => {
			if (props && typeof props.sessionId === 'string' && props.sessionId.length > 0) return props.sessionId;
			const parsed = parseFileAddress(tab && tab.contentId);
			if (parsed && parsed.scope === 'session') return parsed.sessionId;
			return onScreenSessionId(ctx);
		};

		/* ------------------------------------------------------------------ */
		/* Which native file manager this Host can open                       */
		/* ------------------------------------------------------------------ */

		/** `undefined` until the probe answers; then the opener name ('finder' | 'explorer' | 'directory'). */
		let fileManagerState;
		let fileManagerProbe;
		const fileManagerListeners = new Set();

		const publishFileManager = (value) => {
			if (value === fileManagerState) return;
			fileManagerState = value;
			for (const listener of [...fileManagerListeners]) {
				try {
					listener();
				} catch {}
			}
		};

		const subscribeFileManager = (listener) => {
			fileManagerListeners.add(listener);
			return () => {
				fileManagerListeners.delete(listener);
			};
		};

		const fileManagerSnapshot = () => fileManagerState;

		/** Read the Host catalog's file-manager entry (the route the Open In button uses). */
		const readOpenInAppApps = async () => {
			if (typeof fetch !== 'function') return undefined;
			try {
				const response = await fetch('open-in-app/apps', {
					credentials: 'same-origin',
					headers: { accept: 'application/json' },
				});
				if (!response || response.ok !== true) return undefined;
				const body = await response.json();
				return isObject(body) && Array.isArray(body.apps) ? body.apps : undefined;
			} catch {
				return undefined;
			}
		};

		const fileManagerFromApps = (apps) => {
			if (apps.includes('finder')) return 'finder';
			if (apps.includes('explorer')) return 'explorer';
			if (apps.includes('filemanager')) return 'directory';
			return null;
		};

		/** The Host home directory, when the Remote host facts already carry it. */
		const hostHome = (ctx) => {
			try {
				const remote = ctx.get('remote');
				const facts = remote ? remote.$host : undefined;
				return facts && typeof facts.home === 'string' && facts.home.length > 0 ? facts.home : undefined;
			} catch {
				return undefined;
			}
		};

		/** Fallback when the catalog route is unavailable: the Host home spelling. */
		const guessFileManager = (ctx) => {
			const home = hostHome(ctx);
			if (typeof home !== 'string' || home.length === 0) return undefined;
			if (home.startsWith('/Users/')) return 'finder';
			if (/^[A-Za-z]:[\\/]/.test(home) || home.startsWith('\\\\')) return 'explorer';
			if (home.startsWith('/home/') || home.startsWith('/root')) return 'directory';
			return undefined;
		};

		const probeFileManager = async (ctx) => {
			// 1. The Host catalog names the platform's file manager entry exactly.
			const apps = await readOpenInAppApps();
			const matched = apps === undefined ? null : fileManagerFromApps(apps);
			if (typeof matched === 'string') return matched;
			// 2. The Home spelling identifies the same family even when the catalog
			//    hides its file-manager row (a display-less launch still reveals
			//    through the desktop's session bus).
			const guessed = guessFileManager(ctx);
			if (guessed !== undefined) return guessed;
			// 3. Nothing identifies the family: only a Host that can open paths at
			//    all earns the generic label.
			const session = remoteNamespace(ctx, 'session');
			if (session && typeof session.canOpenWorkspacePath === 'function') {
				try {
					const result = await session.canOpenWorkspacePath();
					if (result && result.ok === true && result.value === true) return 'directory';
				} catch {}
			}
			return undefined;
		};

		/**
		 * Resolve the Host file manager once; an unknown answer is retried on the
		 * next menu open because a service may simply not have been mounted yet.
		 */
		const ensureFileManagerProbe = (ctx, options) => {
			if (options && options.force === true) fileManagerProbe = undefined;
			if (fileManagerProbe !== undefined) return fileManagerProbe;
			const running = probeFileManager(ctx)
				.then((value) => {
					if (value === undefined) {
						fileManagerProbe = undefined;
						publishFileManager(undefined);
						return undefined;
					}
					publishFileManager(value);
					return value;
				})
				.catch((error) => {
					warn('file manager probe failed', error);
					fileManagerProbe = undefined;
					publishFileManager(undefined);
					return undefined;
				});
			fileManagerProbe = running;
			return running;
		};

		/**
		 * Probe once the Remote is mounted, then retry a few times while the answer
		 * stays unknown — the host facts that carry the Home directory arrive with
		 * the first connection generation, not with the service itself.
		 */
		const scheduleFileManagerProbe = (ctx, attempt = 0) => {
			const delay = attempt === 0 ? 0 : Math.min(4000, 400 * 2 ** attempt);
			setTimeout(() => {
				if (fileManagerState !== undefined) return;
				Promise.resolve(ensureFileManagerProbe(ctx)).then((value) => {
					if (value === undefined && attempt < 5) scheduleFileManagerProbe(ctx, attempt + 1);
				}, () => {});
			}, delay);
		};

		/* ------------------------------------------------------------------ */
		/* Reveal one file tab in the Host's file manager                     */
		/* ------------------------------------------------------------------ */

		/** The absolute Host path behind a file tab, or undefined when it cannot be proven. */
		const hostPathOfTab = async (ctx, tab) => {
			const parsed = parseFileAddress(tab && tab.contentId);
			if (!parsed) return undefined;
			if (parsed.scope === 'absolute') return parsed.path;
			if (isAbsoluteHostPath(parsed.path)) return parsed.path;
			if (parsed.path.length === 0) return undefined;
			const files = remoteNamespace(ctx, 'workspaceFiles');
			if (!files || typeof files.stat !== 'function') return undefined;
			const result = await files.stat(parsed.sessionId, parsed.path);
			if (result && result.ok === true && result.value && typeof result.value.absolutePath === 'string') {
				return result.value.absolutePath;
			}
			return undefined;
		};

		const revealTabInFileManager = async (ctx, tab, manager) => {
			const label = FILE_MANAGER_LABELS[manager] ?? FILE_MANAGER_LABELS.directory;
			try {
				const session = remoteNamespace(ctx, 'session');
				if (!session || typeof session.openWorkspacePath !== 'function') {
					throw new Error('宿主没有提供打开文件位置的能力');
				}
				const path = await hostPathOfTab(ctx, tab);
				if (path === undefined) throw new Error('无法确定这个文件在磁盘上的路径');
				const result = await session.openWorkspacePath({ path, action: 'reveal' });
				if (!result || result.ok !== true) {
					throw new Error(messageOf(result && result.error) || '宿主拒绝了这次请求');
				}
				info('revealed', path, 'in', manager);
			} catch (error) {
				warn('reveal failed', error);
				showMenuToast(label + '失败：' + (messageOf(error) || '未知原因'));
			}
		};

		/* ------------------------------------------------------------------ */
		/* Menu rendering                                                     */
		/* ------------------------------------------------------------------ */

		const installMenuStyles = () => {
			try {
				if (typeof document === 'undefined') return;
				if (document.querySelector('style[data-plugin-css="' + MENU_STYLE_ID + '"]') !== null) return;
				const tag = document.createElement('style');
				tag.dataset.plugin = 'dsh-sidebar-share';
				tag.dataset.pluginCss = MENU_STYLE_ID;
				tag.textContent =
					'.dsh-sidebar-share-menu-item{display:flex;align-items:center;gap:8px;width:100%;height:28px;padding:0 8px;border:0;border-radius:var(--dsw-radius-md,6px);background:transparent;color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:12px;line-height:1;white-space:nowrap;text-align:left;cursor:pointer}'
					+ '.dsh-sidebar-share-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}'
					+ '.dsh-sidebar-share-menu-item:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#2f6fed);outline-offset:-2px}'
					+ '.dsh-sidebar-share-menu-icon{display:inline-flex;flex:none;align-items:center;justify-content:center;width:14px;height:14px;color:var(--dsw-alias-label-secondary,currentColor)}'
					+ '.dsh-sidebar-share-toast{position:fixed;top:40px;left:50%;z-index:1100;transform:translateX(-50%);width:max-content;max-width:min(640px,calc(100vw - 48px));padding:10px 14px;border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-toast-bg,#2f2f2f);color:var(--dsw-alias-toast-label,#fff);font-size:12.5px;line-height:1.5;text-align:center;box-shadow:0 6px 24px rgba(0,0,0,.28);pointer-events:none}';
				document.head.appendChild(tag);
			} catch {}
		};

		const revealIcon = (h) =>
			h('span', { className: 'dsh-sidebar-share-menu-icon', 'aria-hidden': 'true' },
				h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3 },
					h('path', { d: 'M1.8 4.1c0-.7.6-1.3 1.3-1.3h2.3c.4 0 .8.2 1 .5l.8 1h4.6c.7 0 1.3.6 1.3 1.3v5.3c0 .7-.6 1.3-1.3 1.3H3.1c-.7 0-1.3-.6-1.3-1.3z', strokeLinejoin: 'round' })));

		const chatIcon = (h) =>
			h('span', { className: 'dsh-sidebar-share-menu-icon', 'aria-hidden': 'true' },
				h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5 },
					h('path', { d: 'M2.5 8h7.2', strokeLinecap: 'round' }),
					h('path', { d: 'M8.4 5.2 11.2 8l-2.8 2.8', strokeLinecap: 'round', strokeLinejoin: 'round' }),
					h('path', { d: 'M12.6 3v10', strokeLinecap: 'round', opacity: 0.5 })));

		/* --- Closing a tab's siblings --------------------------------------- */

		/**
		 * The dock pane that currently holds `tabId`, or undefined when the id is
		 * stale. A pane is one tab strip, so "others" and "to the right" never
		 * reach across a split or into a floating panel.
		 */
		const paneOfTab = (layout, tabId) => {
			if (!isObject(layout) || !isObject(layout.nodes)) return undefined;
			if (typeof tabId !== 'string' || tabId.length === 0) return undefined;
			try {
				for (const node of Object.values(layout.nodes)) {
					if (!isObject(node) || node.kind !== 'pane' || !Array.isArray(node.tabs)) continue;
					if (node.tabs.includes(tabId)) return node;
				}
			} catch {}
			return undefined;
		};

		/** The Session whose sidebar owns this menu; the slot carries it, the factory knows it. */
		const sidebarSessionOf = (props, ctx) => {
			if (props && typeof props.sessionId === 'string' && props.sessionId.length > 0) return props.sessionId;
			return onScreenSessionId(ctx);
		};

		/** The `sidebarRight` controller, or undefined when the Host has no sidebar. */
		const sidebarController = (ctx) => {
			try {
				return ctx.get('sidebarRight') || undefined;
			} catch {
				return undefined;
			}
		};

		/** The controller's own view of the sidebar it is showing. */
		const screenSurface = (ctx) => {
			try {
				const right = sidebarController(ctx);
				if (!right || typeof right.screen !== 'function') return undefined;
				const screen = right.screen();
				return isObject(screen) && isObject(screen.surface) ? screen : undefined;
			} catch {
				return undefined;
			}
		};

		/**
		 * One Session's dock layout: the controller first, the mirrored store
		 * second. The controller only knows the Session on screen, while the store
		 * keeps every Session this window has adopted — which is what a mirrored
		 * sidebars menu needs.
		 */
		const sidebarLayoutFor = (ctx, sessionId) => {
			const screen = screenSurface(ctx);
			if (screen && isObject(screen.surface.layout)) {
				if (typeof sessionId !== 'string' || screen.sessionId === sessionId) return screen.surface.layout;
			}
			try {
				for (const group of groups.values()) {
					const record = group.layoutInstances.get(sessionId);
					if (!record || !record.instance || typeof record.instance.getSnapshot !== 'function') continue;
					const snapshot = record.instance.getSnapshot();
					const surface = isObject(snapshot) && isObject(snapshot.bySession) ? snapshot.bySession[sessionId] : undefined;
					if (isObject(surface) && isObject(surface.layout)) return surface.layout;
				}
			} catch {}
			return undefined;
		};

		/** The dock store's own actions; undefined for a Session this window never adopted. */
		const sidebarActionsFor = (ctx, sessionId) => {
			try {
				const right = sidebarController(ctx);
				if (right && typeof right.actionsFor === 'function') {
					const actions = right.actionsFor(sessionId);
					if (isObject(actions) && typeof actions.closeTab === 'function') return actions;
				}
			} catch {}
			try {
				for (const group of groups.values()) {
					const record = group.layoutInstances.get(sessionId);
					const actions = record && record.instance ? record.instance.actions : undefined;
					if (isObject(actions) && typeof actions.closeTab === 'function') return actions;
				}
			} catch {}
			return undefined;
		};

		/**
		 * The tabs a close command would remove. 'others' keeps the menu's own tab;
		 * 'right' keeps everything at or left of it, in tab-strip order.
		 */
		const closeTargetsFor = (layout, tabId, mode) => {
			const pane = paneOfTab(layout, tabId);
			if (!pane) return [];
			const index = pane.tabs.indexOf(tabId);
			if (index === -1) return [];
			return mode === 'others'
				? pane.tabs.filter((id) => id !== tabId)
				: pane.tabs.slice(index + 1);
		};

		const closeTargets = (ctx, props, mode) => {
			const tab = props ? props.tab : undefined;
			return closeTargetsFor(sidebarLayoutFor(ctx, sidebarSessionOf(props, ctx)), tab && tab.id, mode);
		};

		/** Close right-to-left so the kit settles the focus on the leftmost survivor. */
		const closeTabSiblings = (ctx, props, mode) => {
			const sessionId = sidebarSessionOf(props, ctx);
			const tab = props ? props.tab : undefined;
			const targets = closeTargetsFor(sidebarLayoutFor(ctx, sessionId), tab && tab.id, mode);
			if (targets.length === 0) return 0;
			const right = sidebarController(ctx);
			// `closeIn` also runs the tab kind's own teardown (a terminal's cleanup);
			// the raw store action is the fallback for a Host that does not expose it.
			const closeIn = right && typeof right.closeIn === 'function' ? right.closeIn.bind(right) : undefined;
			const actions = closeIn ? undefined : sidebarActionsFor(ctx, sessionId);
			if (!closeIn && !actions) {
				showMenuToast('侧栏还没准备好，请稍后再试');
				return 0;
			}
			let closed = 0;
			for (let index = targets.length - 1; index >= 0; index -= 1) {
				const tabId = targets[index];
				try {
					if (closeIn) closeIn(sessionId, tabId);
					else actions.closeTab(sessionId, tabId);
					closed += 1;
				} catch (error) {
					warn('close tab failed', tabId, error);
				}
			}
			return closed;
		};

		const closeOthersIcon = (h) =>
			h('span', { className: 'dsh-sidebar-share-menu-icon', 'aria-hidden': 'true' },
				h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 },
					h('path', { d: 'M2.6 4.2l4.4 4.4M7 4.2 2.6 8.6', strokeLinecap: 'round' }),
					h('path', { d: 'M10.8 4.2h2.6M10.8 8h2.6M10.8 11.8h2.6', strokeLinecap: 'round', opacity: 0.55 })));

		const closeRightIcon = (h) =>
			h('span', { className: 'dsh-sidebar-share-menu-icon', 'aria-hidden': 'true' },
				h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 },
					h('path', { d: 'M1.8 4.8l4.2 4.2M6 4.8 1.8 9', strokeLinecap: 'round' }),
					h('path', { d: 'M9.6 8h3.6', strokeLinecap: 'round' }),
					h('path', { d: 'M11.4 6.2 13.2 8l-1.8 1.8', strokeLinecap: 'round', strokeLinejoin: 'round' })));

		const createCloseMenuItem = (react, ctx, mode) => {
			const h = react.createElement;
			const label = mode === 'others' ? CLOSE_OTHERS_MENU_LABEL : CLOSE_RIGHT_MENU_LABEL;
			const title = mode === 'others'
				? '关闭同一分栏里除当前标签以外的所有标签页'
				: '关闭同一分栏里排在当前标签右侧的所有标签页';
			const icon = mode === 'others' ? closeOthersIcon : closeRightIcon;
			const CloseItem = (props) => {
				if (closeTargets(ctx, props, mode).length === 0) return null;
				return h('button', {
					type: 'button',
					role: 'menuitem',
					className: 'dsh-sidebar-share-menu-item',
					title,
					onClick: (event) => {
						stopEvent(event);
						const dismiss = props && typeof props.dismiss === 'function' ? props.dismiss : undefined;
						if (dismiss) dismiss();
						closeTabSiblings(ctx, props, mode);
					},
				}, icon(h), h('span', null, label));
			};
			CloseItem.displayName = mode === 'others' ? 'SidebarShareCloseOthersItem' : 'SidebarShareCloseRightItem';
			return CloseItem;
		};

		const createRevealMenuItem = (react, ctx) => {
			const h = react.createElement;
			const RevealItem = (props) => {
				const [manager, setManager] = react.useState(fileManagerSnapshot);
				if (typeof react.useEffect === 'function') {
					react.useEffect(() => {
						ensureFileManagerProbe(ctx);
						return subscribeFileManager(() => setManager(fileManagerSnapshot()));
					}, []);
				}
				const tab = props ? props.tab : undefined;
				if (!isFileTab(tab) || typeof manager !== 'string') return null;
				const label = FILE_MANAGER_LABELS[manager] ?? FILE_MANAGER_LABELS.directory;
				const title = FILE_MANAGER_TITLES[manager] ?? FILE_MANAGER_TITLES.directory;
				return h('button', {
					type: 'button',
					role: 'menuitem',
					className: 'dsh-sidebar-share-menu-item',
					title,
					onClick: (event) => {
						stopEvent(event);
						const dismiss = props && typeof props.dismiss === 'function' ? props.dismiss : undefined;
						if (dismiss) dismiss();
						revealTabInFileManager(ctx, tab, manager);
					},
				}, revealIcon(h), h('span', null, label));
			};
			RevealItem.displayName = 'SidebarShareRevealItem';
			return RevealItem;
		};

		const createChatMenuItem = (react, ctx) => {
			const h = react.createElement;
			const ChatReferenceItem = (props) => {
				const tab = props ? props.tab : undefined;
				if (chatReferenceKind(tab) === undefined) return null;
				return h('button', {
					type: 'button',
					role: 'menuitem',
					className: 'dsh-sidebar-share-menu-item',
					title: '把侧栏里的文件、页面或终端输出插入输入框',
					onClick: async (event) => {
						stopEvent(event);
						const dismiss = props && typeof props.dismiss === 'function' ? props.dismiss : undefined;
						const text = chatReferenceText(tab, sessionIdOfReference(props, ctx, tab));
						const inputActions = props ? props.inputActions : undefined;
						const inserted = inputActions ? insertIntoComposer(inputActions, text) : false;
						if (dismiss) dismiss();
						if (inserted) return;
						if (text.length === 0) {
							showMenuToast('这个标签没有可引用的内容');
							return;
						}
						if (await copyText(text)) {
							showMenuToast('已复制到剪贴板，粘贴到输入框即可');
							return;
						}
						showMenuToast('无法写入输入框，请手动复制');
					},
				}, chatIcon(h), h('span', null, CHAT_MENU_LABEL));
			};
			ChatReferenceItem.displayName = 'SidebarShareChatReferenceItem';
			return ChatReferenceItem;
		};

		/** The `sidebar.right.tab.menu.item` entries; silent when the slot is absent. */
		const registerTabMenuItems = (slots, disposers, ctx) => {
			if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return;
			const react = requireReact();
			if (!react || typeof react.createElement !== 'function') return;
			installMenuStyles();
			const register = (id, order, label, component, failure) => {
				try {
					const dispose = slots.inject('sidebar.right.tab.menu.item', () => slots.register({
						name: 'sidebar.right.tab.menu.item',
						id,
						order,
						label,
					}, component));
					if (typeof dispose === 'function') disposers.push(dispose);
					info(failure + ' menu registered');
				} catch (error) {
					warn(failure + ' menu unavailable', error);
				}
			};
			register(CLOSE_OTHERS_MENU_ID, CLOSE_OTHERS_MENU_ORDER, CLOSE_OTHERS_MENU_LABEL, createCloseMenuItem(react, ctx, 'others'), 'close others');
			register(CLOSE_RIGHT_MENU_ID, CLOSE_RIGHT_MENU_ORDER, CLOSE_RIGHT_MENU_LABEL, createCloseMenuItem(react, ctx, 'right'), 'close right');
			register(REVEAL_MENU_ID, REVEAL_MENU_ORDER, FILE_MANAGER_LABELS.finder, createRevealMenuItem(react, ctx), 'reveal');
			register(CHAT_MENU_ID, CHAT_MENU_ORDER, CHAT_MENU_LABEL, createChatMenuItem(react, ctx), 'chat reference');
		};

		/* ------------------------------------------------------------------ */
		/* Sidebar scope preference                                            */
		/* ------------------------------------------------------------------ */

		let reactModule;
		const requireReact = () => {
			if (reactModule !== undefined) return reactModule;
			try {
				reactModule = require('react');
			} catch {
				reactModule = undefined;
			}
			return reactModule;
		};

		const scopeFromForm = (form) => {
			try {
				const snapshot = form && typeof form.getSnapshot === 'function' ? form.getSnapshot() : undefined;
				const value = snapshot && isObject(snapshot.value) ? snapshot.value : undefined;
				return value && value.scope === 'session' ? 'session' : 'workspace';
			} catch {
				return 'workspace';
			}
		};

		const SCOPE_STYLE_ID = 'dsh-sidebar-share/scope-settings.css';
		const installScopeStyles = () => {
			try {
				if (typeof document === 'undefined') return;
				if (document.querySelector('style[data-plugin-css="' + SCOPE_STYLE_ID + '"]') !== null) return;
				const tag = document.createElement('style');
				tag.dataset.plugin = 'dsh-sidebar-share';
				tag.dataset.pluginCss = SCOPE_STYLE_ID;
				tag.textContent =
					'.dsh-sidebar-share-scope{display:flex;flex-direction:column;gap:10px;padding:14px 16px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}'
					+ '.dsh-sidebar-share-scopeTitle{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}'
					+ '.dsh-sidebar-share-scopeHint{margin:0;font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}'
					+ '.dsh-sidebar-share-options{display:flex;flex-direction:column;gap:6px}'
					+ '.dsh-sidebar-share-option{display:flex;align-items:flex-start;gap:10px;width:100%;padding:9px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer}'
					+ '.dsh-sidebar-share-option:hover{background:var(--dsw-alias-bg-layer-2)}'
					+ '.dsh-sidebar-share-option.is-selected{border-color:var(--dsw-alias-brand-primary,#2f6fed)}'
					+ '.dsh-sidebar-share-option:disabled{opacity:.55;cursor:default}'
					+ '.dsh-sidebar-share-radio{flex:none;width:14px;height:14px;margin-top:1px;border-radius:50%;border:1.5px solid var(--dsw-alias-border-l3)}'
					+ '.dsh-sidebar-share-option.is-selected .dsh-sidebar-share-radio{border-color:var(--dsw-alias-brand-primary,#2f6fed);box-shadow:inset 0 0 0 3px var(--dsw-alias-brand-primary,#2f6fed)}'
					+ '.dsh-sidebar-share-optionText{display:flex;flex-direction:column;gap:2px;min-width:0}'
					+ '.dsh-sidebar-share-optionTitle{font-size:12.5px;font-weight:600}'
					+ '.dsh-sidebar-share-optionDesc{font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}';
				document.head.appendChild(tag);
			} catch {}
		};

		const SCOPE_OPTIONS = [
			{ id: 'workspace', title: '工作区共享', description: '同一工作区的所有会话共用一套右侧栏（本插件行为）' },
			{ id: 'session', title: '会话独立', description: '每个会话各自保留侧栏，等同 DSH 官方默认' },
		];

		const createScopeSection = (react, form) => {
			const h = react.createElement;
			const ScopeSection = () => {
				const [snapshot, setSnapshot] = react.useState(() => form.getSnapshot());
				react.useEffect(() => {
					const off = form.subscribe(() => setSnapshot(form.getSnapshot()));
					setSnapshot(form.getSnapshot());
					return typeof off === 'function' ? off : undefined;
				}, []);
				const value = snapshot && isObject(snapshot.value) && snapshot.value.scope === 'session' ? 'session' : 'workspace';
				const writable = !snapshot || snapshot.writable !== false;
				const choose = (next) => {
					try {
						const pending = form.set(SCOPE_FIELD, next);
						if (pending && typeof pending.catch === 'function') pending.catch(() => {});
					} catch {}
				};
				return h('section', { className: 'dsh-sidebar-share-scope' },
					h('h3', { className: 'dsh-sidebar-share-scopeTitle' }, '侧边栏范围'),
					h('p', { className: 'dsh-sidebar-share-scopeHint' },
						'选择右侧栏按会话独立，还是在同一工作区内共享。切换立即生效；切回工作区共享时会以当前工作区的模板对齐各会话。'),
					h('div', { className: 'dsh-sidebar-share-options', role: 'radiogroup', 'aria-label': '侧边栏范围' },
						SCOPE_OPTIONS.map((option) => h('button', {
							key: option.id,
							type: 'button',
							role: 'radio',
							'aria-checked': String(value === option.id),
							className: 'dsh-sidebar-share-option' + (value === option.id ? ' is-selected' : ''),
							disabled: !writable,
							onClick: () => choose(option.id),
						},
						h('span', { className: 'dsh-sidebar-share-radio', 'aria-hidden': 'true' }),
						h('span', { className: 'dsh-sidebar-share-optionText' },
							h('span', { className: 'dsh-sidebar-share-optionTitle' }, option.title),
							h('span', { className: 'dsh-sidebar-share-optionDesc' }, option.description))))),
					!writable
						? h('p', { className: 'dsh-sidebar-share-scopeHint' }, '当前设置由 Host 只读；修改需要在 profile 的 cordis.patch.yml 里配置。')
						: null);
			};
			ScopeSection.displayName = 'SidebarShareScopeSection';
			return ScopeSection;
		};

		/** The 插件 page row for this bundle; absent when the page owns no form. */
		const registerScopeSettings = (slots, form, disposers) => {
			try {
				if (!form || typeof form.getSnapshot !== 'function') return false;
				if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return false;
				const react = requireReact();
				if (!react || typeof react.useState !== 'function') return false;
				installScopeStyles();
				const dispose = slots.inject(SCOPE_SLOT, () => slots.register({
					name: SCOPE_SLOT,
					key: BUNDLE_NAME,
				}, createScopeSection(react, form)));
				if (typeof dispose === 'function') disposers.push(dispose);
				info('scope settings registered');
				return true;
			} catch (error) {
				warn('scope settings unavailable', error);
				return false;
			}
		};

		/* ------------------------------------------------------------------ */
		/* Plugin lifecycle                                                    */
		/* ------------------------------------------------------------------ */

		const inject = ['slots', 'sessions', 'workspaces'];

		function apply(ctx) {
			try {
				if (typeof window !== 'undefined' && window.__DSH_SIDEBAR_SHARE_APPLIED__) return;
				if (readRaw(DISABLED_KEY) === '1') {
					info('disabled by', DISABLED_KEY);
					return;
				}

				const slots = ctx.get('slots');
				if (!slots || typeof slots.resolveStore !== 'function') {
					warn('slots service unavailable; plugin inactive');
					return;
				}
				const sessions = ctx.get('sessions');
				const workspaces = ctx.get('workspaces');
				sessionService = sessions;
				workspaceService = workspaces;
				if (!sessions && !workspaces) {
					warn('session/workspace services unavailable; plugin inactive');
					return;
				}

				let configForm;
				try {
					const configForms = ctx.get('configForms');
					if (configForms && typeof configForms.get === 'function') configForm = configForms.get(ENTRY_ID);
				} catch (error) {
					warn('config form unavailable', error);
				}
				scopeMode = scopeFromForm(configForm);
				if (scopeMode === 'workspace') {
					const migrated = migrateLegacy();
					if (migrated > 0) info('migrated v1 canonicals', migrated);
				}

				const disposers = [];
				let sweepScheduled = false;
				let sweepTimer;
				const scheduleSweep = () => {
					if (sweepScheduled) return;
					sweepScheduled = true;
					sweepTimer = setTimeout(() => {
						sweepScheduled = false;
						sweepTimer = undefined;
						sweep();
					}, 150);
				};

				const sweep = () => {
					if (scopeMode !== 'workspace') return;
					try {
						const stores = slots._stores;
						if (!stores || typeof stores.forEach !== 'function') return;
						for (const [handle, record] of stores) {
							if (!record || !record.instances || typeof record.instances.forEach !== 'function') continue;
							for (const [sessionId, instance] of record.instances) {
								if (typeof sessionId !== 'string') continue;
								observeHandle(handle, sessionId, instance);
							}
						}
					} catch (error) {
						warn('sweep failed', error);
					}
				};

				const originalResolve = slots.resolveStore;
				function resolveStore(handle, scopeBinding) {
					const instance = originalResolve.call(this, handle, scopeBinding);
					try {
						const sessionId = scopeBinding && scopeBinding.key;
						if (typeof sessionId === 'string') observeHandle(handle, sessionId, instance);
					} catch (error) {
						warn('resolve hook failed', error);
					}
					return instance;
				}

				/** Flip between workspace sharing and per-session sidebars at runtime. */
				function setScopeMode(next) {
					const wanted = next === 'session' ? 'session' : 'workspace';
					if (wanted === scopeMode) return;
					scopeMode = wanted;
					for (const group of groups.values()) {
						if (group.saveTimer !== undefined) {
							clearTimeout(group.saveTimer);
							group.saveTimer = undefined;
						}
						for (const record of group.layoutInstances.values()) {
							try {
								record.unsubscribe?.();
							} catch {}
						}
						for (const record of group.browserInstances.values()) {
							try {
								record.unsubscribe?.();
							} catch {}
						}
					}
					groups.clear();
					mapping.dirty = true;
					info('sidebar scope', scopeMode);
					if (scopeMode !== 'workspace') return;
					const migrated = migrateLegacy();
					if (migrated > 0) info('migrated v1 canonicals', migrated);
					scheduleSweep();
				}

				let scopeSettingsRegistered = false;
				const ensureScopeSettings = () => {
					if (scopeSettingsRegistered || !configForm) return;
					scopeSettingsRegistered = registerScopeSettings(slots, configForm, disposers) === true;
				};

				const bindScopePreference = () => {
					if (!configForm) {
						if (typeof ctx.inject !== 'function') return;
						ctx.inject(['configForms'], (child) => {
							try {
								const late = child.configForms.get(ENTRY_ID);
								if (!late) return;
								configForm = late;
								const off = late.subscribe(() => setScopeMode(scopeFromForm(late)));
								if (typeof off === 'function') disposers.push(off);
								setScopeMode(scopeFromForm(late));
								ensureScopeSettings();
							} catch (error) {
								warn('scope preference unavailable', error);
							}
						});
						return;
					}
					const off = configForm.subscribe(() => setScopeMode(scopeFromForm(configForm)));
					if (typeof off === 'function') disposers.push(off);
				};

				const cleanup = () => {
					if (sweepTimer !== undefined) clearTimeout(sweepTimer);
					if (slots.resolveStore === resolveStore) slots.resolveStore = originalResolve;
					for (const dispose of disposers.splice(0)) {
						try {
							dispose();
						} catch {}
					}
					for (const group of groups.values()) {
						if (group.saveTimer !== undefined) clearTimeout(group.saveTimer);
						for (const record of group.layoutInstances.values()) {
							try {
								record.unsubscribe?.();
							} catch {}
						}
						for (const record of group.browserInstances.values()) {
							try {
								record.unsubscribe?.();
							} catch {}
						}
					}
					groups.clear();
					fileManagerProbe = undefined;
					publishFileManager(undefined);
					sessionService = undefined;
					workspaceService = undefined;
					mapping = { dirty: true, bySession: new Map(), byWorkspace: new Map(), archived: new Set() };
					scopeMode = 'workspace';
					try {
						if (window.__DSH_SIDEBAR_SHARE__) delete window.__DSH_SIDEBAR_SHARE__;
						delete window.__DSH_SIDEBAR_SHARE_APPLIED__;
					} catch {}
				};

				if (typeof ctx.effect === 'function') {
					ctx.effect(() => {
						slots.resolveStore = resolveStore;
						registerTabMenuItems(slots, disposers, ctx);
						if (typeof ctx.inject === 'function') {
							try {
								ctx.inject(['remote'], () => scheduleFileManagerProbe(ctx));
							} catch {
								scheduleFileManagerProbe(ctx);
							}
						} else {
							scheduleFileManagerProbe(ctx);
						}
						bindScopePreference();
						ensureScopeSettings();
						window.__DSH_SIDEBAR_SHARE_APPLIED__ = true;

						const subscribeList = (service) => {
							const list = service && service.list;
							if (!list || typeof list.subscribe !== 'function') return;
							const dispose = list.subscribe(() => {
								mapping.dirty = true;
								scheduleSweep();
							});
							if (typeof dispose === 'function') disposers.push(dispose);
						};
						subscribeList(sessions);
						subscribeList(workspaces);

						if (typeof ctx.on === 'function') {
							const dispose = ctx.on('slots/changed', scheduleSweep);
							if (typeof dispose === 'function') disposers.push(dispose);
						}

						mapping.dirty = true;
						rebuildMapping(workspaces, sessions);
						sweep();
						info('enabled', PLUGIN_VERSION, {
							groups: groups.size,
							sessions: mapping.bySession.size,
							workspaces: mapping.byWorkspace.size,
						});

						try {
							window.__DSH_SIDEBAR_SHARE__ = {
								version: PLUGIN_VERSION,
								canonicalVersion: CANONICAL_VERSION,
								sweep,
								workspaceOf,
								canonicalKey,
								scope: () => scopeMode,
								setScope: (value) => setScopeMode(value),
								chatReference: {
									kindOf: chatReferenceKind,
									textOf: chatReferenceText,
								},
								tabMenu: {
									fileManager: fileManagerSnapshot,
									hostHome: () => hostHome(ctx),
									catalogApps: () => readOpenInAppApps(),
									fileManagerLabel: () => FILE_MANAGER_LABELS[fileManagerSnapshot()] ?? null,
									refreshFileManager: () => ensureFileManagerProbe(ctx, { force: true }),
									resolvePath: (tab) => hostPathOfTab(ctx, tab),
									reveal: (tab) => revealTabInFileManager(ctx, tab, fileManagerSnapshot() ?? 'directory'),
									parseAddress: parseFileAddress,
									closeTargets: (sessionId, tabId, mode) => closeTargetsFor(sidebarLayoutFor(ctx, sessionId), tabId, mode),
									closeSiblings: (props, mode) => closeTabSiblings(ctx, props, mode),
								},
							};
						} catch {}

						return cleanup;
					}, 'sidebar-share: workspace mirror');
				} else {
					warn('ctx.effect unavailable; plugin not installed');
				}
			} catch (error) {
				warn('apply failed', error);
			}
		}

		return { inject, apply };
	},
});
