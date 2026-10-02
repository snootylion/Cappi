/**
 * Pairing replay tombstone + mic negative/dispose + index helper tests (HS-owned).
 *
 * - Consumed one-use enrollment requests replay as 401 `approval-replay`
 *   (never 410): at the store layer, across store reloads (persisted), at the
 *   `POST /pair/poll` wire, with TTL expiry back to 410, bounded memory, and
 *   no enumeration surface. Denied stays 401 `approval-denied`; TTL-expired
 *   and unknown ids stay 410 `approval-expired`.
 * - Mic negatives: `partial` events never ack/prompt; dispose aborts the
 *   request and disposes each helper handle exactly once; a recycled
 *   streamId (new generation) never receives the old owner's finals.
 * - Index helpers: `lanHostCandidates()` (loopback-first, deduped IPv4, no
 *   placeholders) and `makeBackendSetup()` (actual `setup({consent:true})`,
 *   honest error mapping, never throws).
 */

import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  TurnkeyStore,
  newOpaqueId,
  TOMBSTONE_TTL_MS,
  MAX_TOMBSTONES,
} from '../src/pairing-store.ts';
import { ManagedTurnkeyRuntime } from '../src/managed-runtime.ts';
import { lanHostCandidates, makeBackendSetup } from '../src/index.ts';
import type { LiveVoiceWatchService } from '../src/watch-api.ts';

