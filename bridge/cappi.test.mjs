// bridge/cappi.test.mjs — offline tests for the Cappi command validation.
//
// Run: node --test bridge/   (no network, no credentials, no listening sockets)

import test from 'node:test'
import assert from 'node:assert/strict'
import { CAPPI_ALLOWLIST, parseCappiCommand } from './cappi.mjs'

test('every allowlisted action validates', () => {
  assert.equal(CAPPI_ALLOWLIST.length, 18)
  for (const id of CAPPI_ALLOWLIST) {
    assert.deepEqual(parseCappiCommand({ action: id }), { ok: true, action: id })
  }
})

test('static_hold is not model-selectable', () => {
  const r = parseCappiCommand({ action: 'static_hold' })
  assert.equal(r.ok, false)
  assert.match(r.error, /unknown action/)
})

test('clear and null clear the action', () => {
  assert.deepEqual(parseCappiCommand({ action: 'clear' }), { ok: true, action: null })
  assert.deepEqual(parseCappiCommand({ action: null }), { ok: true, action: null })
})

test('malformed bodies rejected', () => {
  assert.equal(parseCappiCommand(null).ok, false)
  assert.equal(parseCappiCommand([1]).ok, false)
  assert.equal(parseCappiCommand('work').ok, false)
  assert.equal(parseCappiCommand({}).ok, false)
  assert.equal(parseCappiCommand({ action: '' }).ok, false)
  assert.equal(parseCappiCommand({ action: 42 }).ok, false)
  assert.equal(parseCappiCommand({ action: 'fly' }).ok, false)
})
