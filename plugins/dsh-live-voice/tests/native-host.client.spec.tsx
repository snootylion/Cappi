import { afterEach, describe, expect, it, vi } from 'vitest'
import { LiveVoiceController } from '../src/client/controller.ts'
import {
  connectFloatingVoicePanelHost,
  getFloatingVoicePanelSnapshot,
  hasNativeVoiceHost,
  postFloatingVoicePanelState,
  postNativeVoiceMessage,
  subscribeFloatingVoicePanel,
} from '../src/client/native-host.ts'

afterEach(() => vi.unstubAllGlobals())

describe('native Dock host bridge', () => {
  it('forwards state and PCM messages when the native host is present', () => {
    const postMessage = vi.fn()
    vi.stubGlobal('window', { webkit: { messageHandlers: { kokoroVoice: { postMessage } } } })

    expect(hasNativeVoiceHost()).toBe(true)
    expect(postNativeVoiceMessage({ type: 'state', phase: 'speaking' })).toBe(true)
    expect(postMessage).toHaveBeenCalledWith({ type: 'state', phase: 'speaking' })
  })

  it('falls back cleanly in an ordinary browser', () => {
    vi.stubGlobal('window', {})
    expect(hasNativeVoiceHost()).toBe(false)
    expect(postNativeVoiceMessage({ type: 'audio' })).toBe(false)
  })

  it('discovers the shared launcher panel and forwards control state without taking browser audio ownership', async () => {
    vi.stubGlobal('window', {})
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ service: 'dsh-live-voice-panel' }) })
      .mockResolvedValueOnce({ ok: true })
    vi.stubGlobal('fetch', fetch)
    const listener = vi.fn()
    const unsubscribe = subscribeFloatingVoicePanel(listener)
    const disconnect = connectFloatingVoicePanelHost()
    try {
      await vi.waitFor(() => expect(getFloatingVoicePanelSnapshot()).toBe(true))
      expect(listener).toHaveBeenCalledTimes(1)
      expect(hasNativeVoiceHost()).toBe(false)

      postFloatingVoicePanelState({ type: 'state', active: true, phase: 'listening' })
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
      expect(fetch.mock.calls[1]?.[0]).toBe('http://127.0.0.1:43129/state')
    } finally {
      disconnect()
      unsubscribe()
    }
  })

  it('carries PCM over the Dock page bridge instead of requiring a second panel connection', () => {
    const postMessage = vi.fn()
    vi.stubGlobal('window', { webkit: { messageHandlers: { kokoroVoice: { postMessage } } } })
    const controller = new LiveVoiceController() as unknown as {
      handleRuntimeMessage(message: Record<string, unknown>): void
    }

    controller.handleRuntimeMessage({
      event: 'audio', speechId: 'sentence-1', sequence: 4, sampleRate: 24_000, pcmBase64: 'AAAAAA==',
    })

    expect(postMessage).toHaveBeenCalledWith({
      type: 'audio', event: 'audio', speechId: 'sentence-1', sequence: 4, sampleRate: 24_000, pcmBase64: 'AAAAAA==',
    })
  })

  it('does not let an inactive background browser play another page’s audio', () => {
    const AudioContext = vi.fn()
    vi.stubGlobal('window', {})
    vi.stubGlobal('AudioContext', AudioContext)
    const controller = new LiveVoiceController() as unknown as {
      handleRuntimeMessage(message: Record<string, unknown>): void
    }

    controller.handleRuntimeMessage({
      event: 'audio', speechId: 'sentence-1', sequence: 0, sampleRate: 24_000, pcmBase64: 'AAAAAA==',
    })

    expect(AudioContext).not.toHaveBeenCalled()
  })
})
