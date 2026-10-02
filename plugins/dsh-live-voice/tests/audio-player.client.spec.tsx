import { afterEach, describe, expect, it, vi } from 'vitest'
import { VoiceAudioPlayer } from '../src/client/controller.ts'

afterEach(() => vi.unstubAllGlobals())

describe('browser PCM playback', () => {
  it('finishes the scheduled sentence before a new speech ID and ignores duplicate chunks', () => {
    const starts: number[] = []
    const context = {
      currentTime: 1,
      state: 'running',
      destination: {},
      createGain: () => ({ gain: { value: 1 }, connect: () => undefined }),
      createDynamicsCompressor: () => ({
        threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 0 }, attack: { value: 0 }, release: { value: 0 }, connect: () => undefined,
      }),
      createBuffer: (_channels: number, length: number, sampleRate: number) => ({
        duration: length / sampleRate,
        getChannelData: () => new Float32Array(length),
      }),
      createBufferSource: () => ({
        buffer: undefined,
        onended: null,
        connect: () => undefined,
        start: (at: number) => starts.push(at),
        stop: () => undefined,
      }),
      resume: async () => undefined,
    }
    vi.stubGlobal('AudioContext', class { constructor() { return context } })
    const decodeBase64 = globalThis.atob.bind(globalThis)
    vi.stubGlobal('window', { atob: decodeBase64 })
    const bytes = new Uint8Array(new Float32Array([0.1, 0.2, 0.3, 0.4]).buffer)
    const pcmBase64 = btoa(String.fromCharCode(...bytes))
    const player = new VoiceAudioPlayer()

    player.play({ event: 'audio', speechId: 'opening-sentence', sequence: 0, sampleRate: 4, pcmBase64 })
    player.play({ event: 'audio', speechId: 'opening-sentence', sequence: 0, sampleRate: 4, pcmBase64 })
    player.play({ event: 'audio', speechId: 'summary-sentence', sequence: 0, sampleRate: 4, pcmBase64 })

    expect(starts).toEqual([1.025, 2.025])
  })

  it('drops stale in-flight chunks for cancelled speech instead of replaying the old tail', () => {
    const starts: number[] = []
    const context = {
      currentTime: 1,
      state: 'running',
      destination: {},
      createGain: () => ({ gain: { value: 1 }, connect: () => undefined }),
      createDynamicsCompressor: () => ({
        threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 0 }, attack: { value: 0 }, release: { value: 0 }, connect: () => undefined,
      }),
      createBuffer: (_channels: number, length: number, sampleRate: number) => ({
        duration: length / sampleRate,
        getChannelData: () => new Float32Array(length),
      }),
      createBufferSource: () => ({
        buffer: undefined,
        onended: null,
        connect: () => undefined,
        start: (at: number) => starts.push(at),
        stop: () => undefined,
      }),
      resume: async () => undefined,
    }
    vi.stubGlobal('AudioContext', class { constructor() { return context } })
    const decodeBase64 = globalThis.atob.bind(globalThis)
    vi.stubGlobal('window', { atob: decodeBase64 })
    const bytes = new Uint8Array(new Float32Array([0.1, 0.2, 0.3, 0.4]).buffer)
    const pcmBase64 = btoa(String.fromCharCode(...bytes))
    const player = new VoiceAudioPlayer()

    player.play({ event: 'audio', speechId: 'old-turn', sequence: 0, sampleRate: 4, pcmBase64 })
    player.cancel()
    // A chunk that was already in flight when cancel landed must not replay.
    player.play({ event: 'audio', speechId: 'old-turn', sequence: 1, sampleRate: 4, pcmBase64 })
    // The next turn still plays normally.
    player.play({ event: 'audio', speechId: 'new-turn', sequence: 0, sampleRate: 4, pcmBase64 })

    expect(starts).toHaveLength(2)
  })
})
