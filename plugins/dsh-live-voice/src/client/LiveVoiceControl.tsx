import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { SessionFace, SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ChatSnapshot, UseChat } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { UseSession } from '@deepseek-ai/dsh-client-ui-session/client'
import { liveVoiceController } from './controller.ts'
import { getFloatingVoicePanelSnapshot, hasNativeVoiceHost, subscribeFloatingVoicePanel } from './native-host.ts'

export interface LiveVoiceControlInjected {
  readonly session: SessionFace
}

export interface LiveVoiceControlProps extends LiveVoiceControlInjected {
  readonly sessionId: SessionFace['sessionId']
  readonly useChat: UseChat
  readonly useSession: UseSession
}

const PHASE_LABELS = {
  idle: 'Voice chat',
  starting: 'Starting voice chat',
  listening: 'Listening',
  hearing: 'Hearing you',
  thinking: 'Working',
  speaking: 'Speaking',
  muted: 'Microphone muted',
  error: 'Live Voice error',
} as const

export function LiveVoiceControl({ session, sessionId, useChat, useSession }: LiveVoiceControlProps) {
  const state = useSyncExternalStore(liveVoiceController.subscribe.bind(liveVoiceController), liveVoiceController.getSnapshot, liveVoiceController.getSnapshot)
  const floatingPanel = useSyncExternalStore(subscribeFloatingVoicePanel, getFloatingVoicePanelSnapshot, () => false)
  const legacy = useChat((snapshot: ChatSnapshot) => snapshot.legacy)
  const running = useSession((snapshot: SessionSnapshot) => snapshot.running)
  const conversation = useMemo(() => ({ ...legacy, running }), [legacy, running])
  useEffect(() => liveVoiceController.updateConversation(String(sessionId), conversation), [sessionId, conversation])
  const active = state.ownedSessionId === String(sessionId)
  const label = active ? PHASE_LABELS[state.phase] : 'Start voice chat'

  return <>
    <button
      type="button"
      className={`dsh-kokoro-voice-button${active ? ' is-active' : ''}`}
      aria-label={label}
      title={label}
      onClick={() => active ? void liveVoiceController.stop() : void liveVoiceController.start(session, conversation)}
    >
      <WaveIcon />
    </button>
    {active && !hasNativeVoiceHost() && !floatingPanel ? <div className={`dsh-kokoro-overlay phase-${state.phase}`} role="status" aria-live="polite">
      <div className="dsh-kokoro-orb" aria-hidden="true"><span /></div>
      <span className="dsh-kokoro-status">{state.message ?? PHASE_LABELS[state.phase]}</span>
      <div className="dsh-kokoro-actions">
        <button type="button" aria-label={state.muted ? 'Unmute microphone' : 'Mute microphone'} onClick={() => void liveVoiceController.toggleMuted()}>
          {state.muted ? <MutedIcon /> : <MicIcon />}
        </button>
        <button type="button" aria-label="End voice chat" className="is-end" onClick={() => void liveVoiceController.stop()}>
          <StopIcon />
        </button>
      </div>
    </div> : null}
  </>
}

function WaveIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h2m2-4v8m4-12v16m4-13v10m4-7v4m2-2h-1" /></svg>
}

function MicIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M6 11a6 6 0 0 0 12 0M12 17v4m-3 0h6" /></svg>
}

function MutedIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 9v2a3 3 0 0 0 4.5 2.6M15 9V6a3 3 0 0 0-5.6-1.5M6 11a6 6 0 0 0 10 4.4M12 17v4m-3 0h6M4 4l16 16" /></svg>
}

function StopIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
}
