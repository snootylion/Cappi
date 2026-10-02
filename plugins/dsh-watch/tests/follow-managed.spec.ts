/**
 * Host-follow consumption tests (HS-owned).
 *
 * Proves the ACTUAL rc1 follow leg is consumed per selected bound device:
 * - follow request is the exact address form `{ address: { kind:'session',
 *   sessionId } }` with a real AbortSignal (never `{ sessionId,
 *   assistantStream }` — that overload does not exist in rc1).
 * - Fixtures use the legitimate `SessionFollowFrame` shape (opening
 *   snapshot `{ header, cursor, records, hasMore, projections }` + live
 *   `{ type:'event', event:{ type, seq, time, data } }` entries, chunk-row
 *   runs as `chunkrow/text-chunks`) — never an invented `content` field.
 * - Synthetic assistant end-to-end PACT against a mock host provider only
 *   (no secret keys, no network, ephemeral nothing): prompt → follow frames
 *   → cumulative assistant SSE → single TTS utterance on the exact
 *   speech-started/audio(pcmBase64)/audio-done wire.
 * - Exactly-once: snapshot history never speaks (reselect replays nothing),
 *   one TTS owner per turn, echo guard skips parroted user text.
 * - Rotation: reselect/stop/revoke/dispose aborts the old follow owner
 *   exactly once; stale frames never deliver.
 *
 * No HOME/DSH_HOME/profile/bridge/network use: TempHOME stores, fake TLS
 * identity, stubbed host + voice services, ephemeral nothing.
 */

import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TurnkeyStore, newOpaqueId } from '../src/pairing-store.ts';
import { ManagedTurnkeyRuntime } from '../src/managed-runtime.ts';
import type { LiveVoiceWatchService } from '../src/watch-api.ts';

function tempHome(): string {
  return mkdtempSync(path.join(realpathSync(tmpdir()), 'turnkey-hs-follow-'));
}

const FAKE_CERT = `-----BEGIN CERTIFICATE-----
${Buffer.alloc(32, 7).toString('base64')}
-----END CERTIFICATE-----`;

function fakeIdentity() {
  return {
    certPem: FAKE_CERT,
    keyPem: 'key',
    pin: 'sha256/' + Buffer.alloc(32, 7).toString('base64'),
    fingerprint: { full: 'AA:'.repeat(31) + 'BB', short: 'AABB-CCDD-EEFF-0011-2233-4455' },
  };
}

function fullHostStub(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    list: async () => ({ items: [{ sessionId: 'sess-1', updatedAt: 1, running: false, blank: false }, { sessionId: 'sess-2', updatedAt: 0, running: false, blank: false }] }),
    create: async () => ({ sessionId: 'sess-new' }),
    inspect: async () => ({ header: {}, events: [] }),
    resolveAgent: async () => ({ agent: { id: 'sess-1' } }),
    prompt: async () => ({ accepted: true as const }),
    selectModel: async () => ({ selected: { provider: 'p', model: 'm' } }),
    modelCatalog: async () => ({ groups: [], failures: [] }),
    page: async () => ({ records: [], hasMore: false }),
    follow: () => (async function* () {})(),
    control: () => (async function* () {})(),
    cancel: () => ({ accepted: true as const }),
    ...overrides,
  };
}

function voiceStub(overrides: Record<string, unknown> = {}): LiveVoiceWatchService & {
  synthCalls: Array<{ text: string; speechId: string }>;
} {
  const synthCalls: Array<{ text: string; speechId: string }> = [];
  const svc = {
    status: async () => ({
      status: 'ready' as const,
      pcm: { encoding: 'pcm16le' as const, sampleRate: 16000, channels: 1 as const },
      consent: 'granted',
    }),
    setup: async () => ({
      status: 'ready' as const,
      pcm: { encoding: 'pcm16le' as const, sampleRate: 16000, channels: 1 as const },
    }),
    createInput: async (args: { streamId: string; onEvent: (e: never) => unknown }) => ({
      writePCM: async () => {},
      end: async () => {},
      dispose: async () => {},
      streamId: args.streamId,
    }),
    synthesize: async (args: { text: string; speechId: string; onChunk: (p: Uint8Array) => void; onDone: (r: { speechId: string }) => void }) => {
      synthCalls.push({ text: args.text, speechId: args.speechId });
      args.onChunk(new Uint8Array([9, 9, 9]));
      args.onDone({ speechId: args.speechId });
    },
    ...overrides,
  } as unknown as LiveVoiceWatchService & { synthCalls: typeof synthCalls };
  svc.synthCalls = synthCalls;
  return svc;
}

