// bridge/characters.test.mjs — canonical registry binding, legacy alias,
// session-binding guard, protocol constants and private state hierarchy.
//
// Run: node --test bridge/   (offline; temp dirs only — the real
// characters/registry.json is read read-only, never written)

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CAPPI_CLEAR,
  createCharacterStore,
  firstActionForRole,
  LEGACY_CAPPI_IDS,
  LEGACY_CAPPI_ROLE,
  modelSelectableFor,
  parseCharacterRegistry,
  resolveCappiAction,
  selectCharacterId,
  STATE_OWNED_ACTIONS,
} from './characters.mjs'
import { checkSessionBinding } from './session-binding.mjs'
import { PROTOCOL_FEATURES, PROTOCOL_VERSION, checkProtocolCompat, protocolHello } from './protocol.mjs'
import { resolveCappiAllowlist, resolveCappiAllowlistFor } from './cappi-registry.mjs'
import { CAPPI_ALLOWLIST } from './cappi.mjs'
import { ensurePrivateDir, loadOrCreateToken } from './storage.mjs'

const REGISTRY_RAW = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'characters', 'registry.json'), 'utf8'))

function registry () {
  const parsed = parseCharacterRegistry(REGISTRY_RAW)
  assert.equal(parsed.ok, true)
  return parsed.registry
}

test('canonical registry parses: default + per-pack capabilities', () => {
  const reg = registry()
  assert.equal(reg.default, 'cappi-original')
  assert.deepEqual(modelSelectableFor(reg, 'cappi-original'),
    ['idle1_a', 'idle1_b', 'idle1_c', 'idle1_d', 'idle2_a', 'idle2_b', 'idle2_c', 'idle2_d', 'idle2_e',
      'breath', 'breath2', 'relaxed', 'talk2', 'talk3', 'talk_gesture', 'dance', 'shadow', 'work'])
  assert.deepEqual(modelSelectableFor(reg, 'dot-default'),
    ['idle_a', 'idle_b', 'idle_c', 'listen', 'talk_a', 'talk_b', 'work_set', 'celebrate'])
  assert.deepEqual(modelSelectableFor(reg, 'ember-min'),
    ['idle_a', 'idle_b', 'idle_c', 'listen', 'talk', 'work_set'])
  // Blank/unknown selection resolves through the registry default.
  assert.deepEqual(modelSelectableFor(reg, null),
    modelSelectableFor(reg, 'cappi-original'))
})

test('selection never throws: unknown/blank → default', () => {
  const reg = registry()
  assert.equal(selectCharacterId(reg, 'ember-min'), 'ember-min')
  assert.equal(selectCharacterId(reg, 'dot-default'), 'dot-default')
  assert.equal(selectCharacterId(reg, 'cappi-original'), 'cappi-original')
  for (const bad of [null, undefined, '', '   ', 'no-such-pack', 'cappi-legacy-local']) {
    assert.equal(selectCharacterId(reg, bad), 'cappi-original')
  }
})

test('question/speech are state-owned, never model-resolvable', () => {
  const reg = registry()
  assert.ok(STATE_OWNED_ACTIONS.includes('question'))
  assert.ok(STATE_OWNED_ACTIONS.includes('static_hold'))
  for (const id of STATE_OWNED_ACTIONS) {
    const out = resolveCappiAction(reg, 'dot-default', id)
    assert.equal(out.ok, false)
    assert.match(out.error, /state-owned/)
  }
  // Default pack (cappi-original): state-owned cues fail closed even though
  // the roles exist in the pack — question/static_hold are refused as
  // state-owned, work_talk (not model-selectable) as unknown.
  for (const id of ['question', 'static_hold']) {
    const out = resolveCappiAction(reg, 'cappi-original', id)
    assert.equal(out.ok, false)
    assert.match(out.error, /state-owned/)
  }
  assert.equal(resolveCappiAction(reg, 'cappi-original', 'work_talk').ok, false)
  assert.equal(resolveCappiAction(reg, 'cappi-original', 'question').ok, false)
})

