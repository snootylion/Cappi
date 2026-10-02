import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { TtsBackend, VoicePluginConfig } from './runtime.ts'
import { DEFAULT_VOICE_DEFAULTS, defaultVoiceSettingsPath } from './voice-defaults.ts'

export const VOICE_SETTINGS_PATH = defaultVoiceSettingsPath()

export interface VoiceSettings {
  readonly ttsBackend: TtsBackend
  readonly voice: string
  readonly pocketVoice: string
  readonly locale: string
  readonly endTurnMs: number
  readonly speechRate: number
  readonly acknowledgementDelayMs: number
  readonly holdingPhraseDelayMs: number
}

export type VoiceSettingsPatch = Partial<VoiceSettings>

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  ttsBackend: DEFAULT_VOICE_DEFAULTS.ttsBackend,
  voice: DEFAULT_VOICE_DEFAULTS.voice,
  pocketVoice: DEFAULT_VOICE_DEFAULTS.pocketVoice,
  locale: DEFAULT_VOICE_DEFAULTS.locale,
  endTurnMs: DEFAULT_VOICE_DEFAULTS.endTurnMs,
  speechRate: DEFAULT_VOICE_DEFAULTS.speechRate,
  acknowledgementDelayMs: DEFAULT_VOICE_DEFAULTS.acknowledgementDelayMs,
  holdingPhraseDelayMs: DEFAULT_VOICE_DEFAULTS.holdingPhraseDelayMs,
}

export async function loadVoiceSettings(): Promise<VoiceSettingsPatch> {
  try {
    const parsed: unknown = JSON.parse(await readFile(VOICE_SETTINGS_PATH, 'utf8'))
    return sanitizeSettings(parsed)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    return {}
  }
}

export async function saveVoiceSettings(patch: VoiceSettingsPatch): Promise<void> {
  const current = await loadVoiceSettings()
  const next = sanitizeSettings({ ...current, ...patch })
  // Preserve the non-target engine's last voice: a Kokoro timing/backend save
  // must not mirror Pocket's display voice (e.g. 'azelma'/'alba') into Kokoro.
  if (patch.ttsBackend === 'kokoro' && patch.voice === undefined && current.voice !== undefined) {
    (next as Record<string, unknown>).voice = current.voice
  }
  if (patch.ttsBackend === 'pocket' && patch.pocketVoice === undefined && current.pocketVoice !== undefined) {
    (next as Record<string, unknown>).pocketVoice = current.pocketVoice
  }
  await mkdir(path.dirname(VOICE_SETTINGS_PATH), { recursive: true, mode: 0o700 })
  const temporary = `${VOICE_SETTINGS_PATH}.tmp-${process.pid}`
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, VOICE_SETTINGS_PATH)
}

export async function applyPersistedVoiceSettings(config: VoicePluginConfig): Promise<VoicePluginConfig> {
  return { ...config, ...(await loadVoiceSettings()) }
}

export function settingsFromConfig(config: VoicePluginConfig): VoiceSettingsPatch {
  const patch: Record<string, unknown> = {}
  if (config.ttsBackend !== undefined) patch.ttsBackend = config.ttsBackend
  if (config.locale !== undefined) patch.locale = config.locale
  if (config.endTurnMs !== undefined) patch.endTurnMs = config.endTurnMs
  if (config.speechRate !== undefined) patch.speechRate = config.speechRate
  if (config.acknowledgementDelayMs !== undefined) patch.acknowledgementDelayMs = config.acknowledgementDelayMs
  if (config.holdingPhraseDelayMs !== undefined) patch.holdingPhraseDelayMs = config.holdingPhraseDelayMs
  // Preserve per-engine voices: do not mirror the resolved display voice into
  // the non-active engine (which previously polluted Kokoro→'azelma'/'alba').
  const backend = typeof config.ttsBackend === 'string' && config.ttsBackend.trim().toLowerCase() === 'pocket' ? 'pocket' : undefined
  if (config.voice !== undefined && backend !== 'pocket') patch.voice = config.voice
  if (config.pocketVoice !== undefined) patch.pocketVoice = config.pocketVoice
  if (config.voice !== undefined && backend === 'pocket' && config.pocketVoice === undefined) patch.pocketVoice = config.voice
  return sanitizeSettings(patch)
}

export function sanitizeSettings(value: unknown): VoiceSettingsPatch {
  if (!isRecord(value)) return {}
  const patch: Record<string, unknown> = {}
  if (typeof value.ttsBackend === 'string') patch.ttsBackend = value.ttsBackend.trim().toLowerCase() === 'pocket' ? 'pocket' : 'kokoro'
  if (typeof value.voice === 'string' && value.voice.trim()) patch.voice = value.voice.trim().slice(0, 100)
  if (typeof value.pocketVoice === 'string' && value.pocketVoice.trim()) patch.pocketVoice = value.pocketVoice.trim().slice(0, 100)
  if (typeof value.locale === 'string' && value.locale.trim()) patch.locale = value.locale.trim().slice(0, 40)
  if (typeof value.endTurnMs === 'number' && Number.isFinite(value.endTurnMs)) patch.endTurnMs = Math.round(Math.min(2_500, Math.max(900, value.endTurnMs)))
  if (typeof value.speechRate === 'number' && Number.isFinite(value.speechRate)) patch.speechRate = Math.min(1.2, Math.max(0.8, value.speechRate))
  if (typeof value.acknowledgementDelayMs === 'number' && Number.isFinite(value.acknowledgementDelayMs)) patch.acknowledgementDelayMs = Math.round(Math.min(1_000, Math.max(0, value.acknowledgementDelayMs)))
  if (typeof value.holdingPhraseDelayMs === 'number' && Number.isFinite(value.holdingPhraseDelayMs)) patch.holdingPhraseDelayMs = Math.round(Math.min(1_500, Math.max(250, value.holdingPhraseDelayMs)))
  return patch as VoiceSettingsPatch
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