function pairedDevice() {
  const home = tempHome();
  const store = new TurnkeyStore(home);
  const secret = newOpaqueId();
  const pending = store.createPending({ deviceAlias: 'Galaxy Watch4', enrollmentSecret: secret });
  store.approve(pending.requestId, true, 'watch-1');
  const { token, deviceId } = store.consumeApproved(pending.requestId, secret);
  store.setBinding(deviceId, 'sess-1', false);
  return { store, token, deviceId };
}

// ---- legitimate rc1 follow frame fixtures (shape from types.d.ts) ----

function snapshotFrame(sessionId: string, cursor: number, records: unknown[]): Record<string, unknown> {
  return {
    type: 'snapshot',
    header: { version: 0, id: sessionId, createdAt: Date.now() },
    cursor,
    records,
    hasMore: false,
    projections: { asOfSeq: cursor, values: {} },
  };
}

function eventFrame(type: string, seq: number, data: unknown): Record<string, unknown> {
  return { type: 'event', event: { type, seq, time: Date.now(), data } };
}

function eventRecord(type: string, seq: number, data: unknown): Record<string, unknown> {
  return { type: 'event', event: { type, seq, time: Date.now(), data } };
}

function chunksRecord(seq: number, texts: string[]): Record<string, unknown> {
  return {
    type: 'chunks',
    event: {
      type: 'chunkrow/text-chunks',
      seq,
      time: Date.now(),
      data: { turn: 1, step: 1, index: 0, dt: [], texts },
    },
  };
}

function sseTap(runtime: ManagedTurnkeyRuntime, deviceId: string): { lines: string[] } {
  const tap = { lines: [] as string[] };
  const set = (runtime as unknown as { sse: Set<{ res: { write: (s: string) => void }; deviceId: string }> }).sse;
  set.add({ res: { write: (s: string) => tap.lines.push(s) }, deviceId });
  return tap;
}

function sseEvents(tap: { lines: string[] }): Array<Record<string, unknown>> {
  return tap.lines
    .flatMap((l) => l.split('\n'))
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>);
}

async function callRoute(
  runtime: ManagedTurnkeyRuntime,
  opts: { method: string; url: string; headers?: Record<string, string>; body?: unknown; raw?: Buffer[] },
): Promise<{ code: number; payload: unknown }> {
  const route = (runtime as unknown as { route: (req: unknown, res: unknown) => Promise<void> }).route.bind(runtime);
  return new Promise((resolve) => {
    const chunks: Buffer[] = opts.raw ?? (opts.body === undefined ? [] : [Buffer.from(JSON.stringify(opts.body))]);
    const req = {
      method: opts.method,
      url: opts.url,
      headers: { 'content-type': opts.raw ? 'application/octet-stream' : 'application/json', ...opts.headers },
      socket: { remoteAddress: '127.0.0.1' },
      on: (ev: string, cb: (...a: never[]) => void): void => {
        if (ev === 'data') for (const c of chunks) cb(c as never);
        if (ev === 'end') queueMicrotask(() => cb());
      },
    };
    const res = {
      writeHead: (code: number): void => {
        (res as { code?: number }).code = code;
      },
      write: (): void => {},
      end: (b?: string): void => {
        resolve({ code: (res as { code?: number }).code ?? 0, payload: b ? JSON.parse(b) : null });
      },
    };
    void route(req as never, res as never);
  });
}