test('direct hits resolve; clear maps to null', () => {
  const reg = registry()
  assert.deepEqual(resolveCappiAction(reg, 'dot-default', 'talk_a'), { ok: true, action: 'talk_a', characterId: 'dot-default' })
  assert.deepEqual(resolveCappiAction(reg, 'ember-min', 'talk'), { ok: true, action: 'talk', characterId: 'ember-min' })
  assert.deepEqual(resolveCappiAction(reg, 'dot-default', 'clear'), { ok: true, action: null, characterId: 'dot-default' })
  assert.deepEqual(resolveCappiAction(reg, 'dot-default', null), { ok: true, action: null, characterId: 'dot-default' })
  assert.equal(CAPPI_CLEAR, 'clear')
})

test('legacy alias maps to the active pack role target', () => {
  const reg = registry()
  assert.deepEqual(Object.keys(LEGACY_CAPPI_ROLE).sort(), [...CAPPI_ALLOWLIST].sort())
  assert.equal(LEGACY_CAPPI_IDS.length, 18)
  // cappi-original (default): original ids resolve exactly.
  assert.deepEqual(resolveCappiAction(reg, 'cappi-original', 'dance'),
    { ok: true, action: 'dance', characterId: 'cappi-original' })
  assert.deepEqual(resolveCappiAction(reg, 'cappi-original', 'shadow'),
    { ok: true, action: 'shadow', characterId: 'cappi-original' })
  assert.deepEqual(resolveCappiAction(reg, 'cappi-original', 'breath'),
    { ok: true, action: 'breath', characterId: 'cappi-original' })
  // dot-default: legacy → semantic role target (schema-driven, not hardcoded).
  assert.equal(resolveCappiAction(reg, 'dot-default', 'dance').action, 'celebrate')
  assert.equal(resolveCappiAction(reg, 'dot-default', 'shadow').action, 'celebrate')
  assert.equal(resolveCappiAction(reg, 'dot-default', 'work').action, 'work_set')
  assert.equal(resolveCappiAction(reg, 'dot-default', 'talk2').action, 'talk_a')
  assert.equal(resolveCappiAction(reg, 'dot-default', 'breath').action, 'listen')
  // ember-min has no celebrate: dance/shadow fail closed with the callable list.
  const refused = resolveCappiAction(reg, 'ember-min', 'dance')
  assert.equal(refused.ok, false)
  assert.match(refused.error, /callable: idle_a, idle_b, idle_c, listen, talk, work_set/)
  assert.equal(resolveCappiAction(reg, 'ember-min', 'shadow').ok, false)
  // unknown ids name the character + callable list (compatibility error).
  const unknown = resolveCappiAction(reg, 'dot-default', 'fly')
  assert.equal(unknown.ok, false)
  assert.match(unknown.error, /unknown action: fly/)
  assert.match(unknown.error, /dot-default/)
})

test('role fallback resolves the first selectable member', () => {
  const reg = registry()
  assert.equal(firstActionForRole(reg, 'dot-default', 'talk'), 'talk_a')
  assert.equal(firstActionForRole(reg, 'ember-min', 'talk'), 'talk')
  assert.equal(firstActionForRole(reg, 'ember-min', 'celebrate'), null)
})

test('character store selects, persists and recovers', () => {
  const reg = registry()
  const persisted = []
  const store = createCharacterStore({ registry: reg, persist: (id) => persisted.push(id) })
  assert.equal(store.selected, 'cappi-original')
  assert.deepEqual(store.select('ember-min'), { ok: true, characterId: 'ember-min' })
  assert.deepEqual(persisted, ['ember-min'])
  assert.deepEqual(store.describe().modelSelectable,
    ['idle_a', 'idle_b', 'idle_c', 'listen', 'talk', 'work_set'])
  assert.equal(store.select('no-such-pack').ok, false)
  assert.equal(store.selected, 'ember-min') // failed select changes nothing
  const recovered = createCharacterStore({ registry: reg, initialId: 'ember-min' })
  assert.equal(recovered.selected, 'ember-min')
  const stale = createCharacterStore({ registry: reg, initialId: 'deleted-pack' })
  assert.equal(stale.selected, 'cappi-original')
})

