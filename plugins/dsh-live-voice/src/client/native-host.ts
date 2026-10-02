type NativeMessageHandler = { postMessage(message: unknown): void }

type FloatingPanelListener = () => void

const FLOATING_PANEL_ORIGIN = 'http://127.0.0.1:43129'
const FLOATING_PANEL_RETRY_MS = 2_000

let floatingPanelConnected = false
let floatingPanelProbeEnabled = false
let floatingPanelProbeInFlight = false
let floatingPanelTimer: ReturnType<typeof setTimeout> | undefined
let latestFloatingPanelState: Record<string, unknown> | undefined
const floatingPanelListeners = new Set<FloatingPanelListener>()

function nativeHandler(): NativeMessageHandler | undefined {
  const candidate = (window as Window & {
    webkit?: { messageHandlers?: { kokoroVoice?: NativeMessageHandler } }
  }).webkit?.messageHandlers?.kokoroVoice
  return candidate && typeof candidate.postMessage === 'function' ? candidate : undefined
}

export function hasNativeVoiceHost(): boolean {
  return nativeHandler() !== undefined
}

export function postNativeVoiceMessage(message: Record<string, unknown>): boolean {
  const handler = nativeHandler()
  if (!handler) return false
  try {
    handler.postMessage(message)
    return true
  } catch {
    return false
  }
}

export function getFloatingVoicePanelSnapshot(): boolean {
  return floatingPanelConnected
}

export function subscribeFloatingVoicePanel(listener: FloatingPanelListener): () => void {
  floatingPanelListeners.add(listener)
  return () => floatingPanelListeners.delete(listener)
}

export function connectFloatingVoicePanelHost(): () => void {
  floatingPanelProbeEnabled = true
  void probeFloatingPanel()
  return () => {
    floatingPanelProbeEnabled = false
    if (floatingPanelTimer !== undefined) clearTimeout(floatingPanelTimer)
    floatingPanelTimer = undefined
    setFloatingPanelConnected(false)
  }
}

export function postFloatingVoicePanelState(message: Record<string, unknown>): void {
  latestFloatingPanelState = message
  if (floatingPanelConnected) sendFloatingPanelState(message)
}

async function probeFloatingPanel(): Promise<void> {
  if (!floatingPanelProbeEnabled || floatingPanelProbeInFlight) return
  floatingPanelProbeInFlight = true
  floatingPanelTimer = undefined
  try {
    const response = await fetch(`${FLOATING_PANEL_ORIGIN}/health`, {
      cache: 'no-store',
      credentials: 'omit',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) throw new Error(`Floating Live Voice panel returned ${response.status}.`)
    const payload: unknown = await response.json()
    if (typeof payload !== 'object' || payload === null || !('service' in payload) || payload.service !== 'dsh-live-voice-panel') {
      throw new Error('Unexpected floating Live Voice panel response.')
    }
    setFloatingPanelConnected(true)
    if (latestFloatingPanelState) sendFloatingPanelState(latestFloatingPanelState)
  } catch {
    setFloatingPanelConnected(false)
    scheduleFloatingPanelProbe()
  } finally {
    floatingPanelProbeInFlight = false
  }
}

function scheduleFloatingPanelProbe(): void {
  if (!floatingPanelProbeEnabled || floatingPanelTimer !== undefined) return
  floatingPanelTimer = setTimeout(() => void probeFloatingPanel(), FLOATING_PANEL_RETRY_MS)
}

function sendFloatingPanelState(message: Record<string, unknown>): void {
  void fetch(`${FLOATING_PANEL_ORIGIN}/state`, {
    method: 'POST',
    cache: 'no-store',
    credentials: 'omit',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(message),
  }).then((response) => {
    if (!response.ok) throw new Error(`Floating Live Voice panel returned ${response.status}.`)
  }).catch(() => {
    setFloatingPanelConnected(false)
    scheduleFloatingPanelProbe()
  })
}

function setFloatingPanelConnected(connected: boolean): void {
  if (floatingPanelConnected === connected) return
  floatingPanelConnected = connected
  for (const listener of floatingPanelListeners) listener()
}
