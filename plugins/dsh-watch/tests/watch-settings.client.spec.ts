/**
 * Watch Settings client tests (UI role, isolated).
 *
 * No HOME/DSH_HOME/profile/bridge/network: fetch is stubbed, rendering uses
 * react-dom/server (no DOM/browser), and the ModuleLoader bundle test runs
 * the built `lib/client.js` inside a `node:vm` sandbox with stubbed
 * `window.__ModuleLoader__` + stubbed externals. The bundle test skips
 * honestly when `lib/client.js` was not built (run `pnpm build` first).
 */

import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { apply, inject, name } from '../src/client/index.tsx'
import { WatchSettingsSection, WatchSettingsView } from '../src/client/settings.tsx'
import {
  approvePair,
  denyPair,
  fetchPairStatus,
  revokePairedDevice,
  setupVoiceBackend,
  PAIR_APPROVAL_PATH,
  PAIR_DENY_PATH,
  PAIR_REVOKE_PATH,
  PAIR_STATUS_PATH,
  VOICE_SETUP_PATH,
  type FetchImpl,
  type PairStatus,
} from '../src/client/settings.ts'

const FULL_FP =
  'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99'
const SHORT_FP = 'AABB-CCDD-EEFF-0011-2233-4455'

function activeStatus(): PairStatus {
  return {
    fingerprint: { full: FULL_FP, short: SHORT_FP },
    hostCandidates: ['192.168.1.20'],
    port: 8443,
    backendStatus: 'ready',
    pending: [
      {
        requestId: 'req-pending-000000000001',
        deviceAlias: 'Test Watch',
        deviceKind: 'Wear OS',
        enrolledAtMs: 1_700_000_000_000,
        expiresAtMs: Date.now() + 90_000,
        attemptsLeft: 5,
      },
    ],
    devices: [{ deviceId: 'watch-abc', deviceAlias: 'Daily Watch', deviceKind: 'Galaxy Watch4', revoked: false }],
  }
}

function viewDefaults(overrides: Partial<Parameters<typeof WatchSettingsView>[0]> = {}) {
  return {
    status: activeStatus(),
    loading: false,
    error: null as string | null,
    notice: null as string | null,
    confirmed: {} as Record<string, boolean>,
    busy: {} as Record<string, boolean>,
    rowError: {} as Record<string, string>,
    onToggleConfirm: vi.fn(),
    onApprove: vi.fn(),
    onReject: vi.fn(),
    onRetry: vi.fn(),
    ...overrides,
  }
}

describe('watch client registrar (actual DSH 0.1.2-rc.1 Settings UI)', () => {
  it('exports the client identity the ModuleLoader/host expects', () => {
    expect(name).toBe('dsh-watch-client')
    expect(inject).toEqual(['slots'])
    expect(typeof apply).toBe('function')
  })

  it('registers the Watch page on the settings.section slot (id watch)', () => {
    const registered: Array<{ options: Record<string, unknown>; component: unknown }> = []
    let injectedSlot = ''
    const ctx = {
      effect: vi.fn(),
      slots: {
        inject: (slot: string, factory: () => unknown) => {
          injectedSlot = slot
          factory()
        },
        register: (options: Record<string, unknown>, component: unknown) => {
          registered.push({ options, component })
          return () => undefined
        },
      },
    }
    apply(ctx as never)
    expect(injectedSlot).toBe('settings.section')
    expect(registered).toHaveLength(1)
    const entry = registered[0]!
    expect(entry.options).toMatchObject({ name: 'settings.section', id: 'watch', order: 15 })
    expect(typeof (entry.options['label'] as () => string)()).toBe('string')
    expect((entry.options['label'] as () => string)()).toBe('Watch')
    expect(entry.component).toBe(WatchSettingsSection)
  })
})

