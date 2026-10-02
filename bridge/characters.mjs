// bridge/characters.mjs — canonical character-registry binding.
//
// Contributor B owns the registry DATA (characters/registry.json, generated
// by CharacterRegistry.toBridgeJson; schema v2). This module binds it: it
// derives the active pack's model-selectable capabilities, resolves the
// selected pack (unknown → default, never throws), and maps the frozen
// legacy /watch/cappi action vocabulary to semantic pack capabilities.
//
// Pure functions + an injectable store: importing this module performs no
// I/O (the caller supplies the parsed registry; persistence is an injected
// callback). No model-owned question/speech: state-owned cues (question,
// static_hold) are never resolvable, even when present in a pack.
//
// Registry shape (subset of characters/registry.json):
//   { default: <id>, characters: [{ id, model_selectable: [ids],
//     roles: { <role>: [ids] } }] }

export const CHARACTER_FILE_NAME = 'character.json'

/** State-owned cues: the scheduler owns them; the model may never request them. */
export const STATE_OWNED_ACTIONS = Object.freeze(['question', 'static_hold'])

export const CAPPI_CLEAR = 'clear'

/**
 * Frozen legacy /watch/cappi vocabulary (bridge/cappi.mjs CAPPI_ALLOWLIST)
 * mapped to semantic pack roles. `null` means no semantic equivalent exists
 * and the id is rejected with a compatibility error naming the pack's
 * callable actions.
 */
export const LEGACY_CAPPI_ROLE = Object.freeze({
  idle1_a: 'idle', idle1_b: 'idle', idle1_c: 'idle', idle1_d: 'idle',
  idle2_a: 'idle', idle2_b: 'idle', idle2_c: 'idle', idle2_d: 'idle', idle2_e: 'idle',
  breath: 'listen', breath2: 'listen', relaxed: 'listen',
  talk2: 'talk', talk3: 'talk', talk_gesture: 'talk',
  work: 'work',
  dance: 'celebrate',
  shadow: 'celebrate',
})

export const LEGACY_CAPPI_IDS = Object.freeze(Object.keys(LEGACY_CAPPI_ROLE))

/**
 * Validate untrusted registry content. Returns { ok:true, registry } with a
 * normalized registry, or { ok:false, error }. Normalized form:
 * { default, characters: Map-free plain object id -> { id, modelSelectable, roles } }.
 */
export function parseCharacterRegistry (value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'character registry must be a JSON object' }
  }
  const chars = value.characters
  if (!Array.isArray(chars) || chars.length === 0) {
    return { ok: false, error: 'character registry declares no characters' }
  }
  const byId = {}
  for (const c of chars) {
    if (!c || typeof c.id !== 'string' || !c.id) return { ok: false, error: 'character entry without id' }
    const selectable = c.model_selectable ?? c.modelSelectable ?? []
    if (!Array.isArray(selectable) || selectable.length === 0 ||
        !selectable.every((id) => typeof id === 'string' && id)) {
      return { ok: false, error: `character '${c.id}' has no model_selectable list` }
    }
    const roles = c.roles ?? {}
    if (roles == null || typeof roles !== 'object' || Array.isArray(roles)) {
      return { ok: false, error: `character '${c.id}' has malformed roles` }
    }
    for (const [role, ids] of Object.entries(roles)) {
      if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) {
        return { ok: false, error: `character '${c.id}' role '${role}' must list action ids` }
      }
    }
    byId[c.id] = {
      id: c.id,
      modelSelectable: Object.freeze([...selectable]),
      roles: Object.freeze({ ...roles }),
    }
  }
  const ids = Object.keys(byId)
  const fallback = typeof value.default === 'string' && byId[value.default] ? value.default : ids.sort()[0]
  return { ok: true, registry: Object.freeze({ default: fallback, characters: Object.freeze(byId) }) }
}

/** Resolve a requested id to a known pack (null/blank/unknown → default). Never throws. */
export function selectCharacterId (registry, requested) {
  try {
    const id = typeof requested === 'string' ? requested.trim() : ''
    if (id && registry?.characters?.[id]) return id
    return registry?.default ?? null
  } catch {
    return registry?.default ?? null
  }
}

export function availableCharacterIds (registry) {
  return Object.keys(registry?.characters ?? {}).sort()
}

/** Model-selectable action ids of one pack (unknown pack → default pack's). */
export function modelSelectableFor (registry, characterId) {
  const id = selectCharacterId(registry, characterId)
  return registry?.characters?.[id]?.modelSelectable ?? []
}

/** First selectable action of a pack serving a semantic role, or null. */
export function firstActionForRole (registry, characterId, role) {
  const id = selectCharacterId(registry, characterId)
  const pack = registry?.characters?.[id]
  if (!pack || typeof role !== 'string' || !role) return null
  const candidates = pack.roles?.[role] ?? []
  const selectable = new Set(pack.modelSelectable ?? [])
  return candidates.find((a) => selectable.has(a)) ?? null
}

/**
 * Resolve one /watch/cappi action against the ACTIVE pack. Returns
 * { ok:true, action } (concrete selectable id or null for clear) or
 * { ok:false, error } with a compatibility-style message. Legacy ids map
 * through LEGACY_CAPPI_ROLE; state-owned cues are always refused.
 */
export function resolveCappiAction (registry, characterId, action) {
  const active = selectCharacterId(registry, characterId)
  if (action === null || action === CAPPI_CLEAR) return { ok: true, action: null, characterId: active }
  if (typeof action !== 'string' || !action) return { ok: false, error: 'bad action' }
  if (STATE_OWNED_ACTIONS.includes(action)) {
    return { ok: false, error: `action '${action}' is state-owned and not model-requestable` }
  }
  const selectable = new Set(modelSelectableFor(registry, active))
  if (selectable.has(action)) return { ok: true, action, characterId: active }
  if (Object.hasOwn(LEGACY_CAPPI_ROLE, action)) {
    const role = LEGACY_CAPPI_ROLE[action]
    if (role === null) {
      return {
        ok: false,
        error: `legacy action '${action}' has no capability in character '${active}'; callable: ${[...selectable].join(', ') || '(none)'}`,
      }
    }
    const mapped = firstActionForRole(registry, active, role)
    if (mapped) return { ok: true, action: mapped, characterId: active, aliased: true }
    return {
      ok: false,
      error: `legacy action '${action}' (${role}) is unavailable in character '${active}'; callable: ${[...selectable].join(', ') || '(none)'}`,
    }
  }
  return {
    ok: false,
    error: `unknown action: ${action} (character '${active}'; callable: ${[...selectable].join(', ') || '(none)'})`,
  }
}

/**
 * In-memory selection with injected persistence. All methods are synchronous;
 * the bridge wires `persist` to the state-dir file and calls it AFTER the
 * in-memory switch (a persist failure never unselects the pack).
 */
export function createCharacterStore ({ registry, initialId = null, persist = null } = {}) {
  if (!registry) throw new Error('character registry is required')
  let current = selectCharacterId(registry, initialId) ?? registry.default
  return {
    get selected () { return current },
    describe () {
      return {
        characterId: current,
        characters: availableCharacterIds(registry),
        modelSelectable: [...modelSelectableFor(registry, current)],
      }
    },
    select (requested) {
      const id = typeof requested === 'string' ? requested.trim() : ''
      if (!id || !registry.characters[id]) {
        return { ok: false, error: `unknown character: ${requested}` }
      }
      current = id
      if (typeof persist === 'function') {
        try { persist(id) } catch { /* persist failure never unselects */ }
      }
      return { ok: true, characterId: id }
    },
  }
}
