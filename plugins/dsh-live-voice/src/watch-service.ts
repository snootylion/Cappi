/**
 * LiveVoice watch audio service (Role V, VI truthful-ready).
 *
 * Truthful readiness:
 * - No capture or OS permission prompt on boot/from `status()`. Saved watch
 *   consent is revalidated only with readonly manifest/--status checks.
 *   Only explicit `setup({ consent: true })` (user button / runtime consent
 *   API) may invoke the helper authorize/diagnostics path. Watch-asr needs
 *   Apple Speech Recognition only; it never auto-acquires the Mac microphone
 *   (stdin PCM comes from the watch, not the Mac mic).
 * - `status()` stays `warming` until backend/TCC/locale actually validate.
 *   `ready` means a diagnostics helper reached native `ready` (or a prior
 *   capture did). Missing binary / non-Darwin / denied TCC / bad locale
 *   never report `ready`.
 * - `createInput()` resolves its handle ONLY after the capture helper emits
 *   the real native `ready` line (bounded 30 s). No capture before backend
 *   ready; nothing buffered-then-shed.
 * - `onEvent` may return `Promise<void>` (H delivery ack); `end()` waits for
 *   the real final ack including that delivery, and surfaces explicit
 *   `no-speech` instead of a silent timeout close.
 * - Busy is held until a terminal transition (cancel / EOF-final / helper
 *   error / dispose), exactly once. Intent alone never releases the owner.
 * - Legacy Mac LiveVoice (`activeSessionId`) and dictation (`dictateLease`)
 *   leases are preserved: watch capture gets `busy` (H maps to 409), never
 *   steals.
 * - Telemetry is counts/RMS buckets only; PCM bytes and transcript text are
 *   never logged.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, chmod, mkdir, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { defaultSpeechLocale } from './voice-defaults.ts';
import { isLikelyPlaybackEcho } from './runtime.ts';
import { readWatchConsent, writeWatchConsent } from './watch-consent.ts';
import type {
  LiveVoiceInputEvent,
  LiveVoiceInputEventHandler,
  LiveVoiceWatchDeps,
  LiveVoiceWatchInputMode,
  LiveVoiceWatchService,
  LiveVoiceWatchStatus,
  LiveVoiceWatchStatusReport,
  PcmFormat,
  SpawnHelperFn,
  SynthFileFn,
  WatchHelperChild,
} from './watch-api.ts';

export const WATCH_PCM: PcmFormat = { encoding: 'pcm16le', sampleRate: 16000, channels: 1 };
export const WATCH_FRAME_BYTES = 2048; // 1024 samples * 2 bytes = 64 ms @ 16 kHz
export const WATCH_READY_TIMEOUT_MS = 30_000;
export const WATCH_FINAL_TIMEOUT_MS = 8_000;
/** Retained for compat; VI accepts no pre-ready audio so nothing buffers. */
export const WATCH_MAX_BUFFERED_BYTES = 0;
export const WATCH_MAX_SYNTH_CHARS = 4_000;
export const WATCH_SYNTH_CHUNK_BYTES = 32 * 1024;
export const ECHO_WINDOW_MS = 30_000;
export const MAX_ECHO_REFS = 32;

interface ActiveInput {
  streamId: string;
  child: WatchHelperChild;
  onEvent: LiveVoiceInputEventHandler;
  txChunks: number;
  txBytes: number;
  ackFinals: number;
  ready: boolean;
  closed: boolean;
  generation: number;
  utteranceId: string | undefined;
  readyTimer: NodeJS.Timeout | undefined;
  finalTimer: NodeJS.Timeout | undefined;
  endRequested: boolean;
  finalReceived: boolean;
  stoppedReceived: boolean;
  terminalErrorSent: boolean;
  pendingDeliveries: Set<Promise<void>>;
  deliveryChain: Promise<void>;
  abortHandler: (() => void) | undefined;
  signal: AbortSignal | undefined;
  resolveReady: ((handle: LiveVoiceWatchInputHandleShape) => void) | undefined;
  rejectReady: ((err: Error) => void) | undefined;
}

type LiveVoiceWatchInputHandleShape = {
  writePCM(bytes: Uint8Array | ArrayBuffer): void;
  end(): Promise<void>;
  dispose(): Promise<void>;
};

function defaultHelperPath(): string {
  try {
    const here = fileURLToPath(import.meta.url);
    return path.resolve(path.dirname(here), '..', 'resources', 'bin', 'watch-asr');
  } catch {
    return path.resolve('resources', 'bin', 'watch-asr');
  }
}

function scrubbedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== 'string') continue;
    if (/^DSH_/u.test(k) || /^BRIDGE_/u.test(k)) continue;
    env[k] = v;
  }
  return env;
}

function defaultSpawnHelper(helperPath: string, locale: string): SpawnHelperFn {
  return (args, hooks) => {
    const child = spawn(helperPath, ['--locale', locale, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: scrubbedEnv(),
      shell: false,
    });
    readline.createInterface({ input: child.stdout }).on('line', (line) => hooks.onLine(line));
    child.stderr.on('data', (chunk) => hooks.onStderr?.(String(chunk).slice(0, 512)));
    child.once('error', () => hooks.onExit(null));
    child.once('exit', (code) => hooks.onExit(code));
    return {
      stdinWritable: () => child.stdin.writable === true,
      writeStdin: (chunk) => child.stdin.write(Buffer.from(chunk)),
      endStdin: () => {
        try {
          child.stdin.end();
        } catch { /* stdin already closed */ }
      },
      kill: (signal) => {
        try {
          child.kill(signal ?? 'SIGTERM');
        } catch { /* already exited */ }
      },
      onLine: () => undefined,
      onExit: () => undefined,
    };
  };
}

function defaultSynthFile(): SynthFileFn {
  return (text, outPath, sampleRate) =>
    new Promise<void>((resolve, reject) => {
      // Per-arg argv spawn (never a shell string): spaces/quotes in `text`
      // cannot escape. `say` writes CAF here (AIFF rejects LEI16@16kHz with
      // "fmt?"); the service strips the container header and delivers raw
      // PCM16LE mono at the explicit rate via onChunk.
      const child = spawn(
        'say',
        ['--data-format', `LEI16@${sampleRate}`, '-o', outPath, text],
        { stdio: ['ignore', 'pipe', 'pipe'], env: scrubbedEnv(), shell: false },
      );
      let stderr = '';
      child.stderr.on('data', (c) => {
        stderr += String(c).slice(0, 256);
      });
      child.once('error', (err) => reject(err));
      child.once('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`system speech synthesis exited ${String(code)}`));
      });
      void stderr;
    });
}

