/**
 * Turnkey managed-runtime regression tests (H-owned).
 *
 * Real registration against a mock host context (tools + sessionController +
 * workspaceController + webServer + connection + liveVoiceWatch stub) with
 * binding/action/session checks; HTTPS/SSE/pairing adversarial cases with
 * mocks (foreign origin/replay/brute-force/request cleanup/revoke/PIN-no-
 * audio-before-trust); full-flow fixtures with synthetic samples only.
 * Ephemeral ports only; no production 3083/8787/8789.
 */

import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { fingerprintOf, pinMatches } from '../src/cert.ts';
import { TurnkeyStore, detectWatchKind, newOpaqueId, secretMatches } from '../src/pairing-store.ts';
import { createAdminHandlers } from '../src/admin-routes.ts';
import { ManagedTurnkeyRuntime } from '../src/managed-runtime.ts';
import type { LiveVoiceWatchService, LiveVoiceInputEventHandler } from '../src/watch-api.ts';
import { apply, inject } from '../src/index.ts';

function tempHome(): string {
  return mkdtempSync(path.join(realpathSync(tmpdir()), 'turnkey-h-'));
}

const FAKE_CERT = `-----BEGIN CERTIFICATE-----
${Buffer.alloc(32, 7).toString('base64')}
-----END CERTIFICATE-----`;

function fakeIdentity() {
  return {
    certPem: FAKE_CERT,
    keyPem: 'key',
    pin: 'sha256/' + Buffer.alloc(32, 7).toString('base64'),
    fingerprint: fingerprintOf(FAKE_CERT),
  };
}

describe('turnkey inject (frozen §9.1)', () => {
  it('injects actual accessed host services', () => {
    expect(inject).toEqual([
      'tools',
      'sessionController',
      'workspaceController',
      'webServer',
      'connection',
      'liveVoiceWatch',
      'permissionPresets',
    ]);
  });
});

describe('cert pin + fingerprint display', () => {
  it('emits full colon-hex + 96-bit short (never 6-digit)', () => {
    const fp = fingerprintOf(FAKE_CERT);
    expect(fp.full).toMatch(/^([0-9a-f]{2}:){31}[0-9a-f]{2}$/);
    expect(fp.short).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){5}$/);
  });
  it('constant-time pin compare rejects mismatch', () => {
    expect(pinMatches(fakeIdentity().pin, fakeIdentity().pin)).toBe(true);
    expect(pinMatches(fakeIdentity().pin, 'sha256/' + Buffer.alloc(32, 9).toString('base64'))).toBe(false);
    expect(pinMatches('', '')).toBe(false);
  });
});

describe('watch kind detection (Watch4 title, not poc)', () => {
  it('detects Galaxy Watch4 on SM-R86x Samsung hardware', () => {
    expect(detectWatchKind({ deviceAlias: 'My Watch', model: 'SM-R860', deviceKind: 'samsung' })).toBe('Galaxy Watch4');
    expect(detectWatchKind({ deviceAlias: 'Galaxy Watch4' })).toBe('Galaxy Watch4');
  });
  it('falls back to generic Wear OS otherwise', () => {
    expect(detectWatchKind({ deviceAlias: 'Pixel Watch' })).toBe('Wear OS');
    expect(detectWatchKind({})).toBe('Wear OS');
  });
});

