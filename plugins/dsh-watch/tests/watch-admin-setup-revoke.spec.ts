/**
 * Watch admin voice-setup + revoke route tests (AU-owned, isolated).
 *
 * Covers the two AU routes HS wires into `index.ts`:
 * - `POST /admin/voice/setup` (+ alias) — explicit `{ consent: true }` only,
 *   calls the `AdminContext.backendSetup` fixed API function (V service via
 *   HS callbacks), returns backend status/actionable messages, never tokens.
 * - `POST /admin/pair/revoke` (+ alias) — `{ deviceId }`, prefers
 *   `runtime.revokeDevice()` (HS-owned) with host-store fallback, removes
 *   the secret server-side, never emits tokens.
 *
 * No HOME/DSH_HOME/profile/bridge/network: TempHOME `TurnkeyStore`,
 * fake identity, stubbed gate (requestRejection). Timer hygiene: no
 * timers or pollers here — every `call()` resolves on `res.end`.
 */

import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAdminHandlers, type AdminContext } from '../src/admin-routes.ts';
import { TurnkeyStore, newOpaqueId } from '../src/pairing-store.ts';
import type { ManagedTurnkeyRuntime } from '../src/managed-runtime.ts';

function tempHome(): string {
  return mkdtempSync(path.join(realpathSync(tmpdir()), 'dsh-watch-admin-au-'));
}

function fakeIdentity(): { fingerprint: { full: string; short: string }; pin: string } {
  return {
    fingerprint: { full: 'AA:'.repeat(31) + 'BB', short: 'AABB-CCDD-EEFF-0011-2233-4455' },
    pin: 'AA:'.repeat(31) + 'BB',
  };
}

function setup(
  gate: () => 401 | 403 | undefined,
  overrides: Partial<AdminContext> = {},
): { store: TurnkeyStore; handlers: Record<string, (req: never, res: never) => void> } {
  const home = tempHome();
  const store = overrides.store ?? new TurnkeyStore(home);
  const identity = (overrides.identity ?? fakeIdentity()) as AdminContext['identity'];
  const runtime = (overrides.runtime ?? {
    port: 1,
    discoveryPortActual: 2,
    discoveryCollision: false,
    store,
  }) as unknown as ManagedTurnkeyRuntime;
  const handlers = createAdminHandlers(
    {
      backendStatus: async () => ({ status: 'ready' as const }),
      hostCandidates: () => ['127.0.0.1'],
      ...overrides,
      store,
      identity,
      runtime,
    },
    () => gate(),
  );
  return { store, handlers };
}

function call(
  handler: (req: never, res: never) => void,
  opts: { body?: unknown; rawText?: string; method?: string; url?: string } = {},
): Promise<{ code: number; payload: unknown }> {
  const method = opts.method ?? 'POST';
  return new Promise((resolve) => {
    const req = {
      method,
      url: opts.url ?? '/',
      headers: { 'content-type': 'application/json' },
      on: (ev: string, cb: (...a: never[]) => void): void => {
        if (ev === 'data' && opts.rawText !== undefined) cb(Buffer.from(opts.rawText) as never);
        else if (ev === 'data' && opts.body !== undefined) cb(Buffer.from(JSON.stringify(opts.body)) as never);
        if (ev === 'end') queueMicrotask(() => cb());
      },
    };
    const res = {
      writeHead: (code: number): void => {
        (res as { code?: number }).code = code;
      },
      end: (b?: string): void => {
        resolve({ code: (res as { code?: number }).code ?? 0, payload: b ? JSON.parse(b) : null });
      },
    };
    handler(req as never, res as never);
  });
}

function pairedDevice(store: TurnkeyStore, deviceId = 'watch-1'): { deviceId: string } {
  const secret = newOpaqueId();
  const pending = store.createPending({ deviceAlias: 'Daily Watch', enrollmentSecret: secret });
  store.approve(pending.requestId, true, deviceId);
  store.consumeApproved(pending.requestId, secret);
  return { deviceId };
}

describe('admin gate: voice/setup + pair/revoke honor the DSH cookie gate', () => {
  it('foreign/unauthenticated origin is rejected before the handler (401/403, no fallback)', async () => {
    const { handlers } = setup(() => 401);
    expect((await call(handlers['/admin/voice/setup'] as never, { body: { consent: true } })).code).toBe(401);
    expect((await call(handlers['/admin/pair/revoke'] as never, { body: { deviceId: 'x' } })).code).toBe(401);
    const { handlers: h2 } = setup(() => 403);
    expect((await call(h2['/admin/voice/setup'] as never, { body: { consent: true } })).code).toBe(403);
    expect((await call(h2['/admin/pair/revoke'] as never, { body: { deviceId: 'x' } })).code).toBe(403);
  });

  it('mutating routes are POST-only', async () => {
    const { handlers } = setup(() => undefined);
    expect((await call(handlers['/admin/voice/setup'] as never, { method: 'GET', body: { consent: true } })).code).toBe(405);
    expect((await call(handlers['/admin/pair/revoke'] as never, { method: 'GET', body: { deviceId: 'x' } })).code).toBe(405);
    expect((await call(handlers['/pair/deny'] as never, { method: 'GET', body: { requestId: 'x' } })).code).toBe(405);
  });

  it('secret query params are rejected (never forwarded device auth)', async () => {
    const { handlers } = setup(() => undefined);
    const out = await call(handlers['/admin/pair/revoke'] as never, { body: { deviceId: 'x' }, url: '/?token=abc' });
    expect(out.code).toBe(401);
  });
});

