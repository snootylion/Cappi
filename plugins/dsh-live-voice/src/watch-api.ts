/**
 * Frozen structural interface for the turnkey watch audio service.
 *
 * Contract: docs/TURNKEY-CONTRACT.md §9.1 + protocol/turnkey.schema.json.
 * PCM is explicit everywhere. Fixture ids/text are synthetic routing samples,
 * never telemetry. H/V/W implement in parallel via structural typing; H/V MAY
 * avoid a runtime import and rely on these shapes only.
 *
 * VI readiness contract (truthful ready):
 * - `setup({ consent:true })` is the ONLY explicit user-gated entry that may
 *   invoke the native helper authorize/diagnostics path (Speech permission
 *   only for watch-asr; never auto-acquires the Mac microphone). No helper
 *   capture and no OS permission prompt ever happens on plugin boot or from
 *   `status()`. Persisted watch consent may use readonly `--status` only.
 * - `status()` stays `warming` until backend/TCC/locale actually validate.
 *   `ready` means a diagnostics helper reached its native `ready` line (or a
 *   prior capture did). Missing binary / non-Darwin platform / denied TCC /
 *   unsupported locale never report `ready`.
 * - `createInput()` resolves its handle ONLY after the capture helper emits
 *   the real native `ready` line (bounded `readyTimeoutMs`, default 30 s).
 *   No audio is accepted before backend ready; nothing is silently shed.
 * - `onEvent` MAY return `Promise<void>` so H can acknowledge actual
 *   delivery; `end()` waits for the real final ack (including that delivery
 *   ack) and surfaces explicit `no-speech` instead of a silent timeout close.
 */

 /** PCM16LE mono format. sampleRate 16000 is the helper contract rate. */
export type PcmFormat = { encoding: 'pcm16le'; sampleRate: number; channels: 1 };

/** Per-stream audio readiness/capture state (contract §9.2 SSE `t:'mic'`). */
export type LiveVoiceWatchStatus = 'warming' | 'ready' | 'capturing' | 'closed' | 'error';

/** Scoped consent mode: watch-ASR needs Speech only; Mac input needs Mic+Speech. */
export type LiveVoiceWatchInputMode = 'watch-asr' | 'mac-input';

/** Explicit user-gated setup options. Only a user button / runtime consent API
 *  may call `setup({ consent: true })`; never on boot. */
export type LiveVoiceWatchSetupOpts = {
  consent: boolean;
  mode?: LiveVoiceWatchInputMode;
};

export type LiveVoiceWatchStatusReport = {
  status: LiveVoiceWatchStatus;
  pcm: PcmFormat;
  consent: string;
  message?: string;
};

export type LiveVoiceInputEvent =
  | { kind: 'partial'; streamId: string; utteranceId: string; text: string }
  | { kind: 'final'; streamId: string; utteranceId: string; text: string }
  | { kind: 'error'; streamId: string; utteranceId?: string; code: string; message: string; retryable: boolean };

/** Delivery-ack handler: H MAY return a Promise that resolves when the event
 *  is durably delivered (prompt pipeline / SSE receipt). V awaits it before
 *  counting the final ack in `end()`. Sync handlers remain valid. */
export type LiveVoiceInputEventHandler = (
  e: LiveVoiceInputEvent,
) => void | Promise<void>;

export interface LiveVoiceWatchInputHandle {
  writePCM(bytes: Uint8Array | ArrayBuffer): Promise<void> | void;
  end(): Promise<void>;
  dispose(): Promise<void>;
}

export interface LiveVoiceWatchSynthesisReceipt {
  speechId: string;
}

export interface LiveVoiceWatchService {
  status(): Promise<LiveVoiceWatchStatusReport>;
  setup(opts: LiveVoiceWatchSetupOpts): Promise<{ status: LiveVoiceWatchStatus; pcm: PcmFormat }>;
  createInput(args: {
    streamId: string;
    /** Dictation is a non-submitting user draft; do not drop deliberate short answers as echo. */
    purpose?: 'prompt' | 'dictation';
    onEvent: LiveVoiceInputEventHandler;
    signal?: AbortSignal;
  }): Promise<LiveVoiceWatchInputHandle>;
  synthesize(args: {
    text: string;
    speechId: string;
    onChunk: (pcm: Uint8Array) => void;
    onDone: (receipt: { speechId: string }) => void;
    signal?: AbortSignal;
  }): Promise<void>;
}

/** Minimal runtime lease view used for mutual exclusion (never steals). */
export interface LiveVoiceWatchRuntimeView {
  readonly activeSessionId?: string | undefined;
  readonly dictateLease?: { clientId: string; leaseId: string; sessionId: string } | undefined;
}

/** Child-process handle shape the service speaks (real spawn or TESTONLY fake). */
export interface WatchHelperChild {
  readonly stdinWritable: () => boolean;
  writeStdin(chunk: Uint8Array): boolean;
  endStdin(): void;
  kill(signal?: NodeJS.Signals): void;
  onLine(cb: (line: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
}

export type SpawnHelperFn = (
  args: string[],
  hooks: {
    onLine: (line: string) => void;
    onExit: (code: number | null) => void;
    onStderr?: (text: string) => void;
  },
) => WatchHelperChild;

export type SynthFileFn = (text: string, outPath: string, sampleRate: number) => Promise<void>;

export interface LiveVoiceWatchDeps {
  runtime: LiveVoiceWatchRuntimeView;
  /** Optional absolute private consent file. Omitted = memory-only (tests/embedders). */
  consentPath?: string;
  helperPath?: string;
  spawnHelper?: SpawnHelperFn;
  synthFile?: SynthFileFn;
  readyTimeoutMs?: number;
  finalTimeoutMs?: number;
  locale?: string;
  /** TESTONLY override, defaults to `process.platform`. Lets tests assert the
   *  Linux graceful `backend-unsupported` path without a real Linux host. */
  platform?: NodeJS.Platform;
  /** TESTONLY override, defaults to `fs.access(helperPath)`. Lets tests assert
   *  the missing-binary `never ready` path without deleting the real binary. */
  existsHelper?: () => Promise<boolean>;
}

export declare function createLiveVoiceWatchService(deps: LiveVoiceWatchDeps): LiveVoiceWatchService;
