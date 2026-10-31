/**
 * Standalone harness for `dist/client.js` (v2 model).
 *
 * It boots the browser half against fake slot/session/workspace services and
 * verifies the rules this release is built around:
 *
 *   - a v1 canonical is deleted and replaced with an explicit reset;
 *   - a reset workspace clears and closes every session it materialises;
 *   - the first tab the user opens releases the reset and becomes the canonical;
 *   - a live change is mirrored, while each window keeps its own expanded state;
 *   - closing every tab writes an empty canonical that is authoritative: no
 *     session, sweep, or later mount resurrects the closed tabs;
 *   - archived sessions neither seed nor receive anything;
 *   - a workspace with no canonical at all adopts one live session, once;
 *   - cleanup restores the slot service.
 *
 * Run with: node test/harness.mjs
 */
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

/* ------------------------------------------------------------------ */
/* Mock browser environment                                            */
/* ------------------------------------------------------------------ */

const storage = new Map()
const localStorage = {
  get length() { return storage.size },
  key(index) { return [...storage.keys()][index] ?? null },
  getItem(key) { return storage.has(key) ? storage.get(key) : null },
  setItem(key, value) { storage.set(key, String(value)) },
  removeItem(key) { storage.delete(key) },
  clear() { storage.clear() },
}
globalThis.localStorage = localStorage
globalThis.window = { localStorage }
// Keep the harness output focused on assertion failures.
console.info = () => {}
console.warn = () => {}

// The Host catalog route the reveal entry reads to learn which native file
// manager this deployment has. Tests mutate `openInAppApps`/`fetchMode` and
// re-probe through the debug face.
const fetchCalls = []
let openInAppApps = ['finder']
let fetchMode = 'ok'
globalThis.fetch = async (input) => {
  fetchCalls.push(String(input))
  if (fetchMode === 'fail') throw new Error('offline')
  return { ok: true, json: async () => ({ apps: openInAppApps }) }
}

const clipboardWrites = []
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  writable: true,
  value: {
    clipboard: {
      writeText(text) {
        clipboardWrites.push(text)
        return Promise.resolve()
      },
    },
  },
})

const fakeReact = {
  createElement(type, props, ...children) {
    return { type, props: props || {}, children }
  },
  // Enough of the hook surface for slot sections to register; they are never
  // rendered in this harness.
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect() {
    return undefined
  },
}

const loaded = []
window.__ModuleLoader__ = {
  load(module) {
    loaded.push(module)
  },
}

await import(join(here, '..', 'dist', 'client.js'))
assert.equal(loaded.length, 1, 'client bundle must register exactly one module')
const module = loaded[0]
assert.equal(module.id, 'dsh-sidebar-share')

const exported = module.factory((specifier) => {
  if (specifier === '@deepseek-ai/dsh-client-ui-dockkit') {
    return { EMPTY_HISTORY: { entries: [], cursor: 0 } }
  }
  if (specifier === 'react') {
    return fakeReact
  }
  throw new Error(`unexpected require: ${specifier}`)
})
assert.deepEqual(exported.inject, ['slots', 'sessions', 'workspaces'])
assert.equal(typeof exported.apply, 'function')

/* ------------------------------------------------------------------ */
/* Fake stores                                                         */
/* ------------------------------------------------------------------ */

function makeStore(initial) {
  let state = structuredClone(initial)
  const subscribers = new Set()
  return {
    getSnapshot: () => state,
    subscribe(fn) {
      subscribers.add(fn)
      return () => subscribers.delete(fn)
    },
    set(next) {
      state = typeof next === 'function' ? next(state) : structuredClone(next)
      for (const fn of [...subscribers]) fn()
    },
  }
}

function makeInstance(initial) {
  const store = makeStore(initial)
  return {
    store,
    getSnapshot: store.getSnapshot,
    subscribe: store.subscribe,
    actions: {},
  }
}

const layoutHandle = {
  spec: {
    actions: {
      open() {},
      setExpanded() {},
      splitPane() {},
    },
  },
  create(key) {
    const raw = localStorage.getItem('dsh.sidebar-right.v1.' + key)
    return makeInstance(raw ? JSON.parse(raw) : { bySession: {} })
  },
}

const browserHandle = {
  spec: {
    persist: 'dsh.sidebar-browser.v1',
    actions: {
      replace() {},
      forget() {},
    },
  },
  create(key) {
    const raw = localStorage.getItem('dsh.sidebar-browser.v1.' + key)
    return makeInstance(raw ? JSON.parse(raw) : { byTab: {} })
  },
}

