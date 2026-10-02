import { useCallback, useEffect, useRef, useState } from 'react'
import {
  approvePair,
  denyPair,
  fetchPairStatus,
  revokePairedDevice,
  setupVoiceBackend,
  PAIRING_COPY,
  type FetchImpl,
  type PairStatus,
} from './settings.ts'

/** Bounded pending-request polling: 5s cadence, max 24 rounds (~2min ≈ pending TTL). */
export const PAIR_POLL_INTERVAL_MS = 5_000
export const PAIR_POLL_MAX_ROUNDS = 24

function Group({ title, description, children }: {
  readonly title: string
  readonly description?: string
  readonly children: React.ReactNode
}): JSX.Element {
  return <section className="dsh-watch-settings__group">
    <h2 className="dsh-watch-settings__group-title">{title}</h2>
    {description ? <p className="dsh-watch-settings__group-description">{description}</p> : null}
    {children}
  </section>
}

function Row({ title, description, children }: {
  readonly title: string
  readonly description: string
  readonly children: React.ReactNode
}): JSX.Element {
  return <div className="dsh-watch-settings__row">
    <div className="dsh-watch-settings__copy">
      <div className="dsh-watch-settings__label">{title}</div>
      <div className="dsh-watch-settings__description">{description}</div>
    </div>
    <div className="dsh-watch-settings__control">{children}</div>
  </div>
}

export interface WatchSettingsViewProps {
  readonly status: PairStatus | null
  readonly loading: boolean
  readonly error: string | null
  readonly notice: string | null
  readonly confirmed: Readonly<Record<string, boolean>>
  readonly busy: Readonly<Record<string, boolean>>
  readonly rowError: Readonly<Record<string, string>>
  readonly onToggleConfirm: (requestId: string, checked: boolean) => void
  readonly onApprove: (requestId: string) => void
  readonly onReject: (requestId: string) => void
  readonly onRetry: () => void
  readonly onResumePoll?: (() => void) | undefined
  readonly pollStopped?: boolean | undefined
  readonly setupConsent?: boolean | undefined
  readonly setupBusy?: boolean | undefined
  readonly setupError?: string | null | undefined
  readonly onToggleSetupConsent?: ((checked: boolean) => void) | undefined
  readonly onSetupVoice?: (() => void) | undefined
  readonly revokeBusy?: Readonly<Record<string, boolean>> | undefined
  readonly onRevoke?: ((deviceId: string) => void) | undefined
}

function formatExpiry(expiresAtMs: number): string {
  const secs = Math.max(0, Math.round((expiresAtMs - Date.now()) / 1_000))
  return `expires in ${secs}s`
}

