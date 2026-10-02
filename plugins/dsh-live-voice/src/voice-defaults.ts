/**
 * Portable default configuration for the live-voice plugin.
 *
 * This module is the single home of every default the plugin applies when the
 * deployment leaves a setting blank: locales, voices, providers, models, model
 * revisions, and filesystem roots. All of them are plain data — the deployment
 * may override any of them through plugin config or the documented environment
 * variables — and none of them is a mandatory personal path.
 *
 * Host support is reported honestly through {@link describeVoiceHost}:
 * Apple-speech capture and the MLX runtimes are macOS-only capabilities.
 * Other hosts degrade to a documented subset instead of claiming full support.
 */

import { homedir } from 'node:os'
import path from 'node:path'

export type TtsBackendName = 'kokoro' | 'pocket'
export type SummaryBackendName = 'local-mlx' | 'harness-llm'
export type HoldingProviderName = 'local-mlx' | 'canned'

export interface VoiceDefaults {
  /** Default TTS engine. */
  readonly ttsBackend: TtsBackendName
  /** Default Kokoro voice id. */
  readonly voice: string
  /** Default Pocket TTS voice id. */
  readonly pocketVoice: string
  /** Default speech-recognition locale (BCP 47). */
  readonly locale: string
  /** Default end-of-turn delay, ms. */
  readonly endTurnMs: number
  /** Default speech rate multiplier. */
  readonly speechRate: number
  /** Default acknowledgement delay, ms. */
  readonly acknowledgementDelayMs: number
  /** Default holding-phrase provider. */
  readonly holdingPhraseProvider: HoldingProviderName
  /** Default holding-phrase delay, ms. */
  readonly holdingPhraseDelayMs: number
  /** Default private-summary backend. */
  readonly summaryBackend: SummaryBackendName
  /** Default summary model provider (explicit `harness-llm` opt-in only). */
  readonly summaryProvider: string
  /** Default summary model (explicit `harness-llm` opt-in only). */
  readonly summaryModel: string
  /** Default summary idle shutdown, ms. */
  readonly summaryIdleMs: number
  /** Default Kokoro model repo + pinned revision (opt-in download only). */
  readonly kokoroModelRepo: string
  readonly kokoroModelRevision: string
  /** Default local summary model repo + pinned revision (opt-in download only). */
  readonly summaryModelRepo: string
  readonly summaryModelRevision: string
  /** Default Pocket TTS package version (opt-in install only). */
  readonly pocketTtsVersion: string
}

export const DEFAULT_VOICE_DEFAULTS: VoiceDefaults = {
  ttsBackend: 'kokoro',
  voice: 'af_heart',
  pocketVoice: 'alba',
  // Neutral, documented fallback only: the effective default is
  // defaultSpeechLocale() (explicit override > system locale > this value).
  locale: 'en-US',
  endTurnMs: 1_500,
  speechRate: 1,
  acknowledgementDelayMs: 250,
  holdingPhraseProvider: 'local-mlx',
  holdingPhraseDelayMs: 550,
  summaryBackend: 'local-mlx',
  summaryProvider: 'openai-codex',
  summaryModel: 'gpt-5.4-mini',
  summaryIdleMs: 5 * 60_000,
  kokoroModelRepo: 'mlx-community/Kokoro-82M-bf16',
  kokoroModelRevision: 'a71e4d38b236d968966a2002c4c895dbd12b1c3c',
  summaryModelRepo: 'cof139/G9v3-3B-mlx-4Bit',
  summaryModelRevision: '076ed58eed5a29dc7a27cf16d184db59550f09cb',
  pocketTtsVersion: '3.0.2',
}

/** Product data directory name used for every default filesystem root. */
export const VOICE_PRODUCT_DIR = 'DeepSeek Harness'
/** Plugin data directory name under the product directory. */
export const VOICE_DATA_DIR = 'live-voice-kokoro'

/** Deployment-overridable live-voice filesystem root. */
export function defaultLiveVoiceRoot(): string {
  const override = process.env.DSH_LIVE_VOICE_ROOT?.trim()
  if (override) return resolveHome(override)
  return path.join(homedir(), 'Library', 'Application Support', VOICE_PRODUCT_DIR, VOICE_DATA_DIR)
}

export function defaultKokoroRoot(liveRoot: string = defaultLiveVoiceRoot()): string {
  return path.join(liveRoot, 'kokoro')
}

export function defaultPocketRoot(liveRoot: string = defaultLiveVoiceRoot()): string {
  return path.join(liveRoot, 'pocket-tts')
}

