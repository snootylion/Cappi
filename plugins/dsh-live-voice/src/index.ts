/** DeepSeek Harness Host plugin for local Apple Speech and Kokoro live voice. */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-client-connection'
import { homedir } from 'node:os'
import path from 'node:path'
import { registerVoiceHttpRoutes } from './http-routes.ts'
import type {} from '@deepseek-ai/dsh-llm'
import { HoldingDiagnosticTrace } from './holding-diagnostics.ts'
import { applyPersistedVoiceSettings } from './voice-settings.ts'
import {
  COMMAND_PATH,
  EVENTS_PATH,
  KokoroVoiceRuntime,
  SETTINGS_PATH,
  STATUS_PATH,
  resolveTtsBackend,
  type VoiceSummaryGenerator,
  type VoicePluginConfig,
} from './runtime.ts'
import {
  buildVoiceSummaryPrompt,
  DEFAULT_VOICE_SUMMARY_BACKEND,
  HarnessLlmSummaryBackend,
  LocalMlxSummaryBackend,
  resolveLocalMlxSummaryConfig,
  resolveVoiceSummaryBackend,
  VOICE_SUMMARY_SYSTEM_PROMPT,
  type VoiceSummaryBackend,
} from './summary-backends.ts'
import {
  CannedHoldingPhraseProvider,
  HoldingPhraseScheduler,
  LocalMlxHoldingPhraseProvider,
  resolveHoldingPhraseDelay,
  resolveHoldingPhraseProvider,
  type HoldingPhraseProvider,
} from './holding-phrase-provider.ts'
import { DEFAULT_VOICE_DEFAULTS, describeVoiceHost } from './voice-defaults.ts'
import type { LiveVoiceWatchService } from './watch-api.ts'
import { createLiveVoiceWatchService } from './watch-service.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    liveVoiceWatch: LiveVoiceWatchService
  }
}

export const name = 'live-voice-kokoro'
export const inject = ['webServer', 'llm', 'connection']
export { SUMMARY_RELEASE_PATH } from './http-routes.ts'

export const Config = z.object({
  runtimeRoot: z.string(),
  watchConsentPath: z.string(),
  pythonPath: z.string(),
  modelPath: z.string(),
  helperPath: z.string(),
  sidecarPath: z.string(),
  ttsBackend: z.string(),
  pocketRuntimeRoot: z.string(),
  pocketPythonPath: z.string(),
  pocketSidecarPath: z.string(),
  pocketVoice: z.string(),
  locale: z.string(),
  voice: z.string(),
  endTurnMs: z.number().step(1).min(900).max(2_500),
  speechRate: z.number().min(0.8).max(1.2),
  acknowledgementDelayMs: z.number().step(1).min(0).max(1_000),
  holdingPhraseProvider: z.string(),
  holdingPhraseDelayMs: z.number().step(1).min(250).max(1_500),
  holdingPhraseDiagnostics: z.boolean(),
  summaryBackend: z.string(),
  summaryRuntimeRoot: z.string(),
  summaryPythonPath: z.string(),
  summaryModelPath: z.string(),
  summarySidecarPath: z.string(),
  summaryIdleMs: z.number().step(1).min(30_000).max(1_800_000),
  summaryProvider: z.string(),
  summaryModel: z.string(),
})

export const DEFAULT_VOICE_SUMMARY_PROVIDER = DEFAULT_VOICE_DEFAULTS.summaryProvider
export const DEFAULT_VOICE_SUMMARY_MODEL = DEFAULT_VOICE_DEFAULTS.summaryModel