const slots = {
  _stores: new Map(),
  resolveStore(handle, binding) {
    let record = this._stores.get(handle)
    if (record === undefined) {
      record = { scope: 'session', instances: new Map() }
      this._stores.set(handle, record)
    }
    const key = binding && binding.key
    let instance = record.instances.get(key)
    if (instance === undefined) {
      instance = handle.create(key)
      record.instances.set(key, instance)
    }
    return instance
  },
}
const menuRegistrations = []
slots.inject = (name, register) => register()
slots.register = (options, component) => {
  menuRegistrations.push({ options, component })
  return () => {}
}
const originalResolveStore = slots.resolveStore

/* ------------------------------------------------------------------ */
/* Fake services                                                       */
/* ------------------------------------------------------------------ */

const sessions = {
  list: {
    getSnapshot: () => ({
      byId: {
        'session-a': { cwd: '/repo' },
        'session-b': { cwd: '/repo' },
        'session-c': { cwd: '/repo' },
        'session-h': { cwd: '/repo' },
        'session-archived': { cwd: '/repo' },
        'session-e': { cwd: '/repo-two' },
        'session-f': { cwd: '/repo-two' },
        'session-g': { cwd: '/repo-three' },
        'session-i': { cwd: '/repo-three' },
      },
    }),
    subscribe: () => () => {},
  },
}

const workspaces = {
  list: {
    getSnapshot: () => ({
      items: [
        {
          workspaceId: 'workspace-1',
          path: '/repo',
          sessionIds: ['session-a', 'session-b', 'session-c', 'session-h', 'session-archived'],
        },
        {
          workspaceId: 'workspace-2',
          path: '/repo-two',
          sessionIds: ['session-e', 'session-f'],
        },
        {
          workspaceId: 'workspace-3',
          path: '/repo-three',
          sessionIds: ['session-g', 'session-i'],
        },
      ],
      archivedSessionIds: ['session-archived'],
    }),
    subscribe: () => () => {},
  },
}

/* ------------------------------------------------------------------ */
/* Fixtures: a polluted v1 workspace, a fresh workspace, an archive    */
/* ------------------------------------------------------------------ */

const tab = (id, file) => ({
  id,
  kind: 'text',
  contentId: `dsh-resource://file/session/session-a/${file}`,
  title: file.split('/').pop(),
})

const pollutedLayout = {
  nodes: {
    pane1: { kind: 'pane', id: 'pane1', host: 'dock', tabs: ['tab12', 'tab13', 'tab14'], activeTabId: 'tab14' },
  },
  tabs: {
    tab12: tab('tab12', 'coupon/coupon-exact.png'),
    tab13: tab('tab13', 'coupon/coupon-flat-final.png'),
    tab14: tab('tab14', 'coupon/coupon-flat-final-900x1200.jpg'),
  },
  rootId: 'pane1',
  floats: [],
  activePaneId: 'pane1',
  expanded: true,
  mode: 'push',
}

const pollutedBrowser = {
  byTab: {
    tab14: {
      entries: [{ kind: 'http', url: 'http://localhost:9000/', title: 'localhost:9000' }],
      index: 0,
      request: { target: { kind: 'http', url: 'http://localhost:9000/' }, revision: 1 },
      navigation: { status: 'known', revision: 1 },
    },
  },
}

