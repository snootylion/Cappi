// bridge/dsh-auth.mjs — isolated DSH loopback credential access.
//
// The watch bridge talks to the local DSH harness with a minted
// `dsh-auth-*` HMAC cookie (v1). All secret file access lives here:
//   - home directory is injectable; DSH_HOME overrides the default ~/.dsh
//   - the cookie format version is bounded (COOKIE_VERSION = 1)
//   - importing this module reads NOTHING; tests inject fixtures.
//
// Never call loadDshSecret() in tests against a real home directory.

import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Minted cookie format version. Bump only with a harness-side change. */
export const COOKIE_VERSION = 1
export const CREDENTIALS_FILE = '.credentials.yaml'
export const CREDENTIAL_ANCHOR = 'client-connection/browser-session:'

/** Resolve the DSH home directory: explicit override, DSH_HOME, or ~/.dsh. */
export function resolveDshHome ({ dshHome = null, env = process.env, home = homedir() } = {}) {
  const raw = dshHome ?? env.DSH_HOME
  if (typeof raw === 'string' && raw.trim()) return raw.trim()
  return join(home, '.dsh')
}

/**
 * Load the 32-byte browser-session secret. Throws without revealing the
 * secret. `read` is injectable so tests never touch real credentials.
 */
export function loadDshSecret ({ dshHome = null, env = process.env, home = homedir(), read = null } = {}) {
  const dir = resolveDshHome({ dshHome, env, home })
  const readFile = read ?? readFileSync
  let text
  try {
    text = readFile(join(dir, CREDENTIALS_FILE), 'utf8')
  } catch {
    throw new Error(`DSH credentials not found in ${dir} (${CREDENTIALS_FILE})`)
  }
  const anchor = text.indexOf(CREDENTIAL_ANCHOR)
  if (anchor < 0) throw new Error('browser-session credential record not found')
  const m = text.slice(anchor).match(/^\s+secret:\s*(\S+)\s*$/m)
  if (!m) throw new Error('browser-session secret not found')
  const buf = Buffer.from(m[1], 'base64url')
  if (buf.byteLength !== 32) throw new Error('browser-session secret has wrong length')
  return buf
}

/** Mint a v1 cookie header value for an authority (host:port). */
export function mintCookie ({ authority, secret, now = Date.now(), ttlMs = 30 * 86400000 } = {}) {
  if (!authority) throw new Error('authority is required')
  if (!Buffer.isBuffer(secret) || secret.byteLength !== 32) throw new Error('secret must be 32 bytes')
  const issuedAt = now
  const body = Buffer.from(JSON.stringify({
    version: COOKIE_VERSION,
    authority,
    issuedAt,
    expiresAt: issuedAt + ttlMs,
  }), 'utf8').toString('base64url')
  const sig = createHmac('sha256', secret).update(body).digest().toString('base64url')
  const name = 'dsh-auth-' + createHash('sha256').update(authority).digest('base64url')
  return `${name}=v1.${body}.${sig}`
}
