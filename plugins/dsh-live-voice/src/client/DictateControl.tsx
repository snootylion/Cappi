import { useEffect, useRef, useSyncExternalStore } from 'react'
import { dictateController } from './dictate.ts'

/** Structural slot props: session scope always provides these; keep loose to survive branded ids. */
interface DictateSlotProps {
  readonly sessionId: unknown
  readonly useInput: (selector: (state: { draft?: unknown }) => unknown) => unknown
  readonly inputActions?: { setDraft?: (text: string) => void } | undefined
}

function draftText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function DictateControl({ sessionId, useInput, inputActions }: DictateSlotProps) {
  const state = useSyncExternalStore(
    dictateController.subscribe,
    dictateController.getSnapshot,
    dictateController.getSnapshot,
  )
  const draft = draftText(useInput((s) => s.draft))
  const draftRef = useRef(draft)
  draftRef.current = draft
  const actionsRef = useRef(inputActions)
  actionsRef.current = inputActions

  useEffect(() => {
    dictateController.connect()
  }, [])

  const target = String(sessionId ?? '')
  const active = Boolean(target) && state.ownedSessionId === target
  const listening = active && (state.phase === 'listening' || state.phase === 'hearing')
  const label = !active
    ? 'Dictate message'
    : state.phase === 'error'
      ? `Dictation error${state.message ? `: ${state.message}` : ''}`
      : state.phase === 'hearing'
        ? `Hearing you${state.interim ? `: ${state.interim}` : ''}`
        : 'Stop dictation'

  // Release the microphone when this composer unmounts (e.g. session switch).
  useEffect(() => () => {
    if (dictateController.getSnapshot().ownedSessionId === target && target) void dictateController.stop()
  }, [target])

  if (!target) return null

  const appendFinal = (text: string) => {
    const cleaned = text.trim()
    if (!cleaned) return
    const setDraft = actionsRef.current?.setDraft
    if (typeof setDraft !== 'function') return
    const current = draftRef.current
    const separator = current && !/\s$/.test(current) ? ' ' : ''
    setDraft(`${current}${separator}${cleaned}`)
  }

  return (
    <button
      type="button"
      className={`dsh-kokoro-voice-button dsh-kokoro-dictate-button${listening ? ' is-active' : ''}`}
      aria-label={label}
      title={state.interim && active ? state.interim : label}
      data-dictate-phase={state.phase}
      onClick={() => {
        if (active) void dictateController.stop()
        else void dictateController.start(target, appendFinal)
      }}
    >
      <MicIcon />
    </button>
  )
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M6 11a6 6 0 0 0 12 0M12 17v4m-3 0h6" />
    </svg>
  )
}
