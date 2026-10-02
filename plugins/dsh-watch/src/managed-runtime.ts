/**
 * Managed in-process turnkey runtime (H-owned).
 *
 * ONE runtime per DSH profile: HTTPS LAN server (ephemeral/auto port, NOT
 * the DSH web port) + pairing service + device-token store + session-binding
 * resolver + full watch endpoints + SSE. Lifecycle bound to the profile
 * fiber via `ctx.effect` (single disposer; hot reload disposes before
 * re-apply so no port leaks).
 *
 * Ported feature-for-feature from the legacy `bridge/*.mjs` standalone
 * server into this in-process adapter (health/stream/state/capabilities/
 * image/mic/command/cappi/pair-probe + session queue + approvals + models +
 * questions + audio outputs + speech chunks) — NOT a stripped
 * green-health-only demo. Legacy explicit `bridgeMode` remains as an
 * optional advanced path (see turnkey config); default is managed.
 *
 * One active watch per profile (0.3): approval reserves capacity; delivery
 * rechecks capacity. A replacement must explicitly revoke the previous watch.
 * Shared watch transport never reaches a second authorized device. Session
 * queues/projections remain keyed by their actual harness session id.
 */

import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { createSocket, type Socket } from 'node:dgram';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { privateDirectory, writePrivateFile } from './private-files.ts';
import { turnkeyDir } from './cert.ts';
import type { LiveVoiceWatchService, LiveVoiceInputHandle } from './watch-api.ts';
import {
  HostSessionHost,
  asHostSessionPort,
  checkSessionBinding,
  followRequestFor,
  withTimeoutSignal,
  type HostSessionPort,
  type SessionFollowFrame,
} from './host-adapter.ts';
import { pinMatches, type TlsIdentity } from './cert.ts';
import {
  MAX_ATTEMPTS,
  TurnkeyStore,
  isOpaqueId,
  newOpaqueId,
  secretMatches,
} from './pairing-store.ts';
import { modelState, modelValue } from './model-wire.ts';
import { readJsonBody } from './json-body.ts';
import type { WorkspaceController, WorkspaceFollowFrame } from '@deepseek-ai/dsh-api-workspace-controller';
import type { PermissionPresetService } from '@deepseek-ai/dsh-permission-presets';
import type { ApprovalRequestEvent, ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types';
import type { AskUserQuestionRequest, AskUserQuestionAnswer, AskUserQuestionAnswerItem } from '@deepseek-ai/dsh-user-questions';
import { toSessionId, type SessionUpdateQueueRequest, type SessionCatalog, type SessionControlFrame, type SessionListValue } from './host-adapter.ts';
import { PAYLOAD_DEFAULT, PAYLOAD_PACKS } from './character-payload.ts';

export const PAIR_INFO_PATH = '/pair/info';
export const PAIR_ENROLL_PATH = '/pair/enroll';
export const PAIR_POLL_PATH = '/pair/poll';

const TOKEN_HEADER = 'x-bridge-token';
const PIN_HEADER = 'x-cert-pin';
const FINGERPRINT_HEADER = 'x-fingerprint-confirmed';

export type HostSessionController = HostSessionPort;
export { asHostSessionPort };

export interface RuntimeOptions {
  dshHome: string;
  identity: TlsIdentity;
  store: TurnkeyStore;
  serverDisplayName?: string | undefined;
  sessionController?: HostSessionPort | unknown | undefined;
  workspaceController?: unknown;
  liveVoiceWatch?: LiveVoiceWatchService | undefined;
  logger?: Pick<Console, 'log' | 'error'> | undefined;
  permissionPresets?: Pick<PermissionPresetService, 'set' | 'current' | 'names' | 'optionOf'> | undefined;
  /** Test-only injected private candidates; never touches production UDP ports. */
  discoveryPorts?: readonly number[];
  /** Advanced explicit port; outside 8788..8797 requires manual discovery. */
  discoveryPort?: number | undefined;
}

/** Bounded streaming caps for one mic upload (never unbounded buffering). */
const MIC_MAX_BYTES = 24 << 20;
const MIC_INPUT_TIMEOUT_MS = 35_000;
const MIC_DRAIN_TIMEOUT_MS = 8_000;
const MIC_FINAL_WAIT_MS = 8_000;
const HOST_RPC_TIMEOUT_MS = 15_000;
const BINDING_LOOKUP_TIMEOUT_MS = 5_000;

interface MicSession {
  streamId: string;
  deviceId: string;
  generation: number;
  /** Watch binding captured at mic preflight (TOCTOU recheck at delivery). */
  boundSessionId: string;
  /** Optional pending-question id this stream drafts for (never autosubmits). */
  draftRequestId?: string | undefined;
  draftQuestionIndex?: number | undefined;
  state: 'ready' | 'capturing' | 'closed' | 'error';
  txChunks: number;
  txBytes: number;
  /** Finals acknowledged by a SUCCESSFUL host delivery only. */
  ackFinals: number;
  draftFinals: number;
  /** Finals safely received but NOT host-delivered (failure/binding/draft). */
  unackedFinals: number;
  /** True once the terminal delivery outcome (success or safe failure) settles. */
  deliverySettled: boolean;
  lastDeliveryError?: string | undefined;
  lastDeliveryCode?: string | undefined;
  lastDeliveryRetryable?: boolean | undefined;
  utteranceId?: string | undefined;
  deliveredUtterances: Set<string>;
  createdAtMs: number;
  handle: LiveVoiceInputHandle;
  abort: AbortController;
  onEvent: (e: { kind: string; utteranceId?: string; text?: string; code?: string; message?: string; retryable?: boolean }) => void | Promise<void>;
}

interface QuestionDraft {
  boundSessionId: string;
  questionIndex: number;
  requestId: string;
  deviceId: string;
  streamId: string;
  utteranceId: string;
  text: string;
  atMs: number;
}

/**
 * Per-device host-follow projection (HS-owned follow consumption).
 *
 * ONE follow owner per device/selected-session: `follows` holds at most one
 * live pump per deviceId; reselect/stop/revoke/dispose aborts the old owner
 * before a new one starts (generation-guarded, stale frames dropped).
 * Assistant text is CUMULATIVE (streamed deltas + assembled messages,
 * suffix-deduped so replays/history never double-count) and TTS fires at most
 * once per turn from LIVE event frames only — snapshot history never speaks,
 * so reselect never replays audio. `lastUserText` is an echo guard (the watch
 * never hears its own submission parroted back).
 */
interface FollowTodo {
  content: string;
  status: string;
}
interface FollowQuestion {
  id: string;
  toolName: string;
  reason?: string | undefined;
}
interface FollowMedia {
  ref?: string | undefined;
  label?: string | undefined;
  mediaType?: string | undefined;
  name?: string | undefined;
}
interface FollowView {
  sessionId: string;
  cwd?: string | undefined;
  running: boolean;
  turn: number | null;
  assistantText: string;
  done: boolean;
  lastSeq: number;
  todos: FollowTodo[];
  hostQuestions: FollowQuestion[];
  media: FollowMedia[];
  memory: string | null;
  updatedAtMs: number;
}
interface DeviceFollow {
  deviceId: string;
  sessionId: string;
  generation: number;
  abort: AbortController;
  done: Promise<void>;
  view: FollowView;
  /** Turn keys already spoken (`${turn}` or `seq:${seq}`); bounded. */
  spokenTurns: Set<string>;
  lastUserText: string;
  lastEmittedRunning: boolean | null;
  lastEmittedText: string | null;
  lastEmittedDone: boolean | null;
  seenSnapshot: boolean;
}

function emptyFollowView(sessionId: string): FollowView {
  return {
    sessionId,
    running: false,
    turn: null,
    assistantText: '',
    done: false,
    lastSeq: 0,
    todos: [],
    hostQuestions: [],
    media: [],
    memory: null,
    updatedAtMs: Date.now(),
  };
}

function isFollowRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Append observed assistant text without double-counting replays/assemblies. */
function appendFollowText(cumulative: string, text: string): string {
  if (!text) return cumulative;
  if (!cumulative) return text.slice(0, 8000);
  if (cumulative.endsWith(text)) return cumulative;
  if (text.startsWith(cumulative)) return text.slice(0, 8000);
  return (cumulative + text).slice(0, 8000);
}

function textOfMessageContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (isFollowRecord(block) && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('');
}

/** Apply ONE wire event ({ type, seq, time, data }) to the view. */
function applyFollowWireEvent(view: FollowView, wire: { type: string; seq: number; data: unknown }): void {
  const seq = wire.seq;
  if (seq >= 0) {
    if (seq <= view.lastSeq) return; // replay/duplicate guard
    view.lastSeq = seq;
  }
  const type = wire.type;
  const data = isFollowRecord(wire.data) ? wire.data : {};
  switch (type) {
    case 'turn/start': {
      if (typeof data.turn === 'number') view.turn = data.turn;
      view.running = true;
      view.assistantText = '';
      view.done = false;
      break;
    }
    case 'turn/end': {
      view.running = false;
      view.done = true;
      break;
    }
    case 'assistant/chunk': {
      const chunk = isFollowRecord(data.chunk) ? data.chunk : null;
      if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        view.assistantText = appendFollowText(view.assistantText, chunk.text);
        view.done = false;
      }
      break;
    }
    case 'assistant/message': {
      const message = isFollowRecord(data.message) ? data.message : null;
      const text = message ? textOfMessageContent(message.content) : '';
      if (text) {
        view.assistantText = appendFollowText(view.assistantText, text);
        view.done = true;
      }
      break;
    }
    case 'todo/write': {
      if (Array.isArray(data.todos)) {
        const todos: FollowTodo[] = [];
        for (const t of data.todos.slice(0, 50)) {
          if (isFollowRecord(t) && typeof t.content === 'string' && typeof t.status === 'string') {
            todos.push({ content: t.content.slice(0, 500), status: t.status.slice(0, 32) });
          }
        }
        view.todos = todos;
      }
      break;
    }
    case 'approval/asked': {
      const id = typeof data.id === 'string' ? data.id.slice(0, 128) : '';
      const toolName = typeof data.toolName === 'string' ? data.toolName.slice(0, 128) : '';
      if (id && toolName && !view.hostQuestions.some((q) => q.id === id)) {
        view.hostQuestions.push({
          id,
          toolName,
          ...(typeof data.reason === 'string' && data.reason ? { reason: data.reason.slice(0, 500) } : {}),
        });
        if (view.hostQuestions.length > 20) view.hostQuestions.splice(0, view.hostQuestions.length - 20);
      }
      break;
    }
    case 'approval/decided': {
      const id = typeof data.id === 'string' ? data.id : '';
      if (id) view.hostQuestions = view.hostQuestions.filter((q) => q.id !== id);
      break;
    }
    case 'compaction/summary': {
      if (typeof data.summary === 'string' && data.summary) {
        view.memory = data.summary.slice(0, 2000);
      }
      break;
    }
    case 'user/message': {
      // Image/media refs only — user TEXT is never projected (never spoken).
      const content = isFollowRecord(data) ? data.content : null;
      if (Array.isArray(content)) {
        for (const block of content.slice(0, 10)) {
          if (isFollowRecord(block) && block.type === 'image') {
            view.media.push({
              ...(typeof block.attachmentId === 'string' ? { ref: `${view.sessionId}|${block.attachmentId}`, label: typeof block.name === 'string' ? block.name : 'Image' } : {}),
              ...(typeof block.mediaType === 'string' ? { mediaType: block.mediaType.slice(0, 64) } : {}),
              ...(typeof block.name === 'string' ? { name: block.name.slice(0, 128) } : {}),
            });
            if (view.media.length > 10) view.media.splice(0, view.media.length - 10);
          }
        }
      }
      break;
    }
    default:
      break; // forward-compatible: unknown event names are ignored, never fatal
  }
  view.updatedAtMs = Date.now();
}

/**
 * Apply snapshot/event records (`SessionHistoryRecord`: `{ type:'event',
 * event }` or `{ type:'chunks', event: ChunkRowEvent }`) to the view.
 * Chunk-row text runs (`chunkrow/text-chunks` with `texts[]`) accumulate;
 * reasoning/tool-call runs are NEVER user-visible text (never spoken).
 */
function applyFollowRecords(view: FollowView, records: readonly unknown[]): void {
  for (const record of records) {
    if (!isFollowRecord(record)) continue;
    if (record.type === 'event' && isFollowRecord(record.event)) {
      const wire = record.event;
      applyFollowWireEvent(view, {
        type: typeof wire.type === 'string' ? wire.type : '',
        seq: typeof wire.seq === 'number' ? wire.seq : -1,
        data: wire.data,
      });
      continue;
    }
    if (record.type === 'chunks' && isFollowRecord(record.event)) {
      const run = record.event;
      const seq = typeof run.seq === 'number' ? run.seq : -1;
      if (seq >= 0) {
        if (seq <= view.lastSeq) continue;
        view.lastSeq = seq;
      }
      if (run.type === 'chunkrow/text-chunks' && isFollowRecord(run.data) && Array.isArray(run.data.texts)) {
        const texts = run.data.texts.filter((t): t is string => typeof t === 'string').join('');
        if (texts) {
          view.assistantText = appendFollowText(view.assistantText, texts);
          view.done = false;
        }
      }
      view.updatedAtMs = Date.now();
    }
  }
}