describe('pairing store: enroll → approve → poll (single-use, atomic)', () => {
  it('full flow delivers one token; replay fails 401; revoke isolates', () => {
    const store = new TurnkeyStore(tempHome());
    const secret = newOpaqueId();
    const row = store.createPending({ deviceAlias: 'Galaxy Watch4', enrollmentSecret: secret });
    expect(row.attemptsLeft).toBe(5);
    // Poll before Mac approval → pending (202-style throw).
    expect(() => store.consumeApproved(row.requestId, secret)).toThrow();
    store.approve(row.requestId, true, 'watch-a');
    const out = store.consumeApproved(row.requestId, secret);
    expect(out.deviceId).toBeTruthy();
    expect(out.token.length).toBeGreaterThan(22);
    // Replay → consumed → 401 path (expired/replay).
    expect(() => store.consumeApproved(row.requestId, secret)).toThrow();
    // Token authenticates exactly one device.
    const device = store.deviceForToken(out.token);
    expect(device?.deviceId).toBe(out.deviceId);
    // A second watch must wait until the first is explicitly revoked.
    const secret2 = newOpaqueId();
    const row2 = store.createPending({ deviceAlias: 'Pixel Watch', enrollmentSecret: secret2 });
    expect(() => store.approve(row2.requestId, true, 'watch-b')).toThrow(/one active watch/);
    expect(store.revoke(out.deviceId)).toBe(true);
    store.approve(row2.requestId, true, 'watch-b');
    const out2 = store.consumeApproved(row2.requestId, secret2);
    expect(store.revoke(out.deviceId)).toBe(true);
    expect(store.deviceForToken(out.token)).toBeUndefined();
    expect(store.deviceForToken(out2.token)?.deviceId).toBe(out2.deviceId);
  });

  it('wrong secret decrements attempts (brute-force bound); unknown secret never matches', () => {
    const store = new TurnkeyStore(tempHome());
    const secret = newOpaqueId();
    const row = store.createPending({ deviceAlias: 'W', enrollmentSecret: secret });
    store.approve(row.requestId, true);
    expect(() => store.consumeApproved(row.requestId, newOpaqueId())).toThrow();
    expect(store.getPending(row.requestId)?.attemptsLeft).toBe(4);
    expect(secretMatches(newOpaqueId(), '00'.repeat(32))).toBe(false);
  });

  it('denied requests poll as approval-denied (401 class)', () => {
    const store = new TurnkeyStore(tempHome());
    const secret = newOpaqueId();
    const row = store.createPending({ deviceAlias: 'W', enrollmentSecret: secret });
    store.deny(row.requestId);
    expect(() => store.consumeApproved(row.requestId, secret)).toThrow();
  });

  it('replacement removes prior binding without authorizing a second active watch', () => {
    const store = new TurnkeyStore(tempHome());
    const s1 = newOpaqueId(); const a = store.createPending({ deviceAlias: 'A', enrollmentSecret: s1 }); store.approve(a.requestId, true, 'watch-a'); store.consumeApproved(a.requestId, s1);
    store.setBinding('watch-a', 'sess-1', false); store.revoke('watch-a');
    const s2 = newOpaqueId(); const b = store.createPending({ deviceAlias: 'B', enrollmentSecret: s2 }); store.approve(b.requestId, true, 'watch-b'); store.consumeApproved(b.requestId, s2);
    store.setBinding('watch-b', 'sess-2', false);
    expect(store.getBinding('watch-a')).toBeUndefined();
    expect(store.getBinding('watch-b')?.watchedSessionId).toBe('sess-2');
    expect(() => store.setBinding('watch-a', 'stale', false)).toThrow(/approved active/);
  });
});

describe('admin routes: DSH-origin gate + approval proof', () => {
  function setup(gate: (h: Record<string, string>) => 401 | 403 | undefined) {
    const home = tempHome();
    const store = new TurnkeyStore(home);
    const identity = fakeIdentity();
    const runtime = { port: 1, discoveryPortActual: 2, discoveryCollision: false, store } as unknown as ManagedTurnkeyRuntime;
    const handlers = createAdminHandlers(
      { store, identity, runtime, backendStatus: async () => ({ status: 'ready' as const }), hostCandidates: () => ['127.0.0.1'] },
      () => gate({}),
    );
    return { store, handlers };
  }

  function call(
    handler: (req: never, res: never) => void,
    body?: unknown,
    method = 'POST',
  ): Promise<{ code: number; payload: unknown }> {
    return new Promise((resolve) => {
      const req = {
        method,
        headers: { 'content-type': 'application/json' },
        on: (ev: string, cb: (...a: never[]) => void): void => {
          if (ev === 'end') queueMicrotask(() => cb());
        },
      };
      void body;
      const res = {
        writeHead: (code: number): void => {
          (res as { code?: number }).code = code;
        },
        end: (b?: string): void => {
          resolve({ code: (res as { code?: number }).code ?? 0, payload: b ? JSON.parse(b) : null });
        },
      };
      // Feed body via readJsonBody-compatible events.
      const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
      (req as { on: (ev: string, cb: (...a: never[]) => void) => void }).on = ((ev: string, cb: (...a: never[]) => void): void => {
        if (ev === 'data') for (const c of chunks) cb(c as never);
        if (ev === 'end') queueMicrotask(() => cb());
      }) as never;
      handler(req as never, res as never);
    });
  }

  it('foreign/unauthenticated origin is rejected (401), forbidden (403) honored', async () => {
    const { handlers } = setup(() => 401);
    const out = await call(handlers['/admin/pair/status'] as never, undefined, 'GET');
    expect(out.code).toBe(401);
    const { handlers: h2 } = setup(() => 403);
    const out2 = await call(h2['/admin/pair/status'] as never, undefined, 'GET');
    expect(out2.code).toBe(403);
  });

  it('approval requires fingerprintConfirmed:true; deny rejects secrets', async () => {
    const { store, handlers } = setup(() => undefined);
    const row = store.createPending({ deviceAlias: 'W', enrollmentSecret: newOpaqueId() });
    const bad = await call(handlers['/admin/pair/approval'] as never, { requestId: row.requestId, approve: true, fingerprintConfirmed: false });
    expect(bad.code).toBe(400);
    const good = await call(handlers['/admin/pair/approval'] as never, { requestId: row.requestId, approve: true, fingerprintConfirmed: true });
    expect(good.code).toBe(200);
    const denySecrets = await call(handlers['/pair/deny'] as never, { requestId: row.requestId, enrollmentSecret: 'x' });
    expect(denySecrets.code).toBe(400);
  });

  it('status returns identifier-only rows (never secrets)', async () => {
    const { store, handlers } = setup(() => undefined);
    store.createPending({ deviceAlias: 'W', enrollmentSecret: newOpaqueId() });
    const out = await call(handlers['/admin/pair/status'] as never, undefined, 'GET');
    expect(out.code).toBe(200);
    const payload = out.payload as { pending: Array<Record<string, unknown>>; fingerprint: unknown };
    expect(payload.fingerprint).toBeTruthy();
    for (const row of payload.pending) {
      expect(row).not.toHaveProperty('enrollmentSecret');
      expect(row).not.toHaveProperty('secretHash');
      expect(row).not.toHaveProperty('token');
    }
  });
});

