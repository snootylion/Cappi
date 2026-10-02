// bridge/tls-pin.test.mjs — pinned HTTPS: correct/wrong pin, no redirects,
// no downgrade, fail-closed without credentials, setup-cert.sh round-trip.
//
// Run: node --test bridge/   (ephemeral loopback ports + temp dirs only;
// ephemeral TEST certificates via openssl, removed afterwards)

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import https from 'node:https'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

import { certSha256Pin, pinOk, loadTlsCredentials, createBridgeServer } from './tls.mjs'

const __dir = dirname(fileURLToPath(import.meta.url))

function tempDir () {
  return mkdtempSync(join(tmpdir(), 'dsh-tls-test-'))
}

/** Scrubbed env for nested subprocesses: ambient DSH_/BRIDGE_ vars from the
 *  operator shell must never redirect a fixture (explicit values win). */
function scrubbedEnv (extra = {}) {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (!Object.hasOwn(extra, key) && /^(DSH_|BRIDGE_|WATCH_)/.test(key)) delete env[key]
  }
  return { ...env, ...extra }
}

/** Generate an ephemeral self-signed TEST cert in dir via openssl. */
function makeTestCert (dir, cn = 'test-bridge') {
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '2', '-nodes',
    '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'),
    '-subj', `/CN=${cn}`,
  ], { stdio: 'pipe', env: scrubbedEnv() })
  return { certFile: join(dir, 'cert.pem'), keyFile: join(dir, 'key.pem') }
}

function listen (server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

function close (server) {
  return new Promise((resolve) => {
    // Tests must not wait on HTTP/1.1 keep-alive sockets.
    try { server.closeAllConnections() } catch {}
    server.close(() => resolve())
  })
}

test('pin helpers: stable fingerprint, constant-time compare', () => {
  const dir = tempDir()
  try {
    const { certFile } = makeTestCert(dir)
    const pem = readFileSync(certFile, 'utf8')
    const a = certSha256Pin(pem)
    const b = certSha256Pin(pem + '\n')
    assert.equal(a, b)
    assert.equal(Buffer.from(a, 'base64').length, 32)
    assert.equal(pinOk(a, a), true)
    const otherDir = mkdtempSync(join(tmpdir(), 'dsh-tls2-'))
    try {
      const otherCert = makeTestCert(otherDir)
      const c = certSha256Pin(readFileSync(otherCert.certFile, 'utf8'))
      assert.equal(pinOk(a, c), false)
    } finally {
      rmSync(otherDir, { recursive: true, force: true })
    }
    assert.equal(pinOk(a, ''), false)
    assert.equal(pinOk('', a), false)
    assert.equal(pinOk('!!!', a), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('setup-cert.sh round-trip: 0600 key/cert, fingerprint matches tls.mjs', () => {
  const dir = tempDir()
  try {
    const env = scrubbedEnv({ BRIDGE_STATE_DIR: dir })
    execFileSync(join(__dir, 'setup-cert.sh'), [], { env, stdio: 'pipe' })
    const cert = join(dir, 'bridge-cert.pem')
    const key = join(dir, 'bridge-key.pem')
    assert.equal(statSync(cert).mode & 0o777, 0o600)
    assert.equal(statSync(key).mode & 0o777, 0o600)
    const printed = execFileSync(join(__dir, 'setup-cert.sh'), ['--fingerprint'], { env, encoding: 'utf8' }).trim()
    const computed = certSha256Pin(readFileSync(cert, 'utf8'))
    assert.equal(printed, computed)
    const creds = loadTlsCredentials({ certFile: cert, keyFile: key })
    assert.equal(creds.fingerprint, computed)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('https server: correct pin connects, wrong pin rejected, no redirects', async () => {
  const dir = tempDir()
  let server = null
  try {
    const { certFile, keyFile } = makeTestCert(dir)
    const tls = loadTlsCredentials({ certFile, keyFile })
    server = createBridgeServer({
      tls,
      handler: (req, res) => {
        if (req.url === '/watch/health') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('{"ok":true}')
          return
        }
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end('{"ok":false}')
      },
    })
    const port = await listen(server)
    // Correct pin: TLS handshake with the expected fingerprint succeeds.
    const body = await new Promise((resolve, reject) => {
      https.get({
        host: '127.0.0.1', port, path: '/watch/health', rejectUnauthorized: false,
      }, (res) => {
        // Capture the peer certificate synchronously: res.socket detaches
        // once the response ends.
        let cert = null
        try { cert = res.socket.getPeerCertificate() } catch (e) { reject(e); return }
        assert.equal(res.headers.location, undefined) // bridge never redirects
        let b = ''
        res.on('data', (d) => { b += d })
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: b, cert })
          } catch (e) { reject(e) }
        })
        res.on('error', reject)
      }).on('error', reject)
    })
    assert.equal(body.status, 200)
    assert.equal(body.body, '{"ok":true}')
    const presentedDer = body.cert.raw
    const { createHash } = await import('node:crypto')
    const presentedPin = createHash('sha256').update(presentedDer).digest('base64')
    assert.equal(pinOk(presentedPin, tls.fingerprint), true)
    // Wrong pin: rejected before anything would be sent.
    const wrong = tls.fingerprint.slice(0, -2) + (tls.fingerprint.endsWith('AA') ? 'BB' : 'AA')
    assert.equal(pinOk(presentedPin, wrong), false)
  } finally {
    if (server) await close(server)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('no downgrade: cleartext client against https fails; fail-closed without cert', async () => {
  const dir = tempDir()
  let server = null
  try {
    const { certFile, keyFile } = makeTestCert(dir)
    const tls = loadTlsCredentials({ certFile, keyFile })
    server = createBridgeServer({ tls, handler: (req, res) => res.end('{}') })
    const port = await listen(server)
    await assert.rejects(
      new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: '/watch/health', timeout: 2000 }, (res) => {
          res.resume()
          resolve(res.statusCode)
        }).on('error', reject)
      }),
      /./, 'cleartext against a TLS server must fail',
    )
  } finally {
    if (server) await close(server)
    rmSync(dir, { recursive: true, force: true })
  }
  assert.throws(
    () => createBridgeServer({ tls: null, allowInsecureHttp: false, handler: () => {} }),
    /refusing to serve cleartext/,
  )
  // Explicit opt-in only: insecure legacy mode is a visible flag, not a fallback.
  const plain = createBridgeServer({ tls: null, allowInsecureHttp: true, handler: (req, res) => res.end('{}') })
  const port = await listen(plain)
  try {
    const code = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/', timeout: 2000 }, (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode))
      }).on('error', reject)
    })
    assert.equal(code, 200)
  } finally {
    await close(plain)
  }
})

test('missing credentials fail with a setup hint, not a bare ENOENT', () => {
  assert.throws(
    () => loadTlsCredentials({ certFile: '/nonexistent/cert.pem', keyFile: '/nonexistent/key.pem' }),
    /setup-cert\.sh/,
  )
})
