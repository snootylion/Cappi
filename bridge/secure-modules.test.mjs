// bridge/secure-modules.test.mjs — offline unit tests for the C extraction:
// config, storage, auth, discovery, dsh-auth, cappi-registry, plus the
// no-side-effects-on-import gate for bridge.mjs/dsh.mjs.
//
// Run: node --test bridge/   (no network beyond loopback, no credentials,
// no listening sockets except ephemeral loopback in later files)

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

import { loadBridgeConfig, isPairedBase, DEFAULT_BRIDGE_PORT } from './config.mjs'
import { loadOrCreateToken, tokenFilePath } from './storage.mjs'
import {
  tokenOkTimingSafe, extractHeaderToken, queryHasToken,
  decideAuth, isTokenBearingUrl, validateOpenMacUrl,
} from './auth.mjs'
import { handleDiscoveryPacket, parseDiscoveryReply } from './discovery.mjs'
import { loadDshSecret, mintCookie, resolveDshHome, COOKIE_VERSION } from './dsh-auth.mjs'
import { CAPPI_ALLOWLIST } from './cappi.mjs'
import { resolveCappiAllowlist, parseCappiCommandWith } from './cappi-registry.mjs'

const __dir = dirname(fileURLToPath(import.meta.url))

// ---- config ---------------------------------------------------------------

test('config defaults are safe: external state dir, no insecure opt-in', () => {
  const cfg = loadBridgeConfig({}, '/tmp/fake-home')
  assert.equal(cfg.port, DEFAULT_BRIDGE_PORT)
  assert.equal(cfg.allowInsecureHttp, false)
  assert.equal(cfg.token, null)
  assert.ok(!cfg.stateDir.includes('wear-dsh-release'))
  assert.ok(cfg.stateDir.startsWith('/tmp/fake-home'))
})

test('config honours env and validates ports', () => {
  const cfg = loadBridgeConfig({
    BRIDGE_PORT: '9999', BRIDGE_DISCOVERY_PORT: '9998',
    BRIDGE_STATE_DIR: '/tmp/s', DSH_HOME: '/tmp/dsh',
    BRIDGE_ALLOW_INSECURE_HTTP: '1',
  }, '/tmp/fake-home')
  assert.equal(cfg.port, 9999)
  assert.equal(cfg.discoveryPort, 9998)
  assert.equal(cfg.stateDir, '/tmp/s')
  assert.equal(cfg.dshHome, '/tmp/dsh')
  assert.equal(cfg.allowInsecureHttp, true)
  const bad = loadBridgeConfig({ BRIDGE_PORT: '99999' }, '/tmp/fake-home')
  assert.equal(bad.port, DEFAULT_BRIDGE_PORT)
  assert.throws(() => loadBridgeConfig({ DSH_BASE: 'gopher://x' }, '/tmp/fake-home'), /scheme/)
})

test('blank and placeholder bases are unpaired; real https base is paired', () => {
  assert.equal(isPairedBase(''), false)
  assert.equal(isPairedBase('http://192.0.2.1:8787'), false)
  assert.equal(isPairedBase('https://bridge.local:8787'), true)
})

// ---- storage --------------------------------------------------------------

function memfs () {
  const files = new Map()
  const dirs = new Set()
  return {
    files,
    existsSync: (p) => files.has(p),
    mkdirSync: (p) => { dirs.add(p) },
    readFileSync: (p) => {
      if (!files.has(p)) throw Object.assign(new Error('enoent'), { code: 'ENOENT' })
      return files.get(p)
    },
    writeFileSync: (p, data, opts) => {
      files.set(p, String(data))
      files.set(`${p}:mode`, opts?.mode ?? null)
    },
  }
}

test('storage: env token wins and writes nothing', () => {
  const fs = memfs()
  const t = loadOrCreateToken({ stateDir: '/s', envToken: '  secret-x  ', fs })
  assert.equal(t, 'secret-x')
  assert.equal(fs.files.size, 0)
})

