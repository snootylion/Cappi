// bridge/websocket-compat.test.mjs — available compatibility for the DSH
// WS-mux auth path, measured against the REAL global WebSocket on this
// runtime: a raw loopback TCP server captures the Upgrade request so the
// test proves whether the Cookie header is actually sent.
//
// Run: node --test bridge/   (127.0.0.1 ephemeral port only)

import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'

/** Capture one HTTP Upgrade request produced by the global WebSocket. */
function captureUpgrade (decorate) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((sock) => {
      let buf = ''
      sock.on('data', (d) => {
        buf += d.toString('latin1')
        const end = buf.indexOf('\r\n\r\n')
        if (end >= 0) {
          const head = buf.slice(0, end)
          sock.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
          server.close()
          resolve(head)
        }
      })
      sock.on('error', () => {})
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      let ws
      try {
        ws = decorate(port)
      } catch (e) {
        server.close()
        reject(e)
        return
      }
      ws.onerror = () => {}
      setTimeout(() => { try { ws.close() } catch {} }, 1500)
    })
    setTimeout(() => { server.close(); reject(new Error('no upgrade received')) }, 5000).unref?.()
  })
}

test('global WebSocket exists (Node 26 runtime gate)', () => {
  const major = Number(process.versions.node.split('.')[0])
  assert.ok(Number.isSafeInteger(major) && major >= 26,
    `unsupported runtime Node ${process.versions.node} — Node 26+ is required (handshake-with-headers verified only on Node 26)`)
  assert.equal(typeof WebSocket, 'function', 'global WebSocket missing — Node 26+ required for the mux path')
})

test('WS handshake carries the Cookie auth header (dsh.mjs mux contract)', async () => {
  // Mirrors dsh.mjs: new WebSocket(WS_URL, { headers: { Cookie } }).
  const head = await captureUpgrade(
    (port) => new WebSocket(`ws://127.0.0.1:${port}/api/remote.mux`, {
      headers: { Cookie: 'dsh-auth-probe=synthetic' },
    }),
  )
  assert.match(head, /^GET \/api\/remote\.mux HTTP\/1\.1/m)
  assert.match(head, /^cookie: dsh-auth-probe=synthetic$/im,
    'Cookie header missing from WS upgrade — the mux auth path is unsupported on this runtime')
})