function tempHome(): string {
  return mkdtempSync(path.join(realpathSync(tmpdir()), 'turnkey-hs-replay-'));
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

function statusOf(fn: () => unknown): number {
  try {
    fn();
  } catch (e) {
    return (e as { status?: number }).status ?? 500;
  }
  return 200;
}

describe('pairing store: consumed replay is 401, not 410', () => {
  it('consume → replay 401 approval-replay (twice); message names replay', () => {
    const store = new TurnkeyStore(tempHome());
    const secret = newOpaqueId();
    const row = store.createPending({ deviceAlias: 'W', enrollmentSecret: secret });
    store.approve(row.requestId, true, 'watch-1');
    expect(statusOf(() => store.consumeApproved(row.requestId, secret))).toBe(200);
    expect(statusOf(() => store.consumeApproved(row.requestId, secret))).toBe(401);
    try {
      const delivered = store.consumeApproved(row.requestId, secret);
      store.revoke(delivered.deviceId);
    } catch (e) {
      expect((e as Error).message).toMatch(/approval-replay/);
    }
  });

  it('unknown ids stay 410; denied stays 401 denied; wrong secret stays 401', () => {
    const store = new TurnkeyStore(tempHome());
    expect(statusOf(() => store.consumeApproved(newOpaqueId(), newOpaqueId()))).toBe(410);
    const secret = newOpaqueId();
    const denied = store.createPending({ deviceAlias: 'W', enrollmentSecret: secret });
    store.deny(denied.requestId);
    expect(statusOf(() => store.consumeApproved(denied.requestId, secret))).toBe(401);
    const secret2 = newOpaqueId();
    const row = store.createPending({ deviceAlias: 'W', enrollmentSecret: secret2 });
    store.approve(row.requestId, true);
    expect(statusOf(() => store.consumeApproved(row.requestId, newOpaqueId()))).toBe(401);
  });

  it('TTL-expired pendings are 410 (not tombstoned)', () => {
    let now = Date.now();
    const store = new TurnkeyStore(tempHome(), () => now);
    const secret = newOpaqueId();
    const row = store.createPending({ deviceAlias: 'W', enrollmentSecret: secret });
    store.approve(row.requestId, true);
    now += 120_000 + 1;
    expect(statusOf(() => store.consumeApproved(row.requestId, secret))).toBe(410);
  });

  it('tombstones persist across reloads and expire back to 410 after TTL', () => {
    const home = tempHome();
    let now = Date.now();
    const store = new TurnkeyStore(home, () => now);
    const secret = newOpaqueId();
    const row = store.createPending({ deviceAlias: 'W', enrollmentSecret: secret });
    store.approve(row.requestId, true, 'watch-1');
    store.consumeApproved(row.requestId, secret);
    const reloaded = new TurnkeyStore(home, () => now);
    expect(statusOf(() => reloaded.consumeApproved(row.requestId, secret))).toBe(401);
    now += TOMBSTONE_TTL_MS + 1;
    const aged = new TurnkeyStore(home, () => now);
    expect(statusOf(() => aged.consumeApproved(row.requestId, secret))).toBe(410);
  });

  it('tombstone memory is bounded and never enumerated', () => {
    const store = new TurnkeyStore(tempHome());
    for (let i = 0; i < MAX_TOMBSTONES + 25; i++) {
      const secret = newOpaqueId();
      const row = store.createPending({ deviceAlias: `W${i}`, enrollmentSecret: secret });
      store.approve(row.requestId, true, `watch-${i}`);
      const delivered = store.consumeApproved(row.requestId, secret);
      store.revoke(delivered.deviceId);
    }
    const data = store as unknown as { data: { consumed: Record<string, number> } };
    expect(Object.keys(data.data.consumed).length).toBeLessThanOrEqual(MAX_TOMBSTONES);
    // No enumeration surface: public rows carry identifiers only.
    for (const pending of store.listPendingPublic()) {
      expect(pending).not.toHaveProperty('enrollmentSecret');
      expect(pending).not.toHaveProperty('secretHash');
      expect(pending).not.toHaveProperty('token');
    }
    expect(store.pendingCount()).toBe(0);
  });
});

describe('pair poll wire: replay after consumed is 401', () => {
  async function callPoll(
    runtime: ManagedTurnkeyRuntime,
    body: unknown,
  ): Promise<{ code: number; payload: unknown }> {
    const route = (runtime as unknown as { route: (req: unknown, res: unknown) => Promise<void> }).route.bind(runtime);
    return new Promise((resolve) => {
      const req = {
        method: 'POST',
        url: '/pair/poll',
        headers: { 'content-type': 'application/json' },
        socket: { remoteAddress: '127.0.0.1' },
        on: (ev: string, cb: (...a: never[]) => void): void => {
          if (ev === 'data') cb(Buffer.from(JSON.stringify(body)) as never);
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

  it('first poll 200, replay poll 401 (not 410)', async () => {
    const home = tempHome();
    const store = new TurnkeyStore(home);
    const runtime = new ManagedTurnkeyRuntime({ dshHome: tempHome(), identity: fakeIdentity(), store });
    const secret = newOpaqueId();
    const row = store.createPending({ deviceAlias: 'W', enrollmentSecret: secret });
    store.approve(row.requestId, true, 'watch-1');
    const first = await callPoll(runtime, { requestId: row.requestId, enrollmentSecret: secret });
    expect(first.code).toBe(200);
    const replay = await callPoll(runtime, { requestId: row.requestId, enrollmentSecret: secret });
    expect(replay.code).toBe(401);
    expect((replay.payload as { error?: string }).error).toMatch(/approval-replay/);
    await runtime.dispose();
  });
});

// ---- mic negatives / dispose / generation ----

function fullHostStub(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    list: async () => ({ items: [] }),
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

function pairedDevice() {
  const home = tempHome();
  const store = new TurnkeyStore(home);
  const secret = newOpaqueId();
  const pending = store.createPending({ deviceAlias: 'W', enrollmentSecret: secret });
  store.approve(pending.requestId, true, 'watch-1');
  const { token, deviceId } = store.consumeApproved(pending.requestId, secret);
  store.setBinding(deviceId, 'sess-1', false);
  return { store, token, deviceId };
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

describe('mic negatives: partials never ack; dispose/dispose-once; generation guard', () => {
  it('partial events never ack and never prompt; exactly-once final on harness accept', async () => {
    const prompt = vi.fn(async () => ({ accepted: true as const }));
    const { store, token } = pairedDevice();
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
      createInput: async () => ({ writePCM: async () => {}, end: async () => {}, dispose: async () => {} }),
      synthesize: async () => {},
    } as unknown as LiveVoiceWatchService;
    const runtime = new ManagedTurnkeyRuntime({
      dshHome: tempHome(),
      identity: fakeIdentity(),
      store,
      sessionController: fullHostStub({ prompt }),
      liveVoiceWatch: svc,
    });
    const pin = fakeIdentity().pin;
    const headers = { 'x-bridge-token': token, 'x-cert-pin': pin };
    const started = await callRoute(runtime, {
      method: 'POST',
      url: '/watch/mic/start',
      headers,
      body: { streamId: 's-part' },
    });
    expect(started.code).toBe(200);
    const session = (runtime as unknown as { mic: Map<string, { ackFinals: number }> }).mic.get('s-part')!;
    const onEvent = (runtime as unknown as { onInputEvent: (s: unknown, e: unknown) => Promise<void> }).onInputEvent.bind(runtime);
    await onEvent(session, { kind: 'partial', utteranceId: 'u1', text: 'hel' });
    await onEvent(session, { kind: 'partial', utteranceId: 'u1', text: 'hello' });
    expect(prompt).not.toHaveBeenCalled();
    expect(session.ackFinals).toBe(0);
    await onEvent(session, { kind: 'final', utteranceId: 'u1', text: 'hello host' });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(session.ackFinals).toBe(1);
    await runtime.dispose();
  });

  it('dispose aborts the request and disposes each helper exactly once', async () => {
    const { store, token } = pairedDevice();
    let disposes = 0;
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
      createInput: async () => ({
        writePCM: async () => {},
        end: async () => {},
        dispose: async () => {
          disposes++;
        },
      }),
      synthesize: async () => {},
    } as unknown as LiveVoiceWatchService;
    const runtime = new ManagedTurnkeyRuntime({
      dshHome: tempHome(),
      identity: fakeIdentity(),
      store,
      sessionController: fullHostStub(),
      liveVoiceWatch: svc,
    });
    const pin = fakeIdentity().pin;
    await callRoute(runtime, {
      method: 'POST',
      url: '/watch/mic/start',
      headers: { 'x-bridge-token': token, 'x-cert-pin': pin },
      body: { streamId: 's-dispose' },
    });
    const session = (runtime as unknown as { mic: Map<string, { abort: AbortController }> }).mic.get('s-dispose')!;
    await runtime.dispose();
    expect(session.abort.signal.aborted).toBe(true);
    expect(disposes).toBe(1);
    await runtime.dispose();
    expect(disposes).toBe(1);
  });

  it('recycled streamId never receives the old generation final (no stale prompt)', async () => {
    const prompt = vi.fn(async () => ({ accepted: true as const }));
    const { store, token } = pairedDevice();
    const closures: Array<(e: { kind: string; utteranceId?: string; text?: string }) => unknown> = [];
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
        closures.push(args.onEvent as never);
        return {
          writePCM: async () => {},
          end: async () => {
            await args.onEvent({ kind: 'final', streamId: args.streamId, utteranceId: `u-${args.streamId}`, text: 'close me' } as never);
          },
          dispose: async () => {},
        };
      },
      synthesize: async () => {},
    } as unknown as LiveVoiceWatchService;
    const runtime = new ManagedTurnkeyRuntime({
      dshHome: tempHome(),
      identity: fakeIdentity(),
      store,
      sessionController: fullHostStub({ prompt }),
      liveVoiceWatch: svc,
    });
    const pin = fakeIdentity().pin;
    const headers = { 'x-bridge-token': token, 'x-cert-pin': pin };
    await callRoute(runtime, { method: 'POST', url: '/watch/mic/start', headers, body: { streamId: 's-cycle' } });
    // EOF the first generation (end emits its final → one prompt, stream closed).
    const closed = await callRoute(runtime, { method: 'POST', url: '/watch/mic?streamId=s-cycle', headers, raw: [Buffer.from([1])] });
    expect(closed.code).toBe(200);
    expect(prompt).toHaveBeenCalledTimes(1);
    // Recycle the same stream id (new generation) and replay the OLD closure.
    await callRoute(runtime, { method: 'POST', url: '/watch/mic/start', headers, body: { streamId: 's-cycle' } });
    const stale = closures[0]!;
    await stale({ kind: 'final', utteranceId: 'u-stale', text: 'stale harness prompt' });
    expect(prompt).toHaveBeenCalledTimes(1);
    await runtime.dispose();
  });
});

describe('index helpers: candidates + backend setup', () => {
  it('lanHostCandidates is loopback-first, deduped IPv4, no placeholders', () => {
    const candidates = lanHostCandidates();
    expect(candidates[0]).toBe('127.0.0.1');
    expect(new Set(candidates).size).toBe(candidates.length);
    for (const ip of candidates) {
      expect(ip).toMatch(/^\d{1,3}(\.\d{1,3}){3}$/);
    }
    expect(candidates).not.toContain('192.0.2.1');
  });

  it('makeBackendSetup calls the actual svc.setup({consent:true}) and never throws', async () => {
    const setup = vi.fn(async () => ({
      status: 'ready' as const,
      pcm: { encoding: 'pcm16le' as const, sampleRate: 16000, channels: 1 as const },
    }));
    const svc = { setup } as unknown as LiveVoiceWatchService;
    const out = await makeBackendSetup(svc)();
    expect(setup).toHaveBeenCalledTimes(1);
    expect(setup).toHaveBeenCalledWith({ consent: true });
    expect(out).toMatchObject({ status: 'ready' });
    expect(await makeBackendSetup(undefined)()).toMatchObject({ status: 'error' });
    const failing = { setup: async () => { throw new Error('tcc denied'); } } as unknown as LiveVoiceWatchService;
    const failed = await makeBackendSetup(failing)();
    expect(failed.status).toBe('error');
    expect(failed.message).toMatch(/tcc denied/);
  });
});