function parseHelperLine(line: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(line);
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch { /* non-JSON diagnostics line */ }
  return undefined;
}

function rmsBucket(rms: number): 'silent' | 'quiet' | 'nominal' | 'hot' {
  if (rms < 0.002) return 'silent';
  if (rms < 0.02) return 'quiet';
  if (rms < 0.2) return 'nominal';
  return 'hot';
}

/**
 * Locate raw PCM inside a CAF file: walk the chunk directory for the `data`
 * chunk and skip its 4-byte edit-count field. Returns undefined for
 * non-CAF input (AIFF SSND and raw fallbacks are handled by the caller).
 */
function findCafData(raw: Buffer): Buffer | undefined {
  if (raw.length < 8 || raw.subarray(0, 4).toString('ascii') !== 'caff') return undefined;
  let at = 8; // file header: magic(4) + version(2) + flags(2)
  while (at + 12 <= raw.length) {
    const type = raw.subarray(at, at + 4).toString('ascii');
    const hi = raw.readUInt32BE(at + 4);
    const lo = raw.readUInt32BE(at + 8);
    const bodyStart = at + 12;
    // CAF uses int64 -1 to mean "to end of file".
    const size = hi === 0xffffffff && lo === 0xffffffff ? raw.length - bodyStart : hi * 0x100000000 + lo;
    if (!Number.isFinite(size) || size < 0 || bodyStart > raw.length) return undefined;
    if (type === 'data') {
      if (bodyStart + 4 > raw.length) return undefined;
      const start = bodyStart + 4; // mEditCount
      const end = Math.min(raw.length, start + Math.max(0, size - 4));
      return raw.subarray(start, Math.max(start, end));
    }
    if (!Number.isFinite(size) || size < 0) return undefined;
    at = bodyStart + size;
    if (at <= bodyStart) return undefined; // no forward progress
  }
  return undefined;
}

function chunkRms(bytes: Uint8Array): number {
  const n = Math.floor(bytes.length / 2);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    const lo = bytes[i * 2] ?? 0;
    const hi = bytes[i * 2 + 1] ?? 0;
    const raw = (hi << 8) | lo;
    const v = (raw >= 0x8000 ? raw - 0x10000 : raw) / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / n);
}

type CodedError = Error & { code: string; retryable: boolean };

function codedError(code: string, message: string, retryable: boolean): CodedError {
  const err = new Error(message) as CodedError;
  err.code = code;
  err.retryable = retryable;
  return err;
}

function busyError(): CodedError {
  return codedError(
    'busy',
    'Watch voice input is busy: a Mac Live Voice or dictation session holds the microphone helper. Stop it first.',
    true,
  );
}

function notConsentedError(): CodedError {
  return codedError(
    'consent-required',
    'Voice input needs explicit consent first. Open Settings, allow Speech Recognition for watch input (Speech only), or Microphone plus Speech for Mac input, then confirm setup.',
    false,
  );
}

function consentGuidance(mode: LiveVoiceWatchInputMode): string {
  if (mode === 'mac-input') {
    return 'Voice input needs explicit consent. Mac input uses Microphone plus Speech Recognition. Open Settings to allow both, then confirm setup.';
  }
  return 'Voice input needs explicit consent. Watch input uses Apple Speech Recognition only (no Mac microphone); Mac input uses Microphone plus Speech. Open Settings to allow, then confirm setup.';
}

function backendUnsupportedMessage(): string {
  return 'Watch voice input needs macOS Apple Speech (on-device recognition). This host does not provide it, so watch input stays warming and never reports ready here.';
}

function missingBinaryMessage(helperPath: string): string {
  return `The watch voice helper is missing at ${helperPath}. Rebuild it from the bundled source with consent (scripts/build-watch-helpers.sh --apply); no Xcode CLT is needed when the install package already ships the binary.`;
}

/**
 * Readonly native-manifest guard: invoked at runtime BEFORE any helper
 * spawn. Compares the on-disk binary sha256 against the shipped manifest,
 * checks the manifest architecture row covers this host, and requires the
 * manifest source/plist hashes to be present. Pure file reads — no spawn,
 * no audio, no TCC. Returns ok or a user-actionable tamper message.
 */
export async function verifyNativeManifest(
  helperPath: string,
  platform: NodeJS.Platform = process.platform,
  hostArch: string = process.arch,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const manifestPath = path.resolve(path.dirname(helperPath), '..', 'watch-asr.manifest.json');
  let manifest: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('invalid manifest');
    manifest = parsed as Record<string, unknown>;
  } catch {
    return {
      ok: false,
      message: `The watch voice manifest is missing at ${manifestPath}. Reinstall the plugin package or rebuild the helper from the bundled source with consent.`,
    };
  }
  const binarySha = typeof manifest['binarySha256'] === 'string' ? (manifest['binarySha256'] as string) : '';
  const sourceSha = typeof manifest['sourceSha256'] === 'string' ? (manifest['sourceSha256'] as string) : '';
  const plistSha = typeof manifest['plistSha256'] === 'string' ? (manifest['plistSha256'] as string) : '';
  const architectures = typeof manifest['architectures'] === 'string' ? (manifest['architectures'] as string) : '';
  if (!binarySha || !sourceSha || !plistSha || !architectures) {
    return {
      ok: false,
      message: 'The watch voice manifest is incomplete (missing hash/architecture rows). Reinstall the plugin package.',
    };
  }
  let binaryBytes: Buffer;
  try {
    binaryBytes = await readFile(helperPath);
  } catch {
    return { ok: false, message: missingBinaryMessage(helperPath) };
  }
  const digest = createHash('sha256').update(binaryBytes).digest('hex');
  if (digest !== binarySha) {
    return {
      ok: false,
      message: 'The watch voice helper binary does not match its shipped manifest (possible tamper or stale rebuild). Reinstall the plugin package or rebuild from the bundled source with consent.',
    };
  }
  if (platform === 'darwin') {
    const want = hostArch === 'x64' ? 'x86_64' : hostArch;
    const archTokens = architectures.split(/\s+/u).filter(Boolean);
    if (!archTokens.includes(want)) {
      return {
        ok: false,
        message: `The watch voice helper (${architectures}) has no slice for this Mac (${want}). Rebuild a universal binary from the bundled source on this Mac with consent (scripts/build-watch-helpers.sh --apply).`,
      };
    }
  }
  return { ok: true };
}

