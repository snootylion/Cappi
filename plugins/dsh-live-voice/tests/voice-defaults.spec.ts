import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  DEFAULT_VOICE_DEFAULTS,
  defaultLiveVoiceRoot,
  defaultSpeechLocale,
  defaultSummaryRoot,
  defaultVoiceSettingsPath,
  describeVoiceHost,
  isSpeechLocaleTag,
} from '../src/voice-defaults.ts'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('portable voice defaults', () => {
  it('keeps documented provider, locale, and voice defaults', () => {
    expect(DEFAULT_VOICE_DEFAULTS.ttsBackend).toBe('kokoro')
    expect(DEFAULT_VOICE_DEFAULTS.voice).toBe('af_heart')
    expect(DEFAULT_VOICE_DEFAULTS.pocketVoice).toBe('alba')
    // The baked-in fallback is the neutral en-US, never a personal locale.
    expect(DEFAULT_VOICE_DEFAULTS.locale).toBe('en-US')
    expect(DEFAULT_VOICE_DEFAULTS.holdingPhraseProvider).toBe('local-mlx')
    expect(DEFAULT_VOICE_DEFAULTS.summaryBackend).toBe('local-mlx')
  })

  it('prefers an explicit locale override, then system, then neutral en-US', () => {
    vi.stubEnv('DSH_LIVE_VOICE_LOCALE', 'fr-FR')
    expect(defaultSpeechLocale()).toBe('fr-FR')

    vi.stubEnv('DSH_LIVE_VOICE_LOCALE', 'not a locale!')
    const fallback = defaultSpeechLocale()
    expect(isSpeechLocaleTag(fallback)).toBe(true)
    expect(fallback).toBe(systemLocaleOrNeutral())

    vi.stubEnv('DSH_LIVE_VOICE_LOCALE', '')
    expect(defaultSpeechLocale()).toBe(systemLocaleOrNeutral())
  })

  it('pins model revisions for opt-in downloads', () => {
    expect(DEFAULT_VOICE_DEFAULTS.kokoroModelRepo).toBe('mlx-community/Kokoro-82M-bf16')
    expect(DEFAULT_VOICE_DEFAULTS.kokoroModelRevision).toBe('a71e4d38b236d968966a2002c4c895dbd12b1c3c')
    expect(DEFAULT_VOICE_DEFAULTS.summaryModelRepo).toBe('cof139/G9v3-3B-mlx-4Bit')
    expect(DEFAULT_VOICE_DEFAULTS.summaryModelRevision).toBe('076ed58eed5a29dc7a27cf16d184db59550f09cb')
    expect(DEFAULT_VOICE_DEFAULTS.pocketTtsVersion).toBe('3.0.2')
  })

  it('roots every default path under the configurable live-voice root', () => {
    vi.stubEnv('DSH_LIVE_VOICE_ROOT', '/tmp/voice-defaults-root')
    expect(defaultLiveVoiceRoot()).toBe('/tmp/voice-defaults-root')
    expect(defaultVoiceSettingsPath()).toBe('/tmp/voice-defaults-root/settings.json')
  })

  it('keeps the summary root independently configurable', () => {
    vi.stubEnv('DSH_KOKORO_SUMMARY_ROOT', '/tmp/voice-summary-root')
    expect(defaultSummaryRoot()).toBe('/tmp/voice-summary-root')
  })
})

describe('host capability reporting', () => {
  it('reports full support on Apple silicon macOS', () => {
    const host = describeVoiceHost('darwin', 'arm64')
    expect(host.appleSpeech).toBe('full')
    expect(host.kokoroTts).toBe('full')
    expect(host.localSummary).toBe('full')
    expect(host.clientUi).toBe('full')
    expect(host.reasons).toEqual({})
  })

  it('honestly degrades on other hosts instead of claiming support', () => {
    const linux = describeVoiceHost('linux', 'x64')
    expect(linux.appleSpeech).toBe('unavailable')
    expect(linux.kokoroTts).toBe('unavailable')
    expect(linux.localSummary).toBe('unavailable')
    expect(linux.clientUi).toBe('full')
    expect(Object.keys(linux.reasons)).toHaveLength(3)

    const intelMac = describeVoiceHost('darwin', 'x64')
    expect(intelMac.appleSpeech).toBe('full')
    expect(intelMac.kokoroTts).toBe('unavailable')
    expect(intelMac.localSummary).toBe('unavailable')
  })
})

function systemLocaleOrNeutral(): string {
  try {
    const tag = new Intl.DateTimeFormat().resolvedOptions().locale
    if (tag && isSpeechLocaleTag(tag)) return tag
  } catch {
    // Intl unavailable: the neutral fallback below applies.
  }
  return 'en-US'
}