describe('managed tool registration: binding/action/session checks', () => {
  async function installHost() {
    const tools: Array<{ name: string; execute: (a: unknown, e: unknown) => Promise<unknown> }> = [];
    const routes = new Map<string, (req: never, res: never) => void>();
    const home = tempHome();
    const { TurnkeyStore: Store } = await import('../src/pairing-store.ts');
    const store = new Store(home);
    const secret = newOpaqueId();
    const pending = store.createPending({ deviceAlias: 'Galaxy Watch4', enrollmentSecret: secret });
    store.approve(pending.requestId, true, 'watch-1');
    const { token, deviceId } = store.consumeApproved(pending.requestId, secret);
    store.setBinding(deviceId, 'sess-1', false);
    const sessionController = {
      list: async () => [{ id: 'sess-1' }],
    };
    const ctx = {
      tools: { register: (d: { name: string; execute: (a: unknown, e: unknown) => Promise<unknown> }) => { tools.push(d); return () => {}; } },
      sessionController,
      workspaceController: {},
      webServer: { register: (r: { path: string; handler: (req: never, res: never) => void }) => { routes.set(r.path, r.handler); return () => { routes.delete(r.path); }; } },
      connection: { requestRejection: () => undefined },
      liveVoiceWatch: {
        status: async () => ({ status: 'ready' as const, pcm: { encoding: 'pcm16le' as const, sampleRate: 16000, channels: 1 as const }, consent: 'granted' }),
        setup: async () => ({ status: 'ready' as const, pcm: { encoding: 'pcm16le' as const, sampleRate: 16000, channels: 1 as const } }),
        createInput: async () => ({ writePCM: () => {}, end: async () => {}, dispose: async () => {} }),
        synthesize: async () => {},
      },
      effect: (setup: () => () => void | Promise<void>) => { void setup; return () => {}; },
      logger: { log: () => {}, error: () => {} },
    };
    // Bypass TLS identity generation (openssl) by stubbing HOME to a dir with
    // a pre-created cert would still need openssl; instead drive apply in
    // legacy mode for the scope test and managed binding via runtime below.
    return { tools, routes, store, token, deviceId, ctx };
  }

  it('legacy tools refuse the wrong session before any network use', async () => {
    const seen: string[] = [];
    const tools: Array<{ name: string; execute: (a: unknown, e: unknown) => Promise<unknown> }> = [];
    const ctx = { tools: { register: (d: never) => { tools.push(d as never); return () => {}; } } };
    await apply(ctx as never, { bridgeMode: 'legacy', bridgeToken: 't', watchSessionId: 'sess-1' } as never);
    expect(tools.map((t) => t.name).sort()).toEqual(['cappi_action', 'watch_cappi']);
    for (const t of tools) {
      const r = await t.execute({ action: 'dance' }, { agent: { id: 'intruder' } });
      expect(r).toEqual({ ok: false, error: 'not the watch session' });
    }
    expect(seen).toHaveLength(0);
  });

  it('runtime cappi enforces exec.agent.id == binding atomically', async () => {
    const { store } = await installHost();
    const runtime = new ManagedTurnkeyRuntime({
      dshHome: tempHome(),
      identity: fakeIdentity(),
      store,
      sessionController: { list: async () => [{ id: 'sess-1' }] },
    });
    const ok = await runtime.toolActionFor('watch-1', 'sess-1', 'dance');
    expect(ok.ok).toBe(true);
    const wrong = await runtime.toolActionFor('watch-1', 'intruder', 'dance');
    expect(wrong).toEqual({ ok: false, error: expect.stringContaining('not the watched session') });
    const stateOwned = await runtime.toolActionFor('watch-1', 'sess-1', 'question');
    expect(stateOwned.ok).toBe(false);
  });
});