interface SseClient {
  res: { write: (s: string) => void; end?: () => void };
  deviceId: string;
}

function json(res: { writeHead: (c: number, h: Record<string, string>) => void; end: (b?: string | Uint8Array) => void }, code: number, obj: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}


export class ManagedTurnkeyRuntime {
  private opts: RuntimeOptions;
  private disposed = false;
  private streamsAbort = new AbortController();
  private streams: Promise<void>[] = [];
  private queues = new Map<string, Array<{ id: string; text: string; state: string }>>();
  private jobs = new Map<string, Array<{ id: string; label: string; state: string }>>();
  private projections = new Map<string, Record<string, unknown>>();
  private projectionSeqs = new Map<string, Map<string, number>>();
  private workspaces: Record<string, unknown>[] = [];
  private archivedSessionIds: string[] = [];
  private requests = new Map<string, { deviceId: string; sessionId: string; signal?: AbortSignal | undefined; resolve: (value: ApprovalOutcome | AskUserQuestionAnswer) => void; questions?: AskUserQuestionRequest['questions'] | undefined; settled: boolean; qi: number; answers: AskUserQuestionAnswerItem[] }>();
  private https: HttpsServer | HttpServer | null = null;
  private udp: Socket | null = null;
  private keepalive: ReturnType<typeof setInterval> | null = null;
  port = 0;
  discoveryPortActual = 0;
  discoveryCollision = false;
  private sse = new Set<SseClient>();
  private mic = new Map<string, MicSession>();
  private pendingInputs = new Map<string, { abort: AbortController; deviceId: string }>();
  /** Bounded short-lived cancellation intents cover force-abort/preflight races. */
  private cancelledMic = new Map<string, number>();
  private generation = 0;
  /** At most one live host-follow owner per deviceId (generation-guarded). */
  private follows = new Map<string, DeviceFollow>();
  private followGeneration = 0;
  /** Last user-submitted text per device (TTS echo guard; never logged). */
  private lastUserText = new Map<string, string>();
  private rate = new Map<string, { count: number; resetAt: number }>();
  private audit: Array<{ noncePrefix: string; result: string; ip: string }> = [];
  private approvals: Array<{ id: string; kind: string; title: string; detail?: string | undefined; options?: unknown }> = [];
  private drafts: QuestionDraft[] = [];
  private cappiAction: string | null = null;
  private characterId = PAYLOAD_DEFAULT;
  private voiceLink = { active: false, muted: false };
  private speech = new Map<string, Set<AbortController>>();
  private openImages = new Set<string>();
  private runningVoice: { sessionId: string | null; running: boolean } = { sessionId: null, running: false };

  constructor(opts: RuntimeOptions) {
    this.opts = opts;
  }

  get store(): TurnkeyStore {
    return this.opts.store;
  }

  private safeLog(message: string): void {
    try {
      const fn = (this.opts.logger as { log?: unknown } | undefined)?.log;
      if (typeof fn === 'function') (fn as (...args: unknown[]) => void)(message);
    } catch { /* logging never fails the runtime */ }
  }

  get identity(): TlsIdentity {
    return this.opts.identity;
  }