test('storage: generates random token with private perms, then reuses it', () => {
  const fs = memfs()
  const a = loadOrCreateToken({ stateDir: '/s', fs })
  assert.match(a, /^[0-9a-f]{24}$/)
  assert.equal(fs.files.get('/s/token:mode'), 0o600)
  const b = loadOrCreateToken({ stateDir: '/s', fs })
  assert.equal(a, b)
})

test('storage: migrates the legacy source-tree token read-only', () => {
  const fs = memfs()
  fs.files.set('/src/token', 'legacy-token\n')
  const t = loadOrCreateToken({ stateDir: '/s', legacyPath: '/src/token', fs })
  assert.equal(t, 'legacy-token')
  assert.ok(fs.files.has('/s/token')) // migrated copy in state dir
  assert.equal(fs.files.get('/src/token'), 'legacy-token\n') // source untouched
})

// ---- auth -----------------------------------------------------------------

test('auth: header-only tokens; query tokens rejected before comparison', () => {
  assert.equal(tokenOkTimingSafe('abc', 'abc'), true)
  assert.equal(tokenOkTimingSafe('abc', 'abd'), false)
  assert.equal(tokenOkTimingSafe('', 'abc'), false)
  assert.equal(extractHeaderToken({ headers: { 'x-bridge-token': 't' } }), 't')
  assert.equal(extractHeaderToken({ headers: {} }), null)
  const withQuery = new URL('http://x/watch/state?token=abc')
  const clean = new URL('http://x/watch/state')
  assert.equal(queryHasToken(withQuery), true)
  assert.equal(queryHasToken(clean), false)
  // A leaked URL token can never authenticate, even when it matches.
  assert.deepEqual(
    decideAuth({ headerToken: null, hasQueryToken: true, expected: 'abc' }),
    { ok: false, error: 'token in URL is rejected; send X-Bridge-Token header' },
  )
  assert.deepEqual(decideAuth({ headerToken: 'abc', hasQueryToken: false, expected: 'abc' }), { ok: true })
  assert.deepEqual(decideAuth({ headerToken: 'nope', hasQueryToken: false, expected: 'abc' }).ok, false)
})

test('auth: token-bearing open-mac URLs are refused', () => {
  assert.equal(isTokenBearingUrl('https://h:8787/watch/image?ref=a&token=secret'), true)
  assert.equal(isTokenBearingUrl('https://h:8787/watch/image?ref=a'), false)
  assert.equal(isTokenBearingUrl('https://example.com/x'), false)
})

test('auth: open-mac raw-URL policy is https-only with no userinfo or token', () => {
  assert.equal(validateOpenMacUrl('https://example.com/some/image.png').ok, true)
  assert.equal(validateOpenMacUrl('https://example.com/x?y=1#frag').ok, true)
  // http is refused (cleartext never opens externally; docs promise https-only).
  assert.match(validateOpenMacUrl('http://example.com/x').error, /only https/)
  assert.match(validateOpenMacUrl('gopher://example.com/x').error, /only https/)
  assert.match(validateOpenMacUrl('not a url').error, /only https/)
  // Userinfo would leak credentials to the opened host: refused before spawn.
  assert.match(validateOpenMacUrl('https://user:pass@example.com/').error, /credentials/)
  assert.match(validateOpenMacUrl('https://user@example.com/').error, /credentials/)
  // Token-bearing URLs are refused (the token never enters a URL).
  assert.match(validateOpenMacUrl('https://example.com/x?token=secret').error, /token-bearing/)
  assert.match(validateOpenMacUrl('https://example.com/x?a=1&token=secret').error, /token-bearing/)
})