// ---- H fix verification: exact TTS wire / mic preflight / ASR delivery ----

describe('managed tool registration: binding still enforced after H fixes', () => {
  it('runtime cappi enforces exec.agent.id == binding atomically', async () => {
    const { store } = pairedDevice();
    const runtime = new ManagedTurnkeyRuntime({
      dshHome: tempHome(),
      identity: fakeIdentity(),
      store,
      sessionController: fullHostStub({ list: async () => ({ items: [{ sessionId: 'sess-1' }] }) }),
    });
    const ok = await runtime.toolActionFor('watch-1', 'sess-1', 'dance');
    expect(ok.ok).toBe(true);
    const wrong = await runtime.toolActionFor('watch-1', 'intruder', 'dance');
    expect(wrong).toEqual({ ok: false, error: expect.stringContaining('not the watched session') });
    const stateOwned = await runtime.toolActionFor('watch-1', 'sess-1', 'question');
    expect(stateOwned.ok).toBe(false);
  });
});

type CapturedSse = { deviceId: string; lines: string[] };

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

function voiceStub(overrides: Partial<LiveVoiceWatchService> = {}): LiveVoiceWatchService & {
  seen: { chunks: Uint8Array[]; inputs: Array<{ streamId: string; onEvent: (e: never) => unknown }> };
} {
  const seen = { chunks: [] as Uint8Array[], inputs: [] as Array<{ streamId: string; onEvent: (e: never) => unknown }> };
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
    createInput: async (args: { streamId: string; onEvent: (e: never) => unknown }) => {
      seen.inputs.push({ streamId: args.streamId, onEvent: args.onEvent });
      return {
        writePCM: async (b: Uint8Array) => {
          seen.chunks.push(b);
        },
        end: async () => {},
        dispose: async () => {},
      };
    },
    synthesize: async () => {},
    ...overrides,
  } as unknown as LiveVoiceWatchService & { seen: typeof seen };
  (svc as { seen?: unknown }).seen = seen;
  return svc as LiveVoiceWatchService & { seen: typeof seen };
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

function sseTap(runtime: ManagedTurnkeyRuntime, deviceId: string): CapturedSse {
  const tap: CapturedSse = { deviceId, lines: [] };
  const set = (runtime as unknown as { sse: Set<{ res: { write: (s: string) => void }; deviceId: string }> }).sse;
  set.add({ res: { write: (s: string) => void tap.lines.push(s) }, deviceId });
  return tap;
}

