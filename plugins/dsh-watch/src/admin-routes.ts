/**
 * DSH-admin pairing + voice-setup routes (AU-owned, same DSH origin).
 *
 * All routes here are Mac trusted Settings UI surface: they MUST call
 * `ctx.connection.requestRejection({ headers })` first and honor 401/403
 * (§1.6(a)). Host/Origin checks alone are insufficient; browser-IP is not
 * authentication. These routes NEVER accept device tokens/secrets and return
 * identifier-only rows (no tokens/session secrets in UI responses).
 *
 * - `GET /admin/pair/status` (+ alias `/watch-bridge/admin/pair/status`)
 * - `POST /admin/pair/approval` (+ alias) — requires fingerprintConfirmed:true
 * - `POST /pair/deny` (+ alias) — DSH-admin only, no secret in body,
 *   no fingerprint proof needed (identifier-only deny)
 * - `POST /admin/voice/setup` (+ alias) — explicit user consent ONLY:
 *   body MUST be exactly `{ consent: true }`. Calls `ctx.backendSetup()`
 *   (HS-wired to `liveVoiceWatch.setup({ consent: true })` in `index.ts`).
 *   Never defaults consent to true; never spawns helpers on boot.
 * - `POST /admin/pair/revoke` (+ alias) — body `{ deviceId }`. Revokes via
 *   `runtime.revokeDevice(deviceId)` when HS provides it, else the
 *   host-store `store.revoke(deviceId)` fallback. Removes the secret
 *   server-side; the client never holds tokens.
 *
 * Transport hardening on every mutating route: POST-only, bounded JSON
 * body (<=16KB), duplicate top-level fields rejected, unknown fields
 * rejected. The DSH cookie gate (`requestRejection`, verified incl. foreign
 * origin before the handler body runs) is the CSRF/auth boundary — no
 * forwarded device auth, no secret query params.
 */

import { readJsonBody } from './json-body.ts';
import type { TurnkeyStore } from './pairing-store.ts';
import type { TlsIdentity } from './cert.ts';
import type { ManagedTurnkeyRuntime } from './managed-runtime.ts';

export interface AdminContext {
  store: TurnkeyStore;
  identity: TlsIdentity;
  runtime: ManagedTurnkeyRuntime;
  backendStatus: () => Promise<{ status: string; message?: string | undefined }>;
  /**
   * HS-wired voice setup entry (owns the `index.ts` callback):
   * calls the V `liveVoiceWatch.setup({ consent: true })` service and
   * resolves the backend status with actionable permission messages.
   * Optional so pre-existing HS test fixtures (which do not wire V)
   * keep compiling; the route answers 503 while it is absent.
   */
  backendSetup?: () => Promise<{ status: string; message?: string | undefined }>;
  hostCandidates: () => string[];
}

export type RequestRejection = (req: { headers: Record<string, string | string[] | undefined> }) => 401 | 403 | undefined;

/** Bounded body cap: 16KB (rejects oversized admin bodies with 413). */
export const ADMIN_BODY_LIMIT_BYTES = 16 * 1024;

interface RawBody {
  text: string;
  value: unknown;
}

function readJsonBodyBounded(req: { on: (ev: string, cb: (...a: never[]) => void) => void }): Promise<RawBody> {
  return readJsonBody(req as never, ADMIN_BODY_LIMIT_BYTES).then(value => ({ text: JSON.stringify(value), value }));
}

/** Top-level duplicate JSON keys (JSON.parse keeps the last — fail closed). */
function duplicateTopLevelKeys(text: string): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  const re = /"((?:[^"\\]|\\.)*)"\s*:/g;
  let m: RegExpExecArray | null;
  let depth = 0;
  // Track only depth-1 keys: crude brace walk to the match offset.
  // Simpler + safe: count braces before each match (strings already
  // consumed by the key regex, so braces inside strings are skipped
  // because the regex only matches quoted keys followed by a colon).
  const stripped = text;
  while ((m = re.exec(stripped)) !== null) {
    const before = stripped.slice(0, m.index);
    let d = 0;
    let inStr = false;
    let esc = false;
    for (let i = 0; i < before.length; i++) {
      const ch = before[i]!;
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') {
        inStr = true;
      } else if (ch === '{') {
        d++;
      } else if (ch === '}') {
        d = Math.max(0, d - 1);
      }
    }
    depth = d;
    if (depth !== 1) continue;
    const key = m[1]!;
    if (seen.has(key)) dupes.add(key);
    else seen.add(key);
  }
  return [...dupes];
}