  /** Ephemeral LAN HTTPS server + UDP discovery. Throws on TLS failure (no plaintext fallback). */
  async start(): Promise<{ port: number; discoveryPort: number }> {
    if (this.disposed) throw new Error('runtime disposed during initialization');
    try {
    const handler = (req: never, res: never): void => {
      void this.route(req as never, res as never).catch((e: unknown) => {
        json(res as never, 500, { ok: false, error: (e as Error).message || 'bridge error' });
      });
    };
    const tls = { cert: this.opts.identity.certPem, key: this.opts.identity.keyPem };
    this.https = createHttpsServer(tls, handler as never);
    (this.https as HttpsServer).requestTimeout = 0;
    await new Promise<void>((resolve, reject) => {
      (this.https as HttpsServer).once('error', reject);
      (this.https as HttpsServer).listen(0, '0.0.0.0', () => resolve());
    });
    const addr = (this.https as HttpsServer).address();
    this.port = typeof addr === 'object' && addr ? (addr.port as number) : 0;

    const candidates = this.opts.discoveryPorts ?? (this.opts.discoveryPort === undefined
      ? Array.from({ length: 10 }, (_, i) => 8788 + i) : [this.opts.discoveryPort]);
    if (!candidates.length) throw new Error('No discovery ports configured');
    for (const candidate of candidates) {
      if (this.disposed) throw new Error('runtime disposed during initialization');
      const socket = createSocket('udp4');
      this.udp = socket;
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (e: Error): void => reject(e);
          socket.once('error', onError);
          socket.bind(candidate, () => { socket.removeListener('error', onError); resolve(); });
        });
        this.discoveryPortActual = socket.address().port;
        break;
      } catch (e) {
        try { socket.close(); } catch { /* not bound */ }
        this.udp = null;
        if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
        this.discoveryCollision = true;
      }
    }
    if (!this.udp) throw new Error('All configured discovery ports are occupied; stop another profile or choose an explicit port (no random fallback)');
    if (this.opts.discoveryPort !== undefined && (this.discoveryPortActual < 8788 || this.discoveryPortActual > 8797)) {
      this.safeLog('[turnkey] custom discovery port is outside 8788..8797; watches require manual host entry');
    }
    if (this.disposed) throw new Error('runtime disposed during initialization');
    (this.udp as Socket).on('message', (msg, rinfo) => {
      try {
        const text = msg.toString('utf8', 0, Math.min(msg.length, 512));
        const m = /^DSHW1DISCOVER ([\w-]{1,64})$/.exec(text.trim());
        if (!m) return;
        const replies = 1;
        void replies;
        const out = Buffer.from(`DSHW1BRIDGE ${m[1]} ${this.port}`, 'utf8');
        (this.udp as Socket).send(out, rinfo.port, rinfo.address);
      } catch { /* never take the runtime down over discovery */ }
    });

    this.keepalive = setInterval(() => {
      for (const c of this.sse) {
        try {
          c.res.write(': keepalive\n\n');
        } catch { /* closing */ }
      }
    }, 15000);
    (this.keepalive as ReturnType<typeof setInterval>).unref?.();
    this.startHostStreams();
    return { port: this.port, discoveryPort: this.discoveryPortActual };
    } catch (error) { await this.dispose(); throw error; }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const ctl of this.pendingInputs.values()) ctl.abort.abort();
    this.pendingInputs.clear();
    this.cancelledMic.clear();
    for (const controllers of this.speech.values()) for (const c of controllers) c.abort();
    this.speech.clear();
    for (const dir of this.openImages) rmSync(dir, { recursive: true, force: true });
    this.openImages.clear();
    this.streamsAbort.abort();
    for (const request of this.requests.values()) request.resolve(request.questions ? { answers: [] } : 'cancelled');
    this.requests.clear();
    this.approvals = [];
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = null;
    for (const c of [...this.sse]) {
      try {
        (c.res as { end?: () => void }).end?.();
      } catch { /* closing */ }
    }
    this.sse.clear();
    // Follow pumps first: abort every owner so no frame lands during teardown,
    // then bound-await each pump before dropping the map (no stale prompts).
    for (const [, f] of [...this.follows]) {
      try {
        f.abort.abort(new Error('runtime-disposed'));
      } catch { /* already aborted */ }
    }
    // Full voice-input cleanup: abort the request, then dispose the helper
    // handle (bounded wait) so no generation/helper/profile leaks. The mic
    // map clear alone is NOT enough — every live handle is disposed here.
    for (const [, m] of this.mic) {
      m.state = 'closed';
      try {
        m.abort.abort(new Error('runtime-disposed'));
      } catch { /* already aborted */ }
      try {
        await withTimeout(Promise.resolve().then(() => m.handle.dispose()), 3000).catch(() => undefined);
      } catch { /* dispose best-effort */ }
    }
    this.mic.clear();
    for (const [, f] of [...this.follows]) {
      try {
        await withTimeout(Promise.resolve(f.done), 3000).catch(() => undefined);
      } catch { /* pump teardown is best-effort */ }
    }
    this.follows.clear();
    await Promise.all(this.streams.map(p => withTimeout(p, 1000).catch(() => undefined)));
    await new Promise<void>((resolve) => {
      try {
        (this.udp as Socket | null)?.close(() => resolve());
      } catch {
        resolve();
      }
      if (!this.udp) resolve();
      this.udp = null;
    });
    await new Promise<void>((resolve) => {
      try {
        (this.https as HttpsServer | null)?.close(() => resolve());
        (this.https as HttpsServer | null)?.closeAllConnections();
      } catch {
        resolve();
      }
      if (!this.https) resolve();
      this.https = null;
    });
  }

  // ---- pairing helpers -------------------------------------------------

  private clientIp(req: { socket?: { remoteAddress?: string }; headers?: Record<string, string | string[] | undefined> }): string {
    return String(req.socket?.remoteAddress ?? 'lan');
  }

  private rateLimited(ip: string): boolean {
    const now = Date.now();
    const row = this.rate.get(ip);
    if (this.rate.size > 128) {
      const first = this.rate.keys().next().value as string | undefined;
      if (first) this.rate.delete(first);
    }
    if (!row || row.resetAt <= now) {
      this.rate.set(ip, { count: 1, resetAt: now + 60_000 });
      return false;
    }
    row.count++;
    return row.count > MAX_ATTEMPTS;
  }

  private auditLog(noncePrefix: string, result: string, ip: string): void {
    this.audit.push({ noncePrefix: String(noncePrefix).slice(0, 8), result, ip });
    if (this.audit.length > 200) this.audit.splice(0, this.audit.length - 200);
  }

  // ---- session binding -------------------------------------------------

  /** Checked narrow of the injected controller (undefined when absent/incomplete). */
  private hostPort(): HostSessionPort | undefined {
    return asHostSessionPort(this.opts.sessionController);
  }

  private host(): HostSessionHost | undefined {
    const port = this.hostPort();
    return port ? new HostSessionHost(port) : undefined;
  }

  /** Resolve the watched session for a device: explicit pin wins, else auto-follow. */
  async watchedSessionFor(deviceId: string): Promise<{ watchedSessionId: string | null; autoFollow: boolean }> {
    if (!this.store.listDevicesPublic().some(d => d.deviceId === deviceId && !d.revoked)) return { watchedSessionId: null, autoFollow: true };
    const binding = this.store.getBinding(deviceId);
    if (binding && !binding.autoFollow && binding.watchedSessionId) {
      return { watchedSessionId: binding.watchedSessionId, autoFollow: false };
    }
    // Auto-follow: latest session from the real host controller with a real
    // AbortSignal and a bounded timeout. Failures fall back to the stored
    // binding below (auto-follow is best-effort, never a quiet lie: the
    // returned autoFollow flag stays true so callers know the provenance).
    const host = this.host();
    if (host) {
      const gate = withTimeoutSignal(BINDING_LOOKUP_TIMEOUT_MS);
      try {
        const items = await host.listSessions(gate.signal);
        const ids = items
          .filter(s => s.origin !== 'subagent')
          .map((s) => (typeof s.sessionId === 'string' ? s.sessionId : ''))
          .filter((s) => !!s);
        if (ids.length > 0) return { watchedSessionId: ids[0] as string, autoFollow: true };
      } catch (e) {
        this.safeLog(`[turnkey] binding lookup failed: ${(e as Error).message ?? e}`);
      } finally {
        gate.dispose();
      }
    }
    if (binding?.watchedSessionId) return { watchedSessionId: binding.watchedSessionId, autoFollow: binding.autoFollow };
    if (this.runningVoice.sessionId) return { watchedSessionId: this.runningVoice.sessionId, autoFollow: true };
    return { watchedSessionId: null, autoFollow: true };
  }

  // ---- host follow (per-device assistant-stream consumption) -----------

  /** Current follow projection for a device (null when nothing is followed). */
  followViewFor(deviceId: string): FollowView | null {
    const live = this.follows.get(deviceId);
    if (!live) return null;
    const view = live.view;
    return {
      ...view,
      todos: view.todos.map((t) => ({ ...t })),
      hostQuestions: view.hostQuestions.map((q) => ({ ...q })),
      media: view.media.map((m) => ({ ...m })),
    };
  }

  /**
   * Ensure the single follow owner for a device's CURRENT bound session.
   * Rotates (abort old, start new) on reselect/new-session/auto-follow drift;
   * stops when nothing is watched; no-ops honestly (null) without a host leg.
   * Never rejects — follow failures are SSE/internal, never command failures.
   */
  async ensureFollowFor(deviceId: string): Promise<DeviceFollow | null> {
    try {
      const bound = await this.watchedSessionFor(deviceId);
      if (!bound.watchedSessionId) {
        await this.stopFollowFor(deviceId);
        return null;
      }
      const live = this.follows.get(deviceId);
      if (live && live.sessionId === bound.watchedSessionId) return live;
      await this.stopFollowFor(deviceId);
      const host = this.host();
      if (!host) return null;
      const generation = ++this.followGeneration;
      const abort = new AbortController();
      const follow: DeviceFollow = {
        deviceId,
        sessionId: bound.watchedSessionId,
        generation,
        abort,
        done: Promise.resolve(),
        view: emptyFollowView(bound.watchedSessionId),
        spokenTurns: new Set<string>(),
        lastUserText: this.lastUserText.get(deviceId) ?? '',
        lastEmittedRunning: null,
        lastEmittedText: null,
        lastEmittedDone: null,
        seenSnapshot: false,
      };
      this.follows.set(deviceId, follow);
      // Owned pump: errors are reported once over SSE; the trailing catch is
      // belt-and-braces so the activation path never sees an unhandled
      // rejection from a background owner.
      follow.done = this.pumpFollow(follow).catch(() => undefined);
      return follow;
    } catch {
      return null;
    }
  }

  /** Abort + bounded-await one device's follow owner (exactly once). */
  async stopFollowFor(deviceId: string): Promise<void> {
    for (const request of this.requests.values()) if (request.deviceId === deviceId) request.resolve(request.questions ? { answers: [] } : 'cancelled');
    this.drafts = this.drafts.filter(d => d.deviceId !== deviceId);
    const live = this.follows.get(deviceId);
    if (!live) return;
    try {
      live.abort.abort(new Error('follow-stopped'));
    } catch { /* already aborted */ }
    try {
      await withTimeout(Promise.resolve(live.done), 3000).catch(() => undefined);
    } catch { /* teardown is best-effort */ }
    if (this.follows.get(deviceId) === live) this.follows.delete(deviceId);
  }

  /**
   * Consume the exact rc1 follow stream for one bound session:
   * `follow({ address: { kind:'session', sessionId }, maxMessages? }, signal)`
   * → opening snapshot + gap-free event frames. Stale owners (post-rotate)
   * drop every frame. Snapshot history NEVER triggers TTS (no replay audio);
   * only live event frames after the snapshot cursor may complete an
   * utterance into the single TTS owner for that turn.
   */
  private async pumpFollow(follow: DeviceFollow): Promise<void> {
    const host = this.host();
    if (!host) return;
    let stream: AsyncIterable<SessionFollowFrame>;
    try {
      stream = host.followSession(followRequestFor(follow.sessionId), follow.abort.signal);
    } catch (e) {
      this.followFailed(follow, (e as Error).message ?? 'follow failed to start');
      return;
    }
    try {
      for await (const frame of stream) {
        const live = this.follows.get(follow.deviceId);
        if (!live || live.generation !== follow.generation) return; // rotated owner
        if (follow.abort.signal.aborted) return;
        await this.applyFollowFrame(follow, frame);
      }
    } catch (e) {
      if (follow.abort.signal.aborted) return; // expected on stop/reselect/dispose
      const live = this.follows.get(follow.deviceId);
      if (!live || live.generation !== follow.generation) return;
      this.followFailed(follow, (e as Error).message ?? 'follow stream failed');
    }
  }

  private followFailed(follow: DeviceFollow, message: string): void {
    // Safe fixed code + generic message: never user text, never secrets.
    this.sendTo(follow.deviceId, {
      t: 'error',
      code: 'follow-failed',
      message: 'session follow failed; reselect the thread to resume live replies',
      detail: String(message).slice(0, 200),
    });
  }

  private async applyFollowFrame(follow: DeviceFollow, frame: SessionFollowFrame): Promise<void> {
    const view = follow.view;
    const beforeRunning = follow.lastEmittedRunning ?? view.running;
    // SessionFollowFrame is already the exact rc1 union (snapshot | event
    // entry) — narrow it directly; only the open-ended wire payloads inside
    // (event data, record lists) go through the defensive record guard.
    if (frame.type === 'snapshot' && !follow.seenSnapshot) {
      follow.seenSnapshot = true;
      view.cwd = frame.header.cwd;
      // Walk the opening window FIRST (record seqs drive lastSeq past the
      // history), then raise the watermark to the snapshot cursor — the
      // cursor is the cut the window was taken through, not a reason to skip
      // the window itself.
      if (Array.isArray(frame.records)) applyFollowRecords(view, frame.records);
      this.seedProjections(follow.sessionId, frame.projections.values, frame.projections.asOfSeq);
      this.applyProjectionTodos(follow.sessionId);
      if (typeof frame.cursor === 'number' && frame.cursor > view.lastSeq) view.lastSeq = frame.cursor;
      // Snapshot history never speaks — mark turns already closed as spoken so
      // a reselect re-reading the same log cannot replay audio.
      if (view.turn !== null && !view.running) follow.spokenTurns.add(`${view.turn}`);
      if (follow.spokenTurns.size > 50) {
        const first = follow.spokenTurns.values().next().value as string | undefined;
        if (first !== undefined) follow.spokenTurns.delete(first);
      }
    } else if (frame.type === 'event') {
      const wasRunning = view.running;
      applyFollowWireEvent(view, frame.event);
      // Live turn completion → single TTS owner for that turn (exactly once).
      if (wasRunning && !view.running && view.assistantText.trim()) {
        const key = view.turn !== null ? `${view.turn}` : `seq:${view.lastSeq}`;
        const echo = view.assistantText.trim() === follow.lastUserText.trim() && !!follow.lastUserText.trim();
        if (!echo && !follow.spokenTurns.has(key)) {
          follow.spokenTurns.add(key);
          if (follow.spokenTurns.size > 50) {
            const first = follow.spokenTurns.values().next().value as string | undefined;
            if (first !== undefined) follow.spokenTurns.delete(first);
          }
          try {
            await this.speak(follow.deviceId, view.assistantText.slice(0, 4000));
          } catch {
            // speak() already emitted audio-done cancelled:true; keep the pump alive.
          }
        }
      }
    } else {
      return;
    }
    this.sendTo(follow.deviceId, { t: 'todos', items: view.todos.map(t => ({ text: t.content, status: t.status })) });
    // Watch-leg SSE (existing wire, HANDOFF-WI §1): cumulative assistant text
    // on change, running only on transitions — never fabricated.
    if (view.assistantText !== follow.lastEmittedText || view.done !== follow.lastEmittedDone) {
      follow.lastEmittedText = view.assistantText;
      follow.lastEmittedDone = view.done;
      this.sendTo(follow.deviceId, { t: 'assistant', text: view.assistantText, done: view.done });
    }
    if (view.running !== beforeRunning) {
      follow.lastEmittedRunning = view.running;
      this.sendTo(follow.deviceId, { t: 'session', running: view.running, sessionId: view.sessionId });
    }
  }

  /**
   * Full device revoke (HS-owned, AU-wired via `POST /admin/pair/revoke`):
   * watch-owned input/output and follow teardown, live mic + SSE cleanup,
   * binding and token atomically removed, never harness-turn cancellation,
   * with access revoked first. Replacement devices are untouched.
   * Returns false ONLY for unknown devices (→ 404); already-revoked ids stay
   * revoked (idempotent true, never 500).
   */
  async revokeDevice(deviceId: string): Promise<boolean> {
    const device = this.store.listDevicesPublic().find(d => d.deviceId === deviceId);
    if (!device) return false;
    if (device.revoked) return true; // never disturbs a replacement watch
    // Authentication + binding revoke is one durable store transaction FIRST.
    // Access revocation is NOT permission to cancel Mac-started harness work.
    if (!this.store.revoke(deviceId)) return false;
    await this.stopWatchIO(deviceId);
    this.voiceLink.active = false;
    await this.stopFollowFor(deviceId);
    this.drafts = this.drafts.filter(d => d.deviceId !== deviceId);
    for (const c of [...this.sse]) {
      if (c.deviceId !== deviceId) continue;
      try { c.res.end?.(); } catch { /* closing */ }
      this.sse.delete(c);
    }
    return true;
  }

  // ---- HTTP route table -----------------------------------------------

  private async route(req: never, res: never): Promise<void> {
    const r = req as unknown as {
      method?: string; url?: string; headers: Record<string, string | string[] | undefined>;
      socket?: { remoteAddress?: string }; on: (ev: string, cb: (...a: never[]) => void) => void;
    };
    const w = res as unknown as {
      writeHead: (c: number, h: Record<string, string>) => void; end: (b?: string | Uint8Array) => void; write: (s: string) => void;
    };
    const url = new URL(r.url ?? '/', 'https://x');
    const path = url.pathname;
    const ip = this.clientIp(r);

    if (/[?&](token|secret)=/i.test(url.search)) {
      return json(w, 401, { ok: false, error: 'token in URL is rejected; send X-Bridge-Token header' });
    }

    // CERT ONLY, unauth, pinning DISABLED for this one call (client verifies).
    if (path === PAIR_INFO_PATH && (r.method ?? 'GET') === 'GET') {
      const nonce = newOpaqueId(16);
      return json(w, 200, {
        pairProtocol: 'turnkey/1',
        certSha256Pin: this.identity.pin,
        serverDisplayName: this.opts.serverDisplayName ?? 'DSH Turnkey',
        nonce,
        fingerprint: this.identity.fingerprint,
      });
    }

    if (path === PAIR_ENROLL_PATH && r.method === 'POST') {
      if (this.rateLimited(ip)) {
        this.auditLog('', 'rate-limited', ip);
        return json(w, 429, { ok: false, error: 'rate-limited', retryable: true });
      }
      let body: Record<string, unknown>;
      try {
        body = (await readJsonBody(r as never)) as Record<string, unknown>;
      } catch (e) {
        return json(w, (e as { status?: number }).status ?? 400, { ok: false, error: (e as Error).message });
      }
      const alias = typeof body.deviceAlias === 'string' ? body.deviceAlias.trim().slice(0, 64) : '';
      const secret = typeof body.enrollmentSecret === 'string' ? body.enrollmentSecret : '';
      const confirmedHeader = String(r.headers[FINGERPRINT_HEADER] ?? r.headers['x-fingerprint-confirmed'] ?? '').toLowerCase();
      const confirmedBody = (body as { fingerprintConfirmed?: unknown }).fingerprintConfirmed;
      const confirmed = confirmedHeader === 'true' || confirmedBody === true;
      // The server cannot prove the client verified the pin; the WATCH must
      // compare the handshake cert pin and confirm on-device BEFORE enroll.
      // Without explicit confirmation the server fails closed here and the
      // Mac approval additionally requires fingerprintConfirmed:true.
      if (!confirmed) {
        this.auditLog('', 'approval-required', ip);
        return json(w, 403, { ok: false, error: 'approval-required', retryable: false });
      }
      if (!alias || !isOpaqueId(secret)) {
        return json(w, 400, { ok: false, error: 'bad alias/secret' });
      }
      try {
        const row = this.store.createPending({
          deviceAlias: alias,
          enrollmentSecret: secret,
          ...(typeof body.deviceKind === 'string' ? { deviceKind: String(body.deviceKind).slice(0, 64) } : {}),
          ...(typeof body.model === 'string' ? { model: String(body.model).slice(0, 64) } : {}),
        });
        this.auditLog(row.requestId.slice(0, 8), 'pending', ip);
        return json(w, 201, { requestId: row.requestId, expiresAtMs: row.expiresAtMs });
      } catch (e) {
        return json(w, (e as { status?: number }).status ?? 500, { ok: false, error: (e as Error).message });
      }
    }

    if (path === PAIR_POLL_PATH && r.method === 'POST') {
      let body: Record<string, unknown>;
      try {
        body = (await readJsonBody(r as never)) as Record<string, unknown>;
      } catch (e) {
        return json(w, (e as { status?: number }).status ?? 400, { ok: false, error: (e as Error).message });
      }
      const requestId = typeof body.requestId === 'string' ? body.requestId : '';
      const secret = typeof body.enrollmentSecret === 'string' ? body.enrollmentSecret : '';
      if (!isOpaqueId(requestId) || !isOpaqueId(secret)) {
        return json(w, 401, { ok: false, error: 'approval-replay' });
      }
      try {
        const out = this.store.consumeApproved(requestId, secret);
        this.auditLog(requestId.slice(0, 8), 'approved', ip);
        // Auto-create an auto-follow binding for the new device.
        this.store.setBinding(out.deviceId, '', true);
        // Start the single follow owner for the auto-followed session (never
        // rejects; failures surface over SSE, never on the poll reply).
        void this.ensureFollowFor(out.deviceId).catch(() => undefined);
        return json(w, 200, {
          status: 'approved',
          deviceId: out.deviceId,
          token: out.token,
          certSha256Pin: this.identity.pin,
        });
      } catch (e) {
        const err = e as { status?: number; message?: string; pending?: boolean };
        if (err.pending) {
          const row = this.store.getPending(requestId);
          return json(w, 202, { status: 'pending', requestId, expiresAtMs: row?.expiresAtMs ?? Date.now() + 60_000 });
        }
        if (err.status === 410) return json(w, 410, { ok: false, error: 'approval-expired' });
        if (err.status === 429) return json(w, 429, { ok: false, error: 'rate-limited', retryable: true });
        return json(w, 401, { ok: false, error: err.message || 'approval-replay' });
      }
    }

    // Device-bearer surface below (pinned TLS + per-device token header).
    const presentedPin = headerValue(r.headers[PIN_HEADER]);
    if (presentedPin && !pinMatches(presentedPin, this.identity.pin)) {
      return json(w, 401, { ok: false, error: 'trust-mismatch' });
    }
    const token = headerValue(r.headers[TOKEN_HEADER]);
    const device = token ? this.store.deviceForToken(token) : undefined;
    if (!device) {
      // Liveness probe stays available without trust (legacy compat, no secrets).
      if (path === '/watch/pair-probe' && (r.method ?? 'GET') === 'GET') {
        const nonce = url.searchParams.get('nonce') ?? '';
        if (!/^[\w-]{1,64}$/.test(nonce)) return json(w, 400, { ok: false, error: 'bad nonce' });
        return json(w, 200, { ok: true, liveness: true });
      }
      return json(w, 401, { ok: false, error: 'bad token' });
    }

    // Authenticated watch surface (full bridge feature port).
    if (path === '/watch/health' && (r.method ?? 'GET') === 'GET') {
      const backend = await this.backendStatus();
      return json(w, 200, { ok: true, features: this.features(), dsh: 'up', voice: backend.status, queue: (this.queues.get(this.store.getBinding(device.deviceId)?.watchedSessionId ?? '')?.length ?? 0), pending: this.approvals.length });
    }
    if (path === '/watch/binding' && (r.method ?? 'GET') === 'GET') {
      const bound = await this.watchedSessionFor(device.deviceId);
      return json(w, 200, { deviceId: device.deviceId, watchedSessionId: bound.watchedSessionId ?? '', autoFollow: bound.autoFollow });
    }
    if (path === '/watch/state' && (r.method ?? 'GET') === 'GET') {
      return json(w, 200, this.snapshot(device.deviceId));
    }
    if (path === '/watch/capabilities' && (r.method ?? 'GET') === 'GET') {
      return json(w, 200, this.capabilities());
    }
    if (path === '/watch/image' && (r.method ?? 'GET') === 'GET') {
      try {
        const ref = new URL(url, 'https://localhost').searchParams.get('ref') ?? '';
        const { bytes, contentType } = await this.readWatchImage(device.deviceId, ref);
        w.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        (w as unknown as { end: (bytes: Buffer) => void }).end(bytes);
        return;
      } catch (e) { return json(w, (e as { status?: number }).status ?? 502, { error: 'image unavailable in watched session' }); }
    }
    if (path === '/watch/stream' && (r.method ?? 'GET') === 'GET') {
      await this.ensureFollowFor(device.deviceId);
      w.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-content-type-options': 'nosniff',
      });
      const caps = this.capabilities();
      w.write(`data: ${JSON.stringify({ t: 'hello', features: this.features(), protocol: '0.2.0', characterId: caps.characterId, voiceActive: this.voiceLink.active, queueDepth: (this.queues.get(this.store.getBinding(device.deviceId)?.watchedSessionId ?? '')?.length ?? 0) })}\n\n`);
      w.write(`data: ${JSON.stringify({ t: 'snapshot', ...this.snapshot(device.deviceId) })}\n\n`);
      const client: SseClient = { res: { write: (s: string) => w.write(s), end: () => w.end() }, deviceId: device.deviceId };
      this.sse.add(client);
      (r as { on: (ev: string, cb: () => void) => void }).on('close', () => {
        this.sse.delete(client);
      });
      return;
    }
    if (path === '/watch/mic/start' && r.method === 'POST') {
      if (this.disposed) return json(w, 503, { ok: false, error: 'watch runtime disposed' });
      if (this.voiceLink.muted) return json(w, 409, { ok: false, error: 'watch microphone is muted' });
      let body: Record<string, unknown>;
      try {
        body = (await readJsonBody(r as never)) as Record<string, unknown>;
      } catch (e) {
        return json(w, (e as { status?: number }).status ?? 400, { ok: false, error: (e as Error).message });
      }
      const streamId = typeof body.streamId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(body.streamId) ? body.streamId : '';
      if (!streamId) return json(w, 400, { ok: false, error: 'streamId required' });
      if (this.isMicCancelled(device.deviceId, streamId)) return json(w, 409, { ok: false, error: 'stream was cancelled; use a new streamId' });
      // Optional question-dictation binding: when present it MUST match a
      // CURRENTLY pending request id; finals for such a stream are stored as
      // drafts only and never autosubmitted.
      const draftRequestId = typeof body.requestId === 'string' && body.requestId ? body.requestId.slice(0, 128) : '';
      if (draftRequestId && !this.requests.get(draftRequestId)?.questions) {
        return json(w, 400, { ok: false, error: 'unknown request: dictation binds to a currently pending request id' });
      }
      // Binding preflight: the watch user creates/selects threads via the UI
      // (no manual session ids on this route). Without a watched session the
      // mic fails closed here — there is nothing truthful to deliver to.
      const bound = await this.watchedSessionFor(device.deviceId);
      if (!bound.watchedSessionId) {
        return json(w, 409, { ok: false, error: 'no watched session; select a session before dictating', retryable: false });
      }
      if (draftRequestId) {
        const request = this.requests.get(draftRequestId);
        if (!request || request.settled || request.signal?.aborted || request.sessionId !== bound.watchedSessionId) return json(w, 409, { ok: false, error: 'question no longer belongs to watched session' });
      }
      const capturedQuestionIndex = draftRequestId ? this.requests.get(draftRequestId)!.qi : undefined;
      // Backend preflight: 200 `ready` is returned ONLY after the ASR input
      // actually exists. `createInput` resolves only after the native helper
      // emits its real `ready` line (V contract), so awaiting it IS awaiting
      // native readiness — no fire-and-forget 'ready' early, no early 200.
      const backend = await this.backendStatus();
      if (backend.status !== 'ready') {
        return json(w, 503, { ok: false, error: 'mic-not-ready', retryable: true, message: backend.message ?? 'voice backend not ready' });
      }
      const svc = this.opts.liveVoiceWatch;
      if (!svc) {
        return json(w, 503, { ok: false, error: 'mic-not-ready', retryable: false, message: 'voice backend not installed' });
      }
      if (this.mic.has(streamId) || this.pendingInputs.has(streamId)) {
        return json(w, 409, { ok: false, error: 'stream already started', retryable: false });
      }
      const preInputBinding = await this.watchedSessionFor(device.deviceId);
      const preInputQuestion = draftRequestId ? this.requests.get(draftRequestId) : undefined;
      if (this.disposed || this.isMicCancelled(device.deviceId, streamId) || this.voiceLink.muted || preInputBinding.watchedSessionId !== bound.watchedSessionId ||
          (draftRequestId && (!preInputQuestion || preInputQuestion.settled || preInputQuestion.signal?.aborted || preInputQuestion.qi !== capturedQuestionIndex)))
        return json(w, 409, { ok: false, error: 'watch owner changed during microphone preflight' });
      // Check again after all awaited status/binding lookups: atomic reservation.
      if (this.mic.has(streamId) || this.pendingInputs.has(streamId)) return json(w, 409, { ok: false, error: 'stream already active' });
      // Explicit authenticated capture barges into OUTPUT only; never cancels
      // the harness turn or invents an idle running state.
      this.stopSpeechOnly(device.deviceId);
      const generation = ++this.generation;
      const abort = new AbortController();
      this.pendingInputs.set(streamId, { abort, deviceId: device.deviceId });
      const timeout = setTimeout(() => abort.abort(new Error('mic ready timeout')), MIC_INPUT_TIMEOUT_MS);
      timeout.unref?.();
      const gate = { signal: abort.signal, dispose: () => clearTimeout(timeout) };
      let handle: LiveVoiceInputHandle;
      try {
        // Generation-guarded dispatch: only the live map entry for this
        // streamId+generation receives events (stale helper callbacks after
        // close/dispose are dropped, never delivered to a recycled id).
        handle = await svc.createInput({
          streamId,
          purpose: draftRequestId ? 'dictation' : 'prompt',
          onEvent: (e) => {
            const live = this.mic.get(streamId);
            if (!live || live.generation !== generation) return;
            return this.onInputEvent(live, e);
          },
          signal: gate.signal,
        });
      } catch (e) {
        // Observed rejection (awaited, never void): no map entry, no 200.
        gate.dispose();
        const aborted = abort.signal.aborted;
        abort.abort();
        if (this.pendingInputs.get(streamId)?.abort === abort) this.pendingInputs.delete(streamId);
        return json(w, aborted ? 499 : 503, {
          ok: false,
          error: 'mic-start-failed',
          message: (e as Error).message ?? 'ASR input failed to become ready',
          retryable: !aborted,
        });
      } finally {
        gate.dispose();
        if (abort.signal.aborted && this.pendingInputs.get(streamId)?.abort === abort) this.pendingInputs.delete(streamId);
      }
      const current = await this.watchedSessionFor(device.deviceId);
      const question = draftRequestId ? this.requests.get(draftRequestId) : undefined;
      if (this.disposed || abort.signal.aborted || this.isMicCancelled(device.deviceId, streamId) || current.watchedSessionId !== bound.watchedSessionId ||
          (draftRequestId && (!question || question.settled || question.signal?.aborted || question.sessionId !== bound.watchedSessionId || question.qi !== capturedQuestionIndex))) {
        abort.abort(); await withTimeout(handle.dispose(), 3000).catch(() => undefined);
        if (this.pendingInputs.get(streamId)?.abort === abort) this.pendingInputs.delete(streamId);
        return json(w, 409, { ok: false, error: 'watch owner changed during microphone preflight' });
      }
      const session: MicSession = {
        streamId,
        deviceId: device.deviceId,
        generation,
        boundSessionId: bound.watchedSessionId,
        ...(draftRequestId ? { draftRequestId, draftQuestionIndex: capturedQuestionIndex! } : {}),
        state: 'ready',
        txChunks: 0,
        txBytes: 0,
        ackFinals: 0,
        draftFinals: 0,
        unackedFinals: 0,
        deliverySettled: false,
        createdAtMs: Date.now(),
        handle,
        abort,
        deliveredUtterances: new Set<string>(),
        onEvent: (e) => this.onInputEvent(session, e),
      };
      // Rebind the pre-registered closure now that the session exists.
      this.mic.set(streamId, session);
      if (this.pendingInputs.get(streamId)?.abort === abort) this.pendingInputs.delete(streamId);
      this.sendTo(device.deviceId, { t: 'mic', streamId, state: 'ready', watchedSessionId: bound.watchedSessionId });
      return json(w, 200, { streamId, state: 'ready', watchedSessionId: bound.watchedSessionId });
    }
    if (path === '/watch/mic' && r.method === 'POST') {
      if (this.voiceLink.muted) return json(w, 409, { ok: false, error: 'watch microphone is muted' });
      if (!/^application\/octet-stream(?:\s*;.*)?$/i.test(headerValue(r.headers['content-type']))) return json(w, 415, { ok: false, error: 'PCM upload requires application/octet-stream' });
      const streamId = (url.searchParams.get('streamId') ?? '').slice(0, 64);
      const session = this.mic.get(streamId);
      if (!session || session.deviceId !== device.deviceId) {
        return json(w, 404, { ok: false, error: 'unknown stream', retryable: false });
      }
      const genHeader = headerValue(r.headers['x-stream-generation']);
      if (genHeader && Number(genHeader) !== session.generation) {
        return json(w, 409, { ok: false, error: 'stale stream generation', retryable: false });
      }
      if (session.state === 'closed' || session.state === 'error') {
        return json(w, 409, { ok: false, error: 'stream already closed', retryable: false });
      }
      session.state = 'capturing';
      this.sendTo(device.deviceId, { t: 'mic', streamId, state: 'capturing' });
      // Progressive bounded streaming: each chunk is written to the live ASR
      // input exactly once, awaited (backpressure), and never logged. The
      // request body is NEVER fully buffered as text and NEVER logged — only
      // byte/chunk counters are observed. Over the byte cap: abort the input,
      // dispose the helper, 413, no partial delivery claim.
      let overCap = false;
      let reqFailed: unknown = null;
      try {
        await new Promise<void>((resolve, reject) => {
          if (session.abort.signal.aborted) {
            reject(session.abort.signal.reason ?? new Error('stream aborted'));
            return;
          }
          const onAbort = (): void => {
            reject(session.abort.signal.reason ?? new Error('stream aborted'));
          };
          session.abort.signal.addEventListener('abort', onAbort, { once: true });
          let pending: Promise<unknown> = Promise.resolve();
          let settled = false;
          const fail = (e: unknown): void => {
            if (settled) return;
            settled = true;
            session.abort.signal.removeEventListener('abort', onAbort);
            // Drain the socket so the connection can close cleanly.
            (r as { resume?: () => void }).resume?.();
            reject(e);
          };
          (r as { on: (ev: string, cb: (...a: never[]) => void) => void }).on('data', ((d: Buffer) => {
            if (settled) return;
            session.txChunks++;
            session.txBytes += d.length;
            if (session.txBytes > MIC_MAX_BYTES) {
              overCap = true;
              fail(Object.assign(new Error('mic upload exceeds bounded cap'), { status: 413 }));
              return;
            }
            const bytes = new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
            pending = pending.then(() => session.handle.writePCM(bytes));
            pending.catch((e: unknown) => fail(e));
          }) as (...a: never[]) => void);
          (r as { on: (ev: string, cb: (...a: never[]) => void) => void }).on('end', (() => {
            if (settled) return;
            pending.then(
              () => {
                settled = true;
                session.abort.signal.removeEventListener('abort', onAbort);
                resolve();
              },
              (e: unknown) => fail(e),
            );
          }) as (...a: never[]) => void);
          (r as { on: (ev: string, cb: (...a: never[]) => void) => void }).on('error', ((e: unknown) => fail(e)) as (...a: never[]) => void);
        });
      } catch (e) {
        reqFailed = e;
      }
      if (reqFailed !== null || overCap) {
        await this.closeMicSession(session, 'error');
        const status = (reqFailed as { status?: number } | null)?.status ?? (overCap ? 413 : 500);
        return json(w, status, {
          ok: false,
          error: overCap ? 'mic-too-large' : 'mic-delivery-failed',
          message: (reqFailed as Error)?.message ?? 'upload failed',
          retryable: !overCap,
        });
      }
      // EOF: end the helper input (V's end() waits for the real final ack,
      // including our delivery-ack promise) with a bounded drain, then report
      // a receipt that is truthful about host delivery.
      const receipt = await this.drainMic(session).catch((e: unknown) => ({
        streamId,
        state: 'error' as const,
        txChunks: session.txChunks,
        txBytes: session.txBytes,
        ackFinals: session.ackFinals,
        delivered: false,
        code: 'mic-delivery-failed',
        message: (e as Error).message ?? 'drain failed',
        retryable: true,
      }));
      await this.closeMicSession(session, receipt.state === 'error' ? 'error' : 'closed');
      this.sendTo(device.deviceId, { t: 'mic', streamId, state: receipt.state, receipt, ...(receipt.code ? { code: receipt.code, message: receipt.message, retryable: receipt.retryable } : {}) });
      return json(w, 200, receipt);
    }
    if (path === '/watch/command' && r.method === 'POST') {
      let body: Record<string, unknown>;
      try {
        body = (await readJsonBody(r as never)) as Record<string, unknown>;
      } catch (e) {
        return json(w, (e as { status?: number }).status ?? 400, { ok: false, error: (e as Error).message });
      }
      try {
        const out = await this.handleCommand(device.deviceId, body);
        return json(w, 200, { ok: true, ...out });
      } catch (e) {
        const err = e as { status?: number; message?: string };
        return json(w, err.status ?? 500, { ok: false, error: err.message ?? 'command failed' });
      }
    }
    if (path === '/watch/cappi' && r.method === 'POST') {
      let body: Record<string, unknown>;
      try {
        body = (await readJsonBody(r as never)) as Record<string, unknown>;
      } catch (e) {
        return json(w, (e as { status?: number }).status ?? 400, { ok: false, error: (e as Error).message });
      }
      const out = await this.handleCappi(device.deviceId, body);
      return json(w, out.status, out.payload);
    }
    return json(w, 404, { ok: false, error: 'not found' });
  }

  private features(): { queueReorder: false; openMac: boolean; micCancel: true } {
    const port = this.hostPort();
    let openMac = false;
    try { openMac = !!port?.openWorkspacePath && !!port.canOpenWorkspacePath?.(); } catch { /* unavailable */ }
    return { queueReorder: false, openMac, micCancel: true };
  }

  private capabilities() {
    const pack = PAYLOAD_PACKS.find((p) => p.id === this.characterId) ?? PAYLOAD_PACKS[0]!;
    return {
      ok: true,
      characterId: pack.id,
      characters: PAYLOAD_PACKS.map((p) => p.id),
      modelSelectable: [...pack.modelSelectable],
      roles: Object.fromEntries(Object.entries(pack.roles).map(([k, v]) => [k, [...v]])),
      // Availability comes from actual typed host services, not guesses about
      // unrelated optional methods on one controller.
      reasoning: { supported: !!this.host(), reason: this.host() ? null : 'session host unavailable' },
      permissions: { supported: !!this.opts.permissionPresets, reason: this.opts.permissionPresets ? null : 'permissionPresets service unavailable' },
      features: this.features(),
      queueReorder: { supported: false, reason: 'rc1 updateQueue has no reorder operation' },
    };
  }

  private snapshot(deviceId: string): Record<string, unknown> {
    const caps = this.capabilities();
    const follow = this.followViewFor(deviceId);
    return {
      // Truthful harness snapshot: idle voice, binding-derived session
      // (running stays false here — ONLY a true harness session event may set
      // running true), real queue / pending / draft rows, plus the live
      // follow projection when a follow owner is streaming (cumulative
      // assistant text, todos, host questions, media refs, memory summary).
      // No assistant text is ever fabricated: without a follow owner there is
      // no `follow` key at all.
      features: this.features(),
      voice: { phase: this.voiceLink.active ? 'listening' : 'idle', active: this.voiceLink.active, muted: this.voiceLink.muted },
      session: follow ? { sessionId: follow.sessionId, running: follow.running, cwd: (follow as FollowView & { cwd?: string }).cwd ?? null } : { sessionId: this.store.getBinding(deviceId)?.watchedSessionId || this.runningVoice.sessionId, running: false },
      assistant: follow ? { text: follow.assistantText, done: follow.done } : { text: '', done: false },
      todos: follow?.todos.map(t => ({ text: t.content, status: t.status })) ?? [],
      jobs: this.jobs.get(follow?.sessionId ?? '') ?? [],
      agents: this.projections.get(follow?.sessionId ?? '')?.agents ?? [],
      images: follow?.media ?? [],
      workspaces: this.workspaces,
      archivedSessionIds: this.archivedSessionIds,
      permissions: this.projections.get(follow?.sessionId ?? '')?.permissions ?? null,
      queue: this.queues.get(follow?.sessionId ?? '') ?? [],
      pending: this.approvals.filter(a => this.requests.get(a.id)?.deviceId === deviceId && !this.requests.get(a.id)?.settled && this.requests.get(a.id)?.sessionId === follow?.sessionId).map(a => ({ ...a })),
      drafts: this.drafts.filter(d => d.deviceId === deviceId && d.boundSessionId === follow?.sessionId && this.requests.get(d.requestId)?.qi === d.questionIndex).map(d => ({ requestId: d.requestId, text: d.text })),
      ...(follow ? { follow } : {}),
      character: caps,
      ...(this.cappiAction != null ? { cappiAction: this.cappiAction } : {}),
    };
  }

  private sendTo(deviceId: string, obj: unknown): void {
    const line = `data: ${JSON.stringify(obj)}\n\n`;
    for (const c of this.sse) {
      if (c.deviceId !== deviceId || !this.store.listDevicesPublic().some(d => d.deviceId === c.deviceId && !d.revoked)) continue;
      try {
        c.res.write(line);
      } catch { /* closing */ }
    }
  }

  private sendAll(obj: unknown): void {
    const line = `data: ${JSON.stringify(obj)}\n\n`;
    for (const c of this.sse) {
      if (!this.store.listDevicesPublic().some(d => d.deviceId === c.deviceId && !d.revoked)) continue;
      try {
        c.res.write(line);
      } catch { /* closing */ }
    }
  }

  private async backendStatus(): Promise<{ status: 'warming' | 'ready' | 'capturing' | 'closed' | 'error'; message?: string | undefined; pcm?: { sampleRate: number; channels: number } | undefined }> {
    const svc = this.opts.liveVoiceWatch;
    if (!svc) return { status: 'error', message: 'voice backend not installed (liveVoiceWatch unavailable)' };
    try {
      const s = await withTimeout(svc.status(), 5000);
      return { status: s.status, message: s.message, pcm: { sampleRate: s.pcm.sampleRate, channels: s.pcm.channels } };
    } catch (e) {
      return { status: 'error', message: (e as Error).message ?? 'backend status failed' };
    }
  }

  /** Full per-stream teardown: abort the request, dispose the helper, drop the map entry. */
  private async closeMicSession(session: MicSession, state: 'closed' | 'error'): Promise<void> {
    session.state = state;
    try {
      session.abort.abort(new Error(`stream ${state}`));
    } catch { /* already aborted */ }
    try {
      await withTimeout(Promise.resolve().then(() => session.handle.dispose()), 3000).catch(() => undefined);
    } catch { /* dispose best-effort */ }
    if (this.mic.get(session.streamId) === session) this.mic.delete(session.streamId);
  }

  /**
   * ASR final delivery (exactly once per utteranceId).
   *
   * Normal finals are delivered as a REAL host prompt to the session bound at
   * mic preflight, rechecked against the CURRENT binding at delivery time
   * (TOCTOU guard: a rebind mid-utterance never delivers to the wrong
   * thread). `ackFinals` increments ONLY on successful host admission; any
   * failure (or draft/question path) records a safe receipt instead — never
   * `ack:true`, never agent-state mutation.
   *
   * Question-bound finals (stream carries a currently-pending request id)
   * are draft-only: stored + `dictation-final` SSE, never autosubmitted.
   */
  private async onInputEvent(
    session: MicSession,
    e: { kind: string; utteranceId?: string; text?: string; code?: string; message?: string; retryable?: boolean },
  ): Promise<void> {
    if (session.abort.signal.aborted || session.state === 'closed' || session.state === 'error' || this.disposed || this.mic.get(session.streamId) !== session) return;
    if (e.kind !== 'final') {
      if (e.kind === 'partial' && typeof e.text === 'string') {
        if (session.draftRequestId) {
          const current = await this.watchedSessionFor(session.deviceId);
          const req = this.requests.get(session.draftRequestId);
          if (current.watchedSessionId === session.boundSessionId && req?.questions && !req.settled && !req.signal?.aborted && req.qi === session.draftQuestionIndex && req.sessionId === session.boundSessionId)
            this.sendTo(session.deviceId, { t: 'dictation-partial', requestId: session.draftRequestId, text: e.text.slice(0, 4000) });
        } else this.sendTo(session.deviceId, { t: 'asr', kind: 'partial', text: e.text.slice(0, 4000) });
      }
      if (e.kind === 'error') {
        session.state = 'error';
        session.deliverySettled = true;
        session.lastDeliveryError = e.message ?? 'Speech recognition failed. Please try recording again.';
        session.lastDeliveryCode = e.code && /^[A-Za-z0-9_-]{1,64}$/.test(e.code) ? e.code : 'recognition-failed';
        session.lastDeliveryRetryable = e.retryable ?? true;
        this.sendTo(session.deviceId, {
          t: 'mic',
          streamId: session.streamId,
          state: 'error',
          code: e.code ?? 'mic-delivery-failed',
          message: e.message ?? 'input failed',
          retryable: e.retryable ?? true,
        });
      }
      return;
    }
    const utteranceId = typeof e.utteranceId === 'string' && e.utteranceId ? e.utteranceId : '';
    const text = typeof e.text === 'string' ? e.text : '';
    if (!utteranceId || session.deliveredUtterances.has(utteranceId)) return;
    session.deliveredUtterances.add(utteranceId);
    session.utteranceId = utteranceId;
    try {
      // Question path: draft-only against the CURRENT pending set.
      if (session.draftRequestId) {
        const current = await this.watchedSessionFor(session.deviceId);
        const request = this.requests.get(session.draftRequestId);
        const stillPending = !session.abort.signal.aborted && this.mic.get(session.streamId) === session && current.watchedSessionId === session.boundSessionId && !!request?.questions && request.deviceId === session.deviceId && !request.settled && !request.signal?.aborted && request.sessionId === session.boundSessionId && request.qi === session.draftQuestionIndex;
        if (!stillPending) {
          throw Object.assign(new Error('question no longer pending; draft held, nothing submitted'), { status: 404 });
        }
        this.drafts.push({
          boundSessionId: session.boundSessionId,
          questionIndex: session.draftQuestionIndex!,
          requestId: session.draftRequestId,
          deviceId: session.deviceId,
          streamId: session.streamId,
          utteranceId,
          text: text.slice(0, 4000),
          atMs: Date.now(),
        });
        if (this.drafts.length > 50) this.drafts.splice(0, this.drafts.length - 50);
        session.draftFinals++;
        this.sendTo(session.deviceId, { t: 'dictation-final', requestId: session.draftRequestId, text: text.slice(0, 4000) });
        session.deliverySettled = true;
        return;
      }
      this.sendTo(session.deviceId, { t: 'asr', kind: 'final', utteranceId, text: text.slice(0, 4000) });
      if (!text.trim()) {
        // Silence final: acknowledged receipt, nothing to deliver.
        session.unackedFinals++;
        session.deliverySettled = true;
        return;
      }
      // TOCTOU recheck: the binding NOW must equal the preflight binding.
      const current = await this.watchedSessionFor(session.deviceId);
      if (session.abort.signal.aborted || this.mic.get(session.streamId) !== session || current.watchedSessionId !== session.boundSessionId) {
        throw Object.assign(
          new Error('watch binding changed mid-utterance; held transcript, delivered nothing'),
          { status: 409 },
        );
      }
      const host = this.host();
      if (!host) {
        throw Object.assign(new Error('session host unavailable; held transcript, delivered nothing'), { status: 503 });
      }
      const gate = withTimeoutSignal(HOST_RPC_TIMEOUT_MS, session.abort.signal);
      try {
        await host.submitUserText({
          callerSessionId: session.boundSessionId,
          boundSessionId: current.watchedSessionId,
          text: text.slice(0, 4000),
          mode: 'queue',
          signal: gate.signal,
        });
      } finally {
        gate.dispose();
      }
      session.ackFinals++;
      session.deliverySettled = true;
      // Echo guard + reply streaming for the spoken turn.
      this.lastUserText.set(session.deviceId, text.slice(0, 4000));
      const kept = await this.ensureFollowFor(session.deviceId);
      if (kept) kept.lastUserText = text.slice(0, 4000);
    } catch (err) {
      // Safe receipt: failure recorded, never ack, never agent state.
      session.unackedFinals++;
      session.deliverySettled = true;
      session.lastDeliveryError = (err as Error).message ?? 'delivery failed';
      session.lastDeliveryCode = 'prompt-delivery-failed';
      session.lastDeliveryRetryable = true;
      this.sendTo(session.deviceId, {
        t: 'mic',
        streamId: session.streamId,
        state: 'error',
        code: 'prompt-delivery-failed',
        message: session.lastDeliveryError,
        retryable: true,
        utteranceId,
      });
    }
  }

  private async drainMic(session: MicSession): Promise<Record<string, unknown>> {
    try {
      await withTimeout(Promise.resolve().then(() => session.handle.end()), MIC_DRAIN_TIMEOUT_MS);
    } catch (e) {
      session.deliverySettled = true;
      session.lastDeliveryError ??= (e as Error).message ?? 'Speech recognition could not finish. Please try recording again.';
      session.lastDeliveryCode ??= 'recognition-failed';
      session.lastDeliveryRetryable ??= true;
    }
    // Bounded wait for the terminal delivery outcome (success OR safe
    // failure). Silence may legitimately produce no final — stop early on
    // error rather than hanging the POST.
    const deadline = Date.now() + MIC_FINAL_WAIT_MS;
    while (Date.now() < deadline && !session.deliverySettled && session.ackFinals === 0 && session.unackedFinals === 0) {
      await new Promise((r) => setTimeout(r, 120));
      if (session.state === 'error') break;
    }
    const delivered = session.ackFinals > 0;
    const drafted = session.draftFinals > 0;
    const failed = !delivered && !drafted;
    return {
      streamId: session.streamId,
      state: failed ? 'error' : 'closed',
      txChunks: session.txChunks,
      txBytes: session.txBytes,
      ackFinals: session.ackFinals,
      delivered,
      ...(drafted ? { drafted: true } : {}),
      ...(session.utteranceId ? { utteranceId: session.utteranceId } : {}),
      ...(failed ? { code: session.lastDeliveryCode ?? 'no-speech', message: session.lastDeliveryError ?? 'No speech detected. Please try recording again.', retryable: session.lastDeliveryRetryable ?? true } : {}),
    };
  }

  /** Direct submit helper: exact rc1 prompt request + signal; errors propagate (never unobserved void). */
  private async submitText(deviceId: string, text: string, mode: 'queue' | 'steer' = 'queue'): Promise<Record<string, unknown>> {
    const bound = await this.watchedSessionFor(deviceId);
    if (!bound.watchedSessionId) {
      throw Object.assign(new Error('no watched session; select a session before submitting'), { status: 409 });
    }
    const host = this.host();
    if (!host) throw Object.assign(new Error('session host unavailable'), { status: 503 });
    try {
      // NOTE: we never synthesize `session.running`; the harness owns
      // agent state. We only report transport truth.
      const gate = withTimeoutSignal(HOST_RPC_TIMEOUT_MS);
      try {
        await host.submitUserText({
          callerSessionId: bound.watchedSessionId,
          boundSessionId: bound.watchedSessionId,
          text: text.slice(0, 4000),
          mode,
          signal: gate.signal,
        });
      } finally {
        gate.dispose();
      }
      // Remember the submission for the TTS echo guard, and make sure the
      // single follow owner is streaming the reply back to the watch.
      this.lastUserText.set(deviceId, text.slice(0, 4000));
      const live = this.follows.get(deviceId);
      if (live) live.lastUserText = text.slice(0, 4000);
      await this.ensureFollowFor(deviceId);
      return {};
    } catch (e) {
      throw Object.assign(new Error((e as Error).message ?? 'submit failed'), { status: (e as { status?: number }).status ?? 502 });
    }
  }

  private isMicCancelled(deviceId: string, streamId: string): boolean {
    const now = Date.now();
    for (const [key, at] of this.cancelledMic) if (now - at > 90_000) this.cancelledMic.delete(key);
    return this.cancelledMic.has(JSON.stringify([deviceId, streamId]));
  }

  /** Force-abort only one owned watch input; never TTS/follow/harness work. */
  private async cancelMic(deviceId: string, streamId: unknown): Promise<Record<string, unknown>> {
    if (typeof streamId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(streamId)) throw Object.assign(new Error('valid streamId required'), { status: 400 });
    const pending = this.pendingInputs.get(streamId);
    const session = this.mic.get(streamId);
    if ((pending && pending.deviceId !== deviceId) || (session && session.deviceId !== deviceId)) throw Object.assign(new Error('stream belongs to another device'), { status: 403 });
    this.isMicCancelled(deviceId, streamId); // prune expired intents
    const key = JSON.stringify([deviceId, streamId]);
    this.cancelledMic.delete(key); this.cancelledMic.set(key, Date.now());
    while (this.cancelledMic.size > 256) this.cancelledMic.delete(this.cancelledMic.keys().next().value!);
    if (pending) {
      this.pendingInputs.delete(streamId);
      pending.abort.abort(new Error('watch input cancelled'));
    }
    const live = session && session.state !== 'closed';
    if (live) {
      // Drop dispatch authority before awaiting native cleanup, so a final
      // racing force-abort cannot become an unrequested SDK prompt/draft.
      this.mic.delete(streamId);
      await this.closeMicSession(session, 'closed');
    }
    return { streamId, cancelled: !!pending || !!live };
  }

  private async handleCommand(deviceId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.store.listDevicesPublic().some(d => d.deviceId === deviceId && !d.revoked)) throw Object.assign(new Error('watch is not paired'), { status: 409 });
    switch (String(body.cmd ?? '')) {
      case 'ping': return { pong: true };
      case 'mic-cancel': return this.cancelMic(deviceId, body.streamId);
      case 'start': {
        if (!this.opts.liveVoiceWatch) throw Object.assign(new Error('watch voice backend unavailable; install live voice'), { status: 503 });
        const st = await this.backendStatus();
        if (st.status === 'error') throw Object.assign(new Error(st.message ?? 'watch voice backend error'), { status: 503 });
        // Watch transport ownership ONLY; does not start any Mac mic or claim
        // capture. Capture begins solely at authenticated /watch/mic preflight.
        this.voiceLink.active = true;
        this.sendTo(deviceId, { t: 'voice', phase: 'listening', active: true, muted: this.voiceLink.muted });
        return { voiceActive: true, backend: st.status };
      }
      case 'stop': {
        this.voiceLink.active = false;
        await this.stopWatchIO(deviceId);
        this.sendTo(deviceId, { t: 'voice', phase: 'idle', active: false, muted: this.voiceLink.muted });
        return { voiceActive: false };
      }
      case 'cancel': {
        await this.commandBinding(deviceId, body);
        await this.stopWatchIO(deviceId);
        const sessionId = await this.commandBinding(deviceId, body);
        const host = this.host();
        if (!host) throw Object.assign(new Error('session host unavailable'), { status: 503 });
        return { ...host.cancelTurn({ callerSessionId: sessionId, boundSessionId: sessionId }) };
      }
      case 'mute': {
        if (typeof body.muted !== 'boolean') throw Object.assign(new Error('muted must be boolean'), { status: 400 });
        this.voiceLink.muted = body.muted;
        if (body.muted) await this.stopWatchIO(deviceId);
        this.sendTo(deviceId, { t: 'voice', phase: this.voiceLink.active ? 'listening' : 'idle', active: this.voiceLink.active, muted: body.muted });
        return { muted: body.muted };
      }
      case 'refresh': {
        await this.ensureFollowFor(deviceId);
        this.sendTo(deviceId, { t: 'snapshot', ...this.snapshot(deviceId) });
        return {};
      }
      case 'projects': return { projects: this.workspaces.map(w => ({ workspaceId: w.workspaceId, title: w.title ?? w.path ?? '', path: w.path, sessions: Array.isArray(w.sessionIds) ? w.sessionIds.length : 0 })), archivedSessionIds: this.archivedSessionIds };
      case 'open-mac': {
        // Only the native session path API is available in rc1. Never treat a
        // watch URL/image ref as an arbitrary filesystem path or shell command.
        const sessionId = await this.commandBinding(deviceId, body);
        const port = this.hostPort();
        if (body.imageRef !== undefined) {
          if (!port?.openWorkspacePath || !port.canOpenWorkspacePath?.()) throw Object.assign(new Error('Host native opener unavailable'), { status: 501 });
          const image = await this.readWatchImage(deviceId, String(body.imageRef));
          await this.commandBinding(deviceId, { sessionId }, true);
          const dir = turnkeyDir(this.opts.dshHome);
          privateDirectory(dir);
          const staging = mkdtempSync(path.join(dir, '.watch-image-'));
          privateDirectory(staging);
          const ext = image.contentType.split('/')[1] === 'jpeg' ? 'jpg' : image.contentType.split('/')[1];
          const file = path.join(staging, `image.${ext}`);
          const gate = withTimeoutSignal(8000);
          try {
            writePrivateFile(file, image.bytes);
            const opened = await port.openWorkspacePath({ path: file }, gate.signal);
            this.openImages.add(staging);
            // Bound private copies, retained until dispose so native apps have
            // time to consume them. Never any user-supplied file path.
            if (this.openImages.size > 8) { const old = this.openImages.values().next().value!; this.openImages.delete(old); rmSync(old, { recursive: true, force: true }); }
            return { ...opened };
          } catch (e) { rmSync(staging, { recursive: true, force: true }); throw e; }
          finally { gate.dispose(); }
        }
        const raw = typeof body.url === 'string' ? body.url : '';
        if (!raw || raw.length > 2048 || /[\u0000-\u0020\u007f]/.test(raw)) throw Object.assign(new Error('Invalid URL'), { status: 400 });
        let url: URL;
        try { url = new URL(raw); } catch { throw Object.assign(new Error('Invalid URL'), { status: 400 }); }
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
            [...url.searchParams.keys()].some(k => /token|secret|credential|authorization|api[-_]?key|password/i.test(k)) ||
            /token|secret|credential|authorization|password|api[-_]?key/i.test(url.hash)) throw Object.assign(new Error('Only credential-free HTTP(S) URLs may be opened'), { status: 400 });
        if (!port?.openWorkspacePath || !port.canOpenWorkspacePath?.()) throw Object.assign(new Error('Host native opener unavailable'), { status: 501 });
        await this.commandBinding(deviceId, { sessionId }, true);
        const gate = withTimeoutSignal(8000);
        try { return { ...await port.openWorkspacePath({ path: url.href }, gate.signal) }; }
        finally { gate.dispose(); }
      }
      case 'sessions': {
        const sessions = await this.listHostSessions();
        const bound = await this.watchedSessionFor(deviceId);
        return { sessions, active: bound.watchedSessionId };
      }
      case 'select-session': {
        const target = String(body.sessionId ?? '');
        const host = this.host();
        if (target) {
          if (!host) throw Object.assign(new Error('session host unavailable'), { status: 503 });
          const gate = withTimeoutSignal(5000);
          try { if (!(await host.listSessions(gate.signal)).some(row => row.sessionId === target)) throw Object.assign(new Error('unknown session'), { status: 404 }); }
          finally { gate.dispose(); }
        }
        this.store.setBinding(deviceId, target, target === '');
        this.runningVoice.sessionId = target || this.runningVoice.sessionId;
        // Reselect rotates the single follow owner (old pump aborted first).
        await this.ensureFollowFor(deviceId);
        return {};
      }
      case 'new-session': {
        const host = this.host();
        if (!host) throw Object.assign(new Error('session host unavailable'), { status: 503 });
        if (body.cwd !== undefined && body.workspaceId !== undefined) throw Object.assign(new Error('choose workspaceId or cwd, not both'), { status: 400 });
        if (body.cwd !== undefined && (typeof body.cwd !== 'string' || !body.cwd.trim())) throw Object.assign(new Error('cwd must be a nonempty path'), { status: 400 });
        if (body.workspaceId !== undefined && (typeof body.workspaceId !== 'string' || !body.workspaceId.trim())) throw Object.assign(new Error('workspaceId must be nonempty'), { status: 400 });
        const created = await withTimeout(host.createSession({
          ...(typeof body.cwd === 'string' ? { cwd: body.cwd } : {}),
          ...(typeof body.workspaceId === 'string' ? { workspaceId: body.workspaceId as NonNullable<Parameters<HostSessionPort['create']>[0]['workspaceId']> } : {}),
        }), 10000);
        if (!this.store.listDevicesPublic().some(d => d.deviceId === deviceId && !d.revoked)) throw Object.assign(new Error('watch revoked during session creation'), { status: 409 });
        const id = String(created.sessionId ?? '');
        if (!id) throw Object.assign(new Error('host did not create a real session'), { status: 502 });
        this.store.setBinding(deviceId, id, false);
        this.runningVoice.sessionId = id;
        this.sendTo(deviceId, { t: 'session', running: false, sessionId: id });
        await this.ensureFollowFor(deviceId);
        return { sessionId: id };
      }
      case 'submit': {
        const text = String(body.text ?? '').trim().slice(0, 4000);
        if (!text) throw Object.assign(new Error('empty text'), { status: 400 });
        return this.submitText(deviceId, text);
      }
      case 'steer':
        await this.commandBinding(deviceId, body);
        if (typeof body.text === 'string' && body.text.trim()) return this.submitText(deviceId, body.text.trim().slice(0, 4000), 'steer');
        return this.mutateQueue(deviceId, body, 'steer');
      case 'queue-remove': return this.mutateQueue(deviceId, body, 'remove');
      case 'queue-clear': {
        const bound = await this.commandBinding(deviceId, body);
        const items = this.queues.get(bound) ?? [];
        // rc1 has no transactional bulk clear. Each real occurrence must ack.
        for (const item of items) await this.mutateQueue(deviceId, { ...body, id: item.id }, 'remove');
        return { accepted: true };
      }
      case 'queue-move':
        throw Object.assign(new Error('rc1 queue API supports remove, steer and edit, not reordering'), { status: 501 });
      case 'approve': return this.answerRequest(deviceId, body);
      case 'character-select': {
        const requested = String(body.characterId ?? '');
        const pack = PAYLOAD_PACKS.find((p) => p.id === requested);
        if (!requested || !pack) throw Object.assign(new Error(`unknown character "${requested}"`), { status: 400 });
        this.characterId = pack.id;
        this.cappiAction = null;
        this.sendAll({ t: 'character', characterId: pack.id });
        return { ok: true, characterId: pack.id };
      }
      case 'models': {
        const sessionId = await this.commandBinding(deviceId, body);
        return this.readModelState(sessionId);
      }
      case 'set-model':
      case 'set-reasoning': {
        const sessionId = await this.commandBinding(deviceId, body, true);
        const host = this.host();
        if (!host) throw Object.assign(new Error('session host unavailable'), { status: 503 });
        const state = await this.readModelState(sessionId);
        const modelId = typeof body.modelId === 'string' ? body.modelId :
          typeof body.provider === 'string' && typeof body.model === 'string' ? modelValue(body.provider, body.model) : '';
        const option = state.options.find(o => o.value === modelId);
        if (!option) throw Object.assign(new Error('Select a model from the current catalog'), { status: 400 });
        let reasoningEffort: string | undefined;
        if (body.cmd === 'set-reasoning') {
          if (state.currentValue !== modelId) throw Object.assign(new Error('Thread model changed; reopen reasoning'), { status: 409 });
          const effort = String(body.reasoningEffort ?? '');
          if (!state.reasoning.adjustable || !state.reasoning.options.some(o => o.value === effort)) throw Object.assign(new Error('Invalid reasoning choice'), { status: 400 });
          reasoningEffort = effort === 'provider-default' ? undefined : effort.slice(7);
        } else if (typeof body.reasoningEffort === 'string') {
          const native = await host.readCatalog();
          const target = native.groups.find(g => g.id === option.provider)?.models.find(m => m.id === option.modelId);
          if (!target?.reasoning?.efforts.some(e => e.id === body.reasoningEffort)) throw Object.assign(new Error('Invalid reasoning choice for model'), { status: 400 });
          reasoningEffort = body.reasoningEffort;
        }
        // Async catalog read must not authorize a stale binding.
        await this.commandBinding(deviceId, { sessionId }, true);
        const selected = await withTimeout(host.selectModelFor({ callerSessionId: sessionId, boundSessionId: sessionId,
          provider: option.provider, model: option.modelId, ...(reasoningEffort ? { reasoningEffort } : {}) }), HOST_RPC_TIMEOUT_MS);
        const projection = this.projections.get(sessionId) ?? {};
        this.projections.set(sessionId, { ...projection, modelSelection: { next: selected.selected, lastUsed: null } });
        return this.readModelState(sessionId);
      }
      case 'set-permission': {
        const sessionId = await this.commandBinding(deviceId, body, true);
        const svc = this.opts.permissionPresets;
        const host = this.host();
        if (!svc || !host) throw Object.assign(new Error('permissionPresets service unavailable'), { status: 503 });
        const value = String(body.preset ?? body.value ?? body.permission ?? '');
        if (!svc.names.includes(value)) throw Object.assign(new Error('Unknown permission preset'), { status: 400 });
        const result = await withTimeout(host.resolveAgentFor(sessionId), HOST_RPC_TIMEOUT_MS);
        if ('error' in result) throw Object.assign(new Error(result.error.message), { status: 502 });
        await this.commandBinding(deviceId, { sessionId }, true);
        svc.set(result.agent.session, value);
        return { permissions: { options: svc.names.map(n => svc.optionOf(n)), currentValue: svc.current(result.agent.session) } };
      }
      case 'workspaces': return { workspaces: this.workspaces, archivedSessionIds: this.archivedSessionIds };
      case 'speak': {
        const text = String(body.text ?? '').trim().slice(0, 4000);
        if (!text) throw Object.assign(new Error('empty text'), { status: 400 });
        await this.speak(deviceId, text);
        return {};
      }
      default:
        throw Object.assign(new Error(`unknown cmd ${String(body.cmd ?? '')}`), { status: 400 });
    }
  }

  private async readWatchImage(deviceId: string, ref: string): Promise<{ bytes: Buffer; contentType: string }> {
    const sessionId = await this.commandBinding(deviceId, {});
    const parts = ref.split('|');
    if (parts.length !== 2 || parts[0] !== sessionId || !parts[1] || parts[1].length > 256) throw Object.assign(new Error('no such image in watched session'), { status: 404 });
    const port = this.hostPort();
    if (!port?.attachment) throw Object.assign(new Error('host attachment API unavailable'), { status: 501 });
    const value = await withTimeout(port.attachment({ sessionId: toSessionId(sessionId), attachmentId: parts[1] as Parameters<NonNullable<HostSessionPort['attachment']>>[0]['attachmentId'] }), 8000);
    await this.commandBinding(deviceId, { sessionId }, true);
    const contentType = value.attachment.mediaType;
    if (!/^image\/(png|jpeg|webp|gif)$/.test(contentType) || value.data.length > 8 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data)) throw Object.assign(new Error('unsupported image format or size'), { status: 415 });
    const bytes = Buffer.from(value.data, 'base64');
    const magic = contentType === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
      : contentType === 'image/jpeg' ? bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))
      : contentType === 'image/gif' ? /^GIF8[79]a/.test(bytes.subarray(0, 6).toString('ascii'))
      : bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
    if (!magic) throw Object.assign(new Error('invalid image bytes'), { status: 415 });
    return { bytes, contentType };
  }

  private async commandBinding(deviceId: string, body: Record<string, unknown>, requireCaller = false): Promise<string> {
    const bound = await this.watchedSessionFor(deviceId);
    const claimed = typeof body.sessionId === 'string' ? body.sessionId : requireCaller ? '' : bound.watchedSessionId ?? '';
    const check = checkSessionBinding(claimed, bound.watchedSessionId);
    if (!check.ok) throw Object.assign(new Error(check.error), { status: check.status });
    return claimed;
  }

  private async readModelState(sessionId: string) {
    const host = this.host();
    if (!host) throw Object.assign(new Error('session host unavailable'), { status: 503 });
    const catalog = await withTimeout(host.readCatalog(), 8000);
    return modelState(sessionId, catalog, this.projections.get(sessionId)?.modelSelection);
  }

  private async mutateQueue(deviceId: string, body: Record<string, unknown>, kind: 'remove' | 'steer'): Promise<Record<string, unknown>> {
    const sessionId = await this.commandBinding(deviceId, body);
    const host = this.host();
    if (!host) throw Object.assign(new Error('session host unavailable'), { status: 503 });
    const itemId = typeof body.id === 'string' ? body.id : '';
    if (!itemId || !this.queues.get(sessionId)?.some(q => q.id === itemId)) throw Object.assign(new Error('not queued in watched session'), { status: 404 });
    const out = host.updateQueueFor({ sessionId: toSessionId(sessionId), itemId: itemId as SessionUpdateQueueRequest['itemId'], action: { kind } }, sessionId);
    if (!out.accepted) throw Object.assign(new Error('host did not acknowledge queue mutation'), { status: 502 });
    // Authoritative control stream replaces the queue; no optimistic fake row deletion.
    return { accepted: true };
  }

  private seedProjections(sessionId: string, values: Record<string, unknown>, seq: number): void {
    const keys = this.projectionSeqs.get(sessionId) ?? new Map<string, number>();
    const current = this.projections.get(sessionId) ?? {};
    for (const [key, value] of Object.entries(values)) {
      if ((keys.get(key) ?? -1) > seq) continue;
      current[key] = value; keys.set(key, seq);
    }
    this.projections.set(sessionId, current); this.projectionSeqs.set(sessionId, keys);
  }

  private applyProjectionTodos(sessionId: string): void {
    const projection = this.projections.get(sessionId);
    const raw = projection?.todos;
    const todos = Array.isArray(raw) ? raw : isFollowRecord(raw) && Array.isArray(raw.items) ? raw.items : null;
    for (const f of this.follows.values()) {
      if (f.sessionId !== sessionId) continue;
      if (todos) f.view.todos = todos.filter(isFollowRecord).map(t => ({ content: String(t.content ?? t.text ?? ''), status: String(t.status ?? '') }));
      this.sendTo(f.deviceId, { t: 'snapshot', ...this.snapshot(f.deviceId) });
    }
  }

  private startHostStreams(): void {
    const host = this.host();
    if (host) this.streams.push((async () => {
      try {
        for await (const frame of host.controlStream(this.streamsAbort.signal)) {
          if (this.streamsAbort.signal.aborted) break;
          this.applyControlFrame(frame);
        }
      } catch { if (!this.streamsAbort.signal.aborted) this.safeLog('[turnkey] host control stream failed; reselect/reload to reconnect'); }
    })());
    const workspace = this.opts.workspaceController as Partial<Pick<WorkspaceController, 'follow'>> | undefined;
    if (typeof workspace?.follow === 'function') this.streams.push((async () => {
      try { for await (const frame of workspace.follow!(this.streamsAbort.signal)) {
        if (this.streamsAbort.signal.aborted) break;
        this.applyWorkspaceFrame(frame);
      } } catch { if (!this.streamsAbort.signal.aborted) this.safeLog('[turnkey] workspace stream failed'); }
    })());
  }

  private applyControlFrame(frame: SessionControlFrame): void {
    const setQueue = (id: string, items: ReadonlyArray<{ id: string; placement: string; message: { content: readonly unknown[] } }>): void => {
      this.queues.set(id, items.map(q => ({ id: q.id, text: textOfMessageContent(q.message.content), state: q.placement })));
    };
    const setJobs = (id: string, rows: ReadonlyArray<{ id: string; label: string; status: string }>): void => {
      this.jobs.set(id, rows.map(j => ({ id: j.id, label: j.label, state: j.status })));
    };
    if (frame.type === 'baseline') {
      this.queues.clear(); this.jobs.clear();
      for (const [id, items] of Object.entries(frame.value.queues)) setQueue(id, items);
      for (const [id, rows] of Object.entries(frame.value.jobs)) setJobs(id, rows);
      for (const [id, p] of Object.entries(frame.value.projections)) this.seedProjections(id, p.values, p.asOfSeq);
    } else if (frame.type === 'queue') setQueue(frame.sessionId, frame.items);
    else if (frame.type === 'jobs') setJobs(frame.sessionId, frame.jobs);
    else if (frame.type === 'projection') this.seedProjections(frame.sessionId, { [frame.key]: frame.value }, frame.seq);
    for (const f of this.follows.values()) this.applyProjectionTodos(f.sessionId);
  }

  private applyWorkspaceFrame(frame: WorkspaceFollowFrame): void {
    if (frame.type === 'baseline') { this.workspaces = frame.value.items.map(w => ({ ...w })); this.archivedSessionIds = [...frame.value.archivedSessionIds]; }
    else if (frame.type === 'upsert') this.workspaces = [...this.workspaces.filter(w => w.workspaceId !== frame.workspace.workspaceId), { ...frame.workspace }];
    else if (frame.type === 'remove') this.workspaces = this.workspaces.filter(w => w.workspaceId !== frame.workspaceId);
    else if (frame.type === 'archived') this.archivedSessionIds = [...frame.archivedSessionIds];
    else if (frame.type === 'order') this.workspaces.sort((a, b) => frame.workspaceIds.indexOf(a.workspaceId as typeof frame.workspaceIds[number]) - frame.workspaceIds.indexOf(b.workspaceId as typeof frame.workspaceIds[number]));
    this.sendAll({ t: 'workspaces', items: this.workspaces, archivedSessionIds: this.archivedSessionIds });
  }

  /** Real Cordis answerer: unbound sessions delegate untouched. The Mac answerer
   * and watch race on the SAME harness promise; only the first answer wins. */
  async answerApprovalCallback(req: ApprovalRequestEvent, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> {
    const out = await this.captureRequest(String(req.agent.id), req.signal, undefined, { kind: 'approval', title: req.toolName, detail: req.reason,
      options: [{ id: 'allowed-once', label: 'Allow once' }, { id: 'rejected', label: 'Deny' }] }, next);
    return out as ApprovalOutcome;
  }
  async answerQuestionCallback(req: AskUserQuestionRequest, next: () => Promise<AskUserQuestionAnswer>): Promise<AskUserQuestionAnswer> {
    if (!req.agent || !req.questions.length) return next();
    const out = await this.captureRequest(String(req.agent.id), req.signal, req.questions, { kind: 'ask', title: req.questions[0]!.question }, next);
    return out as AskUserQuestionAnswer;
  }
  private async captureRequest(sessionId: string, signal: AbortSignal | undefined, questions: AskUserQuestionRequest['questions'] | undefined,
    card: { kind: string; title: string; detail?: string | undefined; options?: unknown }, next: () => Promise<ApprovalOutcome | AskUserQuestionAnswer>): Promise<ApprovalOutcome | AskUserQuestionAnswer> {
    const device = this.store.listDevicesPublic().find(d => !d.revoked);
    if (!device || this.disposed || signal?.aborted || (await this.watchedSessionFor(device.deviceId)).watchedSessionId !== sessionId) return next();
    if (signal?.aborted || this.disposed || !this.store.listDevicesPublic().some(d => d.deviceId === device.deviceId && !d.revoked)) return next();
    const id = `req_${randomUUID()}`;
    let cancel!: () => void;
    const watch = new Promise<ApprovalOutcome | AskUserQuestionAnswer>(resolve => {
      this.requests.set(id, { deviceId: device.deviceId, sessionId, signal, resolve: value => { const current = this.requests.get(id); if (!current || current.settled) return; current.settled = true; resolve(value); }, questions, settled: false, qi: 0, answers: [] });
      cancel = () => resolve(questions ? { answers: [] } : 'cancelled');
      signal?.addEventListener('abort', cancel, { once: true });
    });
    this.approvals.push({ id, ...card });
    if (questions) this.publishQuestion(id);
    this.sendTo(device.deviceId, { t: 'pending', items: this.approvals.filter(a => this.requests.get(a.id)?.deviceId === device.deviceId && !this.requests.get(a.id)?.settled).map(a => ({ ...a })) });
    try { return await Promise.race([watch, Promise.resolve().then(next).then(out => out === 'unavailable' ? watch : out).catch(() => watch)]); }
    finally {
      signal?.removeEventListener('abort', cancel);
      this.requests.delete(id); this.approvals = this.approvals.filter(a => a.id !== id);
      this.sendTo(device.deviceId, { t: 'pending', items: this.approvals.filter(a => this.requests.get(a.id)?.deviceId === device.deviceId && !this.requests.get(a.id)?.settled).map(a => ({ ...a })) });
    }
  }
  private publishQuestion(id: string): void {
    const req = this.requests.get(id); const q = req?.questions?.[req.qi];
    if (!q) return;
    const card = this.approvals.find(a => a.id === id);
    if (card) Object.assign(card, { kind: 'ask', title: q.question, detail: q.detail ?? q.header, multi: !!q.multiSelect,
      options: q.options?.map(o => ({ id: o.label, label: o.label })) ?? [] });
  }
  private async answerRequest(deviceId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = String(body.requestId ?? ''); const req = this.requests.get(id);
    if (!req || req.deviceId !== deviceId || req.settled || req.signal?.aborted) throw Object.assign(new Error('question no longer pending'), { status: 404 });
    await this.commandBinding(deviceId, { sessionId: req.sessionId }, true);
    if (this.requests.get(id) !== req || req.settled || req.signal?.aborted) throw Object.assign(new Error('question no longer pending'), { status: 404 });
    if (body.sessionId !== undefined && body.sessionId !== req.sessionId) throw Object.assign(new Error('not the watched session'), { status: 409 });
    if (!req.questions) {
      const value = body.choiceId;
      if (value !== 'allowed-once' && value !== 'rejected') throw Object.assign(new Error('Invalid approval decision'), { status: 400 });
      req.resolve(value); return { approved: true, done: true };
    }
    const q = req.questions[req.qi]!;
    const choice = body.choiceId ?? body.choiceIds ?? body.choices;
    let answer: AskUserQuestionAnswerItem;
    if (choice === '_free') {
      const custom = typeof body.text === 'string' ? body.text.trim().slice(0, 2000) : '';
      if (!custom) throw Object.assign(new Error('answer is empty'), { status: 400 });
      answer = { id: q.id, selected: [], custom };
    } else {
      const selected = Array.isArray(choice) ? choice : [choice];
      if (!selected.length || new Set(selected).size !== selected.length || selected.some(v => typeof v !== 'string' || !q.options?.some(o => o.label === v)) || (!q.multiSelect && selected.length !== 1)) throw Object.assign(new Error('invalid answer choice'), { status: 400 });
      answer = { id: q.id, selected: selected as string[] };
    }
    if (req.qi + 1 < req.questions.length) {
      req.answers.push(answer); req.qi++; this.publishQuestion(id);
      this.sendTo(deviceId, { t: 'pending', items: this.approvals.filter(a => this.requests.get(a.id)?.deviceId === deviceId && !this.requests.get(a.id)?.settled).map(a => ({ ...a })) });
      return { approved: true, done: false };
    }
    req.resolve({ answers: [...req.answers, answer] });
    return { approved: true, done: true };
  }

  private stopSpeechOnly(deviceId: string): void {
    for (const controller of this.speech.get(deviceId) ?? []) controller.abort(new Error('watch speech cancelled'));
    this.sendTo(deviceId, { t: 'audio-cancel' });
  }

  private async stopWatchIO(deviceId: string): Promise<void> {
    for (const [id, ctl] of this.pendingInputs) if (ctl.deviceId === deviceId) { ctl.abort.abort(); this.pendingInputs.delete(id); }
    this.stopSpeechOnly(deviceId);
    for (const [id, session] of this.mic) {
      if (session.deviceId !== deviceId) continue;
      session.state = 'closed'; session.abort.abort();
      await withTimeout(session.handle.dispose(), 3000).catch(() => undefined);
      this.mic.delete(id);
    }
  }

  /**
   * TTS on the ACTUAL watch wire (HANDOFF-WI §1, read from bridge.mjs +
   * TtsPlayer.kt — never invented):
   * - `{ t:'speech-started', speechId, sampleRate }`
   * - `{ t:'audio', speechId, sequence, sampleRate, pcmBase64 }` per chunk
   * - `{ t:'audio-done', speechId, cancelled }`
   * The watch reads ONLY these keys (`pcmBase64`, `sequence`, `sampleRate`);
   * legacy `chunk/bytes/state` keys are ignored by the watch and are NOT
   * emitted here. Never logs `text`.
   */
  async speak(deviceId: string, text: string, opts?: { signal?: AbortSignal | undefined }): Promise<{ speechId: string }> {
    const svc = this.opts.liveVoiceWatch;
    const speechId = `sp_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    if (!svc) {
      this.sendTo(deviceId, { t: 'audio-done', speechId, cancelled: true });
      throw Object.assign(new Error('voice backend not installed'), { status: 503 });
    }
    if (this.voiceLink.muted) return { speechId };
    const abort = new AbortController();
    const onAbort = (): void => abort.abort(opts?.signal?.reason);
    if (opts?.signal?.aborted) onAbort();
    opts?.signal?.addEventListener('abort', onAbort, { once: true });
    const owned = this.speech.get(deviceId) ?? new Set<AbortController>();
    owned.add(abort); this.speech.set(deviceId, owned);
    let sequence = 0;
    let done = false;
    const finish = (cancelled: boolean): void => {
      if (done) return;
      done = true;
      this.sendTo(deviceId, { t: 'audio-done', speechId, cancelled });
    };
    try {
    const st = await this.backendStatus();
    abort.signal.throwIfAborted();
    const sampleRate = st.pcm?.sampleRate ?? 16000;
    this.sendTo(deviceId, { t: 'speech-started', speechId, sampleRate });
      await svc.synthesize({
        text,
        speechId,
        onChunk: (pcm) => {
          if (abort.signal.aborted || this.voiceLink.muted || this.disposed) return;
          this.sendTo(deviceId, {
            t: 'audio',
            speechId,
            sequence: sequence++,
            sampleRate,
            pcmBase64: Buffer.from(pcm).toString('base64'),
          });
        },
        onDone: () => finish(abort.signal.aborted),
        signal: abort.signal,
      });
    } catch (e) {
      finish(true);
      throw e;
    } finally {
      owned.delete(abort);
      if (!owned.size) this.speech.delete(deviceId);
      opts?.signal?.removeEventListener('abort', onAbort);
    }
    return { speechId };
  }

  private async listHostSessions(): Promise<Array<Record<string, unknown>>> {
    const host = this.host();
    if (!host) return [];
    // Caller-owned signal + bounded timeout; failures surface as [] ONLY at
    // this UI-convenience layer (the binding path above logs them). Never a
    // signal-less `list({})` with a quiet catch.
    const gate = withTimeoutSignal(BINDING_LOOKUP_TIMEOUT_MS);
    try {
      const items = [...(await host.listSessions(gate.signal))];
      for (const f of this.follows.values()) {
        const agents = items.filter(i => i.origin === 'subagent' && i.parentSessionId === f.sessionId)
          .map(i => ({ id: i.sessionId, label: typeof i.projections?.values?.title === 'string' ? i.projections.values.title : `agent ${String(i.sessionId).slice(0, 8)}`, state: i.running ? 'running' : 'idle' }));
        this.projections.set(f.sessionId, { ...this.projections.get(f.sessionId), agents });
        this.sendTo(f.deviceId, { t: 'agents', items: agents });
      }
      return items.filter(i => i.origin !== 'subagent').map(i => ({ sessionId: i.sessionId, title: i.projections?.values?.title ?? null, running: i.running, updatedAt: i.updatedAt,
        blank: i.blank, cwd: i.cwd ?? null, subagent: false, workspaceId: this.workspaces.find(w => Array.isArray(w.sessionIds) && w.sessionIds.includes(i.sessionId))?.workspaceId ?? null }));
    } catch (e) {
      this.safeLog(`[turnkey] session list failed: ${(e as Error).message ?? e}`);
      return [];
    } finally {
      gate.dispose();
    }
  }

  /** Cappi model action: atomic binding check, state-owned cues never resolve. */
  async handleCappi(deviceId: string, body: Record<string, unknown>): Promise<{ status: number; payload: unknown }> {
    if (!this.store.listDevicesPublic().some(d => d.deviceId === deviceId && !d.revoked)) return { status: 409, payload: { ok: false, error: 'watch is not paired' } };
    if (body == null || typeof body !== 'object' || Array.isArray(body)) {
      return { status: 400, payload: { ok: false, error: 'bad body' } };
    }
    if (!Object.hasOwn(body, 'action')) {
      return { status: 400, payload: { ok: false, error: 'missing action' } };
    }
    const bound = await this.watchedSessionFor(deviceId);
    const claimed = typeof body.sessionId === 'string' ? body.sessionId : '';
    const check = checkSessionBinding(claimed, bound.watchedSessionId);
    if (!check.ok) return { status: check.status, payload: { ok: false, error: check.error } };
    const action = body.action === null || body.action === 'clear' ? null : String(body.action);
    if (action === null) {
      this.cappiAction = null;
      this.sendAll({ t: 'cappi', action: null });
      return { status: 200, payload: { ok: true, action: null, characterId: this.characterId } };
    }
    if (['question', 'static_hold', 'work_talk', 'neutral_hold'].includes(action)) {
      return { status: 400, payload: { ok: false, error: `action '${action}' is state-owned and not model-requestable` } };
    }
    const pack = PAYLOAD_PACKS.find((p) => p.id === this.characterId) ?? PAYLOAD_PACKS[0]!;
    const selectable = new Set(pack.modelSelectable);
    let resolved: string | null = null;
    if (selectable.has(action)) resolved = action;
    else {
      const legacyRole = LEGACY_ROLE[action];
      if (legacyRole) {
        resolved = pack.modelSelectable.find((id) => (pack.roles[legacyRole] ?? []).includes(id)) ?? null;
      }
    }
    if (!resolved) {
      return { status: 400, payload: { ok: false, error: `unknown action: ${action} (character '${pack.id}'; callable: ${pack.modelSelectable.join(', ')})` } };
    }
    this.cappiAction = resolved;
    this.sendAll({ t: 'cappi', action: resolved });
    return { status: 200, payload: { ok: true, action: resolved, characterId: pack.id } };
  }

  /** Tool-facing entry: resolves exec.agent.id against THIS device's binding. */
  async toolActionFor(deviceId: string, callerSessionId: string | undefined, action: string | null): Promise<{ ok: true; action: string | null } | { ok: false; error: string }> {
    const bound = await this.watchedSessionFor(deviceId);
    const check = checkSessionBinding(callerSessionId ?? '', bound.watchedSessionId);
    if (!check.ok) return { ok: false, error: check.error };
    const out = await this.handleCappi(deviceId, { action, sessionId: callerSessionId });
    if ((out.payload as { ok?: boolean }).ok === true) {
      return { ok: true, action: (out.payload as { action?: string | null }).action ?? null };
    }
    return { ok: false, error: String((out.payload as { error?: string }).error ?? 'bridge error') };
  }
}

const LEGACY_ROLE: Record<string, string> = {
  idle1_a: 'idle', idle1_b: 'idle', idle1_c: 'idle', idle1_d: 'idle',
  idle2_a: 'idle', idle2_b: 'idle', idle2_c: 'idle', idle2_d: 'idle', idle2_e: 'idle',
  breath: 'listen', breath2: 'listen', relaxed: 'listen',
  talk2: 'talk', talk3: 'talk', talk_gesture: 'talk',
  work: 'work', dance: 'celebrate', shadow: 'celebrate',
};

function headerValue(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? '';
  return typeof v === 'string' ? v : '';
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const gate = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('binding-timeout'), { status: 503 })), ms);
  });
  return Promise.race([p, gate]).finally(() => clearTimeout(timer!)) as Promise<T>;
}

export { secretMatches, newOpaqueId, isOpaqueId };
export type { SseClient };