function authHeaders(token: string, pin: string): Record<string, string> {
  return { 'x-bridge-token': token, 'x-cert-pin': pin };
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for follow pump');
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** History script: closed turn 1 in the snapshot, open live turn 2 after it. */
function scriptedFollow(frames: Record<string, unknown>[]) {
  const seen: Array<{ request: unknown; signal: AbortSignal }> = [];
  return {
    seen,
    follow: (request: unknown, signal: AbortSignal) => {
      seen.push({ request, signal });
      return (async function* () {
        for (const f of frames) yield f as never;
      })();
    },
  };
}

describe('follow request: exact rc1 address form', () => {
  it('calls follow({ address:{ kind:session, sessionId } }, AbortSignal) — never assistantStream', async () => {
    const { store, token, deviceId } = pairedDevice();
    const script = scriptedFollow([]);
    const runtime = new ManagedTurnkeyRuntime({
      dshHome: tempHome(),
      identity: fakeIdentity(),
      store,
      sessionController: fullHostStub({ follow: script.follow }),
      liveVoiceWatch: voiceStub(),
    });
    const out = await callRoute(runtime, {
      method: 'POST',
      url: '/watch/command',
      headers: authHeaders(token, fakeIdentity().pin),
      body: { cmd: 'select-session', sessionId: 'sess-1' },
    });
    expect(out.code).toBe(200);
    expect(deviceId).toBeTruthy();
    await waitFor(() => script.seen.length > 0);
    expect(script.seen).toHaveLength(1);
    const { request, signal } = script.seen[0] as { request: Record<string, unknown>; signal: AbortSignal };
    expect(request).toEqual({ address: { kind: 'session', sessionId: 'sess-1' } });
    expect(request).not.toHaveProperty('assistantStream');
    expect(request).not.toHaveProperty('sessionId');
    expect(signal).toBeInstanceOf(AbortSignal);
    await runtime.dispose();
  });

  it('no host leg → honest null follow (no crash, no follow key in state)', async () => {
    const { store, token } = pairedDevice();
    const runtime = new ManagedTurnkeyRuntime({
      dshHome: tempHome(),
      identity: fakeIdentity(),
      store,
      liveVoiceWatch: voiceStub(),
    });
    const out = await callRoute(runtime, {
      method: 'POST',
      url: '/watch/command',
      headers: authHeaders(token, fakeIdentity().pin),
      body: { cmd: 'select-session', sessionId: 'sess-1' },
    });
    expect(out.code).toBe(503);
    const state = await callRoute(runtime, {
      method: 'GET',
      url: '/watch/state',
      headers: authHeaders(token, fakeIdentity().pin),
    });
    expect(state.code).toBe(200);
    expect(state.payload).not.toHaveProperty('follow');
    await runtime.dispose();
  });
});

describe('follow PACT: frames → cumulative assistant → single TTS utterance', () => {
  function historyPlusLive(): Record<string, unknown>[] {
    return [
      snapshotFrame('sess-1', 5, [
        eventRecord('turn/start', 1, { turn: 1 }),
        chunksRecord(2, ['Hel', 'lo ']),
        eventRecord('assistant/message', 3, {
          turn: 1,
          step: 1,
          message: { role: 'assistant', content: [{ type: 'text', text: 'Hello there' }] },
        }),
        eventRecord('todo/write', 4, { todos: [{ content: 'Write tests', status: 'in_progress' }] }),
        eventRecord('turn/end', 5, { turn: 1, reason: 'completed' }),
      ]),
      eventFrame('turn/start', 6, { turn: 2 }),
      eventFrame('assistant/chunk', 7, {
        turn: 2,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: 'Watch reply' },
      }),
      eventFrame('turn/end', 8, { turn: 2, reason: 'completed' }),
    ];
  }

  it('streams cumulative text + running, projects todos, speaks the live turn exactly once', async () => {
    const prompt = vi.fn(async () => ({ accepted: true as const }));
    const { store, token, deviceId } = pairedDevice();
    const script = scriptedFollow(historyPlusLive());
    const svc = voiceStub();
    const runtime = new ManagedTurnkeyRuntime({
      dshHome: tempHome(),
      identity: fakeIdentity(),
      store,
      sessionController: fullHostStub({ prompt, follow: script.follow }),
      liveVoiceWatch: svc,
    });
    const tap = sseTap(runtime, deviceId);
    const pin = fakeIdentity().pin;
    // User audio → prompt leg (mock provider, no keys): then the reply streams.
    const submitted = await callRoute(runtime, {
      method: 'POST',
      url: '/watch/command',
      headers: authHeaders(token, pin),
      body: { cmd: 'submit', text: 'what time is it' },
    });
    expect(submitted.code).toBe(200);
    expect(prompt).toHaveBeenCalledTimes(1);
    await waitFor(() => svc.synthCalls.length > 0);
    // Single TTS owner for the live turn only (history turn never spoke).
    expect(svc.synthCalls).toHaveLength(1);
    expect(svc.synthCalls[0]?.text).toBe('Watch reply');
    // Exact voice wire on the watch leg.
    const events = sseEvents(tap);
    const speechId = svc.synthCalls[0]?.speechId as string;
    expect(events).toContainEqual({ t: 'speech-started', speechId, sampleRate: 16000 });
    expect(events).toContainEqual({
      t: 'audio',
      speechId,
      sequence: 0,
      sampleRate: 16000,
      pcmBase64: Buffer.from([9, 9, 9]).toString('base64'),
    });
    expect(events).toContainEqual({ t: 'audio-done', speechId, cancelled: false });
    // Cumulative assistant SSE + running transitions from real frames only.
    expect(events).toContainEqual({ t: 'assistant', text: 'Watch reply', done: true });
    expect(events).toContainEqual({ t: 'session', running: true, sessionId: 'sess-1' });
    expect(events).toContainEqual({ t: 'session', running: false, sessionId: 'sess-1' });
    // Snapshot projection: todos + cumulative text, no fabricated keys.
    const state = await callRoute(runtime, { method: 'GET', url: '/watch/state', headers: authHeaders(token, pin) });
    const follow = (state.payload as { follow: Record<string, unknown> }).follow;
    expect(follow).toMatchObject({
      sessionId: 'sess-1',
      running: false,
      assistantText: 'Watch reply',
      done: true,
      todos: [{ content: 'Write tests', status: 'in_progress' }],
    });
    await runtime.dispose();
  });

  it('reselect replays nothing: same session keeps its owner, history never speaks twice', async () => {
    const { store, token } = pairedDevice();
    let calls = 0;
    const script = {
      follow: (_req: unknown, _sig: AbortSignal) => {
        calls++;
        return (async function* () {
          for (const f of historyPlusLive()) yield f as never;
        })();
      },
    };
    const svc = voiceStub();
    const runtime = new ManagedTurnkeyRuntime({
      dshHome: tempHome(),
      identity: fakeIdentity(),
      store,
      sessionController: fullHostStub({ follow: script.follow }),
      liveVoiceWatch: svc,
    });
    const pin = fakeIdentity().pin;
    const headers = authHeaders(token, pin);
    await callRoute(runtime, { method: 'POST', url: '/watch/command', headers, body: { cmd: 'select-session', sessionId: 'sess-1' } });
    await waitFor(() => svc.synthCalls.length > 0);
    expect(svc.synthCalls).toHaveLength(1);
    expect(calls).toBe(1);
    // Reselect the SAME session: the single owner is kept (no new follow, no
    // replay, no second utterance).
    await callRoute(runtime, { method: 'POST', url: '/watch/command', headers, body: { cmd: 'select-session', sessionId: 'sess-1' } });
    await new Promise((r) => setTimeout(r, 300));
    expect(calls).toBe(1);
    expect(svc.synthCalls).toHaveLength(1);
    await runtime.dispose();
  });

  it('echo guard: a parroted submission is never spoken', async () => {
    const prompt = vi.fn(async () => ({ accepted: true as const }));
    const { store, token } = pairedDevice();
    const script = scriptedFollow([
      snapshotFrame('sess-1', 1, [eventRecord('turn/start', 1, { turn: 9 })]),
      eventFrame('assistant/chunk', 2, { turn: 9, step: 1, chunk: { type: 'text-delta', index: 0, text: 'repeat after me' } }),
      eventFrame('turn/end', 3, { turn: 9, reason: 'completed' }),
    ]);
    const svc = voiceStub();
    const runtime = new ManagedTurnkeyRuntime({
      dshHome: tempHome(),
      identity: fakeIdentity(),
      store,
      sessionController: fullHostStub({ prompt, follow: script.follow }),
      liveVoiceWatch: svc,
    });
    const pin = fakeIdentity().pin;
    await callRoute(runtime, {
      method: 'POST',
      url: '/watch/command',
      headers: authHeaders(token, pin),
      body: { cmd: 'submit', text: 'repeat after me' },
    });
    // Let the pump consume the (short, finite) script.
    await new Promise((r) => setTimeout(r, 400));
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(svc.synthCalls).toHaveLength(0);
    await runtime.dispose();
  });
});

