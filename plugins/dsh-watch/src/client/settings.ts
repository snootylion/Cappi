/**
 * Mac Settings client hooks (H-owned web client).
 *
 * Registered via `dsh.client` (`platform: web`) with the real SDK provider
 * hooks — no standalone-port local admin web, no gate bypass. The Settings
 * panel shows:
 * - certificate compare confirmation (FULL fingerprint + 96-bit short),
 * - pending Approve/Reject (calls the §1.6(a)-gated admin routes with the
 *   browser session — the LAN device surface is never used here),
 * - per-device revocation state + per-device revoke (gated confirm in the
 *   panel; the secret is removed server-side, the client never holds it),
 * - backend readiness + explicit Setup consent (the panel calls the real
 *   `POST /admin/voice/setup` with `{ consent: true }` ONLY after the user
 *   ticks the Speech consent checkbox — never on boot, never by re-check).
 *
 * Transport rules (client side of the §1.6(a) gate):
 * - same DSH origin only (relative URLs — never a LAN host/IP literal);
 * - `credentials: 'same-origin'` so the browser session rides the request
 *   and `ctx.connection.requestRejection` can authenticate it server-side;
 * - no token/secret is ever sent or displayed here (identifier-only rows);
 * - no silent auth fallback: 401/403 surfaces as an error, never retried
 *   with different credentials.
 *
 * This module is UI-framework-agnostic (fetch + callbacks) so the pure
 * helpers unit-test without a React runtime; `settings.tsx` binds it to the
 * `settings.section` slot. Client entry: `src/client/index.tsx`.
 */

export interface PairStatus {
  fingerprint: { full: string; short: string };
  hostCandidates: string[];
  port: number;
  backendStatus: string;
  backendMessage?: string;
  pending: Array<{
    requestId: string;
    deviceAlias: string;
    deviceKind: string;
    enrolledAtMs: number;
    expiresAtMs: number;
    attemptsLeft: number;
  }>;
  devices: Array<{ deviceId: string; deviceAlias: string; deviceKind: string; revoked: boolean }>;
}

/** Exact DSH-admin paths served by `src/admin-routes.ts` (never invented). */
export const PAIR_STATUS_PATH = '/admin/pair/status';
export const PAIR_APPROVAL_PATH = '/admin/pair/approval';
export const PAIR_DENY_PATH = '/pair/deny';
export const VOICE_SETUP_PATH = '/admin/voice/setup';
export const PAIR_REVOKE_PATH = '/admin/pair/revoke';

export type FetchImpl = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; credentials?: RequestCredentials; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

const SAME_ORIGIN: RequestCredentials = 'same-origin';

async function readError(res: { status: number; json: () => Promise<unknown> }, fallback: string): Promise<Error> {
  try {
    const body = (await res.json()) as { error?: unknown };
    const detail = typeof body.error === 'string' && body.error ? `: ${body.error}` : '';
    return new Error(`${fallback} ${res.status}${detail}`);
  } catch {
    return new Error(`${fallback} ${res.status}`);
  }
}

export async function fetchPairStatus(
  fetchImpl: FetchImpl = fetch as unknown as FetchImpl,
  signal?: AbortSignal,
): Promise<PairStatus> {
  const res = await fetchImpl(PAIR_STATUS_PATH, {
    headers: { accept: 'application/json' },
    credentials: SAME_ORIGIN,
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw await readError(res, 'pair status');
  return (await res.json()) as PairStatus;
}

export async function approvePair(
  requestId: string,
  approve: boolean,
  fingerprintConfirmed: true,
  fetchImpl: FetchImpl = fetch as unknown as FetchImpl,
  signal?: AbortSignal,
): Promise<{ requestId: string; status: string }> {
  const res = await fetchImpl(PAIR_APPROVAL_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    credentials: SAME_ORIGIN,
    body: JSON.stringify({ requestId, approve, fingerprintConfirmed }),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw await readError(res, 'approval');
  return (await res.json()) as { requestId: string; status: string };
}

export async function denyPair(
  requestId: string,
  fetchImpl: FetchImpl = fetch as unknown as FetchImpl,
  signal?: AbortSignal,
): Promise<{ requestId: string; status: string }> {
  const res = await fetchImpl(PAIR_DENY_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    credentials: SAME_ORIGIN,
    body: JSON.stringify({ requestId }),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw await readError(res, 'deny');
  return (await res.json()) as { requestId: string; status: string };
}

/**
 * Explicit user-gated voice setup. `consent` is typed `true` — callers can
 * only pass the literal `true` after the user ticked the Speech consent
 * checkbox. Never called on boot or from a status re-check.
 */
export async function setupVoiceBackend(
  consent: true,
  fetchImpl: FetchImpl = fetch as unknown as FetchImpl,
  signal?: AbortSignal,
): Promise<{ status: string; message?: string }> {
  const res = await fetchImpl(VOICE_SETUP_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    credentials: SAME_ORIGIN,
    body: JSON.stringify({ consent }),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw await readError(res, 'voice setup');
  return (await res.json()) as { status: string; message?: string };
}

/** Revoke one paired device (identifier only — never secrets/tokens). */
export async function revokePairedDevice(
  deviceId: string,
  fetchImpl: FetchImpl = fetch as unknown as FetchImpl,
  signal?: AbortSignal,
): Promise<{ deviceId: string; status: string }> {
  const res = await fetchImpl(PAIR_REVOKE_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    credentials: SAME_ORIGIN,
    body: JSON.stringify({ deviceId }),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw await readError(res, 'revoke');
  return (await res.json()) as { deviceId: string; status: string };
}

/** Settings copy: the server cannot prove the client's pin — the WATCH must compare. */
export const PAIRING_COPY = Object.freeze({
  compareTitle: 'Compare the fingerprint on BOTH screens before approving',
  compareBody:
    'On the watch pairing wizard, read the SHA-256 fingerprint derived from the ACTUAL TLS handshake certificate. ' +
    'Compare it with the fingerprint below (full value one tap away; short form is 96-bit / 6 groups of 4 hex — never a 6-digit code). ' +
    'Approve ONLY on match, on BOTH the watch Confirm pill and here with fingerprintConfirmed. ' +
    'The server cannot prove the watch pinned the right cert — your comparison is the authentication.',
});