export function createLiveVoiceWatchService(
  deps: LiveVoiceWatchDeps,
): LiveVoiceWatchService & { dispose(): Promise<void> } {
  const runtime = deps.runtime;
  const helperPath = deps.helperPath ?? defaultHelperPath();
  const locale = deps.locale ?? defaultSpeechLocale();
  const readyTimeoutMs = deps.readyTimeoutMs ?? WATCH_READY_TIMEOUT_MS;
  const finalTimeoutMs = deps.finalTimeoutMs ?? WATCH_FINAL_TIMEOUT_MS;
  const platform: NodeJS.Platform = deps.platform ?? process.platform;
  const spawnHelper: SpawnHelperFn =
    deps.spawnHelper ?? defaultSpawnHelper(helperPath, locale);
  const synthFile: SynthFileFn = deps.synthFile ?? defaultSynthFile();
  const existsHelper: () => Promise<boolean> =
    deps.existsHelper ??
    (async () => {
      try {
        await access(helperPath);
        return true;
      } catch {
        return false;
      }
    });

  let disposed = false;
  const probeCancels = new Set<() => void>();
  let consented = false;
  let consentedMode: LiveVoiceWatchInputMode = 'watch-asr';
  let liveStatus: LiveVoiceWatchStatus = 'warming';
  let statusMessage: string | undefined =
    'Voice input is warming. Confirm setup consent to continue.';
  let active: ActiveInput | undefined;
  let generation = 0;
  let diagnosticsInFlight: Promise<void> | undefined;
  const recentSpoken: Array<{ text: string; expiresAt: number }> = [];

  const pruneEchoes = (): string[] => {
    const now = Date.now();
    for (let i = recentSpoken.length - 1; i >= 0; i -= 1) {
      if ((recentSpoken[i]?.expiresAt ?? 0) <= now) recentSpoken.splice(i, 1);
    }
    return recentSpoken.map((e) => e.text);
  };

  const rememberSpoken = (text: string): void => {
    const trimmed = text.trim();
    if (!trimmed) return;
    recentSpoken.push({ text: trimmed, expiresAt: Date.now() + ECHO_WINDOW_MS });
    if (recentSpoken.length > MAX_ECHO_REFS) recentSpoken.splice(0, recentSpoken.length - MAX_ECHO_REFS);
  };

  /** Bounded recent-playback policy shared with Mac runtime. Novel added words
   * remain user speech; explicit stop/wait/pause/no/cancel always pass. */
  const isEcho = (text: string): boolean => {
    if (text.length > WATCH_MAX_SYNTH_CHARS) return false;
    const words = text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    return pruneEchoes().some((reference) => {
      const known = new Set(reference.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
      const novel = words.filter((word) => !known.has(word)).length;
      return novel <= Math.max(1, words.length * 0.2) && isLikelyPlaybackEcho(text, [reference]);
    });
  };

  const setStatus = (s: LiveVoiceWatchStatus, message?: string): void => {
    if (disposed && s !== 'closed') return;
    liveStatus = s;
    statusMessage = message;
  };

  const clearTimer = (t: NodeJS.Timeout | undefined): void => {
    if (t) clearTimeout(t);
  };

  /** Queue an event for delivery, awaiting H's async ack when provided.
   *  Stale inputs (superseded generation / terminally closed for
   *  non-terminal events) never deliver into the next capture. */
  const deliver = (state: ActiveInput, e: LiveVoiceInputEvent, opts?: { terminal?: boolean }): Promise<void> => {
    if (state.closed && !opts?.terminal) return Promise.resolve();
    if (active !== state && !opts?.terminal) return Promise.resolve();
    if (state.generation !== generation && !opts?.terminal) return Promise.resolve();
    let result: void | Promise<void>;
    try {
      result = state.onEvent(e);
    } catch {
      return Promise.resolve();
    }
    const tracked: Promise<void> = Promise.resolve(result).catch(() => undefined).then(() => {
      state.pendingDeliveries.delete(tracked);
    });
    state.pendingDeliveries.add(tracked);
    state.deliveryChain = state.deliveryChain.then(() => tracked).catch(() => undefined);
    return tracked;
  };

  /** Exactly-once terminal transition: clears timers, kills the helper,
   *  releases busy (active) and sets status. Terminal error delivery is
   *  queued before the closed flag blocks it. */
  const terminalize = (
    state: ActiveInput,
    status: LiveVoiceWatchStatus,
    message: string,
    error?: { code: string; message: string; retryable: boolean },
  ): void => {
    if (state.closed) return;
    if (error && !state.terminalErrorSent) {
      state.terminalErrorSent = true;
      void deliver(state, { kind: 'error', streamId: state.streamId, code: error.code, message: error.message, retryable: error.retryable }, { terminal: true });
    }
    state.closed = true;
    clearTimer(state.readyTimer);
    clearTimer(state.finalTimer);
    state.readyTimer = undefined;
    state.finalTimer = undefined;
    try {
      state.child.endStdin();
    } catch { /* best effort */ }
    try {
      state.child.kill('SIGTERM');
    } catch { /* best effort */ }
    if (state.signal && state.abortHandler) {
      try {
        state.signal.removeEventListener('abort', state.abortHandler);
      } catch { /* already removed */ }
    }
    state.abortHandler = undefined;
    // Reject a still-pending ready wait so createInput never hangs.
    if (state.rejectReady) {
      const reject = state.rejectReady;
      state.resolveReady = undefined;
      state.rejectReady = undefined;
      reject(codedError(
        error?.code ?? 'helper-closed',
        error?.message ?? message,
        error?.retryable ?? true,
      ));
    }
    if (active === state) active = undefined;
    generation += 1;
    // Closing one validated recording is not disposal of the reusable backend.
    // Keep per-input no-speech/cancel events, but permit the next explicit
    // record without a second Setup. Revocation, disposal and genuine backend
    // errors remain authoritative; an unvalidated pre-ready close never grants
    // readiness.
    const healthyClose = state.ready && status === 'closed' && consented
      && consentedMode === 'watch-asr' && !disposed
      && (!error || error.code === 'no-speech' || error.code === 'cancelled');
    setStatus(healthyClose ? 'ready' : status,
      healthyClose ? 'Watch voice backend is ready for another explicit recording.' : message);
  };

  const permissionErrorFor = (code: string): { code: string; message: string; retryable: boolean } => {
    if (code === 'speech-permission') {
      return {
        code: 'speech-permission',
        message: 'Speech Recognition permission was denied. Open System Settings, Privacy and Security, Speech Recognition, allow the helper, then confirm setup again.',
        retryable: false,
      };
    }
    if (code === 'recognition-failed') {
      return { code, message: `On-device Apple Speech failed for ${locale}. Check Speech Recognition permission and enable/install the OS Speech or Dictation language assets, then retry setup.`, retryable: false };
    }
    if (code === 'locale-unavailable' || code === 'on-device-unavailable') {
      return {
        code,
        message: `Apple Speech is unavailable for ${locale}. Choose a supported recognition locale in Settings, then confirm setup again.`,
        retryable: false,
      };
    }
    return {
      code,
      message: 'The watch voice helper reported an error. Re-confirm setup; if it persists, rebuild the helper from source.',
      retryable: false,
    };
  };

  /** Explicit user-gated authorization: run the helper `--authorize` mode
   *  (Speech permission request + locale/on-device verification, machine
   *  JSON, no stdin, no Mac microphone). Only runs from setup() after
   *  explicit user consent — never on boot, never from status(). */
  const runAuthorize = async (): Promise<{ ok: true } | { ok: false; code: string; message: string; retryable: boolean }> => {
    if (disposed) return { ok: false, code: 'cancelled', message: 'Watch service closed.', retryable: false };
    setStatus('warming', 'Requesting Speech Recognition permission. Allow Speech Recognition if the system prompts.');
    return new Promise((resolve) => {
      let settled = false;
      let child: WatchHelperChild | undefined;
      const done = (v: { ok: true } | { ok: false; code: string; message: string; retryable: boolean }): void => {
        if (settled) return;
        settled = true;
        probeCancels.delete(cancel);
        clearTimer(timer);
        try {
          child?.endStdin();
        } catch { /* best effort */ }
        try {
          child?.kill('SIGTERM');
        } catch { /* best effort */ }
        resolve(v);
      };
      const cancel = (): void => done({ ok: false, code: 'cancelled', message: 'Watch service closed.', retryable: false });
      probeCancels.add(cancel);
      const timer = setTimeout(() => {
        done({ ok: false, code: 'helper-timeout', message: 'The Speech permission request timed out. Re-confirm setup; if it persists, rebuild the helper from source.', retryable: true });
      }, readyTimeoutMs);
      if (timer.unref) timer.unref();
      try {
        child = spawnHelper(['--authorize'], {
          onLine: (line) => {
            const msg = parseHelperLine(line);
            if (!msg || settled) return;
            if (msg['mode'] === 'authorize' || msg['event'] === 'authorize') {
              const authorized = msg['authorized'] === true || msg['authorization'] === 'authorized';
              if (authorized) {
                const localeAvailable = msg['localeAvailable'];
                const onDevice = msg['onDeviceRecognition'];
                if (localeAvailable === false) {
                  const mapped = permissionErrorFor('locale-unavailable');
                  done({ ok: false, ...mapped });
                } else if (onDevice === false) {
                  const mapped = permissionErrorFor('on-device-unavailable');
                  done({ ok: false, ...mapped });
                } else {
                  done({ ok: true });
                }
              } else {
                const mapped = permissionErrorFor('speech-permission');
                done({ ok: false, ...mapped });
              }
              return;
            }
            if (msg['event'] === 'error') {
              const code = typeof msg['code'] === 'string' ? (msg['code'] as string) : 'helper-error';
              const mapped = permissionErrorFor(code);
              done({ ok: false, ...mapped });
            }
          },
          onExit: (code) => {
            if (settled) return;
            if (code === 0) {
              // Authorize printed no JSON but exited 0: treat as granted;
              // locale depth is still verified by the diagnostics ready gate.
              done({ ok: true });
            } else if (code === 2) {
              done({ ok: false, code: 'speech-permission', message: 'Speech Recognition permission was denied (helper exit 2). Open System Settings, Privacy and Security, Speech Recognition, allow the helper, then confirm setup again.', retryable: false });
            } else if (code === 3) {
              done({ ok: false, code: 'locale-unavailable', message: `Apple Speech helper exited 3 (unsupported locale or configuration for ${locale}). Choose a supported locale in Settings, then confirm setup again.`, retryable: false });
            } else {
              done({ ok: false, code: 'helper-unavailable', message: 'The Speech permission check ended before a verdict. Re-confirm setup; if it persists, rebuild the helper from source.', retryable: true });
            }
          },
        });
      } catch (err) {
        done({ ok: false, code: 'helper-unavailable', message: `The watch voice helper could not start: ${err instanceof Error ? err.message : String(err)}`, retryable: true });
      }
    });
  };

  /** Explicit user-gated diagnostics: spawn the real helper, wait for native
   *  `ready`, then shut it down. Never auto-runs on boot. Speech permission
   *  only; the helper reads piped watch PCM, never the Mac mic. */
  const runDiagnostics = async (): Promise<void> => {
    if (disposed) return;
    if (diagnosticsInFlight) {
      await diagnosticsInFlight;
      return;
    }
    const task = (async (): Promise<void> => {
      setStatus('warming', 'Checking Speech permission and Apple Speech availability. Allow Speech Recognition if the system prompts.');
      const outcome = await new Promise<{ ok: true } | { ok: false; code: string; message: string; retryable: boolean }>((resolve) => {
        let settled = false;
        let child: WatchHelperChild | undefined;
        const done = (v: { ok: true } | { ok: false; code: string; message: string; retryable: boolean }): void => {
          if (settled) return;
          settled = true;
          probeCancels.delete(cancel);
          clearTimer(timer);
          try {
            child?.endStdin();
          } catch { /* best effort */ }
          try {
            child?.kill('SIGTERM');
          } catch { /* best effort */ }
          resolve(v);
        };
        const cancel = (): void => done({ ok: false, code: 'cancelled', message: 'Watch service closed.', retryable: false });
        probeCancels.add(cancel);
        const timer = setTimeout(() => {
          done({ ok: false, code: 'helper-timeout', message: 'The watch voice helper did not become ready in time. Re-confirm setup; if it persists, rebuild the helper from source.', retryable: true });
        }, readyTimeoutMs);
        if (timer.unref) timer.unref();
        try {
          child = spawnHelper([], {
            onLine: (line) => {
              const msg = parseHelperLine(line);
              if (!msg || settled) return;
              if (msg['event'] === 'ready') {
                done({ ok: true });
                return;
              }
              if (msg['event'] === 'error') {
                const code = typeof msg['code'] === 'string' ? (msg['code'] as string) : 'helper-error';
                const mapped = permissionErrorFor(code);
                done({ ok: false, ...mapped });
              }
            },
            onExit: (code) => {
              if (settled) return;
              if (code === 2) {
                done({ ok: false, code: 'speech-permission', message: 'Speech Recognition permission was denied (helper exit 2). Open System Settings, Privacy and Security, Speech Recognition, allow the helper, then confirm setup again.', retryable: false });
              } else if (code === 3) {
                done({ ok: false, code: 'locale-unavailable', message: `Apple Speech helper exited 3 (unsupported locale or configuration for ${locale}). Choose a supported locale in Settings, then confirm setup again.`, retryable: false });
              } else {
                done({ ok: false, code: 'helper-unavailable', message: 'The watch voice helper ended before ready. Rebuild it from source on this Mac, then confirm setup again.', retryable: true });
              }
            },
          });
        } catch (err) {
          done({ ok: false, code: 'helper-unavailable', message: `The watch voice helper could not start: ${err instanceof Error ? err.message : String(err)}`, retryable: true });
        }
      });
      if (outcome.ok) {
        setStatus('ready', 'Watch voice input is ready. Speak after the watch record control starts capture.');
      } else {
        setStatus('error', outcome.message);
      }
    })();
    diagnosticsInFlight = task;
    try {
      await task;
    } finally {
      diagnosticsInFlight = undefined;
    }
  };

  // Rehydration is lazy and read-only: never --authorize, diagnostics capture,
  // PCM or a permission prompt. The OS verdict is NOT inferred from the file.
  let restoration: Promise<void> | undefined;
  const restoreConsent = (): Promise<void> => restoration ??= (async () => {
    if (disposed || !deps.consentPath) return;
    try {
      const saved = await readWatchConsent(deps.consentPath);
      if (!saved?.consent || saved.locale !== locale) return;
      if (platform !== 'darwin') { setStatus('error', backendUnsupportedMessage()); return; }
      if (!(await existsHelper())) { setStatus('error', missingBinaryMessage(helperPath)); return; }
      const manifest = await verifyNativeManifest(helperPath, platform);
      if (!manifest.ok) { setStatus('error', manifest.message); return; }
      if (disposed) return;
      const valid = await new Promise<boolean>((resolve) => {
        let settled = false;
        let child: WatchHelperChild | undefined;
        const done = (ok: boolean): void => {
          if (settled) return;
          settled = true; probeCancels.delete(cancel); clearTimer(timer);
          child?.endStdin(); child?.kill('SIGTERM'); resolve(ok);
        };
        const cancel = (): void => done(false);
        probeCancels.add(cancel);
        const timer = setTimeout(() => done(false), readyTimeoutMs);
        try {
          child = spawnHelper(['--status'], {
            onLine: (line) => {
              const msg = parseHelperLine(line);
              if (msg?.['mode'] !== 'status') return;
              done(msg['tool'] === 'watch-asr' && msg['authorization'] === 'authorized' &&
                msg['locale'] === locale && msg['localeAvailable'] === true && msg['onDeviceRecognition'] === true);
            },
            onExit: () => done(false),
          });
          if (settled) { child.endStdin(); child.kill('SIGTERM'); }
        } catch { done(false); }
      });
      if (disposed) return;
      if (!valid) { setStatus('error', 'Saved watch consent could not be validated. Confirm setup after checking Speech permission and locale.'); return; }
      consented = true;
      consentedMode = 'watch-asr';
      setStatus('ready', 'Watch Speech consent restored after read-only OS validation. Capture starts only from the watch record control.');
    } catch {
      consented = false;
      setStatus('error', 'Watch consent storage is invalid or unsafe. Use an owned 0700 directory and 0600 file, then confirm setup.');
    }
  })();

  const persistConsent = async (consent: boolean): Promise<void> => {
    if (!deps.consentPath) return;
    if (disposed) return;
    await writeWatchConsent(deps.consentPath, { version: 1, scope: 'watch-asr', consent, locale }, () => !disposed);
  };

  const service: LiveVoiceWatchService & { dispose(): Promise<void> } = {
    async status(): Promise<LiveVoiceWatchStatusReport> {
      await restoreConsent();
      const report: LiveVoiceWatchStatusReport = {
        status: liveStatus,
        pcm: { ...WATCH_PCM },
        consent: consented ? 'granted' : 'required',
      };
      if (statusMessage) report.message = statusMessage;
      return report;
    },

    async setup(opts: { consent: boolean; mode?: LiveVoiceWatchInputMode }): Promise<{ status: LiveVoiceWatchStatus; pcm: PcmFormat }> {
      await restoreConsent();
      if (disposed) return { status: 'closed', pcm: { ...WATCH_PCM } };
      const mode: LiveVoiceWatchInputMode = opts.mode ?? 'watch-asr';
      if (opts.consent !== true) {
        consented = false;
        consentedMode = mode;
        if (active) terminalize(active, 'closed', 'Watch consent revoked.');
        try { await persistConsent(false); } catch { setStatus('error', 'Watch consent revocation could not be persisted safely.'); return { status: liveStatus, pcm: { ...WATCH_PCM } }; }
        setStatus('warming', consentGuidance(mode));
        return { status: liveStatus, pcm: { ...WATCH_PCM } };
      }
      consented = true;
      consentedMode = mode;
      if (active) {
        setStatus('capturing', 'Watch voice input is capturing.');
        return { status: liveStatus, pcm: { ...WATCH_PCM } };
      }
      if (platform !== 'darwin') {
        // Graceful degradation: never claim ready where Apple Speech cannot run.
        setStatus('error', backendUnsupportedMessage());
        return { status: liveStatus, pcm: { ...WATCH_PCM } };
      }
      if (!(await existsHelper())) {
        setStatus('error', missingBinaryMessage(helperPath));
        return { status: liveStatus, pcm: { ...WATCH_PCM } };
      }
      // Readonly tamper guard BEFORE any spawn: a modified binary never runs.
      const manifestCheck = await verifyNativeManifest(helperPath, platform);
      if (!manifestCheck.ok) {
        setStatus('error', manifestCheck.message);
        return { status: liveStatus, pcm: { ...WATCH_PCM } };
      }
      // Truthful ready on explicit user consent: FIRST request Speech
      // authorization via --authorize (may show the OS prompt on this user
      // action), THEN validate the live path with a short-lived diagnostics
      // helper before ever claiming ready.
      if (disposed) return { status: 'closed', pcm: { ...WATCH_PCM } };
      const auth = await runAuthorize();
      if (!auth.ok) {
        setStatus('error', auth.message);
        return { status: liveStatus, pcm: { ...WATCH_PCM } };
      }
      await runDiagnostics();
      if (liveStatus === 'ready') {
        try { await persistConsent(mode === 'watch-asr'); } catch { consented = false; setStatus('error', 'Watch consent could not be persisted safely.'); }
      }
      return { status: liveStatus, pcm: { ...WATCH_PCM } };
    },

    async createInput(args) {
      await restoreConsent();
      if (disposed) throw codedError('cancelled', 'Watch service closed.', false);
      const { streamId, onEvent, signal } = args;
      if (!consented) throw notConsentedError();
      if (platform !== 'darwin') {
        throw codedError('backend-unsupported', backendUnsupportedMessage(), false);
      }
      if (!(await existsHelper())) {
        const msg = missingBinaryMessage(helperPath);
        setStatus('error', msg);
        throw codedError('helper-missing', msg, false);
      }
      // Readonly tamper guard BEFORE any spawn: a modified binary never runs.
      const manifestCheck = await verifyNativeManifest(helperPath, platform);
      if (!manifestCheck.ok) {
        setStatus('error', manifestCheck.message);
        throw codedError('helper-tamper', manifestCheck.message, false);
      }
      if (disposed) throw codedError('cancelled', 'Watch service closed.', false);
      // Mutual exclusion first: never steal, never clear another owner's busy
      // on mere intent. A failed acquirer leaves the current owner untouched.
      if (active && !active.closed) throw busyError();
      if (runtime.activeSessionId) throw busyError();
      if (runtime.dictateLease) throw busyError();
      if (typeof streamId !== 'string' || !streamId.trim() || streamId.length > 64) {
        throw codedError('bad-stream', 'Invalid streamId.', false);
      }
      if (signal?.aborted) {
        throw codedError('cancelled', 'Watch voice input was cancelled before it started.', true);
      }

      setStatus('warming', 'Watch voice helper is warming. Waiting for helper ready before audio is accepted.');
      const myGeneration = generation;
      const state: ActiveInput = {
        streamId,
        child: undefined as unknown as WatchHelperChild,
        onEvent,
        txChunks: 0,
        txBytes: 0,
        ackFinals: 0,
        ready: false,
        closed: false,
        generation: myGeneration,
        utteranceId: undefined,
        readyTimer: undefined,
        finalTimer: undefined,
        endRequested: false,
        finalReceived: false,
        stoppedReceived: false,
        terminalErrorSent: false,
        pendingDeliveries: new Set(),
        deliveryChain: Promise.resolve(),
        abortHandler: undefined,
        signal,
        resolveReady: undefined,
        rejectReady: undefined,
      };
      active = state;
      // A new explicit record stream expresses fresh user intent. Prior
      // completed replies must not erase deliberate short answers. The host
      // stops prior playback on record; only synthesis during this capture
      // contributes new echo references. Failed/busy acquirers never clear it.
      recentSpoken.length = 0;

      const onLine = (line: string): void => {
        if (state.closed || active !== state || state.generation !== generation) return;
        const msg = parseHelperLine(line);
        if (!msg) return;
        const event = msg['event'];
        if (event === 'ready') {
          if (state.ready) return;
          state.ready = true;
          clearTimer(state.readyTimer);
          state.readyTimer = undefined;
          setStatus('capturing', 'Watch voice input is capturing.');
          const resolve = state.resolveReady;
          state.resolveReady = undefined;
          state.rejectReady = undefined;
          if (resolve) resolve(buildHandle(state));
          return;
        }
        if (event === 'error') {
          const code = typeof msg['code'] === 'string' ? (msg['code'] as string) : 'helper-error';
          const mapped = permissionErrorFor(code);
          if (!state.ready && state.rejectReady) {
            const reject = state.rejectReady;
            state.resolveReady = undefined;
            state.rejectReady = undefined;
            clearTimer(state.readyTimer);
            terminalize(state, 'error', mapped.message, mapped);
            reject(codedError(mapped.code, mapped.message, mapped.retryable));
          } else {
            terminalize(state, 'error', mapped.message, mapped);
          }
          return;
        }
        // Ignore recognition traffic until native ready: nothing is accepted
        // before the backend confirms it, so nothing can be silently shed.
        if (!state.ready) return;
        if (event === 'partial' && typeof msg['text'] === 'string') {
          const utteranceId = typeof msg['utteranceId'] === 'string' ? (msg['utteranceId'] as string) : '';
          state.utteranceId = utteranceId || state.utteranceId;
          const text = msg['text'] as string;
          if (args.purpose !== 'dictation' && isEcho(text)) return;
          void deliver(state, { kind: 'partial', streamId, utteranceId: state.utteranceId ?? '', text });
          return;
        }
        if (event === 'final' && typeof msg['text'] === 'string') {
          const utteranceId =
            typeof msg['utteranceId'] === 'string' ? (msg['utteranceId'] as string) : (state.utteranceId ?? '');
          const text = msg['text'] as string;
          if (args.purpose !== 'dictation' && isEcho(text)) {
            state.ackFinals += 1;
            state.finalReceived = true;
            maybeFinishEnd(state);
            return;
          }
          state.ackFinals += 1;
          state.finalReceived = true;
          void deliver(state, { kind: 'final', streamId, utteranceId, text }).then(() => {
            maybeFinishEnd(state);
          });
          return;
        }
        if (event === 'stopped') {
          state.stoppedReceived = true;
          maybeFinishEnd(state);
          return;
        }

      };

      const onExit = (code: number | null): void => {
        if (state.closed) return;
        if (active !== state) return;
        if (!state.ready && state.rejectReady) {
          const reject = state.rejectReady;
          state.resolveReady = undefined;
          state.rejectReady = undefined;
          clearTimer(state.readyTimer);
          if (code === 2) {
            const message = 'Speech Recognition permission was denied (helper exit 2). Open System Settings, Privacy and Security, Speech Recognition, allow the helper, then confirm setup again.';
            terminalize(state, 'error', message, { code: 'speech-permission', message, retryable: false });
            reject(codedError('speech-permission', message, false));
          } else if (code === 3) {
            const message = `Apple Speech helper exited 3 (unsupported locale or configuration for ${locale}). Choose a supported locale in Settings, then confirm setup again.`;
            terminalize(state, 'error', message, { code: 'locale-unavailable', message, retryable: false });
            reject(codedError('locale-unavailable', message, false));
          } else {
            const message = 'The watch voice helper ended before ready. Rebuild it from source on this Mac, then confirm setup again.';
            terminalize(state, 'error', message, { code: 'helper-unavailable', message, retryable: true });
            reject(codedError('helper-unavailable', message, true));
          }
          return;
        }
        if (state.ready && code !== 0) {
          // A final receipt/EOF must not hide subsequent permission, locale or
          // helper failures when healthy stream closure maps back to ready.
          const error = code === 2 ? permissionErrorFor('speech-permission')
            : code === 3 ? permissionErrorFor('locale-unavailable')
              : { code: 'helper-exit', message: 'The watch voice helper ended unexpectedly. Re-confirm setup to start a new input.', retryable: true };
          terminalize(state, 'error', error.message, error);
          return;
        }
        if (state.ready && state.ackFinals > 0) {
          // Clean exit after a delivered final: terminal close, keep receipt.
          terminalize(state, 'closed', 'Watch voice input closed.');
          return;
        }
        if (state.endRequested) {
          // EOF path with no final yet: let the EOF waiter decide no-speech
          // explicitly; do not invent a silent close here.
          state.stoppedReceived = true;
          maybeFinishEnd(state);
          return;
        }
        if (code === 2) {
          const message = 'Speech Recognition permission was denied (helper exit 2). Open System Settings, Privacy and Security, Speech Recognition, allow the helper, then confirm setup again.';
          terminalize(state, 'error', message, { code: 'speech-permission', message, retryable: false });
        } else if (code === 3) {
          const message = `Apple Speech helper exited 3 (unsupported locale or configuration for ${locale}). Choose a supported locale in Settings, then confirm setup again.`;
          terminalize(state, 'error', message, { code: 'locale-unavailable', message, retryable: false });
        } else {
          terminalize(state, 'error', 'The watch voice helper ended. Re-confirm setup to start a new input.', { code: 'helper-exit', message: 'The watch voice helper ended. Re-confirm setup to start a new input.', retryable: true });
        }
      };

      try {
        state.child = spawnHelper([], { onLine, onExit });
      } catch (err) {
        const message = `The watch voice helper could not start: ${err instanceof Error ? err.message : String(err)}`;
        if (active === state) active = undefined;
        setStatus('error', message);
        throw codedError('helper-unavailable', message, true);
      }

      const readyPromise = new Promise<LiveVoiceWatchInputHandleShape>((resolve, reject) => {
        state.resolveReady = resolve;
        state.rejectReady = reject;
      });

      state.readyTimer = setTimeout(() => {
        if (state.closed || state.ready) return;
        const reject = state.rejectReady;
        state.resolveReady = undefined;
        state.rejectReady = undefined;
        const message = 'The watch voice helper did not become ready in time. Re-confirm setup; if it persists, rebuild the helper from source.';
        terminalize(state, 'error', message, { code: 'helper-timeout', message, retryable: true });
        reject?.(codedError('helper-timeout', message, true));
      }, readyTimeoutMs);
      if (state.readyTimer.unref) state.readyTimer.unref();

      const abort = (): void => {
        if (state.closed) return;
        if (!state.ready && state.rejectReady) {
          const reject = state.rejectReady;
          state.resolveReady = undefined;
          state.rejectReady = undefined;
          clearTimer(state.readyTimer);
          terminalize(state, 'closed', 'Watch voice input was cancelled.', { code: 'cancelled', message: 'Watch voice input was cancelled.', retryable: true });
          reject(codedError('cancelled', 'Watch voice input was cancelled.', true));
          return;
        }
        terminalize(state, 'closed', 'Watch voice input was cancelled.', { code: 'cancelled', message: 'Watch voice input was cancelled.', retryable: true });
      };
      state.abortHandler = abort;
      signal?.addEventListener('abort', abort, { once: true });

      // Awaited preflight: resolve ONLY on real native ready; reject on
      // denial/timeout/cancel with resources cleared.
      return readyPromise.then((handle) => handle as unknown as Awaited<ReturnType<LiveVoiceWatchService['createInput']>>);
    },

    async synthesize(args) {
      await restoreConsent();
      if (disposed) throw codedError('cancelled', 'Watch service closed.', false);
      const { text, speechId, onChunk, onDone, signal } = args;
      if (!consented) throw notConsentedError();
      void consentedMode;
      if (typeof text !== 'string' || !text.trim() || text.length > WATCH_MAX_SYNTH_CHARS) {
        throw new Error('Invalid synthesis text.');
      }
      if (typeof speechId !== 'string' || !speechId) throw new Error('Invalid speechId.');
      if (signal?.aborted) return;
      // Bounded private wav workspace: dir 0700, file 0600, always cleaned
      // up on cancel and on errors. Never logs `text`.
      const dirPath = path.join(tmpdir(), `dsh-watch-say-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffff).toString(16)}`);
      await mkdir(dirPath, { recursive: true, mode: 0o700 });
      await chmod(dirPath, 0o700);
      const outPath = path.join(dirPath, 'speech.caf');
      let cancelled = false;
      const onAbort = (): void => {
        cancelled = true;
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        await synthFile(text, outPath, WATCH_PCM.sampleRate);
        try {
          await chmod(outPath, 0o600);
        } catch { /* TESTONLY fakes may skip */ }
        if (disposed || cancelled || signal?.aborted) return;
        const raw = await readFile(outPath);
        // Strip the container header: CAF `data` chunk (the `say` CAF
        // produced here) or legacy AIFF SSND; fall back to raw when absent
        // (TESTONLY fakes write raw PCM). Never log `text`.
        let pcm: Uint8Array = raw;
        const cafData = findCafData(raw);
        if (cafData) {
          pcm = cafData;
        } else {
          const ssnd = raw.indexOf(Buffer.from('SSND'));
          if (ssnd >= 0 && ssnd + 16 <= raw.length) {
            const size = raw.readUInt32BE(ssnd + 8);
            const offset = raw.readUInt32BE(ssnd + 12);
            const start = ssnd + 16 + offset;
            pcm = raw.subarray(start, Math.min(raw.length, start + size));
          }
        }
        for (let at = 0; at < pcm.length && !disposed && !cancelled && !signal?.aborted; at += WATCH_SYNTH_CHUNK_BYTES) {
          onChunk(new Uint8Array(pcm.subarray(at, Math.min(pcm.length, at + WATCH_SYNTH_CHUNK_BYTES))));
          // Bounded cooperative yield keeps large buffers from pinning the loop.
          await new Promise((r) => setImmediate(r));
        }
        if (!disposed && !cancelled && !signal?.aborted) {
          rememberSpoken(text);
          onDone({ speechId });
        }
      } finally {
        signal?.removeEventListener('abort', onAbort);
        try {
          await unlink(outPath);
        } catch { /* fake or already removed */ }
        try {
          await rm(dirPath, { recursive: true, force: true });
        } catch { /* best effort */ }
      }
    },

    async dispose(): Promise<void> {
      disposed = true;
      consented = false;
      setStatus('closed', 'Watch voice input closed.');
      for (const cancel of [...probeCancels]) cancel();
      if (restoration) await restoration;
      await setupQueue;
      const cur = active;
      active = undefined;
      generation += 1;
      if (!cur || cur.closed) {
        setStatus('closed', 'Watch voice input closed.');
        return;
      }
      cur.closed = true;
      clearTimer(cur.readyTimer);
      clearTimer(cur.finalTimer);
      cur.readyTimer = undefined;
      cur.finalTimer = undefined;
      if (cur.signal && cur.abortHandler) {
        try {
          cur.signal.removeEventListener('abort', cur.abortHandler);
        } catch { /* best effort */ }
      }
      cur.abortHandler = undefined;
      if (cur.rejectReady) {
        const reject = cur.rejectReady;
        cur.resolveReady = undefined;
        cur.rejectReady = undefined;
        reject(codedError('cancelled', 'Watch voice input was disposed.', true));
      }
      try {
        cur.child.endStdin();
      } catch { /* best effort */ }
      try {
        cur.child.kill('SIGTERM');
      } catch { /* best effort */ }
      setStatus('closed', 'Watch voice input closed.');
    },
  };

  function buildHandle(state: ActiveInput): LiveVoiceWatchInputHandleShape {
    return {
      writePCM(bytes: Uint8Array | ArrayBuffer): void {
        if (state.closed || active !== state) throw new Error('Watch voice input is closed.');
        if (!state.ready) throw new Error('Watch voice input is still warming: helper is not ready.');
        const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        if (view.length === 0) return;
        // Privacy telemetry only: bucket the level, never retain or log audio/text.
        void rmsBucket(chunkRms(view));
        const ok = state.child.writeStdin(view);
        void ok;
        state.txChunks += 1;
        state.txBytes += view.length;
      },
      async end(): Promise<void> {
        if (state.closed) return;
        if (active !== state) throw new Error('Watch voice input is closed.');
        state.endRequested = true;
        try {
          state.child.endStdin();
        } catch { /* stdin already closed */ }
        // Wait for the ACTUAL final ack (helper final + H delivery ack),
        // an explicit stopped/no-speech terminal, helper exit, or the bound.
        // Never resolve a silent false-closed: the timeout path emits an
        // explicit `no-speech` error event first.
        await new Promise<void>((resolve) => {
          const finish = (): void => {
            clearTimer(state.finalTimer);
            state.finalTimer = undefined;
            resolve();
          };
          state.finalTimer = setTimeout(() => {
            if (state.closed) {
              finish();
              return;
            }
            if (!state.finalReceived) {
              const message = 'No speech was recognized in this capture. Speak clearly near the watch, then end capture again if needed.';
              terminalize(state, 'closed', message, { code: 'no-speech', message, retryable: false });
            } else {
              // Final arrived but H's delivery ack is still pending: give the
              // chain a bounded drain rather than shedding it.
              void state.deliveryChain.then(() => {
                if (!state.closed) terminalize(state, 'closed', 'Watch voice input closed.');
                finish();
              });
              return;
            }
            finish();
          }, finalTimeoutMs);
          if (state.finalTimer.unref) state.finalTimer.unref();
          const poll = (): void => {
            if (state.closed) {
              finish();
              return;
            }
            if (state.finalReceived) {
              void state.deliveryChain.then(() => {
                if (!state.closed) terminalize(state, 'closed', 'Watch voice input closed.');
                finish();
              });
              return;
            }
            if (state.stoppedReceived) {
              const message = 'No speech was recognized in this capture. Speak clearly near the watch, then end capture again if needed.';
              terminalize(state, 'closed', message, { code: 'no-speech', message, retryable: false });
              finish();
              return;
            }
            setTimeout(poll, 50).unref?.();
          };
          poll();
        });
      },
      async dispose(): Promise<void> {
        if (state.signal && state.abortHandler) {
          try {
            state.signal.removeEventListener('abort', state.abortHandler);
          } catch { /* best effort */ }
        }
        state.abortHandler = undefined;
        if (state.closed) {
          if (active === state) active = undefined;
          return;
        }
        terminalize(state, 'closed', 'Watch voice input closed.');
      },
    };
  }

  function maybeFinishEnd(state: ActiveInput): void {
    // The end() poller owns the terminal transition: a final arriving after
    // end() was requested still waits for H's delivery ack inside end().
    // A final arriving with no end() requested stays capturing (more audio
    // may follow); only EOF / stopped / timeout / dispose terminates.
    if (state.closed) return;
    if (state.endRequested && state.finalReceived) {
      // Let the end() waiter drain the delivery chain and terminate.
      return;
    }
    if (state.endRequested && state.stoppedReceived && !state.finalReceived) {
      // EOF waiter will emit explicit no-speech; nothing to do here.
      return;
    }
  }

  // Serialize consent changes: an older in-flight Setup can never overwrite a
  // later revocation (or restore ready after revocation).
  const setup = service.setup.bind(service);
  let setupQueue: Promise<void> = Promise.resolve();
  service.setup = (opts) => {
    const task = setupQueue.then(() => setup(opts));
    setupQueue = task.then(() => undefined, () => undefined);
    return task;
  };
  return service;
}
