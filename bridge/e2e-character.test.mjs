// bridge/e2e-character.test.mjs — REAL end-to-end over ephemeral HTTPS.
//
// A mock DSH (controllable watched session) + the REAL production character
// stack (canonical registry.json read-only, session-binding guard,
// watch-actions router, auth, TLS) serve on an ephemeral loopback HTTPS
// port with a fresh openssl self-signed certificate in a temp dir. A pinned
// mock-plugin client (same DER-SHA256 convention as the watch/plugin)
// drives: session-switch rejection, pack selection + persistence/recovery,
// correct/wrong pin, redirect refusal, token-in-URL refusal.
//
// No live harness, no live requests, no credentials: synthetic token only,
// temp roots, ephemeral ports. Requires `openssl` on PATH (loud failure
// otherwise — the pin convention cannot be exercised without a real cert).
//
// Run: node --test bridge/   (or: node --test e2e-character.test.mjs)

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import https from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

import { createBridgeServer, certSha256Pin } from './tls.mjs'
import { extractHeaderToken, queryHasToken, tokenOkTimingSafe } from './auth.mjs'
import { createCharacterStore, parseCharacterRegistry } from './characters.mjs'
import { createWatchActions } from './watch-actions.mjs'

const TOKEN = 'e2e-synthetic-token'
const REGISTRY_PATH = join(import.meta.dirname, '..', 'characters', 'registry.json')

function tempRoot () {
  return mkdtempSync(join(tmpdir(), 'dsh-e2e-'))
}

/** Fresh self-signed cert in a temp dir (2-day, CN label only). */
function makeCert (dir) {
  const cert = join(dir, 'bridge-cert.pem')
  const key = join(dir, 'bridge-key.pem')
  // Scrub ambient DSH_/BRIDGE_ vars before the nested openssl: the cert
  // fixture must never depend on the operator shell (explicit values win;
  // openssl itself ignores these, but the scrub is the invariant).
  const env = { ...process.env }
  for (const k of Object.keys(env)) {
    if (/^(DSH_|BRIDGE_|WATCH_)/.test(k)) delete env[k]
  }
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256',
    '-days', '2', '-nodes', '-keyout', key, '-out', cert, '-subj', '/CN=e2e-bridge'],
    { stdio: 'pipe', env })
  return { certPem: readFileSync(cert, 'utf8'), keyPem: readFileSync(key, 'utf8') }
}

/** Mock-plugin HTTPS client: pinned, redirect-refusing, header-token only. */
function mockPlugin ({ port, pin, token = TOKEN }) {
  const expected = String(pin).replace(/^sha256\//i, '')
  let requests = 0
  async function call (path, { method = 'GET', body = null, queryToken = false } = {}) {
    requests++
    const target = `https://127.0.0.1:${port}${path}${queryToken ? `?token=${token}` : ''}`
    return new Promise((resolve, reject) => {
      const url = new URL(target)
      const payload = body === null ? '' : JSON.stringify(body)
      const req = https.request(url, {
        method,
        headers: { 'content-type': 'application/json', 'x-bridge-token': token },
        rejectUnauthorized: false,
        agent: false,
        // Pin verified on secureConnect BEFORE anything is written (the
        // runtime never invokes checkServerIdentity with rejectUnauthorized:
        // false — measured — so gating the send is the only sound order).
      }, (res) => {
        const status = res.statusCode ?? 0
        if (status >= 300 && status < 400) {
          res.resume()
          reject(new Error(`client refused redirect HTTP ${status} (no follow)`))
          return
        }
        let text = ''
        res.on('data', (d) => { text += d })
        res.on('end', () => {
          let json = null
          try { json = text ? JSON.parse(text) : null } catch { json = null }
          resolve({ status, json })
        })
      })
      req.on('error', reject)
      req.on('socket', (socket) => {
        const verify = () => {
          let raw = null
          try { raw = socket.getPeerCertificate(true)?.raw ?? null } catch { raw = null }
          const presented = raw ? createHash('sha256').update(raw).digest('base64') : ''
          const a = Buffer.from(presented, 'base64')
          const b = Buffer.from(expected, 'base64')
          if (!raw || a.length !== 32 || b.length !== 32 || !a.equals(b)) {
            req.destroy(new Error('bridge certificate pin mismatch'))
            return
          }
          if (payload) req.write(payload)
          req.end()
        }
        let already = null
        try { already = socket.getPeerCertificate(true) } catch { already = null }
        if (already && already.raw?.length) verify()
        else socket.once('secureConnect', verify)
      })
    })
  }
  return { call, requestCount: () => requests }
}

function json (res, code, obj) {
  const b = JSON.stringify(obj)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(b)
}

function readJson (req) {
  return new Promise((resolve, reject) => {
    const parts = []
    req.on('data', (d) => parts.push(d))
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')) } catch { reject(new Error('bad json')) }
    })
    req.on('error', reject)
  })
}

