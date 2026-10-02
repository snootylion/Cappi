/**
 * Character action input shaping for the watch plugin.
 *
 * The AUTHORITY for callable actions is the bridge: `GET /watch/capabilities`
 * returns the active pack's `model_selectable` list (derived from the
 * canonical `characters/registry.json`), and `POST /watch/cappi` re-resolves
 * authoritatively. This module never allowlists on its own — `parseCappiInput`
 * checks SHAPE only (a non-empty action string, or `clear`/null), while
 * `resolveActionCapability` (see capabilities.ts) resolves against queried
 * capabilities. Unknown actions and missing capabilities are refused; nothing
 * invents assets or URLs, and nothing forges pending/question state.
 */

export const CAPPI_CLEAR = 'clear'

/**
 * Model-facing vocabulary hint (documentation only, NOT authority): the union
 * of model-selectable ids across the shipped packs plus the accepted legacy
 * aliases. The tool description uses it; the bridge decides. If a future pack
 * adds an id absent here, shape validation still passes it through and the
 * bridge capabilities resolve it.
 */
export const MODEL_ACTION_IDS: readonly string[] = Object.freeze([
  'idle_a', 'idle_b', 'idle_c', 'listen', 'talk', 'talk_a', 'talk_b', 'work_set', 'celebrate',
  'idle1_a', 'idle1_b', 'idle1_c', 'idle1_d',
  'idle2_a', 'idle2_b', 'idle2_c', 'idle2_d', 'idle2_e',
  'breath', 'breath2', 'relaxed',
  'talk2', 'talk3', 'talk_gesture',
  'work',
  'dance', 'shadow',
])

/**
 * Deprecated manual allowlist. Kept as a re-export of the documentation hint
 * so existing imports keep compiling; it is NOT consulted by the handler.
 * @deprecated Query the bridge capabilities instead (see capabilities.ts).
 */
export const CAPPI_ALLOWLIST: readonly string[] = MODEL_ACTION_IDS

export type ParsedCappiInput =
  | { readonly ok: true; readonly action: string | null }
  | { readonly ok: false; readonly error: string }

/**
 * Validate tool-argument SHAPE only: `{ ok: true, action }` with `action` a
 * non-empty string (resolved later against bridge capabilities) or null
 * (clear), or `{ ok: false, error }`. Capability/authority checks happen in
 * capabilities.ts against queried bridge state — never here.
 */
export function parseCappiInput(body: unknown): ParsedCappiInput {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'bad body' }
  }
  if (!Object.hasOwn(body, 'action')) return { ok: false, error: 'missing action' }
  const action = (body as Record<string, unknown>).action
  if (action === null || action === CAPPI_CLEAR) return { ok: true, action: null }
  if (typeof action !== 'string' || action.length === 0) return { ok: false, error: 'bad action' }
  return { ok: true, action }
}

/** One manifest-declared action and its model visibility. */
export interface ManifestActionEntry {
  readonly modelSelectable?: boolean | undefined
  readonly capability?: string | undefined
}

/**
 * Minimal character-manifest shape the plugin understands. It accepts both
 * the bridge manifest form (`{ actions: { <id>: { model_selectable } } }`,
 * as shipped in `watch-app/.../assets/cappi/cappi-manifest.json`) and the
 * role-based pack form (`{ roles: { <role>: [<asset>, ...] } }`, as in
 * `characters/example-pack/pack.json`), where a role name that matches an
 * allowlisted action id counts as selectable.
 */
export interface CharacterManifest {
  readonly actions?: Readonly<Record<string, ManifestActionEntry | undefined>>
  readonly roles?: Readonly<Record<string, readonly string[] | undefined>>
}

function readSelectableFlag(entry: unknown): boolean | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined
  const record = entry as Record<string, unknown>
  if (typeof record.modelSelectable === 'boolean') return record.modelSelectable
  if (typeof record.model_selectable === 'boolean') return record.model_selectable
  return undefined
}

/**
 * Parse and structurally validate untrusted manifest file content. Returns
 * the manifest, or an error string when the content is not a usable manifest.
 * Unknown extra keys are ignored; malformed entries fail closed.
 */
export function parseCharacterManifest(value: unknown): { ok: true; manifest: CharacterManifest } | { ok: false; error: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: 'manifest must be a JSON object' }
  }
  const record = value as Record<string, unknown>
  const manifest: { actions?: Record<string, ManifestActionEntry>; roles?: Record<string, readonly string[]> } = {}
  if (record.actions !== undefined) {
    if (typeof record.actions !== 'object' || record.actions === null || Array.isArray(record.actions)) {
      return { ok: false, error: 'manifest.actions must be an object' }
    }
    const actions: Record<string, ManifestActionEntry> = {}
    for (const [id, entry] of Object.entries(record.actions)) {
      const flag = readSelectableFlag(entry)
      const capability = typeof (entry as Record<string, unknown>)?.capability === 'string'
        ? String((entry as Record<string, unknown>).capability).slice(0, 120)
        : undefined
      actions[id] = capability === undefined ? { modelSelectable: flag } : { modelSelectable: flag, capability }
    }
    manifest.actions = actions
  }
  if (record.roles !== undefined) {
    if (typeof record.roles !== 'object' || record.roles === null || Array.isArray(record.roles)) {
      return { ok: false, error: 'manifest.roles must be an object' }
    }
    const roles: Record<string, readonly string[]> = {}
    for (const [role, assets] of Object.entries(record.roles)) {
      if (!Array.isArray(assets) || !assets.every((asset) => typeof asset === 'string')) {
        return { ok: false, error: `manifest role '${role}' must list asset names` }
      }
      roles[role] = [...assets]
    }
    manifest.roles = roles
  }
  if (manifest.actions === undefined && manifest.roles === undefined) {
    return { ok: false, error: 'manifest declares neither actions nor roles' }
  }
  return { ok: true, manifest }
}

/**
 * Capability check for one already-allowlisted action against an optional
 * manifest. `clear`/null always passes (it carries no capability). Without a
 * manifest every allowlisted action passes. With a manifest, the action must
 * be explicitly `model_selectable` (bridge-manifest form) or a declared role
 * name (role-pack form); anything else fails closed.
 */
export function checkActionCapability(
  action: string | null,
  manifest: CharacterManifest | undefined,
): { ok: true } | { ok: false; error: string } {
  if (action === null) return { ok: true }
  if (manifest === undefined) return { ok: true }
  const entry = manifest.actions?.[action]
  if (entry !== undefined) {
    if (entry.modelSelectable === true) return { ok: true }
    return { ok: false, error: `action '${action}' is not model-selectable in the character manifest` }
  }
  if (manifest.actions !== undefined) {
    return { ok: false, error: `action '${action}' is not declared in the character manifest` }
  }
  if (manifest.roles !== undefined && Object.hasOwn(manifest.roles, action)) {
    return { ok: true }
  }
  return { ok: false, error: `action '${action}' has no capability in the character manifest` }
}