/** Pure presentational panel: every state in the contract renders without a network round-trip. */
export function WatchSettingsView(props: WatchSettingsViewProps): JSX.Element {
  const { status, loading, error, notice, confirmed, busy, rowError } = props
  const backendReady = status?.backendStatus === 'ready'
  const setupConsent = props.setupConsent === true
  const setupBusy = props.setupBusy === true
  const revokeBusy = props.revokeBusy ?? {}
  return <div className="dsh-watch-settings">
    <div className="dsh-watch-settings__hero">
      <div>
        <h1 className="dsh-watch-settings__title">Watch</h1>
        <p className="dsh-watch-settings__intro">
          Pair this Mac with a Wear OS watch over the turnkey link. Approvals happen here,
          in the trusted Settings panel, after YOU compare the certificate fingerprint.
        </p>
      </div>
      <div className="dsh-watch-settings__summary">
        {loading ? 'Loading…' : status ? (backendReady ? 'Ready' : status.backendStatus) : 'Idle'}
      </div>
    </div>

    {error ? <div className="dsh-watch-settings__error" role="alert">{error}</div> : null}
    {notice ? <div className="dsh-watch-settings__notice" role="status">{notice}</div> : null}

    {loading && !status ? <div className="dsh-watch-settings__spinner" role="status" aria-label="Loading watch pairing status">Loading…</div> : null}

    {status ? <>
      <Group title="Voice backend" description="Watch voice input rides the local Live Voice backend (Speech Recognition only — the Mac microphone is never used for watch input). Nothing starts until YOU tick the consent box and press the setup button.">
        <Row title="Backend status" description={status.backendMessage ?? (backendReady ? 'Voice backend is ready for watch input.' : 'Voice backend is not ready yet.')}>
          <span className="dsh-watch-settings__value">{status.backendStatus}</span>
        </Row>
        {!backendReady ? <>
          <Row title="Consent" description="Allow Speech Recognition for watch input (Speech only, no Mac mic). The setup call fires only after you tick this box.">
            <label className="dsh-watch-settings__confirm">
              <input
                type="checkbox"
                checked={setupConsent}
                disabled={setupBusy}
                onChange={(event) => props.onToggleSetupConsent?.(event.currentTarget.checked)}
              />
              <span>I allow Speech Recognition for watch voice input.</span>
            </label>
          </Row>
          <Row title="Set up" description="Starts the voice backend with your explicit consent. Shows warming, ready, or the actionable error.">
            <button
              type="button"
              className="dsh-watch-settings__button dsh-watch-settings__button--primary"
              disabled={!setupConsent || setupBusy}
              onClick={() => props.onSetupVoice?.()}
            >
              {setupBusy ? 'Starting…' : 'Enable watch voice'}
            </button>
          </Row>
          {props.setupError ? <div className="dsh-watch-settings__error" role="alert">{props.setupError}</div> : null}
          <Row title="Re-check" description="Re-read backend readiness without starting anything.">
            <button type="button" className="dsh-watch-settings__button" disabled={loading} onClick={props.onRetry}>
              {loading ? 'Checking…' : 'Check again'}
            </button>
          </Row>
        </> : null}
      </Group>

      <Group title="Certificate fingerprint" description={PAIRING_COPY.compareBody}>
        <Row title={PAIRING_COPY.compareTitle} description="Short form is 96-bit (6 groups of 4 hex). Full SHA-256 below for exact compare.">
          <span className="dsh-watch-settings__value dsh-watch-settings__mono">{status.fingerprint.short}</span>
        </Row>
        <Row title="Full fingerprint" description="Compare every character with the watch wizard before approving.">
          <span className="dsh-watch-settings__value dsh-watch-settings__mono dsh-watch-settings__wrap">{status.fingerprint.full}</span>
        </Row>
        <Row title="How to reach this Mac" description="LAN liveness hints only — the browser panel always uses this same DSH origin.">
          <span className="dsh-watch-settings__value dsh-watch-settings__mono">
            {(status.hostCandidates.length > 0 ? status.hostCandidates : ['127.0.0.1']).join(', ')}:{status.port}
          </span>
        </Row>
      </Group>

      <Group
        title="Pending watch requests"
        description={status.pending.length === 0
          ? 'No watch is waiting for approval. Start pairing on the watch to create a request (expires in 2 minutes).'
          : 'Approve ONLY the request whose fingerprint you compared above. Approve needs the row checkbox; Reject (deny) needs no fingerprint proof and works immediately.'}
      >
        {status.pending.length === 0
          ? <Row title="No pending requests" description="The list refreshes automatically while this page is open.">
            <span className="dsh-watch-settings__value">—</span>
          </Row>
          : status.pending.map((row) => {
            const isConfirmed = confirmed[row.requestId] === true
            const isBusy = busy[row.requestId] === true
            const err = rowError[row.requestId]
            return <div key={row.requestId} className="dsh-watch-settings__pending">
              <Row title={row.deviceAlias} description={`${row.deviceKind} · ${formatExpiry(row.expiresAtMs)} · ${row.attemptsLeft} attempts left`}>
                <span className="dsh-watch-settings__value dsh-watch-settings__mono">{row.requestId.slice(0, 8)}…</span>
              </Row>
              <label className="dsh-watch-settings__confirm">
                <input
                  type="checkbox"
                  checked={isConfirmed}
                  disabled={isBusy}
                  onChange={(event) => props.onToggleConfirm(row.requestId, event.currentTarget.checked)}
                />
                <span>I compared the FULL fingerprint on both screens — it matches.</span>
              </label>
              {err ? <div className="dsh-watch-settings__error" role="alert">{err}</div> : null}
              <div className="dsh-watch-settings__actions">
                <button
                  type="button"
                  className="dsh-watch-settings__button dsh-watch-settings__button--primary"
                  disabled={!isConfirmed || isBusy}
                  onClick={() => props.onApprove(row.requestId)}
                >
                  {isBusy ? 'Working…' : 'Approve'}
                </button>
                <button
                  type="button"
                  className="dsh-watch-settings__button dsh-watch-settings__button--danger"
                  disabled={isBusy}
                  onClick={() => props.onReject(row.requestId)}
                >
                  {isBusy ? 'Working…' : 'Reject'}
                </button>
              </div>
            </div>
          })}
        {props.pollStopped === true && status.pending.length === 0 && props.onResumePoll ? <Row title="Auto-refresh paused" description="Stopped after 2 minutes. Resume watching for the next pairing request.">
          <button type="button" className="dsh-watch-settings__button" onClick={props.onResumePoll}>
            Resume watching
          </button>
        </Row> : null}
      </Group>

      <Group title="Paired devices" description="Revoke removes the device secret on the server. The panel never shows tokens or session secrets — identifiers only.">
        {status.devices.length === 0
          ? <Row title="No paired devices" description="Approved watches appear here."><span className="dsh-watch-settings__value">—</span></Row>
          : status.devices.map((device) => <Row
            key={device.deviceId}
            title={device.deviceAlias}
            description={`${device.deviceKind} · ${device.revoked ? 'revoked' : 'paired'}`}
          >
            {device.revoked
              ? <span className="dsh-watch-settings__value">Revoked</span>
              : <button
                type="button"
                className="dsh-watch-settings__button dsh-watch-settings__button--danger"
                disabled={revokeBusy[device.deviceId] === true}
                onClick={() => props.onRevoke?.(device.deviceId)}
              >
                {revokeBusy[device.deviceId] === true ? 'Revoking…' : 'Revoke'}
              </button>}
          </Row>)}
      </Group>
    </> : null}

    {!loading && !status && !error ? <div className="dsh-watch-settings__notice">
      <button type="button" className="dsh-watch-settings__button" onClick={props.onRetry}>Load status</button>
    </div> : null}
  </div>
}