localStorage.setItem(
  'dsh.sidebar-right.v1.session-a',
  JSON.stringify({ bySession: { 'session-a': { layout: pollutedLayout, minted: 14 } } }),
)
localStorage.setItem('dsh.sidebar-browser.v1.session-a', JSON.stringify(pollutedBrowser))
// Session B also carries a stale sidebar from before the upgrade.
const staleB = structuredClone(pollutedLayout)
for (const entry of Object.values(staleB.tabs)) {
  entry.contentId = entry.contentId.replace('/session/session-a/', '/session/session-b/')
}
localStorage.setItem(
  'dsh.sidebar-right.v1.session-b',
  JSON.stringify({ bySession: { 'session-b': { layout: staleB, minted: 14 } } }),
)
localStorage.setItem(
  'dsh.sidebar-share.v1.workspace-1',
  JSON.stringify({
    version: 1,
    savedAt: 1,
    layout: { layout: pollutedLayout, minted: 14 },
    browser: pollutedBrowser,
  }),
)
// The archived session is the stale location the old code used to reseed from.
localStorage.setItem(
  'dsh.sidebar-right.v1.session-archived',
  JSON.stringify({ bySession: { 'session-archived': { layout: pollutedLayout, minted: 14 } } }),
)
// A workspace that never had a canonical: its first live session is the template.
const seedLayout = {
  nodes: { pane1: { kind: 'pane', id: 'pane1', host: 'dock', tabs: ['tab7'], activeTabId: 'tab7' } },
  tabs: {
    tab7: {
      id: 'tab7',
      kind: 'text',
      contentId: 'dsh-resource://file/session/session-e/docs/seed.md',
      title: 'seed.md',
    },
  },
  rootId: 'pane1',
  floats: [],
  activePaneId: 'pane1',
  expanded: true,
  mode: 'push',
}
localStorage.setItem(
  'dsh.sidebar-right.v1.session-e',
  JSON.stringify({ bySession: { 'session-e': { layout: seedLayout, minted: 7 } } }),
)

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

const scopeState = { value: { scope: 'workspace' }, writable: true, revision: 1 }
const scopeListeners = new Set()
const configForm = {
  getSnapshot: () => ({
    status: 'ready',
    value: scopeState.value,
    writable: scopeState.writable,
    revision: scopeState.revision,
  }),
  subscribe(listener) {
    scopeListeners.add(listener)
    return () => scopeListeners.delete(listener)
  },
  set(field, value) {
    scopeState.value = { ...scopeState.value, [field]: value }
    scopeState.revision += 1
    for (const listener of [...scopeListeners]) listener()
    return Promise.resolve(true)
  },
}
const configForms = {
  get(entryId) {
    assert.equal(entryId, 'sidebar-share', 'the plugin must read its own settings namespace')
    return configForm
  },
}

const remoteCalls = { stat: [], reveal: [], canOpen: 0 }
const remoteState = {
  canOpen: true,
  stat(sessionId, path) {
    return { ok: true, value: { absolutePath: '/repo/' + path, version: 'v1' } }
  },
  reveal() {
    return { ok: true, value: { opened: true } }
  },
}
const remote = {
  $host: { home: '/home/harness', isLoopback: true },
  session: {
    async canOpenWorkspacePath() {
      remoteCalls.canOpen += 1
      return { ok: true, value: remoteState.canOpen }
    },
    async openWorkspacePath(request) {
      remoteCalls.reveal.push(request)
      return remoteState.reveal(request)
    },
  },
  workspaceFiles: {
    async stat(sessionId, path) {
      remoteCalls.stat.push([sessionId, path])
      return remoteState.stat(sessionId, path)
    },
  },
}
const sidebarRightState = { mounted: 'session-a' }
const sidebarRight = {
  mounted: { getSnapshot: () => sidebarRightState.mounted },
}

const disposers = []
const ctx = {
  get(name) {
    return { slots, sessions, workspaces, configForms, remote, sidebarRight }[name]
  },
  effect(callback) {
    const dispose = callback()
    if (typeof dispose === 'function') disposers.push(dispose)
    return dispose
  },
  on() {
    return () => {}
  },
}

exported.apply(ctx)
assert.equal(window.__DSH_SIDEBAR_SHARE__.version, '0.1.6')
assert.equal(window.__DSH_SIDEBAR_SHARE__.canonicalVersion, 2)

const settle = () => new Promise((resolve) => setTimeout(resolve, 350))
const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0))
const v2 = () => JSON.parse(localStorage.getItem('dsh.sidebar-share.v2.workspace-1'))
const v2two = () => JSON.parse(localStorage.getItem('dsh.sidebar-share.v2.workspace-2'))
const v3 = () => JSON.parse(localStorage.getItem('dsh.sidebar-share.v2.workspace-3'))
const tabsOf = (surface) => Object.values(surface.layout.tabs)
const layoutOf = (instance, sessionId) => instance.getSnapshot().bySession[sessionId]

/* ------------------------------------------------------------------ */
/* 1. v1 template is deleted, the migration leaves an explicit reset   */
/* ------------------------------------------------------------------ */

assert.equal(localStorage.getItem('dsh.sidebar-share.v1.workspace-1'), null, 'the v1 canonical must be deleted')
const resetCanonical = v2()
assert.equal(resetCanonical.version, 2)
assert.equal(resetCanonical.reset, true)
assert.equal(resetCanonical.layout, null)

