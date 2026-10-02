/**
 * Structural freeze of the LiveVoice watch service (TURNKEY-CONTRACT §9.1).
 *
 * Source of truth: voice package path './watch-api' (V owns the runtime).
 * H MUST NOT provide this key — H only consumes it via `inject`. This file
 * is a structural mirror so H compiles and tests without a runtime import
 * (P/H concern per contract). V's `provide('liveVoiceWatch', service)` must
 * satisfy this shape.
 *
 * PCM explicit: PCM16LE mono; sampleRate comes from the live start payload
 * read by the TTS player (16000 is ONLY the fallback when omitted).
 */

export type PcmFormat = { encoding: 'pcm16le'; sampleRate: number; channels: 1 };
export type LiveVoiceWatchStatus = 'warming' | 'ready' | 'capturing' | 'closed' | 'error';
export type LiveVoiceInputEvent =
  | { kind: 'partial'; streamId: string; utteranceId: string; text: string }
  | { kind: 'final'; streamId: string; utteranceId: string; text: string }
  | { kind: 'error'; streamId: string; utteranceId?: string; code: string; message: string; retryable: boolean };

/**
 * Delivery-ack handler (V truth: `plugins/dsh-live-voice/src/watch-api.ts`
 * `LiveVoiceInputEventHandler`): H MAY return a Promise that resolves when
 * the event is durably delivered (host prompt pipeline / SSE receipt). V
 * awaits it before counting the final ack in `end()`. Sync handlers remain
 * valid. H resolves (never hangs `end()`); a negative delivery outcome is
 * recorded on the mic receipt, never thrown through the ASR path.
 */
export type LiveVoiceInputEventHandler = (
  e: LiveVoiceInputEvent,
) => void | Promise<void>;

export interface LiveVoiceInputHandle {
  writePCM(bytes: Uint8Array | ArrayBuffer): Promise<void> | void;
  end(): Promise<void>;
  dispose(): Promise<void>;
}

export interface LiveVoiceWatchService {
  status(): Promise<{ status: LiveVoiceWatchStatus; pcm: PcmFormat; consent: string; message?: string }>;
  setup(opts: { consent: boolean }): Promise<{ status: LiveVoiceWatchStatus; pcm: PcmFormat }>;
  createInput(args: {
    streamId: string;
    /** Validated pending-question capture; never submits a prompt automatically. */
    purpose?: 'prompt' | 'dictation';
    onEvent: LiveVoiceInputEventHandler;
    signal?: AbortSignal;
  }): Promise<LiveVoiceInputHandle>;
  synthesize(args: {
    text: string;
    speechId: string;
    onChunk: (pcm: Uint8Array) => void;
    onDone: (receipt: { speechId: string }) => void;
    signal?: AbortSignal;
  }): Promise<void>;
}
