import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { liveVoiceController, type VoiceTtsBackend } from './controller.ts'

type VoicePhase = 'idle' | 'starting' | 'listening' | 'hearing' | 'thinking' | 'speaking' | 'muted' | 'error'

type VoiceSettings = {
  readonly ttsBackend: VoiceTtsBackend
  readonly voice: string
  readonly pocketVoice: string
  readonly locale: string
  readonly endTurnMs: number
  readonly speechRate: number
  readonly acknowledgementDelayMs: number
  readonly holdingPhraseDelayMs: number
}

type RuntimeStatus = {
  readonly phase?: VoicePhase
  readonly active?: boolean
  readonly tts?: { readonly backend?: VoiceTtsBackend }
  readonly summary?: { readonly kind?: string; readonly state?: string }
  readonly holding?: { readonly provider?: string; readonly delayMs?: number }
}

const DEFAULTS: VoiceSettings = {
  ttsBackend: 'kokoro',
  voice: 'af_heart',
  pocketVoice: 'alba',
  locale: 'en-US',
  endTurnMs: 1_500,
  speechRate: 1,
  acknowledgementDelayMs: 250,
  holdingPhraseDelayMs: 550,
}

const KOKORO_VOICES = [
  { value: 'af_heart', label: 'Heart · Female · US · default' },
  { value: 'af_alloy', label: 'Alloy · Female · US' },
  { value: 'af_aoede', label: 'Aoede · Female · US' },
  { value: 'af_bella', label: 'Bella · Female · US' },
  { value: 'af_jessica', label: 'Jessica · Female · US' },
  { value: 'af_kore', label: 'Kore · Female · US' },
  { value: 'af_nicole', label: 'Nicole · Female · US' },
  { value: 'af_nova', label: 'Nova · Female · US' },
  { value: 'af_river', label: 'River · Female · US' },
  { value: 'af_sarah', label: 'Sarah · Female · US' },
  { value: 'af_sky', label: 'Sky · Female · US' },
  { value: 'bf_alice', label: 'Alice · Female · British' },
  { value: 'bf_emma', label: 'Emma · Female · British' },
  { value: 'bf_isabella', label: 'Isabella · Female · British' },
  { value: 'bf_lily', label: 'Lily · Female · British' },
] as const
const POCKET_VOICES = [
  { value: 'alba', label: 'Alba · English · default' },
  { value: 'marius', label: 'Marius · English' },
  { value: 'javert', label: 'Javert · English' },
  { value: 'jean', label: 'Jean · English' },
  { value: 'fantine', label: 'Fantine · English' },
  { value: 'cosette', label: 'Cosette · English' },
  { value: 'eponine', label: 'Eponine · English' },
  { value: 'azelma', label: 'Azelma · English' },
] as const
const LOCALES = [
  ['en-US', 'English · United States'],
  ['en-AU', 'English · Australia'],
  ['en-GB', 'English · United Kingdom'],
  ['fr-FR', 'French · France'],
  ['de-DE', 'German · Germany'],
  ['es-ES', 'Spanish · Spain'],
  ['it-IT', 'Italian · Italy'],
  ['pt-PT', 'Portuguese · Portugal'],
] as const

function Group({ title, description, children }: { readonly title: string; readonly description?: string; readonly children: ReactNode }): JSX.Element {
  return <section className="dsh-live-voice-settings__group">
    <h2 className="dsh-live-voice-settings__group-title">{title}</h2>
    {description ? <p className="dsh-live-voice-settings__group-description">{description}</p> : null}
    {children}
  </section>
}

function Row({ title, description, children }: { readonly title: string; readonly description: string; readonly children: ReactNode }): JSX.Element {
  return <div className="dsh-live-voice-settings__row">
    <div className="dsh-live-voice-settings__copy">
      <div className="dsh-live-voice-settings__label">{title}</div>
      <div className="dsh-live-voice-settings__description">{description}</div>
    </div>
    <div className="dsh-live-voice-settings__control">{children}</div>
  </div>
}