/** Stand up the mock-DSH + production-stack HTTPS bridge. */
async function startE2eBridge (t) {
  const dir = tempRoot()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { certPem, keyPem } = makeCert(dir)
  const pin = certSha256Pin(certPem)

  const parsed = parseCharacterRegistry(JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')))
  assert.equal(parsed.ok, true)
  const stateFile = join(dir, 'character.json')
  const chars = createCharacterStore({
    registry: parsed.registry,
    persist: (id) => writeFileSync(stateFile, JSON.stringify({ characterId: id }) + '\n', { mode: 0o600 }),
  })
  let watched = 'sess-A'
  let cappiAction = null
  const sse = []
  const actions = createWatchActions({
    getWatchedSession: () => watched,
    chars,
    registry: parsed.registry,
    getCappiAction: () => cappiAction,
    setCappiAction: (a) => { cappiAction = a },
    notify: (o) => sse.push(o),
  })
  let redirectHits = 0

  const handler = async (req, res) => {
    const url = new URL(req.url, 'https://x')
    if (queryHasToken(url)) return json(res, 401, { ok: false, error: 'token in URL is rejected' })
    if (url.pathname === '/watch/redirect-stub') {
      redirectHits++
      res.writeHead(302, { location: '/watch/capabilities' })
      return res.end()
    }
    const headerToken = req.headers['x-bridge-token']
    const provided = Array.isArray(headerToken) ? headerToken[0] : headerToken
    if (!tokenOkTimingSafe(provided ?? null, TOKEN)) return json(res, 401, { ok: false, error: 'bad token' })
    try {
      if (url.pathname === '/watch/capabilities' && req.method === 'GET') {
        return json(res, 200, actions.describeCapabilities())
      }
      if (url.pathname === '/watch/cappi' && req.method === 'POST') {
        const out = actions.handleCappiBody(await readJson(req))
        return json(res, out.status, out.payload)
      }
      if (url.pathname === '/watch/command' && req.method === 'POST') {
        const body = await readJson(req)
        if (body?.cmd === 'character-select') {
          const out = actions.handleCharacterSelect(body)
          return json(res, out.status, out.payload)
        }
        return json(res, 400, { ok: false, error: `unknown cmd ${body?.cmd}` })
      }
      return json(res, 404, { ok: false, error: 'not found' })
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message })
    }
  }

  // The bridge never redirects: assert the production server factory emits
  // no 3xx machinery of its own (routes above only ever 2xx/4xx/5xx).
  const server = createBridgeServer({ handler, tls: { cert: certPem, key: keyPem } })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const port = server.address().port
  return {
    dir, pin, port, stateFile,
    setWatched: (id) => { watched = id },
    sse,
    cappi: () => cappiAction,
    selected: () => chars.selected,
    redirectHits: () => redirectHits,
  }
}

test('E2E: capabilities shape + correct pin over ephemeral HTTPS', async (t) => {
  const bridge = await startE2eBridge(t)
  const plugin = mockPlugin({ port: bridge.port, pin: bridge.pin })
  const caps = await plugin.call('/watch/capabilities')
  assert.equal(caps.status, 200)
  assert.equal(caps.json.ok, true)
  assert.equal(caps.json.version, '0.2.0')
  assert.ok(Array.isArray(caps.json.features) && caps.json.features.includes('session-binding'))
  assert.equal(caps.json.characterId, 'cappi-original')
  assert.deepEqual(caps.json.characters, ['cappi-original', 'dot-default', 'ember-min'])
  assert.ok(caps.json.modelSelectable.includes('talk2'))
  assert.ok(caps.json.roles && Array.isArray(caps.json.roles.talk))
})

test('E2E: wrong pin fails closed before any token is sent', async (t) => {
  const bridge = await startE2eBridge(t)
  const impostor = mockPlugin({ port: bridge.port, pin: Buffer.alloc(32, 7).toString('base64') })
  await assert.rejects(() => impostor.call('/watch/capabilities'), /pin mismatch/)
})

test('E2E: token in URL is rejected (401), redirect is refused without follow', async (t) => {
  const bridge = await startE2eBridge(t)
  const plugin = mockPlugin({ port: bridge.port, pin: bridge.pin })
  const leaked = await plugin.call('/watch/capabilities', { queryToken: true })
  assert.equal(leaked.status, 401)
  const before = plugin.requestCount()
  await assert.rejects(() => plugin.call('/watch/redirect-stub'), /refused redirect/)
  assert.equal(plugin.requestCount(), before + 1) // exactly one request: never followed
  assert.equal(bridge.redirectHits(), 1)
})

