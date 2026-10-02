/**
 * Turnkey pairing + token + binding store (H-owned, in-process).
 *
 * Frozen wire (§8): JSON only, no URL secrets (`?token=`/`?secret=` → 401).
 * `requestId`/`enrollmentSecret`/`token` are SENSITIVE: never logged (audit
 * log keeps ≤8-char nonce prefix + result + ip only). Pending TTL max 120s.
 * One-use token: single `poll` approval delivery per `requestId`, consumed
 * atomically. Only one active watch per profile; replacement requires explicit revoke.
 *
 * Persistence: `<DSH_HOME>/dsh-watch/turnkey/store.json` (0600, dir 0700),
 * survives profile reload. A fresh repo ships NO personal config.
 *
 * Security notes (documented, not asserted falsely):
 * - The server CANNOT prove the client's pin: pinning is verified by the
 *   WATCH (client) against the TLS handshake cert. The server only asserts
 *   its cert bytes via `GET /pair/info` (BIND assertion: handshake-derived
 *   pin MUST equal response `certSha256Pin` or fail `trust-mismatch`).
 *   Client responsibility to compare + confirm is documented in the wizard
 *   and settings copy — the server never claims a "pinned client channel".
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { privateDirectory, readPrivateFile, writePrivateFile } from './private-files.ts';
import path from 'node:path';
import { parseStrictObject } from './json-body.ts';
import { turnkeyDir } from './cert.ts';

export const PAIR_TTL_MS = 120_000;
export const MAX_PENDING = 32;
export const MAX_ATTEMPTS = 5;
/**
 * Consumed-request tombstones: after one `200` delivery the `requestId` is
 * consumed and its pending row is deleted — but a later replay of the same
 * `requestId` MUST answer 401 `approval-replay` (one-use contract §8.1), NOT
 * 410 `approval-expired` (which means TTL-expiry/unknown). Tombstones are
 * identifier-only (requestId → consumedAtMs), persisted with the store,
 * bounded in count, TTL-pruned, and NEVER enumerated (no list surface).
 */
export const TOMBSTONE_TTL_MS = 10 * 60_000;
export const MAX_TOMBSTONES = 128;

const ID_RE = /^[A-Za-z0-9_-]{22,128}$/;

export interface PendingRow {
  requestId: string;
  deviceAlias: string;
  deviceKind: string;
  deviceId?: string | undefined;
  secretHash: string;
  enrolledAtMs: number;
  expiresAtMs: number;
  attemptsLeft: number;
  noncePrefix?: string | undefined;
  approved: boolean;
  denied: boolean;
  consumed: boolean;
}

export interface DeviceRow {
  deviceId: string;
  deviceAlias: string;
  deviceKind: string;
  tokenHash: string;
  issuedAtMs: number;
  revoked: boolean;
}

export interface BindingRow {
  deviceId: string;
  watchedSessionId: string;
  autoFollow: boolean;
  updatedAtMs: number;
}

interface StoreFile {
  pending: Record<string, PendingRow>;
  devices: Record<string, DeviceRow>;
  /** Token bytes live ONLY here + on the device; never logged. */
  tokens: Record<string, string>;
  bindings: Record<string, BindingRow>;
  /** Consumed one-use requestIds (replay → 401); identifier-only, TTL-pruned. */
  consumed: Record<string, number>;
}

function emptyStore(): StoreFile {
  return { pending: {}, devices: {}, tokens: {}, bindings: {}, consumed: {} };
}

export function storePath(dshHome: string): string {
  return path.join(turnkeyDir(dshHome), 'store.json');
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(String(secret), 'utf8').digest('hex');
}