export function defaultSummaryRoot(): string {
  const override = process.env.DSH_KOKORO_SUMMARY_ROOT?.trim()
  if (override) return resolveHome(override)
  return path.join(defaultLiveVoiceRoot(), 'summary')
}

export function defaultVoiceSettingsPath(): string {
  const override = process.env.VOICE_SETTINGS_PATH?.trim()
  if (override) return resolveHome(override)
  return path.join(defaultLiveVoiceRoot(), 'settings.json')
}

export function defaultLocalMlxLeasePath(): string {
  const override = process.env.DSH_LOCAL_MLX_LEASE_PATH?.trim()
  if (override) return resolveHome(override)
  return path.join(
    homedir(),
    'Library',
    'Application Support',
    VOICE_PRODUCT_DIR,
    'local-model-coordination',
    'active.json',
  )
}

/**
 * Effective default speech-recognition locale (BCP 47) when neither plugin
 * config nor persisted settings names one. Precedence: explicit
 * `DSH_LIVE_VOICE_LOCALE` override, then the host system locale when it is a
 * well-formed tag, then the documented neutral `en-US` fallback. The previous
 * baked-in `en-AU` was a personal preference, not a product default.
 */
export function defaultSpeechLocale(): string {
  const override = process.env.DSH_LIVE_VOICE_LOCALE?.trim()
  if (override && isSpeechLocaleTag(override)) return override
  return systemSpeechLocale() ?? DEFAULT_VOICE_DEFAULTS.locale
}

export function isSpeechLocaleTag(value: string): boolean {
  return value.length <= 40 && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(value)
}

function systemSpeechLocale(): string | undefined {
  try {
    const tag = new Intl.DateTimeFormat().resolvedOptions().locale
    if (tag && isSpeechLocaleTag(tag)) return tag
  } catch {
    // Intl unavailable or misconfigured: fall through to the neutral default.
  }
  return undefined
}

/** Bootstrap Python used by installers; deployments override the path. */
export function defaultBootstrapPython(): string {
  return process.env.DSH_LIVE_VOICE_BOOTSTRAP_PYTHON?.trim()
    || process.env.DSH_KOKORO_BOOTSTRAP_PYTHON?.trim()
    || '/opt/homebrew/bin/python3.12'
}

export type VoiceCapability = 'full' | 'degraded' | 'unavailable'

export interface VoiceHostCapabilities {
  /** OS platform the report was computed for (defaults to the current host). */
  readonly platform: string
  readonly arch: string
  /** macOS Apple-speech input helper (on-device recognition). */
  readonly appleSpeech: VoiceCapability
  /** Kokoro MLX TTS sidecar (Apple-silicon MLX runtime). */
  readonly kokoroTts: VoiceCapability
  /** Local MLX summary/holding sidecar (Apple-silicon MLX runtime). */
  readonly localSummary: VoiceCapability
  /** Browser/client UI surface (works on any host with a browser). */
  readonly clientUi: VoiceCapability
  /** Human-readable reason for every non-`full` capability. */
  readonly reasons: Readonly<Record<string, string>>
}

/**
 * Honestly report what this host can do. macOS on Apple silicon is the only
 * fully supported host: elsewhere the native helper and MLX runtimes are
 * unavailable and the plugin degrades to its client UI plus explicit remote
 * summary opt-in instead of claiming support it does not have.
 */
export function describeVoiceHost(
  platform: string = process.platform,
  arch: string = process.arch,
): VoiceHostCapabilities {
  const reasons: Record<string, string> = {}
  const isMac = platform === 'darwin'
  const isAppleSilicon = arch === 'arm64'
  if (!isMac) {
    reasons.appleSpeech = 'The input helper uses macOS Apple Speech and Xcode compilation; it is unavailable on this platform.'
    reasons.kokoroTts = 'The Kokoro MLX runtime requires macOS on Apple silicon; it is unavailable on this platform.'
    reasons.localSummary = 'The local MLX summary runtime requires macOS on Apple silicon; it is unavailable on this platform.'
  } else if (!isAppleSilicon) {
    reasons.kokoroTts = 'The Kokoro MLX runtime requires Apple silicon; it is unavailable on this Mac.'
    reasons.localSummary = 'The local MLX summary runtime requires Apple silicon; it is unavailable on this Mac.'
  }
  return {
    platform,
    arch,
    appleSpeech: isMac ? 'full' : 'unavailable',
    kokoroTts: isMac && isAppleSilicon ? 'full' : 'unavailable',
    localSummary: isMac && isAppleSilicon ? 'full' : 'unavailable',
    clientUi: 'full',
    reasons,
  }
}

function resolveHome(value: string): string {
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return path.join(homedir(), value.slice(2))
  return path.resolve(value)
}
