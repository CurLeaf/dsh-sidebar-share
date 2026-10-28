/**
 * Host half of `dsh-sidebar-share`.
 *
 * All mirroring lives in the browser half (`dist/client.js`). This entry only
 * declares the user-facing configuration and lets the Host settings document
 * serve it, so the 插件 page can edit the sidebar scope and the browser half can
 * follow it live.
 *
 * `scope`:
 *   - `workspace` (default): every session of a workspace shares one sidebar.
 *   - `session`: each session keeps its own sidebar — DSH's official default.
 */

import z from '@deepseek-ai/schemastery'

export const name = 'sidebar-share'

/** Persisted, editable preference served through the Host settings document. */
export const Config = z.object({
	// NOTE: no `.volatile()` here. Volatile fields resolve to a reference object
	// read with `.get()`; the browser half compares `snapshot.value.scope` to a
	// plain string, so a volatile `scope` never equals 'session' and the setting
	// silently stays on 'workspace'. Official DSH settings plugins read plain
	// values the same way (`snapshot.value?.key`).
	scope: z.union(['workspace', 'session']).default('workspace'),
})

/**
 * Publish the namespace so `ctx.configForms.get('sidebar-share')` answers in the
 * browser. `auto: false` keeps the Host from rendering a generic form: this
 * plugin contributes its own row to the 插件 page instead.
 * @param ctx Host plugin context.
 */
export function apply(ctx) {
	ctx.inject(['settings'], (child) => {
		child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
	})
}
