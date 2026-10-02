/** Dictate (STT-only) controller: Apple on-device Speech via the existing helper.
 * Unlike Live Voice, finals are inserted into the composer draft and never auto-sent. */

const EVENTS_PATH = '/dsh-kokoro-live-voice/events'
const COMMAND_PATH = '/dsh-kokoro-live-voice/command'

export type DictatePhase = 'idle' | 'listening' | 'hearing' | 'error'

export interface DictateState {
  readonly phase: DictatePhase
  readonly ownedSessionId?: string
  readonly interim?: string
  readonly message?: string
}

type Listener = () => void
type RuntimeMessage = Record<string, unknown>

function newClientId(): string {
  try {
    const uuid = globalThis.crypto?.randomUUID?.()
    if (typeof uuid === 'string' && uuid.length > 0) return uuid
  } catch { /* fall through */ }
  return `dictate-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`
}

function newLeaseId(): string {
  try {
    const uuid = globalThis.crypto?.randomUUID?.()
    if (typeof uuid === 'string' && uuid.length > 0) return uuid
  } catch { /* fall through */ }
  return `lease-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`
}

class DictateController {
  private readonly clientId = newClientId()
  private eventSource: EventSource | undefined
  private leaseId: string | undefined
  private ownedSessionId: string | undefined
  private interim = ''
  private message: string | undefined
  private phase: DictatePhase = 'idle'
  private readonly listeners = new Set<Listener>()
  private onFinalText: ((text: string) => void) | undefined
  // useSyncExternalStore requires a cached snapshot identity: a fresh object
  // per read forces an infinite re-render (and unmounts the mic entry).
  private snapshot: DictateState = { phase: 'idle' }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): DictateState => this.snapshot

  private sync(): void {
    this.snapshot = {
      phase: this.phase,
      ...(this.ownedSessionId ? { ownedSessionId: this.ownedSessionId } : {}),
      ...(this.interim ? { interim: this.interim } : {}),
      ...(this.message ? { message: this.message } : {}),
    }
    for (const listener of this.listeners) listener()
  }

  connect(): void {
    if (!this.eventSource) this.ensureEvents()
  }

  /** Start Apple-STT dictation for one session. Finals call onFinal instead of prompting. */
  async start(sessionId: string, onFinal: (text: string) => void): Promise<void> {
    const target = String(sessionId)
    if (this.leaseId && this.ownedSessionId === target) return
    if (this.leaseId) await this.stop()
    this.onFinalText = onFinal
    const leaseId = newLeaseId()
    this.leaseId = leaseId
    this.ownedSessionId = target
    this.interim = ''
    this.message = undefined
    this.setPhase('listening')
    if (!this.eventSource) this.ensureEvents()
    try {
      await this.command({ command: 'dictate-start', sessionId: target, leaseId })
    } catch (error) {
      this.releaseOwnership()
      this.setPhase('error', error instanceof Error ? error.message : String(error))
    }
  }

  async stop(): Promise<void> {
    if (!this.leaseId) return
    try {
      await this.command({ command: 'dictate-stop' })
    } catch { /* local teardown stays authoritative */ }
    this.releaseOwnership()
    this.setPhase('idle')
  }

  private setPhase(phase: DictatePhase, message?: string): void {
    this.phase = phase
    this.message = message
    this.sync()
  }

  private setInterim(interim: string): void {
    this.interim = interim
    this.sync()
  }

  private releaseOwnership(): void {
    this.leaseId = undefined
    this.ownedSessionId = undefined
    this.interim = ''
    this.onFinalText = undefined
  }

  private ensureEvents(): void {
    this.eventSource?.close()
    const parameters = new URLSearchParams({ clientId: this.clientId })
    const source = new EventSource(`${EVENTS_PATH}?${parameters}`, { withCredentials: true })
    this.eventSource = source
    source.onmessage = (event) => {
      let message: RuntimeMessage
      try {
        const value: unknown = JSON.parse(event.data)
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return
        message = value as RuntimeMessage
      } catch { return }
      this.handleRuntimeMessage(message)
    }
    source.onerror = () => {
      if (this.ownedSessionId) this.setPhase('error', 'The local dictation connection was interrupted.')
    }
  }

  private ownsEvent(message: RuntimeMessage): boolean {
    return Boolean(
      this.leaseId
      && this.ownedSessionId
      && message.clientId === this.clientId
      && message.leaseId === this.leaseId
      && message.sessionId === this.ownedSessionId,
    )
  }

  private handleRuntimeMessage(message: RuntimeMessage): void {
    switch (message.event) {
      case 'dictate-partial':
        if (!this.ownsEvent(message) || typeof message.text !== 'string') break
        this.setPhase('hearing')
        this.setInterim(message.text.trim())
        break
      case 'dictate-final':
        if (!this.ownsEvent(message) || typeof message.text !== 'string') break
        this.setInterim('')
        this.setPhase('listening')
        this.onFinalText?.(message.text)
        break
      case 'dictate-error':
        if (!this.ownsEvent(message)) break
        this.setPhase('error', typeof message.message === 'string' ? message.message : 'Apple Speech failed.')
        break
      case 'ownership-revoked':
        if (typeof message.leaseId === 'string' && message.leaseId === this.leaseId) {
          this.releaseOwnership()
          this.setPhase('idle')
        }
        break
      default:
        break
    }
  }

  private async command(body: RuntimeMessage): Promise<void> {
    const payload = {
      clientId: this.clientId,
      ...(this.leaseId ? { leaseId: this.leaseId } : {}),
      ...body,
    }
    const response = await fetch(COMMAND_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
    })
    if (response.ok) return
    const value: unknown = await response.json().catch(() => undefined)
    const text = typeof value === 'object' && value !== null && 'error' in value && typeof value.error === 'string'
      ? value.error
      : `Dictation request failed (${response.status}).`
    throw new Error(text)
  }
}

export const dictateController = new DictateController()