test('bridge: set-permission requires the caller session and matches the captured watched id', async () => {
  const { decideSetPermissionTarget, decideApprovalScope } = await import('./bridge.mjs')
  // Missing sessionId → 400 before any effect.
  assert.deepEqual(decideSetPermissionTarget({}, 'sess-A').ok, false)
  assert.equal(decideSetPermissionTarget({}, 'sess-A').status, 400)
  assert.equal(decideSetPermissionTarget({ sessionId: '' }, 'sess-A').status, 400)
  // None watched → 409.
  assert.equal(decideSetPermissionTarget({ sessionId: 'sess-A' }, null).status, 409)
  assert.equal(decideSetPermissionTarget({ sessionId: 'sess-A' }, '').status, 409)
  // Pinned-A / active-B mismatch → 409 (the R-05 case): no RPC may run.
  const mismatch = decideSetPermissionTarget({ sessionId: 'sess-A' }, 'sess-B')
  assert.equal(mismatch.ok, false)
  assert.equal(mismatch.status, 409)
  // Correct binding returns the CAPTURED id (the effect lands on it).
  assert.deepEqual(decideSetPermissionTarget({ sessionId: 'sess-A' }, 'sess-A'), { ok: true, sessionId: 'sess-A' })
  // Approvals: absent sessionId stays legacy-compatible; present is enforced.
  assert.deepEqual(decideApprovalScope({}, 'sess-A'), { ok: true, sessionId: null })
  assert.deepEqual(decideApprovalScope({ sessionId: '' }, 'sess-A'), { ok: true, sessionId: null })
  assert.deepEqual(decideApprovalScope({ sessionId: 'sess-A' }, 'sess-A'), { ok: true, sessionId: 'sess-A' })
  assert.equal(decideApprovalScope({ sessionId: 'sess-A' }, 'sess-B').status, 409)
  assert.equal(decideApprovalScope({ sessionId: 'sess-A' }, null).status, 409)
})

// ---- discovery ------------------------------------------------------------

test('discovery: valid probe answered; garbage silent', () => {
  assert.equal(handleDiscoveryPacket('DSHW1DISCOVER abc-123_X', 8787), 'DSHW1BRIDGE abc-123_X 8787')
  assert.equal(handleDiscoveryPacket('HELLO', 8787), null)
  assert.equal(handleDiscoveryPacket('DSHW1DISCOVER ', 8787), null)
  assert.equal(handleDiscoveryPacket('DSHW1DISCOVER bad nonce!', 8787), null)
  assert.equal(handleDiscoveryPacket('DSHW1DISCOVER ' + 'n'.repeat(65), 8787), null)
  assert.equal(handleDiscoveryPacket('DSHW1DISCOVER ' + 'n'.repeat(600), 8787), null)
  assert.equal(handleDiscoveryPacket('DSHW1DISCOVER abc', 0), null)
  assert.equal(handleDiscoveryPacket('DSHW1DISCOVER abc', 70000), null)
})

test('discovery: foreign/garbled replies rejected', () => {
  assert.deepEqual(parseDiscoveryReply('DSHW1BRIDGE nonce1 8787', 'nonce1'), { nonce: 'nonce1', port: 8787 })
  assert.equal(parseDiscoveryReply('DSHW1BRIDGE other 8787', 'nonce1'), null) // foreign responder
  assert.equal(parseDiscoveryReply('DSHW1BRIDGE nonce1 0', 'nonce1'), null)
  assert.equal(parseDiscoveryReply('DSHW1BRIDGE nonce1 99999', 'nonce1'), null)
  assert.equal(parseDiscoveryReply('DSHW1BRIDGE nonce1 abc', 'nonce1'), null)
  assert.equal(parseDiscoveryReply('GARBAGE', 'nonce1'), null)
})

// ---- dsh-auth -------------------------------------------------------------

const SECRET_B64URL = Buffer.from('a'.repeat(32)).toString('base64url')
const CRED_YAML = `kind: dsh-credentials\nclient-connection/browser-session:\n  secret: ${SECRET_B64URL}\n`

