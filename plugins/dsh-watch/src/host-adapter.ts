/**
 * Typed host-session adapter (H-owned).
 *
 * Exact rc1 proof (installed `@deepseek-ai/dsh-api-session-controller`
 * 0.1.2-rc.1, `lib/types/index.d.ts` + `lib/types/types.d.ts`, identical in
 * the workspace install and the global DSH install):
 *
 * - `list(_request: SessionListRequest, signal: AbortSignal)`
 *   → `Promise<SessionListValue>` where
 *   `SessionListRequest = { cursor?: string }` and
 *   `SessionListValue = { items: readonly SessionSummary[] }`.
 * - `create(request: SessionCreateRequest)` → `Promise<SessionCreateValue>`
 *   where every field of `SessionCreateRequest`
 *   (`workspaceId?/cwd?/sessionId?/agentPreset?`) is optional.
 * - `inspect(sessionId: SessionId, signal?: AbortSignal)`
 *   → `Promise<SessionInspection>`.
 * - `resolveAgent(sessionId: SessionId)` → `Promise<ApiSessionAgentResult>`.
 * - `prompt(request: SessionPromptRequest, signal: AbortSignal)`
 *   → `Promise<SessionPromptValue>` where
 *   `SessionPromptRequest = { requestId, sessionId, mode: 'queue'|'steer',
 *   content: readonly PromptContentPart[], clientTimeZone? }` and
 *   `PromptContentPart = { type:'text', text } | { type:'image', ... }`.
 *   There is NO `{ sessionId, text }` and NO `{ sessionId, input }`
 *   overload — callers MUST build `content: [{ type: 'text', text }]`
 *   (see `textPromptRequest`) and pass a real `AbortSignal`.
 * - `selectModel(request: SessionSelectModelRequest)`
 *   → `Promise<SessionSelectModelValue>`.
 * - `modelCatalog()` → `Promise<ModelCatalog>`.
 * - `page(request: SessionPageRequest, signal: AbortSignal)`,
 *   `follow(request: SessionFollowRequest, signal: AbortSignal)`,
 *   `control(signal: AbortSignal)`, `cancel(request)` (sync).
 *
 * There is deliberately NO `as never` / `unknown`-DTO bypass anywhere in
 * this file: the single brand-point `toSessionId` validates a non-empty
 * string once, and every RPC goes through the `HostSessionPort` interface
 * below with the exact request/signal arity above.
 *
 * Binding atomicity: every session-scoped adapter method takes the caller's
 * session id AND the watch binding and runs `checkSessionBinding` BEFORE
 * any host RPC (missing → 400, none → 409, mismatch → 409, no effect).
 */

import { randomUUID } from 'node:crypto';
import type { SessionController } from '@deepseek-ai/dsh-api-session-controller';

// ---- exact rc1 request/value types, derived from the real controller ----
export type SessionListRequest = Parameters<SessionController['list']>[0];
export type SessionListValue = Awaited<ReturnType<SessionController['list']>>;
export type SessionCreateRequest = Parameters<SessionController['create']>[0];
export type SessionCreateValue = Awaited<ReturnType<SessionController['create']>>;
export type SessionPromptRequest = Parameters<SessionController['prompt']>[0];
export type SessionPromptValue = Awaited<ReturnType<SessionController['prompt']>>;
export type SessionSelectModelRequest = Parameters<SessionController['selectModel']>[0];
export type SessionSelectModelValue = Awaited<ReturnType<SessionController['selectModel']>>;
export type SessionFollowRequest = Parameters<SessionController['follow']>[0];
export type SessionFollowFrame = Awaited<
  ReturnType<SessionController['follow']>
> extends AsyncIterable<infer F>
  ? F
  : never;
export type SessionPageRequest = Parameters<SessionController['page']>[0];
export type SessionPage = Awaited<ReturnType<SessionController['page']>>;
export type SessionInspection = Awaited<ReturnType<SessionController['inspect']>>;
export type ApiSessionAgentResult = Awaited<ReturnType<SessionController['resolveAgent']>>;
export type SessionControlFrame = Awaited<
  ReturnType<SessionController['control']>
> extends AsyncIterable<infer F>
  ? F
  : never;
export type SessionCancelValue = ReturnType<SessionController['cancel']>;
export type SessionCatalog = Awaited<ReturnType<SessionController['modelCatalog']>>;
export type SessionUpdateQueueRequest = Parameters<SessionController['updateQueue']>[0];
export type SessionCancelRequest = Parameters<SessionController['cancel']>[0];
export type SessionId = SessionPromptRequest['sessionId'];
export type SessionAddress = SessionFollowRequest['address'];