/* ------------------------------------------------------------------ */
/* 2. Every session of the reset workspace is emptied and closed       */
/* ------------------------------------------------------------------ */

const layoutA = slots.resolveStore(layoutHandle, { key: 'session-a' })
const browserA = slots.resolveStore(browserHandle, { key: 'session-a' })
const surfaceA = layoutOf(layoutA, 'session-a')
assert.ok(surfaceA, 'session A must be seeded')
assert.deepEqual(tabsOf(surfaceA), [], 'the polluted tabs must be stripped')
assert.equal(surfaceA.layout.expanded, false, 'an empty workspace is applied closed')
assert.deepEqual(browserA.getSnapshot().byTab, {}, 'the polluted browser page must be cleared')

const layoutB = slots.resolveStore(layoutHandle, { key: 'session-b' })
const surfaceB = layoutOf(layoutB, 'session-b')
assert.deepEqual(tabsOf(surfaceB), [], 'session B must start empty as well')

/* ------------------------------------------------------------------ */
/* 3. The first tab opened by the user releases the reset              */
/* ------------------------------------------------------------------ */

const opened = structuredClone(surfaceA)
opened.layout.tabs.tab1 = {
  id: 'tab1',
  kind: 'text',
  contentId: 'dsh-resource://file/session/session-a/docs/readme.md',
  title: 'readme.md',
}
opened.layout.nodes.pane1.tabs = ['tab1']
opened.layout.nodes.pane1.activeTabId = 'tab1'
opened.layout.expanded = true
layoutA.store.set({ bySession: { 'session-a': opened } })

await settle()
const afterOpen = v2()
assert.equal(afterOpen.reset, false, 'opening a tab must release the reset')
assert.deepEqual(Object.keys(afterOpen.layout.layout.tabs), ['tab1'])

const mirroredB = layoutOf(layoutB, 'session-b')
assert.deepEqual(Object.keys(mirroredB.layout.tabs), ['tab1'], 'session B must receive the tab')
assert.equal(
  mirroredB.layout.tabs.tab1.contentId,
  'dsh-resource://file/session/session-b/docs/readme.md',
  'workspace-file address must point at the receiving session',
)
assert.equal(mirroredB.layout.expanded, false, 'content sync must not pop a closed column open')

/* ------------------------------------------------------------------ */
/* 4. A session opened later inherits the closed-but-shared content    */
/* ------------------------------------------------------------------ */

const layoutC = slots.resolveStore(layoutHandle, { key: 'session-c' })
const surfaceC = layoutOf(layoutC, 'session-c')
assert.deepEqual(Object.keys(surfaceC.layout.tabs), ['tab1'])
assert.equal(
  surfaceC.layout.tabs.tab1.contentId,
  'dsh-resource://file/session/session-c/docs/readme.md',
  'the third session gets its own file address',
)

/* ------------------------------------------------------------------ */
/* 5. Closing every tab is authoritative — and nothing resurrects it   */
/* ------------------------------------------------------------------ */

const closed = structuredClone(layoutOf(layoutB, 'session-b'))
closed.layout.tabs = {}
closed.layout.nodes.pane1.tabs = []
delete closed.layout.nodes.pane1.activeTabId
closed.layout.expanded = false
layoutB.store.set({ bySession: { 'session-b': closed } })

await settle()
const closedCanonical = v2()
assert.equal(closedCanonical.reset, false)
assert.deepEqual(closedCanonical.layout.layout.tabs, {}, 'an empty canonical must be persisted as empty')
assert.deepEqual(tabsOf(layoutOf(layoutA, 'session-a')), [], 'closing in B must empty A')
assert.deepEqual(tabsOf(layoutOf(layoutC, 'session-c')), [], 'closing in B must empty C')
assert.equal(layoutOf(layoutA, 'session-a').layout.expanded, false)
assert.equal(layoutOf(layoutC, 'session-c').layout.expanded, false)

// A sweep (the old repair trigger) must not rebuild anything.
window.__DSH_SIDEBAR_SHARE__.sweep()
await settle()
assert.deepEqual(v2().layout.layout.tabs, {}, 'a sweep must not invent a template')

// A session mounting after the close starts empty and closed.
const layoutH = slots.resolveStore(layoutHandle, { key: 'session-h' })
const surfaceH = layoutOf(layoutH, 'session-h')
assert.deepEqual(tabsOf(surfaceH), [], 'a later session must stay closed')
assert.equal(surfaceH.layout.expanded, false)