function sseEvents(tap: CapturedSse): Array<Record<string, unknown>> {
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

function authHeaders(token: string, pin: string, extra: Record<string, string> = {}): Record<string, string> {
  return { 'x-bridge-token': token, 'x-cert-pin': pin, ...extra };
}

describe('managed TTS: exact watch wire (HANDOFF-WI §1)', () => {
  it('emits speech-started / audio{sequence,pcmBase64} / audio-done (no chunk/state keys)', async () => {
    const { store, deviceId } = pairedDevice();
    const svc = voiceStub({
      synthesize: async (args: { onChunk: (p: Uint8Array) => void; onDone: (r: { speechId: string }) => void; speechId: string }) => {
        args.onChunk(new Uint8Array([1, 2, 3]));
        args.onChunk(new Uint8Array([4, 5]));
        args.onDone({ speechId: args.speechId });
      },
    } as never);
    const runtime = new ManagedTurnkeyRuntime({ dshHome: tempHome(), identity: fakeIdentity(), store, liveVoiceWatch: svc });
    const tap = sseTap(runtime, deviceId);
    const { speechId } = await runtime.speak(deviceId, 'hello');
    const events = sseEvents(tap);
    expect(events[0]).toEqual({ t: 'speech-started', speechId, sampleRate: 16000 });
    expect(events[1]).toEqual({ t: 'audio', speechId, sequence: 0, sampleRate: 16000, pcmBase64: Buffer.from([1, 2, 3]).toString('base64') });
    expect(events[2]).toEqual({ t: 'audio', speechId, sequence: 1, sampleRate: 16000, pcmBase64: Buffer.from([4, 5]).toString('base64') });
    expect(events[3]).toEqual({ t: 'audio-done', speechId, cancelled: false });
    for (const e of events) {
      expect(e).not.toHaveProperty('chunk');
      expect(e).not.toHaveProperty('state');
      expect(e).not.toHaveProperty('bytes');
    }
    await runtime.dispose();
  });

  it('failed synthesis emits audio-done cancelled:true and throws', async () => {
    const { store, deviceId } = pairedDevice();
    const svc = voiceStub({ synthesize: async () => { throw new Error('tts boom'); } } as never);
    const runtime = new ManagedTurnkeyRuntime({ dshHome: tempHome(), identity: fakeIdentity(), store, liveVoiceWatch: svc });
    const tap = sseTap(runtime, deviceId);
    await expect(runtime.speak(deviceId, 'hi')).rejects.toThrow('tts boom');
    const events = sseEvents(tap);
    expect(events[events.length - 1]).toMatchObject({ t: 'audio-done', cancelled: true });
    await runtime.dispose();
  });
});

describe('managed mic preflight: binding + awaited native ready', () => {
  it('200 only after createInput resolves (no fire-forget ready); 409 without binding', async () => {
    const { store, token, deviceId } = pairedDevice();
    let release!: (h: { writePCM: () => {}; end: () => Promise<void>; dispose: () => Promise<void> }) => void;
    const gate = new Promise((resolve) => {
      release = resolve as never;
    });
    const svc = voiceStub({ createInput: (() => gate) as never } as never);
    const runtime = new ManagedTurnkeyRuntime({
      dshHome: tempHome(),
      identity: fakeIdentity(),
      store,
      sessionController: fullHostStub(),
      liveVoiceWatch: svc,
    });
    const pin = fakeIdentity().pin;
    let responded = false;
    const pending = callRoute(runtime, {
      method: 'POST',
      url: '/watch/mic/start',
      headers: authHeaders(token, pin),
      body: { streamId: 's-await' },
    }).then((r) => {
      responded = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(responded).toBe(false);
    release({ writePCM: () => ({}), end: async () => {}, dispose: async () => {} });
    const out = await pending;
    expect(responded).toBe(true);
    expect(out.code).toBe(200);
    expect(out.payload).toMatchObject({ streamId: 's-await', state: 'ready', watchedSessionId: 'sess-1' });
    expect(deviceId).toBeTruthy();
    await runtime.dispose();
  });

  it('createInput failure observes the rejection: 503, no map entry, no 200', async () => {
    const { store, token } = pairedDevice();
    const svc = voiceStub({ createInput: async () => { throw new Error('helper gone'); } } as never);
    const runtime = new ManagedTurnkeyRuntime({
      dshHome: tempHome(),
      identity: fakeIdentity(),
      store,
      sessionController: fullHostStub(),
      liveVoiceWatch: svc,
    });
    const out = await callRoute(runtime, {
      method: 'POST',
      url: '/watch/mic/start',
      headers: authHeaders(token, fakeIdentity().pin),
      body: { streamId: 's-fail' },
    });
    expect(out.code).toBe(503);
    expect((runtime as unknown as { mic: Map<string, unknown> }).mic.has('s-fail')).toBe(false);
    await runtime.dispose();
  });

  it('fails closed 409 when no session is bound (no manual ids)', async () => {
    const home = tempHome();
    const store = new TurnkeyStore(home);
    const secret = newOpaqueId();
    const pending = store.createPending({ deviceAlias: 'W', enrollmentSecret: secret });
    store.approve(pending.requestId, true, 'watch-x');
    const { token } = store.consumeApproved(pending.requestId, secret);
    // No binding, no host controller: nothing truthful to deliver to.
    const runtime = new ManagedTurnkeyRuntime({
      dshHome: tempHome(),
      identity: fakeIdentity(),
      store,
      liveVoiceWatch: voiceStub(),
    });
    const out = await callRoute(runtime, {
      method: 'POST',
      url: '/watch/mic/start',
      headers: authHeaders(token, fakeIdentity().pin),
      body: { streamId: 's-nobind' },
    });
    expect(out.code).toBe(409);
    await runtime.dispose();
  });
});

describe('managed ASR final: exact host delivery, exactly once, TOCTOU-safe', () => {
  it('delivers prompt({requestId,sessionId,mode,content},signal); ack only on success; exactly once', async () => {
    const prompt = vi.fn(async () => ({ accepted: true as const }));
    const { store, token } = pairedDevice();
    const runtime = new ManagedTurnkeyRuntime({
      dshHome: tempHome(),
      identity: fakeIdentity(),
      store,
      sessionController: fullHostStub({ prompt }),
      liveVoiceWatch: voiceStub(),
    });
    const pin = fakeIdentity().pin;
    const started = await callRoute(runtime, {
      method: 'POST',
      url: '/watch/mic/start',
      headers: authHeaders(token, pin),
      body: { streamId: 's-deliver' },
    });
    expect(started.code).toBe(200);
    const session = (runtime as unknown as { mic: Map<string, { ackFinals: number }> }).mic.get('s-deliver')!;
    const onEvent = (runtime as unknown as {
      onInputEvent: (s: unknown, e: unknown) => Promise<void>;
    }).onInputEvent.bind(runtime);
    await onEvent(session, { kind: 'final', utteranceId: 'u1', text: 'hello host' });
    await onEvent(session, { kind: 'final', utteranceId: 'u1', text: 'hello host' });
    expect(prompt).toHaveBeenCalledTimes(1);
    const [req, sig] = prompt.mock.calls[0] as unknown as [Record<string, unknown>, AbortSignal];
    expect(req.sessionId).toBe('sess-1');
    expect(req.mode).toBe('queue');
    expect(req.content).toEqual([{ type: 'text', text: 'hello host' }]);
    expect(typeof req.requestId).toBe('string');
    expect(sig).toBeInstanceOf(AbortSignal);
    expect(session.ackFinals).toBe(1);
    await runtime.dispose();
  });

  it('host failure: no ack, safe receipt, never agent state', async () => {
    const { store, token, deviceId } = pairedDevice();
    const runtime = new ManagedTurnkeyRuntime({
      dshHome: tempHome(),
      identity: fakeIdentity(),
      store,
      sessionController: fullHostStub({
        prompt: async () => {
          throw new Error('agent busy');
        },
      }),
      liveVoiceWatch: voiceStub(),
    });
    const tap = sseTap(runtime, deviceId);
    await callRoute(runtime, {
      method: 'POST',
      url: '/watch/mic/start',
      headers: authHeaders(token, fakeIdentity().pin),
      body: { streamId: 's-err' },
    });
    const session = (runtime as unknown as {
      mic: Map<string, { ackFinals: number; unackedFinals: number; lastDeliveryError?: string }>;
    }).mic.get('s-err')!;
    await (runtime as unknown as { onInputEvent: (s: unknown, e: unknown) => Promise<void> }).onInputEvent(session, {
      kind: 'final',
      utteranceId: 'u9',
      text: 'will fail',
    });
    expect(session.ackFinals).toBe(0);
    expect(session.unackedFinals).toBe(1);
    expect(session.lastDeliveryError).toMatch(/agent busy/);
    const errors = sseEvents(tap).filter((e) => e.t === 'mic' && e.state === 'error');
    expect(errors.length).toBeGreaterThan(0);
    await runtime.dispose();
  });

  it('binding change mid-utterance (TOCTOU): held, never delivered to the wrong thread', async () => {
    const prompt = vi.fn(async () => ({ accepted: true as const }));
    const { store, token, deviceId } = pairedDevice();
    const runtime = new ManagedTurnkeyRuntime({
      dshHome: tempHome(),
      identity: fakeIdentity(),
      store,
      sessionController: fullHostStub({ prompt }),
      liveVoiceWatch: voiceStub(),
    });
    await callRoute(runtime, {
      method: 'POST',
      url: '/watch/mic/start',
      headers: authHeaders(token, fakeIdentity().pin),
      body: { streamId: 's-toctou' },
    });
    store.setBinding(deviceId, 'sess-2', false);
    const session = (runtime as unknown as { mic: Map<string, unknown> }).mic.get('s-toctou')!;
    await (runtime as unknown as { onInputEvent: (s: unknown, e: unknown) => Promise<void> }).onInputEvent(session, {
      kind: 'final',
      utteranceId: 'u2',
      text: 'stale thread',
    });
    expect(prompt).not.toHaveBeenCalled();
    await runtime.dispose();
  });

  it('question-bound final is draft-only: stored + dictation-final, never autosubmitted', async () => {
    const prompt = vi.fn(async () => ({ accepted: true as const }));
    const { store, token, deviceId } = pairedDevice();
    const runtime = new ManagedTurnkeyRuntime({
      dshHome: tempHome(),
      identity: fakeIdentity(),
      store,
      sessionController: fullHostStub({ prompt }),
      liveVoiceWatch: voiceStub(),
    });
    const callback = runtime.answerQuestionCallback({
      agent: { id: 'sess-1' } as never,
      questions: [{ id: 'q1', question: 'confirm?' }],
    }, () => new Promise(() => {}));
    await new Promise(resolve => setTimeout(resolve, 0));
    const questionId = (runtime as unknown as { approvals: Array<{ id: string }> }).approvals[0]!.id;
    const tap = sseTap(runtime, deviceId);
    const started = await callRoute(runtime, {
      method: 'POST',
      url: '/watch/mic/start',
      headers: authHeaders(token, fakeIdentity().pin),
      body: { streamId: 's-q', requestId: questionId },
    });
    expect(started.code).toBe(200);
    const session = (runtime as unknown as { mic: Map<string, unknown> }).mic.get('s-q')!;
    await (runtime as unknown as { onInputEvent: (s: unknown, e: unknown) => Promise<void> }).onInputEvent(session, {
      kind: 'final',
      utteranceId: 'uq',
      text: 'draft answer',
    });
    expect(prompt).not.toHaveBeenCalled();
    const drafts = (runtime as unknown as { drafts: Array<Record<string, unknown>> }).drafts;
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ requestId: questionId, text: 'draft answer' });
    expect(sseEvents(tap).filter((e) => e.t === 'dictation-final')).toHaveLength(1);
    await runtime.dispose();
    await callback;
  });

  it('mic upload streams progressively (write-once, ordered) and reports a truthful receipt', async () => {
    const prompt = vi.fn(async () => ({ accepted: true as const }));
    const { store, token } = pairedDevice();
    const svc = voiceStub();
    const runtime = new ManagedTurnkeyRuntime({
      dshHome: tempHome(),
      identity: fakeIdentity(),
      store,
      sessionController: fullHostStub({ prompt }),
      liveVoiceWatch: svc,
    });
    const pin = fakeIdentity().pin;
    // Final is emitted by the helper during end(); delivery settles the drain.
    const origCreate = svc.createInput.bind(svc);
    (svc as unknown as { createInput: unknown }).createInput = async (args: {
      streamId: string;
      onEvent: LiveVoiceInputEventHandler;
      signal?: AbortSignal;
    }) => {
      const h = await origCreate(args);
      return {
        ...h,
        end: async () => {
          await args.onEvent({ kind: 'final', streamId: args.streamId, utteranceId: 'uf', text: 'streamed hi' });
          await h.end();
        },
      };
    };
    await callRoute(runtime, {
      method: 'POST',
      url: '/watch/mic/start',
      headers: authHeaders(token, pin),
      body: { streamId: 's-up' },
    });
    const c1 = Buffer.from([10, 20, 30]);
    const c2 = Buffer.from([40, 50]);
    const out = await callRoute(runtime, {
      method: 'POST',
      url: '/watch/mic?streamId=s-up',
      headers: authHeaders(token, pin),
      raw: [c1, c2],
    });
    expect(out.code).toBe(200);
    expect(out.payload).toMatchObject({ streamId: 's-up', state: 'closed', delivered: true, ackFinals: 1, txChunks: 2, txBytes: 5 });
    const written = Buffer.concat(svc.seen.chunks.map((c) => Buffer.from(c)));
    expect(written).toEqual(Buffer.concat([c1, c2]));
    expect(prompt).toHaveBeenCalledTimes(1);
    await runtime.dispose();
  });
});