test('dsh-auth: DSH_HOME respected; secrets never read at import', () => {
  assert.equal(resolveDshHome({ env: { DSH_HOME: '/tmp/custom' }, home: '/h' }), '/tmp/custom')
  assert.equal(resolveDshHome({ env: {}, home: '/h' }), '/h/.dsh')
  const secret = loadDshSecret({ dshHome: '/x', read: () => CRED_YAML })
  assert.equal(secret.byteLength, 32)
  assert.throws(() => loadDshSecret({ dshHome: '/x', read: () => { throw new Error('no') } }), /not found/)
  assert.throws(() => loadDshSecret({ dshHome: '/x', read: () => 'empty' }), /record not found/)
})

test('dsh-auth: minted cookie is version-bounded v1', () => {
  assert.equal(COOKIE_VERSION, 1)
  const secret = Buffer.alloc(32, 7)
  const cookie = mintCookie({ authority: '127.0.0.1:3083', secret, now: 1700000000000 })
  assert.match(cookie, /^dsh-auth-[A-Za-z0-9_-]+=v1\./)
  const body = JSON.parse(Buffer.from(cookie.split('.')[1], 'base64url').toString('utf8'))
  assert.equal(body.version, 1)
  assert.equal(body.authority, '127.0.0.1:3083')
})

// ---- cappi registry --------------------------------------------------------

test('cappi-registry: frozen fallback; registry override; parity with parser', () => {
  assert.equal(resolveCappiAllowlist(null), CAPPI_ALLOWLIST)
  assert.equal(resolveCappiAllowlist({}), CAPPI_ALLOWLIST)
  assert.equal(resolveCappiAllowlist({ actions: [] }), CAPPI_ALLOWLIST)
  const reg = { actions: [{ id: 'dance', modelSelectable: true }, { id: 'nap', modelSelectable: false }] }
  const list = resolveCappiAllowlist(reg)
  assert.deepEqual([...list], ['dance'])
  assert.deepEqual(parseCappiCommandWith({ action: 'dance' }, list), { ok: true, action: 'dance' })
  // Parity: default list behaves exactly like the frozen parser.
  for (const id of CAPPI_ALLOWLIST) {
    assert.deepEqual(parseCappiCommandWith({ action: id }), { ok: true, action: id })
  }
  assert.equal(parseCappiCommandWith({ action: 'fly' }).ok, false)
  assert.deepEqual(parseCappiCommandWith({ action: 'clear' }, list), { ok: true, action: null })
})

// ---- import side effects ----------------------------------------------------

test('importing bridge.mjs and dsh.mjs opens no sockets and writes no files', () => {
  const before = new Set(readdirSync(__dir))
  const tmpHome = mkdtempSync(join(tmpdir(), 'dsh-import-test-'))
  try {
    // Scrub ambient DSH_ vars: an inherited DSH_HOME/DSH_BASE/BRIDGE_* from
    // the operator shell would redirect the nested import under the real
    // home. Explicit synthetic values below still win.
    const scrubbed = { ...process.env }
    for (const key of Object.keys(scrubbed)) {
      if (/^(DSH_|BRIDGE_|WATCH_)/u.test(key)) delete scrubbed[key]
    }
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
      await import('./bridge.mjs');
      await import('./dsh.mjs');
      console.log('import-clean');
    `], {
      cwd: __dir,
      timeout: 15000,
      encoding: 'utf8',
      env: {
        ...scrubbed,
        HOME: tmpHome,
        BRIDGE_STATE_DIR: join(tmpHome, 'state'),
        BRIDGE_TOKEN: 'synthetic-import-token',
        DSH_BASE: 'http://127.0.0.1:3083',
      },
    })
    assert.equal(r.status, 0, `import failed: ${r.stderr}`)
    assert.match(r.stdout, /import-clean/)
    const after = new Set(readdirSync(__dir))
    assert.deepEqual([...after], [...before], 'import created files in the source tree')
  } finally {
    rmSync(tmpHome, { recursive: true, force: true })
  }
})