describe('follow rotation: reselect/stop/revoke/dispose aborts the old owner', () => {
  function hangingFollow(seen: Array<{ sessionId: string; signal: AbortSignal }>) {
    return (request: unknown, signal: AbortSignal) => {
      const address = (request as { address: { sessionId: string } }).address;
      seen.push({ sessionId: address.sessionId, signal });
      return (async function* (): AsyncGenerator<never> {
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      })();
    };
  }

  it('reselect aborts the previous owner exactly once; stale frames never deliver', async () => {
    const { store, token } = pairedDevice();
    const seen: Array<{ sessionId: string; signal: AbortSignal }> = [];
    const runtime = new ManagedTurnkeyRuntime({
      dshHome: tempHome(),
      identity: fakeIdentity(),
      store,
      sessionController: fullHostStub({ follow: hangingFollow(seen) }),
      liveVoiceWatch: voiceStub(),
    });
    const pin = fakeIdentity().pin;
    const headers = authHeaders(token, pin);
    await callRoute(runtime, { method: 'POST', url: '/watch/command', headers, body: { cmd: 'select-session', sessionId: 'sess-1' } });
    await waitFor(() => seen.length >= 1);
    await callRoute(runtime, { method: 'POST', url: '/watch/command', headers, body: { cmd: 'select-session', sessionId: 'sess-2' } });
    await waitFor(() => seen.length >= 2);
    expect(seen[0]?.sessionId).toBe('sess-1');
    expect(seen[1]?.sessionId).toBe('sess-2');
    expect(seen[0]?.signal.aborted).toBe(true);
    expect(seen[1]?.signal.aborted).toBe(false);
    await runtime.dispose();
    expect(seen[1]?.signal.aborted).toBe(true);
  });

  it('revokeDevice stops owned follow and access without cancelling the harness turn', async () => {
    const cancel = vi.fn(() => ({ accepted: true as const }));
    const { store, token, deviceId } = pairedDevice();
    const seen: Array<{ sessionId: string; signal: AbortSignal }> = [];
    const runtime = new ManagedTurnkeyRuntime({
      dshHome: tempHome(),
      identity: fakeIdentity(),
      store,
      sessionController: fullHostStub({ follow: hangingFollow(seen), cancel }),
      liveVoiceWatch: voiceStub(),
    });
    const pin = fakeIdentity().pin;
    await callRoute(runtime, {
      method: 'POST',
      url: '/watch/command',
      headers: authHeaders(token, pin),
      body: { cmd: 'select-session', sessionId: 'sess-1' },
    });
    await waitFor(() => seen.length >= 1);
    const ok = await runtime.revokeDevice(deviceId);
    expect(ok).toBe(true);
    expect(cancel).not.toHaveBeenCalled();
    expect(seen[0]?.signal.aborted).toBe(true);
    expect(store.deviceForToken(token)).toBeUndefined();
    expect(store.getBinding(deviceId)).toBeUndefined();
    // Unknown device → false (AU route answers 404); revoked stays revoked.
    expect(await runtime.revokeDevice('no-such-device')).toBe(false);
    expect(await runtime.revokeDevice(deviceId)).toBe(true);
    await runtime.dispose();
  });

  it('follow stream errors emit one safe error (no user text, no secrets)', async () => {
    const { store, token, deviceId } = pairedDevice();
    const runtime = new ManagedTurnkeyRuntime({
      dshHome: tempHome(),
      identity: fakeIdentity(),
      store,
      sessionController: fullHostStub({
        follow: () => (async function* (): AsyncGenerator<never> {
          throw new Error('host exploded');
        })(),
      }),
      liveVoiceWatch: voiceStub(),
    });
    const tap = sseTap(runtime, deviceId);
    await callRoute(runtime, {
      method: 'POST',
      url: '/watch/command',
      headers: authHeaders(token, fakeIdentity().pin),
      body: { cmd: 'select-session', sessionId: 'sess-1' },
    });
    await waitFor(() => sseEvents(tap).some((e) => e.t === 'error'));
    const errors = sseEvents(tap).filter((e) => e.t === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ t: 'error', code: 'follow-failed' });
    expect(JSON.stringify(errors[0])).not.toMatch(/tk_|secret|token/i);
    await runtime.dispose();
  });
});

describe('capabilities: unsupported rationale is truthful', () => {
  it('reports actual host reasoning availability and absent permission service', async () => {
    const { store, token } = pairedDevice();
    const runtime = new ManagedTurnkeyRuntime({
      dshHome: tempHome(),
      identity: fakeIdentity(),
      store,
      sessionController: fullHostStub(),
      liveVoiceWatch: voiceStub(),
    });
    const pin = fakeIdentity().pin;
    const caps = await callRoute(runtime, {
      method: 'GET',
      url: '/watch/capabilities',
      headers: authHeaders(token, pin),
    });
    expect(caps.code).toBe(200);
    expect(caps.payload).toMatchObject({
      reasoning: { supported: true },
      permissions: { supported: false },
    });
    const denied = await callRoute(runtime, {
      method: 'POST',
      url: '/watch/command',
      headers: authHeaders(token, pin),
      body: { cmd: 'set-reasoning', sessionId: 'sess-1' },
    });
    expect(denied.code).toBe(503);
    await runtime.dispose();
  });
});