describe('WatchSettingsView states (static markup, no DOM)', () => {
  it('renders the active settings page: backend, 96-bit fingerprint, pending, devices', () => {
    const html = renderToStaticMarkup(WatchSettingsView(viewDefaults()) as never)
    expect(html).toContain('Watch')
    expect(html).toContain('Voice backend')
    expect(html).toContain('ready')
    expect(html).toContain(FULL_FP)
    expect(html).toContain(SHORT_FP)
    expect(html).toContain('Pending watch requests')
    expect(html).toContain('Test Watch')
    expect(html).toContain('Approve')
    expect(html).toContain('Reject')
    expect(html).toContain('Daily Watch')
    expect(html).toContain('Paired')
    // Never auto-approve: Approve stays disabled until the compare checkbox is set.
    // Reject (deny) needs no fingerprint proof and is enabled immediately.
    expect(html).toContain('Approve')
    expect(html).toContain('Reject')
    expect(html.match(/disabled/g)?.length ?? 0).toBeGreaterThanOrEqual(1)
  })

  it('enables Approve only after the fingerprint compare is confirmed (Reject needs no proof)', () => {
    const gated = renderToStaticMarkup(WatchSettingsView(viewDefaults()) as never)
    // Approve gated on the compare checkbox; Reject (deny) works immediately.
    expect(gated).toContain('Approve')
    expect(gated).toContain('Reject')
    const confirmed = renderToStaticMarkup(
      WatchSettingsView(viewDefaults({ confirmed: { 'req-pending-000000000001': true } })) as never,
    )
    expect(confirmed).not.toContain('disabled')
  })

  it('renders the pending-rejection error state on the row (role=alert)', () => {
    const html = renderToStaticMarkup(
      WatchSettingsView(
        viewDefaults({ rowError: { 'req-pending-000000000001': 'approval 404: unknown or expired request' } }),
      ) as never,
    )
    expect(html).toContain('role="alert"')
    expect(html).toContain('approval 404')
  })

  it('renders the global load error state with a retry path', () => {
    const onRetry = vi.fn()
    const html = renderToStaticMarkup(
      WatchSettingsView(viewDefaults({ status: null, loading: false, error: 'pair status 401: unauthorized', onRetry })) as never,
    )
    expect(html).toContain('role="alert"')
    expect(html).toContain('pair status 401')
  })

  it('renders the loading spinner while the first status fetch is in flight', () => {
    const html = renderToStaticMarkup(
      WatchSettingsView(viewDefaults({ status: null, loading: true, error: null })) as never,
    )
    expect(html).toContain('Loading')
  })

  it('marks revoked devices read-only while paired devices offer Revoke (no tokens shown)', () => {
    const status = activeStatus()
    status.devices = [{ deviceId: 'watch-old', deviceAlias: 'Old Watch', deviceKind: 'Wear OS', revoked: true }]
    const html = renderToStaticMarkup(WatchSettingsView(viewDefaults({ status })) as never)
    expect(html).toContain('Old Watch')
    expect(html).toContain('Revoked')
    expect(html).not.toContain('tk_')
    const paired = renderToStaticMarkup(WatchSettingsView(viewDefaults()) as never)
    expect(paired).toContain('Revoke')
    expect(paired).not.toContain('tk_')
  })

  it('voice setup UI: consent checkbox gates the setup button (never auto-starts)', () => {
    const idle = renderToStaticMarkup(
      WatchSettingsView(viewDefaults({ status: { ...activeStatus(), backendStatus: 'warming' } })) as never,
    )
    expect(idle).toContain('Speech Recognition')
    expect(idle).toContain('Enable watch voice')
    // Button disabled until the user ticks consent.
    expect(idle).toContain('disabled')
    const consented = renderToStaticMarkup(
      WatchSettingsView(
        viewDefaults({ status: { ...activeStatus(), backendStatus: 'warming' }, setupConsent: true }),
      ) as never,
    )
    // Setup button enabled; only the unrelated pending Approve stays disabled.
    expect(consented).toContain('Enable watch voice')
    expect(consented.match(/disabled/g)?.length ?? 0).toBe(1)
  })
})