/* ------------------------------------------------------------------ */
/* 6. Archived sessions neither seed nor receive                       */
/* ------------------------------------------------------------------ */

const layoutArchived = slots.resolveStore(layoutHandle, { key: 'session-archived' })
const archivedSurface = layoutOf(layoutArchived, 'session-archived')
assert.deepEqual(
  Object.keys(archivedSurface.layout.tabs).sort(),
  ['tab12', 'tab13', 'tab14'],
  'an archived session keeps its own store; the plugin must not clear or mirror it',
)
assert.deepEqual(v2().layout.layout.tabs, {}, 'an archived session must not re-seed the canonical')

/* ------------------------------------------------------------------ */
/* 7. A workspace with no canonical adopts one live session, once      */
/* ------------------------------------------------------------------ */

const layoutE = slots.resolveStore(layoutHandle, { key: 'session-e' })
assert.deepEqual(Object.keys(layoutOf(layoutE, 'session-e').layout.tabs), ['tab7'])
await settle()
const adopted = v2two()
assert.ok(adopted, 'the first live session seeds a workspace that has no canonical')
assert.deepEqual(Object.keys(adopted.layout.layout.tabs), ['tab7'])
assert.equal(adopted.reset, false)

const layoutF = slots.resolveStore(layoutHandle, { key: 'session-f' })
assert.deepEqual(Object.keys(layoutOf(layoutF, 'session-f').layout.tabs), ['tab7'], 'later sessions inherit it')

/* ------------------------------------------------------------------ */
/* 8. Presentation stays per window                                    */
/* ------------------------------------------------------------------ */

const collapsedE = structuredClone(layoutOf(layoutE, 'session-e'))
collapsedE.layout.expanded = false
layoutE.store.set({ bySession: { 'session-e': collapsedE } })
assert.equal(
  layoutOf(layoutF, 'session-f').layout.expanded,
  true,
  'collapsing one window must not close the other',
)

/* ------------------------------------------------------------------ */
/* 9. A session that mounts empty creates the canonical on first use   */
/* ------------------------------------------------------------------ */

const layoutG = slots.resolveStore(layoutHandle, { key: 'session-g' })
assert.equal(layoutOf(layoutG, 'session-g'), undefined, 'nothing is written before the user opens anything')
assert.equal(v3(), null, 'a workspace with no content has no canonical')

const openedG = {
  nodes: { pane1: { kind: 'pane', id: 'pane1', host: 'dock', tabs: ['tab2'], activeTabId: 'tab2' } },
  tabs: {
    tab2: {
      id: 'tab2',
      kind: 'text',
      contentId: 'dsh-resource://file/session/session-g/docs/later.md',
      title: 'later.md',
    },
  },
  rootId: 'pane1',
  floats: [],
  activePaneId: 'pane1',
  expanded: true,
  mode: 'push',
}
layoutG.store.set({ bySession: { 'session-g': { layout: openedG, minted: 2 } } })
await settle()
assert.deepEqual(Object.keys(v3().layout.layout.tabs), ['tab2'], 'the first tab must be persisted as the canonical')

const layoutI = slots.resolveStore(layoutHandle, { key: 'session-i' })
assert.deepEqual(
  Object.keys(layoutOf(layoutI, 'session-i').layout.tabs),
  ['tab2'],
  'the canonical must be seeded into a session opened afterwards',
)

/* ------------------------------------------------------------------ */
/* 10. Sidebar → chat reference                                       */
/* ------------------------------------------------------------------ */

const chatReference = window.__DSH_SIDEBAR_SHARE__.chatReference
assert.equal(typeof chatReference.kindOf, 'function')
assert.equal(typeof chatReference.textOf, 'function')

const fileTab = {
  id: 'tab1',
  kind: 'text',
  contentId: 'dsh-resource://file/session/session-a/coupon/coupon-exact.png',
  title: 'coupon-exact.png',
}
assert.equal(chatReference.kindOf(fileTab), 'file')
assert.equal(chatReference.textOf(fileTab, 'session-a'), '@coupon/coupon-exact.png ')
assert.equal(
  chatReference.textOf(
    { id: 'tab1', kind: 'text', contentId: 'dsh-resource://file/session/session-a/docs/my%20plan.md' },
    'session-a',
  ),
  '@"docs/my plan.md" ',
  'paths with spaces must use the quoted mention form',
)
assert.equal(chatReference.textOf(fileTab, 'session-a', 'ignored'), '@coupon/coupon-exact.png ')
assert.equal(chatReference.kindOf({ id: 'tab3', kind: 'guide' }), undefined)
assert.equal(chatReference.textOf({ id: 'tab3', kind: 'guide' }, 'session-a'), '')
assert.equal(chatReference.textOf({ id: 'tab4', kind: 'text', contentId: 'dsh-resource://file/session/session-a/' }, 'session-a'), '')

