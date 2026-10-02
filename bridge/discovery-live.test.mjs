// bridge/discovery-live.test.mjs — live UDP discovery bounds on ephemeral
// loopback ports: valid probe answered, oversize/foreign/garbled silent,
// cancellation supported by callers.
//
// Run: node --test bridge/   (127.0.0.1 only, ephemeral ports)

import test from 'node:test'
import assert from 'node:assert/strict'
import dgram from 'node:dgram'
import { startDiscovery, parseDiscoveryReply } from './discovery.mjs'

function responderPort (sock) {
  return new Promise((resolve) => {
    try {
      const bound = sock.address()
      if (bound && typeof bound.port === 'number' && bound.port !== 0) { resolve(bound.port); return }
    } catch {}
    sock.once('listening', () => resolve(sock.address().port))
  })
}

function sendProbe (port, text, raw = null) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4')
    const payload = raw ?? Buffer.from(text, 'utf8')
    const timer = setTimeout(() => { sock.close(); resolve(null) }, 700)
    sock.on('message', (msg) => {
      clearTimeout(timer)
      sock.close()
      resolve(msg.toString('utf8'))
    })
    sock.on('error', (e) => { clearTimeout(timer); sock.close(); reject(e) })
    sock.send(payload, port, '127.0.0.1', (e) => { if (e) { clearTimeout(timer); sock.close(); reject(e) } })
  })
}

test('live discovery: probe answered on ephemeral port; bounds hold', async () => {
  const responder = startDiscovery({ port: 0, servicePort: 18787, log: () => {} })
  try {
    const port = await responderPort(responder)
    const nonce = 'live-nonce-1'
    const reply = await sendProbe(port, `DSHW1DISCOVER ${nonce}`)
    assert.equal(reply, `DSHW1BRIDGE ${nonce} 18787`)
    assert.deepEqual(parseDiscoveryReply(reply, nonce), { nonce, port: 18787 })

    // Foreign nonce reply rejected by the parser (relay of another scan).
    assert.equal(parseDiscoveryReply(reply, 'different-nonce'), null)
    // Garbage gets no answer.
    assert.equal(await sendProbe(port, 'HELLO BRIDGE'), null)
    // Oversize packet (>512 B) is dropped silently.
    assert.equal(await sendProbe(port, `DSHW1DISCOVER ${'n'.repeat(600)}`), null)
    // Bad nonce shape gets no answer.
    assert.equal(await sendProbe(port, 'DSHW1DISCOVER has spaces!'), null)
  } finally {
    responder.close()
  }
})

test('collision picks next known port and exhaustion reports actionable health', async () => {
  const owner = dgram.createSocket('udp4')
  await new Promise(r => owner.bind(0, '127.0.0.1', r))
  const occupied = owner.address().port
  const probe = dgram.createSocket('udp4')
  await new Promise(r => probe.bind(0, '127.0.0.1', r))
  const available = probe.address().port
  await new Promise(r => probe.close(r))
  const responder = startDiscovery({ ports: [occupied, available], servicePort: 18787, host: '127.0.0.1' })
  try {
    assert.equal(await responderPort(responder), available)
    assert.deepEqual(responder.discoveryStatus, { state: 'ready', port: available })
    assert.match(await sendProbe(available, 'DSHW1DISCOVER next'), /DSHW1BRIDGE next/)
    const failed = startDiscovery({ port: occupied, servicePort: 18787, host: '127.0.0.1' })
    await new Promise(r => failed.once('close', r))
    assert.equal(failed.discoveryStatus.state, 'failed')
    assert.match(failed.discoveryStatus.action, /BRIDGE_DISCOVERY_PORT/)
  } finally { responder.close(); owner.close() }
})

test('live discovery: invalid ports rejected at startup', () => {
  assert.throws(() => startDiscovery({ port: -1, servicePort: 8787 }), /invalid discovery port/)
  assert.throws(() => startDiscovery({ port: 70000, servicePort: 8787 }), /invalid discovery port/)
})