function send(res: { writeHead: (c: number, h: Record<string, string>) => void; end: (b?: string) => void }, code: number, obj: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

type Req = {
  headers: Record<string, string | string[] | undefined>;
  on: (ev: string, cb: (...a: never[]) => void) => void;
  method?: string;
  url?: string;
};
type Res = { writeHead: (c: number, h: Record<string, string>) => void; end: (b?: string) => void };

export function createAdminHandlers(ctx: AdminContext, requestRejection: RequestRejection): Record<string, (req: never, res: never) => void> {
  const gate = (req: Req, res: Res): boolean => {
    const rejection = requestRejection({ headers: req.headers });
    if (rejection === 401 || rejection === 403) {
      send(res, rejection, { ok: false, error: rejection === 401 ? 'unauthorized' : 'forbidden' });
      return false;
    }
    return true;
  };

  const rejectSecretQuery = (req: Req, res: Res): boolean => {
    const q = String(req.url ?? '');
    if (/[?&](token|secret|enrollmentSecret)=/i.test(q)) {
      send(res, 401, { ok: false, error: 'secret in URL is rejected; send identifiers in the POST body' });
      return false;
    }
    return true;
  };

  const status = (_req: never, res: never): void => {
    const r = _req as unknown as Req;
    const w = res as unknown as Res;
    if (!gate(r, w)) return;
    if ((r.method ?? 'GET') !== 'GET') {
      send(w, 405, { ok: false, error: 'method not allowed' });
      return;
    }
    void ctx.backendStatus().then((backend) => {
      send(w, 200, {
        fingerprint: ctx.identity.fingerprint,
        hostCandidates: ctx.hostCandidates(),
        port: ctx.runtime.port,
        discoveryPort: ctx.runtime.discoveryPortActual,
        discoveryCollision: ctx.runtime.discoveryCollision,
        backendStatus: backend.status,
        ...(backend.message ? { backendMessage: backend.message } : {}),
        pending: ctx.store.listPendingPublic(),
        devices: ctx.store.listDevicesPublic(),
      });
    }).catch((e: unknown) => send(w, 500, { ok: false, error: (e as Error).message ?? 'status failed' }));
  };

  const approval = (req: never, res: never): void => {
    const r = req as unknown as Req;
    const w = res as unknown as Res;
    if (!gate(r, w)) return;
    if (!rejectSecretQuery(r, w)) return;
    if ((r.method ?? 'POST') !== 'POST') {
      send(w, 405, { ok: false, error: 'method not allowed' });
      return;
    }
    void readJsonBodyBounded(r).then((raw) => {
      const dupes = duplicateTopLevelKeys(raw.text);
      if (dupes.length > 0) {
        send(w, 400, { ok: false, error: `duplicate field: ${dupes[0]}` });
        return;
      }
      const b = raw.value as Record<string, unknown>;
      const allowed = new Set(['requestId', 'approve', 'fingerprintConfirmed', 'deviceId']);
      for (const key of Object.keys(b)) {
        if (!allowed.has(key)) {
          send(w, 400, { ok: false, error: `unknown field: ${key}` });
          return;
        }
      }
      if (typeof b.requestId !== 'string' || !b.requestId) {
        send(w, 400, { ok: false, error: 'requestId required' });
        return;
      }
      if (b.fingerprintConfirmed !== true) {
        send(w, 400, { ok: false, error: 'fingerprintConfirmed:true required (Mac-side compare proof)' });
        return;
      }
      try {
        const row = ctx.store.approve(b.requestId, b.approve === true, typeof b.deviceId === 'string' ? b.deviceId : undefined);
        send(w, 200, { requestId: row.requestId, status: row.approved ? 'approved' : 'denied' });
      } catch (e) {
        send(w, (e as { status?: number }).status ?? 500, { ok: false, error: (e as Error).message });
      }
    }).catch((e: unknown) => send(w, (e as { status?: number }).status ?? 400, { ok: false, error: (e as Error).message }));
  };

  const deny = (req: never, res: never): void => {
    const r = req as unknown as Req;
    const w = res as unknown as Res;
    if (!gate(r, w)) return;
    if (!rejectSecretQuery(r, w)) return;
    if ((r.method ?? 'POST') !== 'POST') {
      send(w, 405, { ok: false, error: 'method not allowed' });
      return;
    }
    void readJsonBodyBounded(r).then((raw) => {
      const dupes = duplicateTopLevelKeys(raw.text);
      if (dupes.length > 0) {
        send(w, 400, { ok: false, error: `duplicate field: ${dupes[0]}` });
        return;
      }
      const b = raw.value as Record<string, unknown>;
      const allowed = new Set(['requestId']);
      for (const key of Object.keys(b)) {
        if (!allowed.has(key)) {
          send(w, 400, { ok: false, error: `unknown field: ${key}` });
          return;
        }
      }
      if (b.enrollmentSecret !== undefined || (b as { token?: unknown }).token !== undefined || (b as { secret?: unknown }).secret !== undefined) {
        send(w, 400, { ok: false, error: 'never send secrets to the admin deny route' });
        return;
      }
      if (typeof b.requestId !== 'string' || !b.requestId) {
        send(w, 400, { ok: false, error: 'requestId required' });
        return;
      }
      try {
        const row = ctx.store.deny(b.requestId);
        send(w, 200, { requestId: row.requestId, status: 'denied' });
      } catch (e) {
        send(w, (e as { status?: number }).status ?? 500, { ok: false, error: (e as Error).message });
      }
    }).catch((e: unknown) => send(w, (e as { status?: number }).status ?? 400, { ok: false, error: (e as Error).message }));
  };

  /**
   * Authenticated voice setup: the ONLY UI path that may start ASR consent.
   * Requires the explicit user body `{ consent: true }` — consent is never
   * defaulted, and `status()` alone never starts capture. Returns the
   * backend status with actionable permission messages; never emits tokens.
   */
  const voiceSetup = (req: never, res: never): void => {
    const r = req as unknown as Req;
    const w = res as unknown as Res;
    if (!gate(r, w)) return;
    if (!rejectSecretQuery(r, w)) return;
    if ((r.method ?? 'POST') !== 'POST') {
      send(w, 405, { ok: false, error: 'method not allowed' });
      return;
    }
    void readJsonBodyBounded(r).then((raw) => {
      const dupes = duplicateTopLevelKeys(raw.text);
      if (dupes.length > 0) {
        send(w, 400, { ok: false, error: `duplicate field: ${dupes[0]}` });
        return;
      }
      const b = raw.value as Record<string, unknown>;
      for (const key of Object.keys(b)) {
        if (key !== 'consent') {
          send(w, 400, { ok: false, error: `unknown field: ${key}` });
          return;
        }
      }
      // Explicit consent only: no default-true, no truthy coercion.
      if (b.consent !== true) {
        send(w, 400, { ok: false, error: 'consent:true required (explicit user consent)' });
        return;
      }
      if (!ctx.backendSetup) {
        send(w, 503, { ok: false, error: 'voice backend not installed', status: 'error' });
        return;
      }
      void ctx.backendSetup().then((backend) => {
        send(w, 200, {
          ok: true,
          status: backend.status,
          ...(backend.message ? { message: backend.message } : {}),
        });
      }).catch((e: unknown) => send(w, 500, { ok: false, error: (e as Error).message ?? 'voice setup failed', status: 'error' }));
    }).catch((e: unknown) => send(w, (e as { status?: number }).status ?? 400, { ok: false, error: (e as Error).message }));
  };

  /**
   * Authenticated device revoke: removes the per-device secret server-side.
   * Prefers the HS-owned `runtime.revokeDevice(deviceId)` (closes live mic
   * sessions + SSE), falling back to the host-store `store.revoke()`.
   * Identifier-only; never accepts or emits tokens/secrets.
   */
  const revoke = (req: never, res: never): void => {
    const r = req as unknown as Req;
    const w = res as unknown as Res;
    if (!gate(r, w)) return;
    if (!rejectSecretQuery(r, w)) return;
    if ((r.method ?? 'POST') !== 'POST') {
      send(w, 405, { ok: false, error: 'method not allowed' });
      return;
    }
    void readJsonBodyBounded(r).then((raw) => {
      const dupes = duplicateTopLevelKeys(raw.text);
      if (dupes.length > 0) {
        send(w, 400, { ok: false, error: `duplicate field: ${dupes[0]}` });
        return;
      }
      const b = raw.value as Record<string, unknown>;
      for (const key of Object.keys(b)) {
        if (key !== 'deviceId') {
          send(w, 400, { ok: false, error: `unknown field: ${key}` });
          return;
        }
      }
      if (typeof b.deviceId !== 'string' || !b.deviceId) {
        send(w, 400, { ok: false, error: 'deviceId required' });
        return;
      }
      try {
        const rt = ctx.runtime as unknown as { revokeDevice?: (id: string) => boolean | Promise<boolean> };
        if (typeof rt.revokeDevice === 'function') {
          void Promise.resolve(rt.revokeDevice(b.deviceId)).then((ok) => {
            if (!ok) {
              send(w, 404, { ok: false, error: 'unknown device' });
              return;
            }
            send(w, 200, { deviceId: b.deviceId, status: 'revoked' });
          }).catch((e: unknown) => send(w, 500, { ok: false, error: (e as Error).message ?? 'revoke failed' }));
          return;
        }
        const ok = ctx.store.revoke(b.deviceId);
        if (!ok) {
          send(w, 404, { ok: false, error: 'unknown device' });
          return;
        }
        send(w, 200, { deviceId: b.deviceId, status: 'revoked' });
      } catch (e) {
        send(w, (e as { status?: number }).status ?? 500, { ok: false, error: (e as Error).message });
      }
    }).catch((e: unknown) => send(w, (e as { status?: number }).status ?? 400, { ok: false, error: (e as Error).message }));
  };

  return {
    '/admin/pair/status': status,
    '/watch-bridge/admin/pair/status': status,
    '/admin/pair/approval': approval,
    '/watch-bridge/admin/pair/approval': approval,
    '/pair/deny': deny,
    '/watch-bridge/pair/deny': deny,
    '/admin/voice/setup': voiceSetup,
    '/watch-bridge/admin/voice/setup': voiceSetup,
    '/admin/pair/revoke': revoke,
    '/watch-bridge/admin/pair/revoke': revoke,
  };
}