localStorage.setItem(
  'dsh.sidebar-browser.v1.session-b',
  JSON.stringify({ byTab: { tabB: { entries: [{ url: 'http://localhost:9000/#/' }], index: 0 } } }),
)
assert.equal(chatReference.kindOf({ id: 'tabB', kind: 'browser' }), 'browser')
assert.equal(chatReference.textOf({ id: 'tabB', kind: 'browser' }, 'session-b'), 'http://localhost:9000/#/\n')
assert.equal(chatReference.textOf({ id: 'tabB', kind: 'browser' }, 'session-a'), '', 'a missing Browser store yields no reference')

assert.equal(chatReference.kindOf({ id: 'term', kind: 'terminal', contentId: 'sidebar://terminal/abc' }), 'terminal')

/* ------------------------------------------------------------------ */
/* 11. Tab menu: entries, address parsing, reveal, reference fallback  */
/* ------------------------------------------------------------------ */

const scopeEntry = menuRegistrations.find((entry) => entry.options.name === 'plugins.bundle.config')
assert.ok(scopeEntry, 'the settings row must be registered')
assert.equal(scopeEntry.options.key, 'dsh-sidebar-share', 'the row is keyed by the bundle name')

const scopeNode = scopeEntry.component({ view: 'page' })
assert.equal(scopeNode.type, 'section', 'the settings row renders a section')
const scopeOptions = scopeNode.children.find((child) => child && child.props && child.props.role === 'radiogroup')
assert.ok(scopeOptions, 'the section renders a radio group')
assert.equal(scopeOptions.children.flat().length, 2)

const menuEntries = menuRegistrations.filter((entry) => entry.options.name === 'sidebar.right.tab.menu.item')
assert.equal(menuEntries.length, 2, 'the tab menu must contribute two entries')
const revealEntry = menuEntries.find((entry) => entry.options.id === 'sidebar-share:reveal-in-file-manager')
const menuEntry = menuEntries.find((entry) => entry.options.id === 'sidebar-share:chat-reference')
assert.ok(revealEntry, 'the reveal entry must be registered')
assert.ok(menuEntry, 'the chat reference entry must be registered')
assert.ok(revealEntry.options.order < menuEntry.options.order, 'reveal sorts above the chat reference')
assert.equal(menuEntry.options.label, '引用到对话')
assert.equal(typeof revealEntry.component, 'function')
assert.equal(typeof menuEntry.component, 'function')

const tabMenu = window.__DSH_SIDEBAR_SHARE__.tabMenu
assert.equal(typeof tabMenu.reveal, 'function')
assert.equal(typeof tabMenu.resolvePath, 'function')

/* Address parsing: workspace-relative, absolute-in-session, and absolute scope. */
assert.deepEqual(tabMenu.parseAddress('dsh-resource://file/session/session-a/docs/my%20plan.md'), {
  scope: 'session',
  sessionId: 'session-a',
  path: 'docs/my plan.md',
})
assert.deepEqual(tabMenu.parseAddress('dsh-resource://file/session/session-a//home/x/y.md'), {
  scope: 'session',
  sessionId: 'session-a',
  path: '/home/x/y.md',
})
assert.deepEqual(tabMenu.parseAddress('dsh-resource://file/absolute/home/x/y.md'), {
  scope: 'absolute',
  path: '/home/x/y.md',
})
assert.deepEqual(tabMenu.parseAddress('dsh-resource://file/absolute/C%3A/Users/x.md'), {
  scope: 'absolute',
  path: 'C:/Users/x.md',
})
assert.deepEqual(tabMenu.parseAddress('dsh-resource://file/absolute//server/share/x.md'), {
  scope: 'absolute',
  path: '//server/share/x.md',
})
assert.equal(tabMenu.parseAddress('sidebar://terminal/abc'), undefined)
assert.equal(tabMenu.parseAddress('dsh-resource://other/x'), undefined)