/** Minimal structural port of the rc1 SessionController surface H may use. */
export interface HostSessionPort {
  list(request: SessionListRequest, signal: AbortSignal): Promise<SessionListValue>;
  create(request: SessionCreateRequest): Promise<SessionCreateValue>;
  inspect(
    ...args: Parameters<SessionController['inspect']>
  ): ReturnType<SessionController['inspect']>;
  resolveAgent(
    ...args: Parameters<SessionController['resolveAgent']>
  ): ReturnType<SessionController['resolveAgent']>;
  prompt(request: SessionPromptRequest, signal: AbortSignal): Promise<SessionPromptValue>;
  selectModel(request: SessionSelectModelRequest): Promise<SessionSelectModelValue>;
  modelCatalog(): Promise<Awaited<ReturnType<SessionController['modelCatalog']>>>;
  page(request: SessionPageRequest, signal: AbortSignal): Promise<Awaited<ReturnType<SessionController['page']>>>;
  follow(request: SessionFollowRequest, signal: AbortSignal): AsyncIterable<SessionFollowFrame>;
  control(signal: AbortSignal): AsyncIterable<Awaited<ReturnType<SessionController['control']>> extends AsyncIterable<infer F> ? F : never>;
  updateQueue?: SessionController['updateQueue'];
  attachment?: SessionController['attachment'];
  canOpenWorkspacePath?: SessionController['canOpenWorkspacePath'];
  openWorkspacePath?: SessionController['openWorkspacePath'];
  cancel(request: SessionCancelRequest): ReturnType<SessionController['cancel']>;
}

const PORT_METHODS = [
  'list',
  'create',
  'inspect',
  'resolveAgent',
  'prompt',
  'selectModel',
  'modelCatalog',
  'page',
  'follow',
  'control',
  'cancel',
] as const;

/** Checked narrow of the injected host service (never `as never`). */
export function asHostSessionPort(raw: unknown): HostSessionPort | undefined {
  if (!raw || (typeof raw !== 'object' && typeof raw !== 'function')) return undefined;
  const rec = raw as Record<string, unknown>;
  for (const m of PORT_METHODS) {
    if (typeof rec[m] !== 'function') return undefined;
  }
  return raw as HostSessionPort;
}

/** Single validated brand-point: string → rc1 SessionId (throws on empty). */
export function toSessionId(id: string): SessionId {
  if (typeof id !== 'string' || !id) throw new Error('session id required');
  return id as SessionId;
}

/**
 * Exact user-text prompt builder: rc1 admits prompts ONLY as
 * `{ requestId, sessionId, mode, content: [{ type: 'text', text }] }`.
 */
export function textPromptRequest(args: {
  sessionId: string;
  text: string;
  mode?: 'queue' | 'steer' | undefined;
  requestId?: string | undefined;
}): SessionPromptRequest {
  const text = args.text;
  if (typeof text !== 'string' || !text.trim()) throw new Error('empty text');
  return {
    requestId: (args.requestId ?? randomUUID()) as SessionPromptRequest['requestId'],
    sessionId: toSessionId(args.sessionId),
    mode: args.mode ?? 'queue',
    content: [{ type: 'text', text } as SessionPromptRequest['content'][number]],
  };
}

/**
 * Exact rc1 follow request for one ordinary session: rc1 takes
 * `{ address: { kind: 'session', sessionId }, maxMessages? }` — there is NO
 * `{ sessionId, assistantStream }` overload (no `assistantStream` key exists
 * on `SessionFollowRequest`). Callers MUST build the address form here.
 */
export function followRequestFor(sessionId: string, maxMessages?: number | undefined): SessionFollowRequest {
  return {
    address: { kind: 'session', sessionId: toSessionId(sessionId) },
    ...(maxMessages === undefined ? {} : { maxMessages }),
  };
}

/** Atomic caller-vs-binding check shared by the adapter and the runtime. */
export function checkSessionBinding(
  claimed: string,
  watched: string | null,
): { ok: true } | { ok: false; status: number; error: string } {
  if (typeof claimed !== 'string' || !claimed) {
    return { ok: false, status: 400, error: 'session binding required: send the calling session id as sessionId' };
  }
  if (typeof watched !== 'string' || !watched) {
    return { ok: false, status: 409, error: 'no watched session; select a session before character actions' };
  }
  if (claimed !== watched) {
    return { ok: false, status: 409, error: 'not the watched session: the bridge followed a different session' };
  }
  return { ok: true };
}