function Range({ label, value, min, max, step, format, disabled, onChange }: {
  readonly label: string
  readonly value: number
  readonly min: number
  readonly max: number
  readonly step: number
  readonly format: (value: number) => string
  readonly disabled: boolean
  readonly onChange: (value: number) => void
}): JSX.Element {
  return <label className="dsh-live-voice-settings__range">
    <input aria-label={label} type="range" min={min} max={max} step={step} value={value} disabled={disabled} onChange={(event) => onChange(Number(event.currentTarget.value))} />
    <output>{format(value)}</output>
  </label>
}

export function LiveVoiceSettingsSection(): JSX.Element {
  const [settings, setSettings] = useState<VoiceSettings>(DEFAULTS)
  const [runtime, setRuntime] = useState<RuntimeStatus>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const controllerState = liveVoiceController.getSnapshot()
  const active = Boolean(controllerState.activeSessionId || runtime.active)

  const load = useCallback(async () => {
    try {
      const [settingsResponse, statusResponse] = await Promise.all([
        fetch('/dsh-kokoro-live-voice/settings', { headers: { accept: 'application/json' } }),
        fetch('/dsh-kokoro-live-voice/status', { headers: { accept: 'application/json' } }),
      ])
      const next = await settingsResponse.json() as VoiceSettings & { error?: string }
      const status = await statusResponse.json() as RuntimeStatus
      if (!settingsResponse.ok) throw new Error(next.error ?? 'Could not load Live Voice settings.')
      setSettings({ ...DEFAULTS, ...next })
      setRuntime(status)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load Live Voice settings.')
    }
  }, [])

  useEffect(() => {
    void load()
    return liveVoiceController.subscribe(() => {
      const next = liveVoiceController.getSnapshot()
      setRuntime((current) => ({ ...current, phase: next.phase, active: Boolean(next.activeSessionId), tts: { backend: next.ttsBackend } }))
    })
  }, [load])

  const update = useCallback(async (patch: Partial<VoiceSettings>) => {
    if (active || busy) return
    setBusy(true)
    setError(undefined)
    setSettings((current) => ({ ...current, ...patch }))
    try {
      const response = await fetch('/dsh-kokoro-live-voice/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ patch }),
      })
      const body = await response.json() as VoiceSettings & { error?: string }
      if (!response.ok) throw new Error(body.error ?? 'Could not save Live Voice settings.')
      setSettings({ ...DEFAULTS, ...body })
      setRuntime((current) => ({ ...current, tts: { backend: body.ttsBackend } }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save Live Voice settings.')
      await load()
    } finally {
      setBusy(false)
    }
  }, [active, busy, load])

  const backend = settings.ttsBackend
  const voiceOptions = backend === 'pocket' ? POCKET_VOICES : KOKORO_VOICES
  const currentVoice = backend === 'pocket' ? settings.pocketVoice : settings.voice
  const displayPhase = runtime.phase ?? controllerState.phase
  const summaryState = runtime.summary?.state ?? 'cold'
  const provider = runtime.holding?.provider ?? 'local-mlx'
  const holdingDelay = runtime.holding?.delayMs ?? settings.holdingPhraseDelayMs

  return <div className="dsh-live-voice-settings">
    <div className="dsh-live-voice-settings__hero">
      <div>
        <h1 className="dsh-live-voice-settings__title">Live Voice</h1>
        <p className="dsh-live-voice-settings__intro">Speak with local, on-device transcription and private speech rendering. Settings are saved under DeepSeek Harness and apply to the next Live Voice session.</p>
      </div>
      <div className="dsh-live-voice-settings__summary">{active ? 'Active' : 'Idle'} · {backend === 'pocket' ? 'Pocket TTS' : 'Kokoro'}</div>
    </div>

    {error ? <div className="dsh-live-voice-settings__error" role="alert">{error}</div> : null}
    {active ? <div className="dsh-live-voice-settings__notice">End Live Voice before changing settings. The current microphone session is not interrupted by this page.</div> : null}

    <Group title="Speech" description="Choose which local TTS runtime and voice speaks assistant responses. Kokoro remains the default; Pocket TTS is an optional CPU-oriented alternative.">
      <Row title="Speech engine" description={busy ? 'Applying…' : 'Switching engines is available while Live Voice is idle.'}>
        <select aria-label="Live Voice speech engine" className="dsh-live-voice-settings__select" value={backend} disabled={active || busy} onChange={(event) => void update({ ttsBackend: event.currentTarget.value === 'pocket' ? 'pocket' : 'kokoro' })}>
          <option value="kokoro">Kokoro-82M · MLX</option>
          <option value="pocket">Pocket TTS · CPU</option>
        </select>
      </Row>
      <Row title="Voice" description={backend === 'pocket' ? 'Pocket’s bundled voice; more voices require separately licensed assets.' : 'The installed Kokoro voice asset on this Mac.'}>
        <select aria-label="Live Voice voice" className="dsh-live-voice-settings__select" value={currentVoice} disabled={active || busy} onChange={(event) => void update(backend === 'pocket' ? { pocketVoice: event.currentTarget.value } : { voice: event.currentTarget.value })}>
          {voiceOptions.map((voice) => <option key={voice.value} value={voice.value}>{voice.label}</option>)}
        </select>
      </Row>
      <Row title="Recognition language" description="Locale used by Apple Speech for microphone transcription.">
        <select aria-label="Live Voice recognition language" className="dsh-live-voice-settings__select" value={settings.locale} disabled={active || busy} onChange={(event) => void update({ locale: event.currentTarget.value })}>
          {LOCALES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </Row>
    </Group>

    <Group title="Conversation timing" description="Tune how quickly Live Voice recognizes a turn and starts its short acknowledgement. Changes apply to the next utterance/session.">
      <Row title="End of turn" description="Pause that completes your utterance.">
        <Range label="End of turn pause" value={settings.endTurnMs} min={900} max={2_500} step={100} disabled={active || busy} format={(value) => `${value} ms`} onChange={(value) => void update({ endTurnMs: value })} />
      </Row>
      <Row title="Voice speed" description="Speech rate for both local engines.">
        <Range label="Voice speed" value={settings.speechRate} min={0.8} max={1.2} step={0.05} disabled={active || busy} format={(value) => `${value.toFixed(2)}×`} onChange={(value) => void update({ speechRate: value })} />
      </Row>
      <Row title="Acknowledgement delay" description="Delay before a short acknowledgement may be spoken.">
        <Range label="Acknowledgement delay" value={settings.acknowledgementDelayMs} min={0} max={1_000} step={50} disabled={active || busy} format={(value) => `${value} ms`} onChange={(value) => void update({ acknowledgementDelayMs: value })} />
      </Row>
      <Row title="Holding phrase deadline" description="Maximum wait for a contextual local holding phrase before the safe fallback.">
        <Range label="Holding phrase deadline" value={settings.holdingPhraseDelayMs} min={250} max={1_500} step={50} disabled={active || busy} format={(value) => `${value} ms`} onChange={(value) => void update({ holdingPhraseDelayMs: value })} />
      </Row>
    </Group>

    <Group title="Runtime" description="Diagnostics and model status for this Mac. No microphone audio is stored by Live Voice.">
      <Row title="Current phase" description="Live Voice runtime state."><span className="dsh-live-voice-settings__value">{displayPhase} · {active ? 'active' : 'idle'}</span></Row>
      <Row title="Holding phrases" description="Fast local context-aware acknowledgement provider."><span className="dsh-live-voice-settings__value">{provider} · {holdingDelay} ms</span></Row>
      <Row title="Private summary" description="Short local summary used for spoken responses."><span className="dsh-live-voice-settings__value">local MLX · {summaryState}</span></Row>
      <Row title="Storage" description="Models, caches, and saved settings remain under DeepSeek Harness-owned paths."><span className="dsh-live-voice-settings__value">On this Mac</span></Row>
    </Group>
  </div>
}
