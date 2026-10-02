// bridge/cappi-registry.mjs — allowlist resolution toward the character registry.
//
// Contributor B owns the registry DATA (characters/, protocol/
// character-pack.schema.json). This module only resolves a model-selectable
// action allowlist from an injected registry object, falling back to the
// frozen CAPPI_ALLOWLIST when no registry is available. No file I/O here,
// no import of B-owned data — the caller supplies the parsed registry.
//
// Accepted shapes (first match wins):
//   - canonical v2 file form: { default, characters: [{ id,
//     model_selectable: [...] }] } (characters/registry.json)
//   - normalized form: { default, characters: { <id>: { modelSelectable } } }
//     (bridge/characters.mjs parseCharacterRegistry output)
//   - legacy forms: { actions: [{ id, modelSelectable }] } (modelSelectable
//     !== false counts) or a plain string array.
// Anything else → frozen fallback (backward compatibility, never throws).

import { CAPPI_ALLOWLIST, parseCappiCommand } from './cappi.mjs'

export function resolveCappiAllowlist (registry) {
  return resolveCappiAllowlistFor(registry)
}

/**
 * Resolve the allowlist for one character pack (or the registry default when
 * characterId is blank/unknown). Legacy shapes ignore characterId and behave
 * exactly like resolveCappiAllowlist.
 */
export function resolveCappiAllowlistFor (registry, characterId = null) {
  try {
    const v2 = characterAllowlistV2(registry, characterId)
    if (v2) return v2
    if (Array.isArray(registry)) {
      const ids = registry.filter(id => typeof id === 'string' && id.length > 0)
      if (ids.length) return Object.freeze([...ids])
    } else if (registry && Array.isArray(registry.actions)) {
      const ids = registry.actions
        .filter(a => a && typeof a.id === 'string' && a.id.length > 0 && a.modelSelectable !== false)
        .map(a => a.id)
      if (ids.length) return Object.freeze([...ids])
    }
  } catch {
    // fall through to the frozen list
  }
  return CAPPI_ALLOWLIST
}

/** Canonical v2 registry (file or normalized form) → pack allowlist or null. */
function characterAllowlistV2 (registry, characterId) {
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) return null
  const chars = registry.characters
  const pack = Array.isArray(chars)
    ? pickFilePack(chars, typeof registry.default === 'string' ? registry.default : null, characterId)
    : pickNormalizedPack(chars, typeof registry.default === 'string' ? registry.default : null, characterId)
  if (!pack) return null
  const list = pack.model_selectable ?? pack.modelSelectable ?? []
  if (!Array.isArray(list)) return null
  const ids = list.filter(id => typeof id === 'string' && id.length > 0)
  return ids.length ? Object.freeze([...ids]) : null
}

function pickFilePack (chars, fallback, characterId) {
  if (typeof characterId === 'string' && characterId) {
    const hit = chars.find(c => c && c.id === characterId)
    if (hit) return hit
  }
  return chars.find(c => c && c.id === fallback) ?? chars.find(c => c && typeof c.id === 'string') ?? null
}

function pickNormalizedPack (chars, fallback, characterId) {
  if (!chars || typeof chars !== 'object' || Array.isArray(chars)) return null
  if (typeof characterId === 'string' && characterId && chars[characterId]) return chars[characterId]
  if (typeof fallback === 'string' && chars[fallback]) return chars[fallback]
  const first = Object.values(chars).find(c => c && typeof c === 'object')
  return first ?? null
}

/**
 * Validate a parsed JSON body against an explicit allowlist. Returns
 * { ok:true, action } (validated id or null for clear) or { ok:false, error }.
 * Identical semantics to parseCappiCommand; the default list is the frozen one.
 */
export function parseCappiCommandWith (body, allowlist = CAPPI_ALLOWLIST) {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'bad body' }
  }
  if (!Object.hasOwn(body, 'action')) return { ok: false, error: 'missing action' }
  const a = body.action
  if (a === null || a === 'clear') return { ok: true, action: null }
  if (typeof a !== 'string' || a.length === 0) return { ok: false, error: 'bad action' }
  const list = Array.isArray(allowlist) ? allowlist : CAPPI_ALLOWLIST
  if (!list.includes(a)) return { ok: false, error: `unknown action: ${a}` }
  return { ok: true, action: a }
}

export { parseCappiCommand }
