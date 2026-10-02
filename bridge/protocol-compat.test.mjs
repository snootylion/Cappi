// bridge/protocol-compat.test.mjs — transport contract regressions:
// the SSE route is /watch/stream (never /watch/events), the route table
// matches protocol/transport-endpoints.md, fixtures match their shapes, and
// the frozen legacy cappi vocabulary is intact (authority: the canonical
// character registry).
//
// Run: node --test bridge/   (offline; no sockets, no credentials)

import test from 'node:test'
import assert from 'node:assert/strict'

import { WATCH_ROUTES } from './bridge.mjs'
import { CAPPI_ALLOWLIST, parseCappiCommand } from './cappi.mjs'
import { PROTOCOL_FEATURES, PROTOCOL_VERSION, checkProtocolCompat } from './protocol.mjs'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dir = dirname(fileURLToPath(import.meta.url))
const fixture = (name) => JSON.parse(readFileSync(join(__dir, '..', 'protocol', 'fixtures', name), 'utf8'))
const health = fixture('health.json')
const cappiCommand = fixture('cappi-command.json')
const cappiResponse = fixture('cappi-response.json')
const characterSelect = fixture('character-select.json')
const capabilities = fixture('capabilities.json')
const transportDoc = readFileSync(join(__dir, '..', 'protocol', 'transport-endpoints.md'), 'utf8')

test('route table: /watch/stream exists, /watch/events never did', () => {
  assert.ok(WATCH_ROUTES.includes('GET /watch/stream'))
  assert.ok(!WATCH_ROUTES.some(r => r.includes('/watch/events')),
    'regression: the erroneous /watch/events path must not appear')
  for (const required of [
    'GET /watch/health', 'GET /watch/state', 'GET /watch/capabilities',
    'GET /watch/image',
    'POST /watch/mic', 'POST /watch/command', 'POST /watch/cappi',
  ]) {
    assert.ok(WATCH_ROUTES.includes(required), `missing route ${required}`)
  }
  assert.equal(WATCH_ROUTES.length, 9)
})

test('route table matches protocol/transport-endpoints.md (source parity)', () => {
  for (const route of WATCH_ROUTES) {
    const [method, rawPath] = route.split(' ')
    const path = rawPath.split('?')[0]
    assert.ok(transportDoc.includes(method) && transportDoc.includes(`\`${path}`),
      `route ${route} missing from transport-endpoints.md`)
  }
  for (const documented of ['/watch/capabilities', '/watch/cappi', 'character-select']) {
    assert.ok(transportDoc.includes(documented), `contract item ${documented} missing from transport-endpoints.md`)
  }
})

test('health fixture matches the unauthenticated liveness shape', () => {
  assert.equal(health.ok, true)
  assert.ok(typeof health.dsh === 'string')
  assert.ok(typeof health.voice === 'string')
  assert.ok(Number.isSafeInteger(health.queue))
  assert.ok(Number.isSafeInteger(health.pending))
})

test('cappi contract frozen: 18 legacy ids, clear semantics, unknown rejected', () => {
  assert.equal(CAPPI_ALLOWLIST.length, 18)
  assert.ok(!CAPPI_ALLOWLIST.includes('static_hold'))
  assert.deepEqual(parseCappiCommand({ action: 'clear' }), { ok: true, action: null })
  assert.deepEqual(parseCappiCommand({ action: 'dance' }), { ok: true, action: 'dance' })
  assert.equal(parseCappiCommand({ action: 'fly' }).ok, false)
})

test('session-bound cappi fixtures carry the caller session id', () => {
  assert.equal(typeof cappiCommand.action, 'string')
  assert.equal(typeof cappiCommand.sessionId, 'string')
  assert.equal(cappiResponse.ok, true)
  assert.equal(cappiResponse.action, cappiCommand.action)
  assert.equal(typeof cappiResponse.characterId, 'string')
})

test('character-select + capabilities fixtures match the 0.2.0 contract', () => {
  assert.equal(characterSelect.cmd, 'character-select')
  assert.equal(typeof characterSelect.characterId, 'string')
  assert.equal(capabilities.ok, true)
  assert.equal(capabilities.version, PROTOCOL_VERSION)
  assert.deepEqual([...capabilities.features].sort(), [...PROTOCOL_FEATURES].sort())
  assert.ok(Array.isArray(capabilities.characters) && capabilities.characters.length > 0)
  assert.ok(Array.isArray(capabilities.modelSelectable) && capabilities.modelSelectable.length > 0)
  assert.ok(capabilities.modelSelectable.includes(cappiCommand.action),
    'cappi fixture action must be callable in the capabilities fixture pack')
})

test('protocol compatibility errors are explicit', () => {
  assert.equal(checkProtocolCompat(PROTOCOL_VERSION), null)
  assert.equal(checkProtocolCompat('0.1.0'), null)
  assert.ok(typeof checkProtocolCompat('0.0.1') === 'string')
  assert.ok(typeof checkProtocolCompat('9.9.9') === 'string')
  assert.ok(typeof checkProtocolCompat('bogus') === 'string')
  assert.ok(typeof checkProtocolCompat('') === 'string')
})