export async function apply(ctx: Context, config: VoicePluginConfig): Promise<void> {
  const effectiveConfig = await applyPersistedVoiceSettings(config)
  const summaryBackend = createVoiceSummaryBackend(ctx, effectiveConfig)
  const holdingDiagnostics = new HoldingDiagnosticTrace(
    effectiveConfig.holdingPhraseDiagnostics === true,
    undefined,
    ctx.logger,
  )
  let holdingLocalBackend: LocalMlxSummaryBackend | undefined
  let holdingProvider: HoldingPhraseProvider
  if (resolveHoldingPhraseProvider(effectiveConfig.holdingPhraseProvider) === 'canned') {
    holdingProvider = new CannedHoldingPhraseProvider()
  } else {
    holdingLocalBackend = summaryBackend instanceof LocalMlxSummaryBackend
      ? summaryBackend
      : new LocalMlxSummaryBackend(resolveLocalMlxSummaryConfig(effectiveConfig), ctx.logger)
    holdingProvider = new LocalMlxHoldingPhraseProvider(holdingLocalBackend, holdingDiagnostics)
  }
  const holdingScheduler = new HoldingPhraseScheduler(
    holdingProvider,
    resolveHoldingPhraseDelay(effectiveConfig),
    holdingDiagnostics,
  )
  const holdingSharesSummaryBackend = holdingLocalBackend === summaryBackend
  const runtime = new KokoroVoiceRuntime(
    effectiveConfig,
    ctx.logger,
    summaryBackend.generate.bind(summaryBackend),
    async () => {
      await (holdingSharesSummaryBackend
        ? summaryBackend.warm()
        : Promise.all([summaryBackend.warm(), holdingProvider.warm()]).then(() => undefined))
    },
    () => {
      summaryBackend.release()
      if (!holdingSharesSummaryBackend) holdingProvider.release()
    },
    holdingScheduler,
  )
  await runtime.initialize()

  // Turnkey watch audio service (contract §9.1, Role V): provided here,
  // consumed by H via `inject: [..., 'liveVoiceWatch']`. Lazy by design —
  // no capture until explicit `createInput()` (watch record control). First
  // setup needs a user consent action; saved watch consent may be revalidated
  // by read-only manifest/--status checks, never authorization or capture.
  const liveVoiceWatch = createLiveVoiceWatchService({
    consentPath: effectiveConfig.watchConsentPath?.trim() || path.join(process.env.DSH_HOME?.trim() || path.join(homedir(), '.dsh'), 'live-voice-watch', 'consent.json'),
    ...(effectiveConfig.locale ? { locale: effectiveConfig.locale } : {}),
    runtime: {
      get activeSessionId() {
        return runtime.watchExclusion.activeSessionId
      },
      get dictateLease() {
        return runtime.watchExclusion.dictateLease
      },
    },
  })
  const disposeLiveVoiceWatch = ctx.provide('liveVoiceWatch', liveVoiceWatch)

  const disposers = registerVoiceHttpRoutes(ctx, runtime, () => ({
    ...runtime.status(),
    tts: { backend: runtime.settings().ttsBackend },
    summary: summaryBackend.status(),
    holding: { provider: holdingProvider.kind, delayMs: runtime.settings().holdingPhraseDelayMs },
    host: describeVoiceHost(),
  }), async () => {
    await summaryBackend.evict()
    if (holdingLocalBackend && holdingLocalBackend !== summaryBackend) await holdingLocalBackend.evict()
  })

  ctx.effect(() => async () => {
    disposeLiveVoiceWatch()
    await liveVoiceWatch.dispose()
    for (const dispose of disposers) dispose()
    await runtime.dispose()
    await summaryBackend.dispose()
    if (holdingLocalBackend && holdingLocalBackend !== summaryBackend) await holdingLocalBackend.dispose()
    await holdingDiagnostics.flush()
  }, 'dsh-live-voice-kokoro: runtime and HTTP routes')
}

export function createVoiceSummaryBackend(
  ctx: Pick<Context, 'llm' | 'logger'>,
  config: VoicePluginConfig = {},
): VoiceSummaryBackend {
  if (resolveVoiceSummaryBackend(config) === 'local-mlx') {
    return new LocalMlxSummaryBackend(resolveLocalMlxSummaryConfig(config), ctx.logger)
  }
  const route = resolveVoiceSummaryRoute(config)
  return new HarnessLlmSummaryBackend(createVoiceSummaryGenerator(ctx, config), `${route.provider}/${route.model}`)
}

export function createVoiceSummaryGenerator(ctx: Pick<Context, 'llm'>, config: VoicePluginConfig = {}): VoiceSummaryGenerator {
  const route = resolveVoiceSummaryRoute(config)
  return async (request, onDelta, signal) => {
    const modelInfo = await ctx.llm.resolveModelInfo(route.provider, route.model, signal)
    const supportsReasoningOff = modelInfo.reasoning?.efforts.some((effort) => String(effort.id) === 'off') === true
    if (modelInfo.reasoning && !supportsReasoningOff) {
      throw new Error(`Voice summary model ${route.provider}/${route.model} cannot disable reasoning.`)
    }
    let completed = false
    for await (const chunk of ctx.llm.stream({
      provider: route.provider,
      model: route.model,
      ...(supportsReasoningOff ? { reasoningEffort: ReasoningEffortId('off') } : {}),
      system: VOICE_SUMMARY_SYSTEM_PROMPT,
      messages: [createUserMessage({
        content: [{ type: 'text', text: buildVoiceSummaryPrompt(request) }],
        source: { kind: 'plugin', plugin: name },
      })],
      maxTokens: 160,
      signal,
    })) {
      if (chunk.type === 'text-delta') onDelta(chunk.text)
      if (chunk.type === 'finish') completed = chunk.reason.kind === 'stop' || chunk.reason.kind === 'max-tokens'
    }
    return completed
  }
}

export function resolveVoiceSummaryRoute(config: VoicePluginConfig): { readonly provider: string; readonly model: string } {
  return {
    provider: config.summaryProvider?.trim() || DEFAULT_VOICE_SUMMARY_PROVIDER,
    model: config.summaryModel?.trim() || DEFAULT_VOICE_SUMMARY_MODEL,
  }
}

export {
  COMMAND_PATH,
  EVENTS_PATH,
  KokoroVoiceRuntime,
  SETTINGS_PATH,
  STATUS_PATH,
  resolveTtsBackend,
  resolveVoiceConfig,
  type ResolvedVoiceConfig,
  type RuntimeEvent,
  type VoicePluginConfig,
} from './runtime.ts'

export {
  buildVoiceSummaryPrompt,
  DEFAULT_VOICE_SUMMARY_BACKEND,
  resolveLocalMlxSummaryConfig,
  resolveVoiceSummaryBackend,
} from './summary-backends.ts'

export {
  DEFAULT_VOICE_DEFAULTS,
  describeVoiceHost,
  type VoiceDefaults,
  type VoiceHostCapabilities,
} from './voice-defaults.ts'