describe('POST /admin/voice/setup: explicit consent only', () => {
  it('calls backendSetup and returns its status/message (no tokens)', async () => {
    const home = tempHome();
    const store = new TurnkeyStore(home);
    const { handlers } = setup(() => undefined, {
      store,
      backendSetup: async () => ({ status: 'ready', message: 'Voice backend is ready for watch input.' }),
    });
    const out = await call(handlers['/admin/voice/setup'] as never, { body: { consent: true } });
    expect(out.code).toBe(200);
    expect(out.payload).toMatchObject({ ok: true, status: 'ready' });
    expect(JSON.stringify(out.payload)).not.toMatch(/tk_|token|secret/i);
    const alias = await call(handlers['/watch-bridge/admin/voice/setup'] as never, { body: { consent: true } });
    expect(alias.code).toBe(200);
  });

  it('rejects missing/false consent (never defaults true)', async () => {
    let called = 0;
    const { handlers } = setup(() => undefined, { backendSetup: async () => { called++; return { status: 'ready' }; } });
    for (const body of [{}, { consent: false }, { consent: 'true' }, { consent: 1 }]) {
      const out = await call(handlers['/admin/voice/setup'] as never, { body });
      expect(out.code).toBe(400);
      expect(String((out.payload as { error?: string }).error ?? '')).toMatch(/consent:true/);
    }
    expect(called).toBe(0);
  });

  it('rejects unknown and duplicate fields', async () => {
    const { handlers } = setup(() => undefined, { backendSetup: async () => ({ status: 'ready' }) });
    const unknown = await call(handlers['/admin/voice/setup'] as never, { body: { consent: true, mode: 'mac-input' } });
    expect(unknown.code).toBe(400);
    const dupe = await call(handlers['/admin/voice/setup'] as never, {
      rawText: '{"consent": false, "consent": true}',
    });
    expect(dupe.code).toBe(400);
  });

  it('is 503 while the backend callback is unwired, and bounded at 16KB', async () => {
    const { handlers } = setup(() => undefined);
    const out = await call(handlers['/admin/voice/setup'] as never, { body: { consent: true } });
    expect(out.code).toBe(503);
    const big = await call(handlers['/admin/voice/setup'] as never, {
      rawText: `{"consent": true, "pad": "${'x'.repeat(17 * 1024)}"}`,
    });
    expect(big.code).toBe(413);
  });
});

describe('POST /admin/pair/revoke: identifier-only revoke', () => {
  it('revokes via the host store fallback and hides secrets', async () => {
    const home = tempHome();
    const store = new TurnkeyStore(home);
    pairedDevice(store);
    const { handlers } = setup(() => undefined, { store });
    const out = await call(handlers['/admin/pair/revoke'] as never, { body: { deviceId: 'watch-1' } });
    expect(out.code).toBe(200);
    expect(out.payload).toEqual({ deviceId: 'watch-1', status: 'revoked' });
    expect(store.listDevicesPublic().find((d) => d.deviceId === 'watch-1')?.revoked).toBe(true);
    const alias = await call(handlers['/watch-bridge/admin/pair/revoke'] as never, { body: { deviceId: 'watch-1' } });
    // Second revoke of the same id is idempotent-revoked (still 200, never 500).
    expect([200, 404]).toContain(alias.code);
  });

  it('prefers runtime.revokeDevice when HS provides it', async () => {
    const home = tempHome();
    const store = new TurnkeyStore(home);
    pairedDevice(store, 'watch-9');
    let seen: string[] = [];
    const runtime = {
      port: 1,
      discoveryPortActual: 2,
      discoveryCollision: false,
      store,
      revokeDevice: (id: string) => { seen.push(id); return store.revoke(id); },
    } as unknown as ManagedTurnkeyRuntime;
    const { handlers } = setup(() => undefined, { store, runtime });
    const out = await call(handlers['/admin/pair/revoke'] as never, { body: { deviceId: 'watch-9' } });
    expect(out.code).toBe(200);
    expect(seen).toEqual(['watch-9']);
  });

  it('requires deviceId, rejects secrets/unknown/duplicate fields, 404s unknown devices', async () => {
    const { handlers } = setup(() => undefined);
    expect((await call(handlers['/admin/pair/revoke'] as never, { body: {} })).code).toBe(400);
    expect((await call(handlers['/admin/pair/revoke'] as never, { body: { deviceId: '' } })).code).toBe(400);
    expect((await call(handlers['/admin/pair/revoke'] as never, { body: { deviceId: 'x', token: 'tk_a' } })).code).toBe(400);
    expect((await call(handlers['/admin/pair/revoke'] as never, {
      rawText: '{"deviceId": "a", "deviceId": "b"}',
    })).code).toBe(400);
    expect((await call(handlers['/admin/pair/revoke'] as never, { body: { deviceId: 'no-such-device' } })).code).toBe(404);
  });
});