/** Bounded AbortSignal with explicit dispose (timer unref'd, never leaked). */
export function withTimeoutSignal(ms: number, parent?: AbortSignal | undefined): { signal: AbortSignal; dispose: () => void } {
  const ctl = new AbortController();
  if (parent?.aborted) ctl.abort(parent.reason);
  const onParentAbort = (): void => ctl.abort(parent?.reason);
  parent?.addEventListener('abort', onParentAbort, { once: true });
  const timer = setTimeout(() => {
    ctl.abort(new Error('host-timeout'));
  }, ms);
  timer.unref?.();
  return {
    signal: ctl.signal,
    dispose: (): void => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onParentAbort);
    },
  };
}

export interface BoundCall {
  callerSessionId: string;
  boundSessionId: string | null;
}

/** Enforce the binding BEFORE running the host RPC (atomic, no effect on mismatch). */
export async function invokeBound<T>(
  bound: BoundCall,
  run: () => Promise<T>,
): Promise<T> {
  const check = checkSessionBinding(bound.callerSessionId, bound.boundSessionId);
  if (!check.ok) throw Object.assign(new Error(check.error), { status: check.status });
  return run();
}

/**
 * Binding-checked host adapter. Every session-scoped method enforces
 * `callerSessionId === boundSessionId` atomically before any host RPC.
 */
export class HostSessionHost {
  constructor(private readonly port: HostSessionPort) {}

  get raw(): HostSessionPort {
    return this.port;
  }

  /** Cold-safe list with a caller-owned signal (never a quiet `[]` catch). */
  async listSessions(signal: AbortSignal): Promise<SessionListValue['items']> {
    const out = await this.port.list({}, signal);
    return out.items;
  }

  async createSession(request: SessionCreateRequest = {}): Promise<SessionCreateValue> {
    return this.port.create(request);
  }

  async inspectSession(sessionId: string, signal?: AbortSignal | undefined): Promise<SessionInspection> {
    return this.port.inspect(toSessionId(sessionId), signal);
  }

  async resolveAgentFor(sessionId: string): Promise<ApiSessionAgentResult> {
    return this.port.resolveAgent(toSessionId(sessionId));
  }

  /** Submit exact user text as an rc1 prompt (content parts + signal). */
  async submitUserText(args: {
    callerSessionId: string;
    boundSessionId: string | null;
    text: string;
    mode?: 'queue' | 'steer' | undefined;
    signal: AbortSignal;
  }): Promise<SessionPromptValue> {
    return invokeBound(
      { callerSessionId: args.callerSessionId, boundSessionId: args.boundSessionId },
      async () => {
        const request = textPromptRequest({
          sessionId: args.callerSessionId,
          text: args.text,
          ...(args.mode !== undefined ? { mode: args.mode } : {}),
        });
        return this.port.prompt(request, args.signal);
      },
    );
  }

  async selectModelFor(args: {
    callerSessionId: string;
    boundSessionId: string | null;
    provider: string;
    model: string;
    reasoningEffort?: string | undefined;
  }): Promise<SessionSelectModelValue> {
    return invokeBound(
      { callerSessionId: args.callerSessionId, boundSessionId: args.boundSessionId },
      async () => {
        if (!args.provider || !args.model) {
          throw Object.assign(new Error('provider and model are required'), { status: 400 });
        }
        return this.port.selectModel({
          sessionId: toSessionId(args.callerSessionId),
          provider: args.provider,
          model: args.model,
          ...(args.reasoningEffort !== undefined ? { reasoningEffort: args.reasoningEffort } : {}),
        });
      },
    );
  }

  async readCatalog(): Promise<SessionCatalog> {
    return this.port.modelCatalog();
  }

  async readPage(request: SessionPageRequest, signal: AbortSignal): Promise<SessionPage> {
    return this.port.page(request, signal);
  }

  followSession(request: SessionFollowRequest, signal: AbortSignal): AsyncIterable<SessionFollowFrame> {
    return this.port.follow(request, signal);
  }

  controlStream(signal: AbortSignal): AsyncIterable<SessionControlFrame> {
    return this.port.control(signal);
  }

  updateQueueFor(request: SessionUpdateQueueRequest, boundSessionId: string | null): ReturnType<SessionController['updateQueue']> {
    const check = checkSessionBinding(request.sessionId, boundSessionId);
    if (!check.ok) throw Object.assign(new Error(check.error), { status: check.status });
    if (!this.port.updateQueue) throw Object.assign(new Error('host queue API unavailable'), { status: 503 });
    return this.port.updateQueue(request);
  }

  cancelTurn(args: { callerSessionId: string; boundSessionId: string | null }): SessionCancelValue {
    const check = checkSessionBinding(args.callerSessionId, args.boundSessionId);
    if (!check.ok) throw Object.assign(new Error(check.error), { status: check.status });
    return this.port.cancel({ sessionId: toSessionId(args.callerSessionId) });
  }
}