export function WatchSettingsSection({ fetchImpl }: { readonly fetchImpl?: FetchImpl } = {}): JSX.Element {
  const implRef = useRef<FetchImpl | undefined>(fetchImpl)
  implRef.current = fetchImpl
  const [status, setStatus] = useState<PairStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [rowError, setRowError] = useState<Record<string, string>>({})
  const [setupConsent, setSetupConsent] = useState(false)
  const [setupBusy, setSetupBusy] = useState(false)
  const [setupError, setSetupError] = useState<string | null>(null)
  const [revokeBusy, setRevokeBusy] = useState<Record<string, boolean>>({})
  const [pollKey, setPollKey] = useState(0)
  const [pollStopped, setPollStopped] = useState(false)

  const load = useCallback(async (signal: AbortSignal, silent: boolean): Promise<PairStatus | null> => {
    if (!silent) {
      setLoading(true)
      setError(null)
    }
    try {
      const impl = implRef.current
      const next = impl ? await fetchPairStatus(impl, signal) : await fetchPairStatus(undefined, signal)
      if (signal.aborted) return null
      setStatus(next)
      setError(null)
      return next
    } catch (cause) {
      if (signal.aborted) return null
      const message = cause instanceof Error ? cause.message : 'Could not load watch pairing status.'
      if (!silent) setError(message)
      return null
    } finally {
      if (!signal.aborted && !silent) setLoading(false)
    }
  }, [])

  // Initial load + bounded pending poll. Exactly one poller per mount cycle
  // (StrictMode-safe: the effect cleanup aborts the controller and clears
  // the timer). After ~2min the poller stops and offers resume; bumping
  // pollKey (retry/resume) starts a fresh bounded cycle.
  useEffect(() => {
    const controller = new AbortController()
    let rounds = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    setPollStopped(false)
    void (async () => {
      const first = await load(controller.signal, false)
      const tick = async (): Promise<void> => {
        if (controller.signal.aborted) return
        if (rounds >= PAIR_POLL_MAX_ROUNDS) {
          setPollStopped(true)
          setNotice('Stopped auto-refreshing after 2 minutes. Use Resume watching to keep watching.')
          return
        }
        rounds += 1
        const next = await load(controller.signal, true)
        if (controller.signal.aborted) return
        if (next && next.pending.length === 0) {
          // Keep watching for the next pairing request until the round
          // budget is spent — a re-pair after expiry must still appear.
          timer = setTimeout(() => void tick(), PAIR_POLL_INTERVAL_MS)
          return
        }
        timer = setTimeout(() => void tick(), PAIR_POLL_INTERVAL_MS)
      }
      // Always keep the bounded poller running (even with zero pending) so
      // a watch that starts pairing AFTER the page loads still appears.
      if (first) timer = setTimeout(() => void tick(), PAIR_POLL_INTERVAL_MS)
    })()
    return () => {
      controller.abort()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [load, pollKey])

  const retry = useCallback(() => {
    setNotice(null)
    setPollStopped(false)
    setPollKey((k) => k + 1)
  }, [])

  const resumePoll = useCallback(() => {
    setNotice(null)
    setPollStopped(false)
    setPollKey((k) => k + 1)
  }, [])

  const decide = useCallback(async (requestId: string, approve: boolean) => {
    setBusy((current) => ({ ...current, [requestId]: true }))
    setRowError((current) => {
      const next = { ...current }
      delete next[requestId]
      return next
    })
    try {
      const impl = implRef.current
      // Approve carries the fingerprint compare proof; Reject (deny) is
      // identifier-only and needs no fingerprint proof.
      const result = approve
        ? (impl
          ? await approvePair(requestId, true, true, impl)
          : await approvePair(requestId, true, true))
        : (impl
          ? await denyPair(requestId, impl)
          : await denyPair(requestId))
      setNotice(`Request ${result.requestId.slice(0, 8)}… ${result.status}.`)
      setConfirmed((current) => {
        const next = { ...current }
        delete next[requestId]
        return next
      })
      const controller = new AbortController()
      await load(controller.signal, true)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Approval failed.'
      setRowError((current) => ({ ...current, [requestId]: message }))
    } finally {
      setBusy((current) => {
        const next = { ...current }
        delete next[requestId]
        return next
      })
    }
  }, [load])

  const runSetup = useCallback(async () => {
    // Explicit-consent gate: the route is called ONLY with consent:true
    // after the user ticked the box. Never on boot, never from re-check.
    if (!setupConsent || setupBusy) return
    setSetupBusy(true)
    setSetupError(null)
    try {
      const impl = implRef.current
      const out = impl
        ? await setupVoiceBackend(true, impl)
        : await setupVoiceBackend(true)
      const label = typeof out.message === 'string' && out.message ? `: ${out.message}` : ''
      setNotice(`Voice backend ${out.status}${label}.`)
      const controller = new AbortController()
      await load(controller.signal, true)
    } catch (cause) {
      setSetupError(cause instanceof Error ? cause.message : 'Voice setup failed.')
    } finally {
      setSetupBusy(false)
    }
  }, [load, setupConsent, setupBusy])

  const runRevoke = useCallback(async (deviceId: string) => {
    if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
      if (!window.confirm(`Revoke ${deviceId}? The watch will need to pair again.`)) return
    }
    setRevokeBusy((current) => ({ ...current, [deviceId]: true }))
    try {
      const impl = implRef.current
      const out = impl
        ? await revokePairedDevice(deviceId, impl)
        : await revokePairedDevice(deviceId)
      setNotice(`Device ${out.deviceId} ${out.status}.`)
      const controller = new AbortController()
      await load(controller.signal, true)
    } catch (cause) {
      setNotice(null)
      setError(cause instanceof Error ? cause.message : 'Revoke failed.')
    } finally {
      setRevokeBusy((current) => {
        const next = { ...current }
        delete next[deviceId]
        return next
      })
    }
  }, [load])

  return <WatchSettingsView
    status={status}
    loading={loading}
    error={error}
    notice={notice}
    confirmed={confirmed}
    busy={busy}
    rowError={rowError}
    onToggleConfirm={(requestId, checked) => setConfirmed((current) => ({ ...current, [requestId]: checked }))}
    onApprove={(requestId) => void decide(requestId, true)}
    onReject={(requestId) => void decide(requestId, false)}
    onRetry={retry}
    onResumePoll={resumePoll}
    pollStopped={pollStopped}
    setupConsent={setupConsent}
    setupBusy={setupBusy}
    setupError={setupError}
    onToggleSetupConsent={(checked) => setSetupConsent(checked)}
    onSetupVoice={() => void runSetup()}
    revokeBusy={revokeBusy}
    onRevoke={(deviceId) => void runRevoke(deviceId)}
  />
}
