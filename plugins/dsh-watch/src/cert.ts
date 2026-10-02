/**
 * Turnkey TLS identity: stable self-signed certificate + pin/fingerprint.
 *
 * - Cert/key live OUTSIDE the package under `<DSH_HOME>/dsh-watch/turnkey/`
 *   (dir 0700, files 0600). Never shipped, never logged.
 * - Generated at startup with the platform-standard tool (`openssl req -x509`)
 *   — NOT a forced runtime Xcode/Swift compile. openssl ships with macOS itself
 *   and most Linux distros; when absent the runtime fails with an actionable
 *   message (repair/install the platform openssl tool) instead of serving plaintext.
 * - No quiet plaintext LAN: without a cert the LAN server refuses to start
 *   unless the explicit advanced `allowInsecureLan` + loopback-only path is
 *   used (local fixtures only).
 * - Pin: `sha256/` + base64 of exactly 32 bytes (SHA-256 of DER), compared
 *   constant-time. Fingerprint display: FULL colon-hex + 96-bit short
 *   (6 groups of 4 hex, e.g. `a1b2-c3d4-…`); a 6-digit SAS MUST NOT be used
 *   for the cert comparison (§3.2).
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { privateDirectory, readPrivateFile, writePrivateFile } from './private-files.ts';
import { createSecureContext } from 'node:tls';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);

export interface TlsIdentity {
  certPem: string;
  keyPem: string;
  /** `sha256/` + base64(DER-SHA256), the pairing pin. */
  pin: string;
  fingerprint: { full: string; short: string };
}

export function turnkeyDir(dshHome: string): string {
  return path.join(dshHome, 'dsh-watch', 'turnkey');
}

export function certPaths(dshHome: string): { dir: string; certFile: string; keyFile: string } {
  const dir = turnkeyDir(dshHome);
  return { dir, certFile: path.join(dir, 'cert.pem'), keyFile: path.join(dir, 'key.pem') };
}

/** SHA-256 over DER bytes of a PEM cert → base64 (no prefix). */
export function certDerPinB64(certPem: string): string {
  const b64 = String(certPem)
    .split('\n')
    .filter((line) => !line.includes('-----BEGIN') && !line.includes('-----END'))
    .join('')
    .trim();
  const der = Buffer.from(b64, 'base64');
  if (!der.length) throw new Error('empty certificate');
  return createHash('sha256').update(der).digest('base64');
}

export function certDerBytes(certPem: string): Buffer {
  const b64 = String(certPem)
    .split('\n')
    .filter((line) => !line.includes('-----BEGIN') && !line.includes('-----END'))
    .join('')
    .trim();
  return Buffer.from(b64, 'base64');
}

/** Constant-time pin compare; both must decode to 32 bytes. */
export function pinMatches(a: string, b: string): boolean {
  try {
    const norm = (s: string): Buffer => {
      let v = String(s ?? '').trim();
      if (/^sha256\//i.test(v)) v = v.slice(7).trim();
      return Buffer.from(v, 'base64');
    };
    const ab = norm(a);
    const bb = norm(b);
    if (ab.length !== 32 || bb.length !== 32) return false;
    return timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

export function fingerprintOf(certPem: string): { full: string; short: string } {
  const digest = createHash('sha256').update(certDerBytes(certPem)).digest('hex');
  const pairs = digest.match(/../g) ?? [];
  const full = pairs.join(':');
  const short = [0, 1, 2, 3, 4, 5].map((g) => pairs.slice(g * 2, g * 2 + 2).join('')).join('-');
  return { full, short };
}

/**
 * Load or create the stable identity. Creates the dir (0700) and files
 * (0600). Generation uses `openssl req -x509 -newkey rsa:2048 -nodes`
 * (platform-standard tool, no Xcode). Throws actionably when openssl is
 * missing or generation fails — the caller must refuse LAN startup.
 */
export async function loadOrCreateIdentity(dshHome: string): Promise<TlsIdentity> {
  const { dir, certFile, keyFile } = certPaths(dshHome);
  privateDirectory(path.dirname(dir));
  privateDirectory(dir);
  const existingCert = readPrivateFile(certFile);
  const existingKey = readPrivateFile(keyFile);
  if (existingCert !== undefined || existingKey !== undefined) {
    if (!existingCert?.trim() || !existingKey?.trim()) throw new Error('Incomplete TLS identity; restore both private certificate files before startup');
    createSecureContext({ cert: existingCert, key: existingKey });
    return { certPem: existingCert, keyPem: existingKey, pin: `sha256/${certDerPinB64(existingCert)}`, fingerprint: fingerprintOf(existingCert) };
  }
  const staging = mkdtempSync(path.join(dir, '.identity-'));
  privateDirectory(staging);
  try {
    const stagedKey = path.join(staging, 'key.pem');
    const stagedCert = path.join(staging, 'cert.pem');
    await execFileAsync(process.platform === 'darwin' ? '/usr/bin/openssl' : 'openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', stagedKey, '-out', stagedCert, '-days', '825',
      '-subj', '/CN=dsh-watch-turnkey',
      '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
    ]);
    const certPem = readFileSync(stagedCert, 'utf8');
    const keyPem = readFileSync(stagedKey, 'utf8');
    createSecureContext({ cert: certPem, key: keyPem });
    writePrivateFile(keyFile, keyPem);
    writePrivateFile(certFile, certPem);
    return { certPem, keyPem, pin: `sha256/${certDerPinB64(certPem)}`, fingerprint: fingerprintOf(certPem) };
  } catch (error) {
    throw new Error(`Turnkey TLS identity creation failed; check private storage and openssl availability: ${(error as Error).message}`);
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
