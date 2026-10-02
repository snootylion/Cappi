import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  checkBridgeUrl,
  DEFAULT_BRIDGE_BASE_URL,
  DEFAULT_BRIDGE_TIMEOUT_MS,
  isLoopbackHost,
  resolveWatchConfig,
} from '../src/config.ts'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('watch plugin config defaults', () => {
  it('defaults to the secure loopback https target, header token file, and safe timeouts', () => {
    vi.stubEnv('DSH_HOME', '/tmp/dsh-watch-test-home')
    const resolved = resolveWatchConfig({})
    expect(resolved.bridgeBaseUrl).toBe(DEFAULT_BRIDGE_BASE_URL)
    expect(resolved.bridgeBaseUrl).toBe('https://127.0.0.1:8787')
    expect(resolved.bridgeToken).toBeUndefined()
    expect(resolved.bridgeTokenPath).toBe('/tmp/dsh-watch-test-home/dsh-watch/bridge/token')
    expect(resolved.watchSessionId).toBe('')
    expect(resolved.manifestPath).toBeUndefined()
    expect(resolved.allowInsecureLan).toBe(false)
    expect(resolved.timeoutMs).toBe(DEFAULT_BRIDGE_TIMEOUT_MS)
  })

  it('fails closed by default: https without a pin sends nothing', async () => {
    vi.stubEnv('DSH_HOME', '/tmp/dsh-watch-test-home')
    const { checkBridgeUrl } = await import('../src/config.ts')
    expect(checkBridgeUrl(resolveWatchConfig({}).bridgeBaseUrl, false, '').ok).toBe(false)
  })

  it('keeps personal addresses out of the defaults', () => {
    const resolved = resolveWatchConfig({})
    expect(resolved.bridgeBaseUrl).not.toMatch(/192\.168|10\.\d|172\.(1[6-9]|2\d|3[01])\./u)
  })

  it('prefers explicit config, then env, then defaults', () => {
    vi.stubEnv('DSH_WATCH_BRIDGE_URL', 'https://bridge.example:8787')
    vi.stubEnv('DSH_WATCH_SESSION_ID', 'env-session')
    expect(resolveWatchConfig({}).bridgeBaseUrl).toBe('https://bridge.example:8787')
    expect(resolveWatchConfig({ bridgeBaseUrl: 'http://127.0.0.1:9999' }).bridgeBaseUrl).toBe(
      'http://127.0.0.1:9999',
    )
    expect(resolveWatchConfig({}).watchSessionId).toBe('env-session')
    expect(resolveWatchConfig({ watchSessionId: 'cfg-session' }).watchSessionId).toBe('cfg-session')
  })

  it('clamps the bridge timeout into a sane range', () => {
    expect(resolveWatchConfig({ timeoutMs: 1 }).timeoutMs).toBe(1_000)
    expect(resolveWatchConfig({ timeoutMs: 1_000_000 }).timeoutMs).toBe(30_000)
  })
})

describe('bridge URL policy (bridge C header/HTTPS contract)', () => {
  it.each(['127.0.0.1', 'localhost', '::1'])('treats %s as loopback', (host) => {
    expect(isLoopbackHost(host)).toBe(true)
  })

  it('allows explicit loopback http for local fixtures', () => {
    const checked = checkBridgeUrl('http://127.0.0.1:8787', false)
    expect(checked.ok).toBe(true)
  })

  it('requires https for non-loopback unless cleartext is explicitly allowed', () => {
    const pin = Buffer.alloc(32, 1).toString('base64')
    expect(checkBridgeUrl('http://192.0.2.10:8787', false).ok).toBe(false)
    expect(checkBridgeUrl('https://bridge.example:8787', false).ok).toBe(false) // pin required
    expect(checkBridgeUrl('https://bridge.example:8787', false, pin).ok).toBe(true)
    const opted = checkBridgeUrl('http://192.0.2.10:8787', true)
    expect(opted.ok).toBe(true)
  })

  it('requires a pin for every https target, loopback included (fail-closed)', () => {
    const pin = Buffer.alloc(32, 1).toString('base64')
    expect(checkBridgeUrl('https://127.0.0.1:8787', false).ok).toBe(false)
    expect(checkBridgeUrl('https://127.0.0.1:8787', false, pin).ok).toBe(true)
    expect(checkBridgeUrl('https://127.0.0.1:8787', false, `sha256/${pin}`).ok).toBe(true)
  })

  it('rejects credentials, token query params, and non-http schemes', () => {
    expect(checkBridgeUrl('http://token@127.0.0.1:8787', false).ok).toBe(false)
    expect(checkBridgeUrl('http://127.0.0.1:8787/?token=abc', false).ok).toBe(false)
    expect(checkBridgeUrl('ws://127.0.0.1:8787', false).ok).toBe(false)
    expect(checkBridgeUrl(':::not a url:::', false).ok).toBe(false)
  })

  it('normalizes pins like the watch SecureTransport (sha256/ or bare, 32 bytes)', async () => {
    const { normalizeBridgePin } = await import('../src/config.ts')
    const pin = Buffer.alloc(32, 9).toString('base64')
    expect(normalizeBridgePin(`sha256/${pin}`)).toBe(pin)
    expect(normalizeBridgePin(pin)).toBe(pin)
    expect(normalizeBridgePin('')).toBe('')
    expect(normalizeBridgePin('sha256/short')).toBe('')
    expect(normalizeBridgePin('not-base64!!!')).toBe('')
  })

  it('resolves the pin from explicit config, env, then empty', async () => {
    const { resolveWatchConfig } = await import('../src/config.ts')
    vi.stubEnv('DSH_WATCH_BRIDGE_PIN', '')
    expect(resolveWatchConfig({}).bridgeCertPin).toBe('')
    const pin = Buffer.alloc(32, 3).toString('base64')
    vi.stubEnv('DSH_WATCH_BRIDGE_PIN', `sha256/${pin}`)
    expect(resolveWatchConfig({}).bridgeCertPin).toBe(pin)
    expect(resolveWatchConfig({ bridgeCertPin: pin }).bridgeCertPin).toBe(pin)
  })
})
