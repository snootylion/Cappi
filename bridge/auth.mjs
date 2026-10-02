// bridge/auth.mjs — header-only bridge token authentication.
//
// The token travels ONLY in the X-Bridge-Token header. Query-string tokens
// (?token=...) are rejected outright: URLs land in logs, history and error
// reports, headers do not. Importing this module performs no I/O.

import { createHash, timingSafeEqual } from 'node:crypto'

export const TOKEN_HEADER = 'x-bridge-token'

/** Constant-time token comparison (hash-then-compare; no length oracle). */
export function tokenOkTimingSafe (provided, expected) {
  if (typeof provided !== 'string' || !provided) return false
  if (typeof expected !== 'string' || !expected) return false
  const a = createHash('sha256').update(provided).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

/**
 * Extract the bearer token from request headers only. Returns null when
 * absent. A token smuggled in the query string is NOT accepted — callers
 * should reject the request with a hint (see queryHasToken).
 */
export function extractHeaderToken (req) {
  const raw = req?.headers?.[TOKEN_HEADER]
  if (Array.isArray(raw)) return raw[0] ?? null
  return typeof raw === 'string' && raw ? raw : null
}

/** True when the URL carries a token that must be refused. */
export function queryHasToken (url) {
  try {
    return url.searchParams.has('token')
  } catch {
    return false
  }
}

/** True when a URL string embeds a token (rejected for open-mac targets). */
export function isTokenBearingUrl (target) {
  return /[?&]token=/i.test(String(target || ''))
}

/**
 * Intended open-mac raw-URL policy (plain https links only, no credentials).
 * Returns { ok:true, url } or { ok:false, error }. Pure: no I/O, no spawn.
 * Policy: https: only (no http/cleartext, no other schemes), no username or
 * password userinfo (credentials would leak to the opened host), and no
 * token-bearing query (?token=/&token=). Image refs bypass this (bytes open
 * from a private temp file); this validates only raw {url} targets.
 */
export function validateOpenMacUrl (target) {
  const raw = String(target || '')
  let url
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, error: 'only https URLs may be opened on the Mac' }
  }
  if (url.protocol !== 'https:') {
    return { ok: false, error: 'only https URLs may be opened on the Mac' }
  }
  if (url.username || url.password) {
    return { ok: false, error: 'URLs with credentials are rejected' }
  }
  if (isTokenBearingUrl(raw)) {
    return { ok: false, error: 'token-bearing URLs are rejected' }
  }
  return { ok: true, url }
}

/**
 * One auth decision for a watch request. Query tokens are rejected before
 * the header token is even compared, so a leaked URL can never authenticate.
 * Returns { ok:true } or { ok:false, error }.
 */
export function decideAuth ({ headerToken, hasQueryToken, expected }) {
  if (hasQueryToken) return { ok: false, error: 'token in URL is rejected; send X-Bridge-Token header' }
  if (!tokenOkTimingSafe(headerToken, expected)) return { ok: false, error: 'bad token' }
  return { ok: true }
}