test('E2E: session switch rejection leaves character state untouched', async (t) => {
  const bridge = await startE2eBridge(t)
  const plugin = mockPlugin({ port: bridge.port, pin: bridge.pin })
  // Explicit selection: this test drives the dot-default vocabulary.
  const select = await plugin.call('/watch/command', { method: 'POST', body: { cmd: 'character-select', characterId: 'dot-default' } })
  assert.equal(select.status, 200)
  // Missing binding → 400.
  const missing = await plugin.call('/watch/cappi', { method: 'POST', body: { action: 'talk_a' } })
  assert.equal(missing.status, 400)
  // Wrong session → 409, no effect, no SSE.
  const intruder = await plugin.call('/watch/cappi', { method: 'POST', body: { action: 'talk_a', sessionId: 'sess-B' } })
  assert.equal(intruder.status, 409)
  assert.match(intruder.json.error, /watched session/)
  assert.equal(bridge.cappi(), null)
  assert.equal(bridge.sse.length, 1) // only the explicit selection event; the rejected call adds nothing
  // Correct session → 200 with atomic effect + SSE.
  const good = await plugin.call('/watch/cappi', { method: 'POST', body: { action: 'talk_a', sessionId: 'sess-A' } })
  assert.equal(good.status, 200)
  assert.deepEqual(good.json, { ok: true, action: 'talk_a', characterId: 'dot-default' })
  assert.equal(bridge.cappi(), 'talk_a')
  assert.deepEqual(bridge.sse.at(-1), { t: 'cappi', action: 'talk_a' })
  // The bridge follows a session switch: the OLD caller is now rejected.
  bridge.setWatched('sess-B')
  const stale = await plugin.call('/watch/cappi', { method: 'POST', body: { action: 'idle_a', sessionId: 'sess-A' } })
  assert.equal(stale.status, 409)
  assert.equal(bridge.cappi(), 'talk_a') // untouched by the rejected call
  const fresh = await plugin.call('/watch/cappi', { method: 'POST', body: { action: 'idle_a', sessionId: 'sess-B' } })
  assert.equal(fresh.status, 200)
  assert.equal(bridge.cappi(), 'idle_a')
})

test('E2E: legacy alias resolves per active pack; state-owned never resolves', async (t) => {
  const bridge = await startE2eBridge(t)
  const plugin = mockPlugin({ port: bridge.port, pin: bridge.pin })
  // Default pack (cappi-original): original ids resolve exactly.
  const exact = await plugin.call('/watch/cappi', { method: 'POST', body: { action: 'dance', sessionId: 'sess-A' } })
  assert.equal(exact.status, 200)
  assert.equal(exact.json.action, 'dance')
  assert.equal(exact.json.characterId, 'cappi-original')
  // Explicit dot-default selection: dance aliases to the celebrate role.
  const select = await plugin.call('/watch/command', { method: 'POST', body: { cmd: 'character-select', characterId: 'dot-default' } })
  assert.equal(select.status, 200)
  const dance = await plugin.call('/watch/cappi', { method: 'POST', body: { action: 'dance', sessionId: 'sess-A' } })
  assert.equal(dance.status, 200)
  assert.equal(dance.json.action, 'celebrate') // dot-default: dance → celebrate role
  const owned = await plugin.call('/watch/cappi', { method: 'POST', body: { action: 'question', sessionId: 'sess-A' } })
  assert.equal(owned.status, 400)
  assert.match(owned.json.error, /state-owned/)
})

test('E2E: pack selection persists, recovers, and re-scopes callable actions', async (t) => {
  const bridge = await startE2eBridge(t)
  const plugin = mockPlugin({ port: bridge.port, pin: bridge.pin })
  const unknown = await plugin.call('/watch/command', { method: 'POST', body: { cmd: 'character-select', characterId: 'nope' } })
  assert.equal(unknown.status, 400)
  assert.match(unknown.json.error, /unknown character/)
  const select = await plugin.call('/watch/command', { method: 'POST', body: { cmd: 'character-select', characterId: 'ember-min' } })
  assert.equal(select.status, 200)
  assert.deepEqual(select.json, { ok: true, characterId: 'ember-min' })
  assert.deepEqual(bridge.sse.at(-1), { t: 'character', characterId: 'ember-min' })
  assert.equal(bridge.cappi(), null) // pack switch retires the held action
  const caps = await plugin.call('/watch/capabilities')
  assert.deepEqual(caps.json.modelSelectable, ['idle_a', 'idle_b', 'idle_c', 'listen', 'talk', 'work_set'])
  // dance has no celebrate role on ember-min now.
  const dance = await plugin.call('/watch/cappi', { method: 'POST', body: { action: 'dance', sessionId: 'sess-A' } })
  assert.equal(dance.status, 400)
  assert.match(dance.json.error, /callable/)
  const talk = await plugin.call('/watch/cappi', { method: 'POST', body: { action: 'talk', sessionId: 'sess-A' } })
  assert.equal(talk.status, 200)
  // Persistence: the selection survives a store rebuild from the state file.
  const stored = JSON.parse(readFileSync(bridge.stateFile, 'utf8'))
  assert.equal(stored.characterId, 'ember-min')
  const reparsed = parseCharacterRegistry(JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')))
  const recovered = createCharacterStore({ registry: reparsed.registry, initialId: stored.characterId })
  assert.equal(recovered.selected, 'ember-min')
})
