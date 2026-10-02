// bridge/cappi.mjs — legacy Cappi action vocabulary for POST /watch/cappi.
//
// FROZEN for backward compatibility: these 18 ids are the pre-character
// contract. The authority is now the canonical character registry
// (characters/registry.json via bridge/characters.mjs): the active pack's
// model_selectable capabilities decide what resolves, and these legacy ids
// map to semantic pack roles (LEGACY_CAPPI_ROLE) where an equivalent exists.
// New integrations must query GET /watch/capabilities
// instead of hardcoding this list. Offline-testable, zero dependencies.

export const CAPPI_CLEAR = 'clear'

export const CAPPI_ALLOWLIST = Object.freeze([
  'idle1_a', 'idle1_b', 'idle1_c', 'idle1_d',
  'idle2_a', 'idle2_b', 'idle2_c', 'idle2_d', 'idle2_e',
  'breath', 'breath2', 'relaxed',
  'talk2', 'talk3', 'talk_gesture',
  'work',
  'dance', 'shadow',
])

/**
 * Validate a parsed JSON body. Returns { ok:true, action } where action is a
 * validated id or null (clear), or { ok:false, error }.
 */
export function parseCappiCommand (body) {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'bad body' }
  }
  if (!Object.hasOwn(body, 'action')) return { ok: false, error: 'missing action' }
  const a = body.action
  if (a === null || a === CAPPI_CLEAR) return { ok: true, action: null }
  if (typeof a !== 'string' || a.length === 0) return { ok: false, error: 'bad action' }
  if (!CAPPI_ALLOWLIST.includes(a)) return { ok: false, error: `unknown action: ${a}` }
  return { ok: true, action: a }
}