/* The Host catalog's file-manager entry decides the label. */
await nextTick()
assert.equal(tabMenu.fileManager(), 'finder', 'the finder entry from the catalog is the opener')
assert.equal(tabMenu.fileManagerLabel(), '在访达中显示')
assert.ok(fetchCalls.includes('open-in-app/apps'), 'the entry reads the same catalog route as Open In')

/* Only file tabs get the entry. */
assert.equal(revealEntry.component({ tab: { id: 'tab3', kind: 'guide' }, dismiss() {} }), null)
assert.equal(revealEntry.component({ tab: { id: 'tabB', kind: 'browser' }, dismiss() {} }), null)

let dismissed = false
const revealItem = revealEntry.component({
  tab: fileTab,
  dismiss: () => {
    dismissed = true
  },
})
assert.equal(revealItem.type, 'button')
assert.equal(revealItem.props.role, 'menuitem')
assert.equal(revealItem.children[1].children[0], '在访达中显示')
assert.equal(dismissed, false)
revealItem.props.onClick({ preventDefault() {}, stopPropagation() {} })
assert.equal(dismissed, true, 'an acting menu item must dismiss the menu')
await nextTick()
assert.deepEqual(remoteCalls.stat.at(-1), ['session-a', 'coupon/coupon-exact.png'])
assert.deepEqual(remoteCalls.reveal.at(-1), {
  path: '/repo/coupon/coupon-exact.png',
  action: 'reveal',
})

/* An absolute address needs no workspace stat. */
const statCount = remoteCalls.stat.length
const absoluteTab = {
  id: 'tabZ',
  kind: 'text',
  contentId: 'dsh-resource://file/absolute/home/nope/x.md',
  title: 'x.md',
}
assert.equal(await tabMenu.resolvePath(absoluteTab), '/home/nope/x.md')
await tabMenu.reveal(absoluteTab)
assert.equal(remoteCalls.stat.length, statCount, 'an absolute address is not restat-ed')
assert.deepEqual(remoteCalls.reveal.at(-1), { path: '/home/nope/x.md', action: 'reveal' })

/* A Host refusal is announced, never thrown out of the click. */
remoteState.reveal = () => ({ ok: false, error: { message: 'no desktop' } })
const failingItem = revealEntry.component({ tab: fileTab, dismiss() {} })
failingItem.props.onClick({ preventDefault() {}, stopPropagation() {} })
await nextTick()
remoteState.reveal = () => ({ ok: true, value: { opened: true } })

/* A Linux Home keeps the entry even when the catalog omits its file-manager row. */
openInAppApps = []
await tabMenu.refreshFileManager()
assert.equal(tabMenu.fileManager(), 'directory', 'the Home spelling identifies the family')
assert.equal(tabMenu.fileManagerLabel(), '在文件管理器中显示')

/* Without the catalog route the Home spelling still decides. */
fetchMode = 'fail'
await tabMenu.refreshFileManager()
assert.equal(tabMenu.fileManager(), 'directory', 'the fallback reads the Host home')

/* Nothing identifies the family and the Host cannot open paths: hide the entry. */
remote.$host.home = ''
remoteState.canOpen = false
await tabMenu.refreshFileManager()
assert.equal(tabMenu.fileManager(), undefined, 'an unidentifiable Host has no opener yet')
assert.equal(revealEntry.component({ tab: fileTab, dismiss() {} }), null)
remote.$host.home = '/home/harness'
remoteState.canOpen = true
fetchMode = 'ok'
openInAppApps = ['finder']
await tabMenu.refreshFileManager()
assert.equal(tabMenu.fileManager(), 'finder')

/* 「引用到对话」 keeps the composer insertion face when the Host supplies it. */
const inserted = []
const inputActions = {
  captureInsertion: () => ({ draftRev: 3 }),
  insertText: (text, span) => {
    inserted.push([text, span])
    return true
  },
}
const item = menuEntry.component({
  tab: fileTab,
  inputActions,
  dismiss: () => {},
})
assert.equal(item.type, 'button')
item.props.onClick({ preventDefault() {}, stopPropagation() {} })
assert.deepEqual(inserted, [['@coupon/coupon-exact.png ', { draftRev: 3 }]])
assert.ok(
  chatReference.textOf({ id: 'term', kind: 'terminal', title: 'zsh' }, 'session-a').includes('侧边栏终端「zsh」'),
  'terminal references carry the tab title',
)