export function secretMatches(presented: string, expectedHashHex: string): boolean {
  try {
    const a = Buffer.from(hashSecret(presented), 'hex');
    const b = Buffer.from(expectedHashHex, 'hex');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function newOpaqueId(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

export function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value);
}

/**
 * Detect the watch kind for display. Only known Samsung Galaxy Watch4
 * model/manufacturer pairs select "Galaxy Watch4" (SM-R86x / SM-R87x /
 * Watch4); everything else is generic Wear OS. Never "poc".
 */
export function detectWatchKind(input: { deviceAlias?: string | undefined; deviceKind?: string | undefined; model?: string | undefined } = {}): string {
  const hay = `${input.deviceKind ?? ''} ${input.model ?? ''} ${input.deviceAlias ?? ''}`;
  const isSamsung = /samsung|galaxy/i.test(hay);
  const isWatch4 =
    /SM-R86\d/i.test(hay) || /SM-R87\d/i.test(hay) || /watch\s*4/i.test(hay);
  if (isSamsung && isWatch4) return 'Galaxy Watch4';
  return 'Wear OS';
}

export class TurnkeyStore {
  private file: string;
  private data: StoreFile;
  private now: () => number;
  private committed: string;

  constructor(dshHome: string, now: () => number = Date.now) {
    this.file = storePath(dshHome);
    this.now = now;
    this.data = this.load(dshHome);
    this.committed = JSON.stringify(this.data);
    if (Object.values(this.data.devices).filter(d => !d.revoked).length > 1) {
      throw new Error("Only one active watch per profile is supported; revoke older devices before restarting");
    }
  }

  private load(dshHome: string): StoreFile {
    const dir = turnkeyDir(dshHome);
    privateDirectory(path.dirname(dir));
    privateDirectory(dir);
    const text = readPrivateFile(this.file);
    if (text === undefined) return emptyStore();
    try {
      const parsed = parseStrictObject(text) as Partial<StoreFile>;
      for (const key of ['pending', 'devices', 'tokens', 'bindings'] as const) {
        if (!parsed[key] || typeof parsed[key] !== 'object' || Array.isArray(parsed[key])) throw new Error('invalid store shape');
      }
      const result = { ...parsed, consumed: parsed.consumed ?? {} } as StoreFile;
      for (const [id, d] of Object.entries(result.devices)) {
        if (!d || d.deviceId !== id || typeof d.revoked !== 'boolean' || !/^[a-f0-9]{64}$/.test(d.tokenHash)) throw new Error('invalid device record');
      }
      const record = (v: unknown): boolean => !!v && typeof v === 'object' && !Array.isArray(v);
      if (!record(result.consumed)) throw new Error('invalid consumed records');
      for (const [id, row] of Object.entries(result.pending)) {
        if (!record(row) || row.requestId !== id || !isOpaqueId(id) || !/^[a-f0-9]{64}$/.test(row.secretHash) ||
            !Number.isFinite(row.expiresAtMs) || !Number.isFinite(row.enrolledAtMs) || !Number.isInteger(row.attemptsLeft) || row.attemptsLeft < 0 || row.attemptsLeft > MAX_ATTEMPTS ||
            typeof row.approved !== 'boolean' || typeof row.denied !== 'boolean' || typeof row.consumed !== 'boolean') throw new Error('invalid pending record');
      }
      for (const [id, token] of Object.entries(result.tokens)) {
        if (typeof token !== 'string' || !result.devices[id] || !secretMatches(token, result.devices[id].tokenHash)) throw new Error('invalid private token record');
      }
      for (const [id, b] of Object.entries(result.bindings)) {
        if (!record(b) || b.deviceId !== id || typeof b.watchedSessionId !== 'string' || typeof b.autoFollow !== 'boolean' || !Number.isFinite(b.updatedAtMs)) throw new Error('invalid binding record');
      }
      for (const [id, at] of Object.entries(result.consumed)) if (!isOpaqueId(id) || !Number.isFinite(at)) throw new Error('invalid replay tombstone');
      return result;
    } catch {
      throw new Error('Turnkey store is corrupt; restore a valid private store backup or explicitly reset pairing in this profile (authentication was NOT reset)');
    }
  }

  /** Roll back to the last COMMITTED state, not the already-mutated state. */
  private save(): void {
    const next = JSON.stringify(this.data);
    try {
      writePrivateFile(this.file, next + '\n');
      this.committed = next;
    } catch (error) {
      this.data = JSON.parse(this.committed) as StoreFile;
      throw error;
    }
  }

  private assertCapacity(requestId: string): void {
    const now = this.now();
    if (Object.values(this.data.devices).some(d => !d.revoked) ||
        Object.values(this.data.pending).some(p => p.requestId !== requestId && p.approved && !p.denied && !p.consumed && p.expiresAtMs > now)) {
      throw Object.assign(new Error('one active watch per profile; revoke the prior watch or deny its reservation first'), { status: 409 });
    }
  }

  pruneExpired(): number {
    const now = this.now();
    let removed = 0;
    for (const [id, row] of Object.entries(this.data.pending)) {
      if (row.expiresAtMs <= now || row.consumed) {
        delete this.data.pending[id];
        removed++;
      }
    }
    // Tombstone TTL + bound (identifier-only; never enumerated anywhere).
    let tombPruned = false;
    for (const [id, atMs] of Object.entries(this.data.consumed)) {
      if (typeof atMs !== 'number' || atMs + TOMBSTONE_TTL_MS <= now) {
        delete this.data.consumed[id];
        tombPruned = true;
      }
    }
    if (tombPruned) {
      while (Object.keys(this.data.consumed).length > MAX_TOMBSTONES) {
        const oldest = Object.entries(this.data.consumed).sort((a, b) => a[1] - b[1])[0]?.[0];
        if (!oldest) break;
        delete this.data.consumed[oldest];
      }
    }
    if (removed || tombPruned) this.save();
    return removed;
  }

  pendingCount(): number {
    return Object.keys(this.data.pending).length;
  }

  createPending(args: { deviceAlias: string; enrollmentSecret: string; deviceKind?: string | undefined; model?: string | undefined; noncePrefix?: string | undefined }): PendingRow {
    this.pruneExpired();
    if (Object.keys(this.data.pending).length >= MAX_PENDING) {
      throw Object.assign(new Error('too many pending requests'), { status: 429 });
    }
    const requestId = newOpaqueId();
    const now = this.now();
    const row: PendingRow = {
      requestId,
      deviceAlias: args.deviceAlias,
      deviceKind: detectWatchKind({ deviceAlias: args.deviceAlias, deviceKind: args.deviceKind, model: args.model }),
      secretHash: hashSecret(args.enrollmentSecret),
      enrolledAtMs: now,
      expiresAtMs: now + PAIR_TTL_MS,
      attemptsLeft: MAX_ATTEMPTS,
      ...(args.noncePrefix ? { noncePrefix: args.noncePrefix.slice(0, 8) } : {}),
      approved: false,
      denied: false,
      consumed: false,
    };
    this.data.pending[requestId] = row;
    this.save();
    return row;
  }

  getPending(requestId: string): PendingRow | undefined {
    const row = this.data.pending[requestId];
    if (!row) return undefined;
    if (row.expiresAtMs <= this.now()) {
      delete this.data.pending[requestId];
      this.save();
      return undefined;
    }
    return row;
  }

  /** Identifier-only rows for the trusted Mac UI (never secrets). */
  listPendingPublic(): Array<{ requestId: string; deviceAlias: string; deviceKind: string; deviceId?: string; enrolledAtMs: number; expiresAtMs: number; attemptsLeft: number; noncePrefix?: string }> {
    this.pruneExpired();
    return Object.values(this.data.pending).map((r) => ({
      requestId: r.requestId,
      deviceAlias: r.deviceAlias,
      deviceKind: r.deviceKind,
      ...(r.deviceId ? { deviceId: r.deviceId } : {}),
      enrolledAtMs: r.enrolledAtMs,
      expiresAtMs: r.expiresAtMs,
      attemptsLeft: r.attemptsLeft,
      ...(r.noncePrefix ? { noncePrefix: r.noncePrefix } : {}),
    }));
  }

  approve(requestId: string, approve: boolean, deviceIdHint?: string): PendingRow {
    const row = this.getPending(requestId);
    if (deviceIdHint && (!/^[A-Za-z0-9_-]{1,128}$/.test(deviceIdHint) || ['__proto__', 'constructor', 'prototype'].includes(deviceIdHint))) throw Object.assign(new Error('invalid device id'), { status: 400 });
    if (!row) throw Object.assign(new Error('unknown or expired request'), { status: 404 });
    if (approve) {
      this.assertCapacity(requestId);
      row.approved = true;
      row.denied = false;
      if (deviceIdHint && !row.deviceId) row.deviceId = deviceIdHint;
    } else {
      row.denied = true;
      row.approved = false;
    }
    this.save();
    return row;
  }

  deny(requestId: string): PendingRow {
    return this.approve(requestId, false);
  }

  decrementAttempts(requestId: string): PendingRow | undefined {
    const row = this.data.pending[requestId];
    if (!row) return undefined;
    row.attemptsLeft = Math.max(0, row.attemptsLeft - 1);
    this.save();
    return row;
  }

  /**
   * One-use approval delivery. Verifies the secret constant-time, then mints
   * the per-device token ATOMICALLY (single-use rollback: on persist failure
   * the request is NOT consumed). Returns the token bytes (caller delivers
   * over pinned TLS only, never logs).
   *
   * Replay contract (§8.1): after one `200` the `requestId` is consumed and a
   * bounded tombstone (TTL) answers later replays with 401 `approval-replay`
   * — never 410. Unknown/never-issued and TTL-expired ids stay 410
   * `approval-expired`; denied/wrong-secret stay 401 with their own errors.
   * Tombstones are identifier-only and never listed (no enumeration leak).
   */
  consumeApproved(requestId: string, enrollmentSecret: string): { deviceId: string; token: string } {
    const row = this.getPending(requestId);
    if (!row) {
      const tomb = this.data.consumed[requestId];
      if (typeof tomb === 'number' && tomb + TOMBSTONE_TTL_MS > this.now()) {
        throw Object.assign(new Error('approval-replay'), { status: 401 });
      }
      if (typeof tomb === 'number') delete this.data.consumed[requestId];
      throw Object.assign(new Error('approval-expired'), { status: 410 });
    }
    if (row.consumed) throw Object.assign(new Error('approval-replay'), { status: 401 });
    if (row.denied) throw Object.assign(new Error('approval-denied'), { status: 401 });
    if (row.attemptsLeft <= 0) throw Object.assign(new Error('rate-limited'), { status: 429 });
    if (!secretMatches(enrollmentSecret, row.secretHash)) {
      this.decrementAttempts(requestId);
      throw Object.assign(new Error('approval-replay'), { status: 401 });
    }
    if (!row.approved) {
      throw Object.assign(new Error('approval-pending'), { status: 202, pending: true });
    }
    this.assertCapacity(requestId);
    const deviceId = row.deviceId && row.deviceId.trim() ? row.deviceId : `watch-${newOpaqueId(9).toLowerCase()}`;
    const token = `tk_${newOpaqueId(32)}`;
    // Atomic: tombstone + consumed mark + device + token bytes in ONE save;
    // on failure the row stays un-consumed (rollback by restoring snapshot).
    const snapshot = JSON.stringify(this.data);
    try {
      row.consumed = true;
      row.deviceId = deviceId;
      this.data.consumed[requestId] = this.now();
      while (Object.keys(this.data.consumed).length > MAX_TOMBSTONES) {
        const oldest = Object.entries(this.data.consumed).sort((a, b) => a[1] - b[1])[0]?.[0];
        if (!oldest) break;
        delete this.data.consumed[oldest];
      }
      this.data.devices[deviceId] = {
        deviceId,
        deviceAlias: row.deviceAlias,
        deviceKind: row.deviceKind,
        tokenHash: hashSecret(token),
        issuedAtMs: this.now(),
        revoked: false,
      };
      this.data.tokens[deviceId] = token;
      delete this.data.pending[requestId];
      this.save();
    } catch (error) {
      this.data = JSON.parse(snapshot) as StoreFile;
      throw error;
    }
    return { deviceId, token };
  }

  deviceForToken(presented: string): DeviceRow | undefined {
    if (!presented) return undefined;
    for (const device of Object.values(this.data.devices)) {
      if (!device.revoked && secretMatches(presented, device.tokenHash)) return device;
    }
    return undefined;
  }

  revoke(deviceId: string): boolean {
    const row = this.data.devices[deviceId];
    if (!row) return false;
    if (row.revoked) return true;
    row.revoked = true;
    delete this.data.tokens[deviceId];
    delete this.data.bindings[deviceId];
    this.save();
    return true;
  }

  listDevicesPublic(): Array<{ deviceId: string; deviceAlias: string; deviceKind: string; issuedAtMs: number; revoked: boolean }> {
    return Object.values(this.data.devices).map((d) => ({
      deviceId: d.deviceId,
      deviceAlias: d.deviceAlias,
      deviceKind: d.deviceKind,
      issuedAtMs: d.issuedAtMs,
      revoked: d.revoked,
    }));
  }

  getBinding(deviceId: string): BindingRow | undefined {
    return this.data.bindings[deviceId];
  }

  setBinding(deviceId: string, watchedSessionId: string, autoFollow: boolean): BindingRow {
    if (!this.data.devices[deviceId] || this.data.devices[deviceId].revoked) throw Object.assign(new Error('binding requires an approved active watch'), { status: 409 });
    const row: BindingRow = { deviceId, watchedSessionId, autoFollow, updatedAtMs: this.now() };
    this.data.bindings[deviceId] = row;
    this.save();
    return row;
  }
}