test('session binding: exact match only, no falsy shortcuts', () => {
  assert.deepEqual(checkSessionBinding({ claimed: 'a', watched: 'a' }), { ok: true })
  assert.equal(checkSessionBinding({ claimed: 'b', watched: 'a' }).status, 409)
  assert.equal(checkSessionBinding({ claimed: '', watched: 'a' }).status, 400)
  assert.equal(checkSessionBinding({ claimed: undefined, watched: 'a' }).status, 400)
  assert.equal(checkSessionBinding({ claimed: 'a', watched: null }).status, 409)
  assert.equal(checkSessionBinding({ claimed: ' A', watched: 'A' }).status, 409) // verbatim, no trim
})

test('protocol version/features and compat errors', () => {
  assert.equal(PROTOCOL_VERSION, '0.2.0')
  assert.ok(PROTOCOL_FEATURES.includes('session-binding'))
  assert.ok(PROTOCOL_FEATURES.includes('character-select'))
  assert.deepEqual(protocolHello(), { version: '0.2.0', features: [...PROTOCOL_FEATURES] })
  assert.equal(checkProtocolCompat('0.2.0'), null)
  assert.equal(checkProtocolCompat('0.1.0'), null)
  assert.ok(checkProtocolCompat('0.0.9'))
  assert.ok(checkProtocolCompat('1.0.0'))
})

test('cappi-registry resolves the canonical v2 shapes per pack', () => {
  assert.deepEqual(resolveCappiAllowlistFor(REGISTRY_RAW, 'ember-min'),
    ['idle_a', 'idle_b', 'idle_c', 'listen', 'talk', 'work_set'])
  assert.deepEqual(resolveCappiAllowlistFor(REGISTRY_RAW),
    ['idle1_a', 'idle1_b', 'idle1_c', 'idle1_d', 'idle2_a', 'idle2_b', 'idle2_c', 'idle2_d', 'idle2_e',
      'breath', 'breath2', 'relaxed', 'talk2', 'talk3', 'talk_gesture', 'dance', 'shadow', 'work'])
  const reg = registry()
  assert.deepEqual(resolveCappiAllowlistFor(reg, 'ember-min'),
    ['idle_a', 'idle_b', 'idle_c', 'listen', 'talk', 'work_set'])
  // legacy shapes keep working; garbage keeps the frozen fallback.
  assert.deepEqual(resolveCappiAllowlist(['a', 'b']), ['a', 'b'])
  assert.deepEqual(resolveCappiAllowlist({ actions: [{ id: 'x', modelSelectable: true }] }), ['x'])
  assert.equal(resolveCappiAllowlist({ nope: 1 }), CAPPI_ALLOWLIST)
})

test('malformed registries fail closed', () => {
  for (const bad of [null, [], {}, { characters: [] }, { characters: [{ id: '' }] },
    { characters: [{ id: 'x' }] }, { characters: [{ id: 'x', model_selectable: 'yes' }] }]) {
    assert.equal(parseCharacterRegistry(bad).ok, false)
  }
})

test('stored state hardens the private directory, not just the file', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-bridge-state-'))
  try {
    const token = loadOrCreateToken({ stateDir: root })
    assert.ok(token)
    assert.equal(statSync(root).mode & 0o777, 0o700)
    assert.equal(statSync(join(root, 'token')).mode & 0o777, 0o600)
    assert.equal(loadOrCreateToken({ stateDir: root }), token) // stable across loads
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ensurePrivateDir tightens pre-existing directories', async () => {
  const { chmodSync } = await import('node:fs')
  const root = mkdtempSync(join(tmpdir(), 'dsh-bridge-priv-'))
  try {
    chmodSync(root, 0o755)
    ensurePrivateDir(root)
    assert.equal(statSync(root).mode & 0o777, 0o700)
    writeFileSync(join(root, 'token'), 'synthetic\n', { mode: 0o644 })
    loadOrCreateToken({ stateDir: root })
    assert.equal(statSync(join(root, 'token')).mode & 0o777, 0o600)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
