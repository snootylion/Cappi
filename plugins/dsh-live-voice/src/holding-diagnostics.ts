import { appendFile, chmod, mkdir, rename, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import type { HoldingPhraseInspection } from './shared/holding-phrase.ts'
import { defaultLiveVoiceRoot } from './voice-defaults.ts'

export const DEFAULT_HOLDING_TRACE_PATH = process.env.DSH_HOLDING_TRACE_PATH?.trim()
  || path.join(defaultLiveVoiceRoot(), 'holding-phrase-trace.jsonl')

export type HoldingFallbackReason =
  | 'backend-not-ready'
  | 'empty-context'
  | 'generation-error'
  | 'invalid-output'
  | 'deadline'
  | 'configured-canned'

export type HoldingDiagnosticEvent =
  | { readonly event: 'request'; readonly requestId: string; readonly deadlineMs: number }
  | {
      readonly event: 'generation'
      readonly requestId: string
      readonly backendState: 'cold' | 'starting' | 'ready'
      readonly outcome: 'completed' | 'aborted' | 'error' | 'skipped'
      readonly firstDeltaMs?: number
      readonly completionMs: number
      readonly rawPhrase?: string
      readonly validation?: HoldingPhraseInspection
    }
  | {
      readonly event: 'selection'
      readonly requestId: string
      readonly source: 'local-mlx' | 'canned'
      readonly reason?: HoldingFallbackReason
      readonly phrase: string
      readonly elapsedMs: number
    }

export interface HoldingDiagnosticSink {
  record(event: HoldingDiagnosticEvent): void
}

export const NOOP_HOLDING_DIAGNOSTICS: HoldingDiagnosticSink = { record: () => undefined }

export class HoldingDiagnosticTrace implements HoldingDiagnosticSink {
  private tail = Promise.resolve()

  constructor(
    private readonly enabled: boolean,
    private readonly tracePath = DEFAULT_HOLDING_TRACE_PATH,
    private readonly log: Pick<Console, 'warn'> = console,
    private readonly maxBytes = 1024 * 1024,
  ) {}

  record(event: HoldingDiagnosticEvent): void {
    if (!this.enabled) return
    const line = `${JSON.stringify({ schema: 1, timestamp: new Date().toISOString(), ...event })}\n`
    this.tail = this.tail.then(() => this.append(line)).catch((error: unknown) => {
      this.log.warn(`[kokoro-live-voice:holding-trace] ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  flush(): Promise<void> {
    return this.tail
  }

  private async append(line: string): Promise<void> {
    await mkdir(path.dirname(this.tracePath), { recursive: true, mode: 0o700 })
    let currentBytes = 0
    try {
      currentBytes = (await stat(this.tracePath)).size
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (currentBytes > 0 && currentBytes + Buffer.byteLength(line) > this.maxBytes) {
      try {
        await unlink(`${this.tracePath}.1`)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      await rename(this.tracePath, `${this.tracePath}.1`)
    }
    await appendFile(this.tracePath, line, { encoding: 'utf8', mode: 0o600 })
    await chmod(this.tracePath, 0o600)
  }
}