/* Insertion order: capture the caret, focus the editor, insert, then dismiss.
   Focusing after the edit is what used to drop the caret at offset 0. */
const order = []
const fakeEditor = {
  getClientRects: () => [{ width: 1, height: 1 }],
  focus: () => order.push('focus'),
}
globalThis.document = {
  querySelector: () => null,
  querySelectorAll: (selector) => (String(selector).includes('contenteditable') ? [fakeEditor] : []),
  createElement: () => ({
    dataset: {},
    style: {},
    setAttribute() {},
    appendChild() {},
    remove() {},
    textContent: '',
  }),
  head: { appendChild() {} },
  body: { appendChild() {} },
  execCommand: () => false,
}
const orderedActions = {
  captureInsertion: () => {
    order.push('capture')
    return { draftRev: 1 }
  },
  insertText: () => {
    order.push('insert')
    return true
  },
}
const orderedItem = menuEntry.component({
  tab: fileTab,
  inputActions: orderedActions,
  dismiss: () => order.push('dismiss'),
})
orderedItem.props.onClick({ preventDefault() {}, stopPropagation() {} })
assert.deepEqual(order, ['capture', 'focus', 'insert', 'dismiss'], 'the caret is captured before the menu closes and the editor is focused before the edit')
delete globalThis.document

/* Without that face it copies the reference and says so, instead of vanishing. */
clipboardWrites.length = 0
const clipboardItem = menuEntry.component({ tab: fileTab, dismiss() {} })
assert.notEqual(clipboardItem, null, 'a file tab references itself even without inputActions')
clipboardItem.props.onClick({ preventDefault() {}, stopPropagation() {} })
await nextTick()
assert.deepEqual(clipboardWrites, ['@coupon/coupon-exact.png '])

/* A browser tab without a supplied session uses the sidebar's on-screen session. */
sidebarRightState.mounted = 'session-b'
const browserItem = menuEntry.component({ tab: { id: 'tabB', kind: 'browser' }, dismiss() {} })
browserItem.props.onClick({ preventDefault() {}, stopPropagation() {} })
await nextTick()
assert.deepEqual(clipboardWrites.at(-1), 'http://localhost:9000/#/\n')
sidebarRightState.mounted = 'session-a'

/* ------------------------------------------------------------------ */
/* 12. Sidebar scope preference                                        */
/* ------------------------------------------------------------------ */

const live = window.__DSH_SIDEBAR_SHARE__
assert.equal(live.scope(), 'workspace', 'workspace sharing is the default')

const canonicalBefore = localStorage.getItem('dsh.sidebar-share.v2.workspace-3')
await configForm.set('scope', 'session')
assert.equal(live.scope(), 'session')

const sessionNode = scopeEntry.component({ view: 'page' })
const sessionOptions = sessionNode.children.find((child) => child && child.props && child.props.role === 'radiogroup')
assert.equal(sessionOptions.children.flat()[1].props['aria-checked'], 'true', 'the switch reflects the stored scope')
assert.equal(sessionOptions.children.flat()[0].props['aria-checked'], 'false')

const widened = structuredClone(layoutOf(layoutI, 'session-i'))
widened.layout.tabs.tab99 = {
  id: 'tab99',
  kind: 'text',
  contentId: 'dsh-resource://file/session/session-i/docs/scope.md',
  title: 'scope.md',
}
widened.layout.nodes.pane1.tabs = [...widened.layout.nodes.pane1.tabs, 'tab99']
layoutI.store.set({ bySession: { 'session-i': widened } })
await settle()
assert.equal(
  localStorage.getItem('dsh.sidebar-share.v2.workspace-3'),
  canonicalBefore,
  'session scope must not write the workspace canonical',
)

await configForm.set('scope', 'workspace')
assert.equal(live.scope(), 'workspace')
await settle()
assert.deepEqual(
  Object.keys(layoutOf(layoutI, 'session-i').layout.tabs),
  ['tab2'],
  'switching back to workspace sharing re-seeds from the canonical',
)

/* ------------------------------------------------------------------ */
/* 13. Cleanup                                                         */
/* ------------------------------------------------------------------ */

for (const dispose of disposers) dispose()
assert.equal(slots.resolveStore, originalResolveStore, 'cleanup must restore resolveStore')
assert.equal(window.__DSH_SIDEBAR_SHARE_APPLIED__, undefined)
assert.equal(window.__DSH_SIDEBAR_SHARE__, undefined)

console.log('sidebar-share harness: ok')