describe('admin fetch helpers (exact routes, same-origin, error bodies)', () => {
  function stubFetch(ok: boolean, status: number, body: unknown, capture: Array<{ input: string; init: unknown }>): FetchImpl {
    return (async (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string; credentials?: RequestCredentials; signal?: AbortSignal }) => {
      capture.push({ input, init })
      return { ok, status, json: async () => body }
    }) as FetchImpl
  }

  it('fetchPairStatus hits the exact GET status path with same-origin credentials', async () => {
    const capture: Array<{ input: string; init: unknown }> = []
    const body = activeStatus()
    const out = await fetchPairStatus(stubFetch(true, 200, body, capture))
    expect(out.fingerprint.short).toBe(SHORT_FP)
    expect(capture).toHaveLength(1)
    expect(capture[0]!.input).toBe(PAIR_STATUS_PATH)
    expect(capture[0]!.input.startsWith('/')).toBe(true) // same DSH origin, never a LAN literal
    expect((capture[0]!.init as { credentials?: string }).credentials).toBe('same-origin')
  })

  it('fetchPairStatus surfaces 401/403 without any auth fallback', async () => {
    const capture: Array<{ input: string; init: unknown }> = []
    await expect(fetchPairStatus(stubFetch(false, 401, { ok: false, error: 'unauthorized' }, capture))).rejects.toThrow(
      'pair status 401: unauthorized',
    )
    expect(capture).toHaveLength(1) // exactly one attempt — no retry-with-different-credentials
  })

  it('approvePair posts the exact approval path with fingerprintConfirmed:true', async () => {
    const capture: Array<{ input: string; init: unknown }> = []
    const out = await approvePair('req-1', true, true, stubFetch(true, 200, { requestId: 'req-1', status: 'approved' }, capture))
    expect(out).toEqual({ requestId: 'req-1', status: 'approved' })
    expect(capture[0]!.input).toBe(PAIR_APPROVAL_PATH)
    const init = capture[0]!.init as { method?: string; body?: string; credentials?: string }
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('same-origin')
    expect(JSON.parse(init.body ?? '{}')).toEqual({ requestId: 'req-1', approve: true, fingerprintConfirmed: true })
  })

  it('approvePair rejection carries the server error (pending-rejection error state)', async () => {
    const capture: Array<{ input: string; init: unknown }> = []
    await expect(
      approvePair('req-gone', false, true, stubFetch(false, 404, { ok: false, error: 'unknown or expired request' }, capture)),
    ).rejects.toThrow('approval 404: unknown or expired request')
  })

  it('denyPair posts the exact deny path with identifier only (never secrets)', async () => {
    const capture: Array<{ input: string; init: unknown }> = []
    const out = await denyPair('req-1', stubFetch(true, 200, { requestId: 'req-1', status: 'denied' }, capture))
    expect(out).toEqual({ requestId: 'req-1', status: 'denied' })
    expect(capture[0]!.input).toBe(PAIR_DENY_PATH)
    const init = capture[0]!.init as { method?: string; credentials?: string }
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('same-origin')
    const body = JSON.parse((capture[0]!.init as { body?: string }).body ?? '{}') as Record<string, unknown>
    expect(body).toEqual({ requestId: 'req-1' })
    expect('enrollmentSecret' in body || 'token' in body).toBe(false)
  })

  it('setupVoiceBackend posts consent:true to the exact setup path (same-origin, explicit only)', async () => {
    const capture: Array<{ input: string; init: unknown }> = []
    const out = await setupVoiceBackend(true, stubFetch(true, 200, { ok: true, status: 'ready' }, capture))
    expect(out).toEqual({ ok: true, status: 'ready' })
    expect(capture[0]!.input).toBe(VOICE_SETUP_PATH)
    expect(capture[0]!.input.startsWith('/')).toBe(true)
    const init = capture[0]!.init as { method?: string; body?: string; credentials?: string }
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('same-origin')
    expect(JSON.parse(init.body ?? '{}')).toEqual({ consent: true })
  })

  it('setupVoiceBackend surfaces permission errors without retry/fallback', async () => {
    const capture: Array<{ input: string; init: unknown }> = []
    await expect(
      setupVoiceBackend(true, stubFetch(false, 403, { ok: false, error: 'forbidden' }, capture)),
    ).rejects.toThrow('voice setup 403: forbidden')
    expect(capture).toHaveLength(1)
  })

  it('revokePairedDevice posts deviceId only to the exact revoke path (never secrets)', async () => {
    const capture: Array<{ input: string; init: unknown }> = []
    const out = await revokePairedDevice('watch-abc', stubFetch(true, 200, { deviceId: 'watch-abc', status: 'revoked' }, capture))
    expect(out).toEqual({ deviceId: 'watch-abc', status: 'revoked' })
    expect(capture[0]!.input).toBe(PAIR_REVOKE_PATH)
    const init = capture[0]!.init as { method?: string; body?: string; credentials?: string }
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('same-origin')
    const body = JSON.parse(init.body ?? '{}') as Record<string, unknown>
    expect(body).toEqual({ deviceId: 'watch-abc' })
    expect('token' in body || 'enrollmentSecret' in body || 'secret' in body).toBe(false)
  })
})
