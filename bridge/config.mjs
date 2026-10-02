// bridge/config.mjs — environment configuration for the watch bridge.
//
// Pure parsing: importing this module performs no I/O, opens no sockets,
// reads no credentials and creates no files. Call loadBridgeConfig(env)
// explicitly at startup.
//
// Runtime state (token file, cert paths by default) lives in an EXTERNAL
// state directory — never in the source tree. Defaults honour
// BRIDGE_STATE_DIR, then XDG_STATE_HOME, then ~/.local/state/dsh-watch-bridge.

import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_BRIDGE_PORT = 8787
export const DEFAULT_DISCOVERY_PORT = 8788
export const DEFAULT_DSH_BASE = 'http://127.0.0.1:3083'

export const MAX_BODY_BYTES = 1 << 20
export const MAX_DISCOVERY_BYTES = 512
export const MAX_DISCOVERY_REPLIES = 8

/** RFC 5737 documentation placeholder. Blank means "unpaired" — never polled. */
export const PLACEHOLDER_BASE = 'http://192.0.2.1:8787'

export function defaultStateDir (env = process.env, home = homedir()) {
  if (env.BRIDGE_STATE_DIR && env.BRIDGE_STATE_DIR.trim()) return env.BRIDGE_STATE_DIR.trim()
  const xdg = env.XDG_STATE_HOME && env.XDG_STATE_HOME.trim()
  if (xdg) return join(xdg, 'dsh-watch-bridge')
  return join(home, '.local', 'state', 'dsh-watch-bridge')
}

function numInRange (raw, fallback, min, max) {
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n < min || n > max) return fallback
  return n
}

function flag (raw) {
  return raw === '1' || String(raw).toLowerCase() === 'true'
}

/**
 * Parse startup configuration. Returns a frozen object; throws on invalid
 * values. Never reads files or credentials.
 *
 * TLS is enforced by default: when no certificate/key is configured the
 * bridge must either be given one or started with explicit
 * BRIDGE_ALLOW_INSECURE_HTTP=1 (LAN legacy opt-in, never a silent fallback).
 */
export function loadBridgeConfig (env = process.env, home = homedir()) {
  const stateDir = defaultStateDir(env, home)
  const port = numInRange(env.BRIDGE_PORT, DEFAULT_BRIDGE_PORT, 1, 65535)
  const discoveryPort = numInRange(env.BRIDGE_DISCOVERY_PORT, DEFAULT_DISCOVERY_PORT, 1, 65535)
  const discoveryPortExplicit = Boolean(env.BRIDGE_DISCOVERY_PORT?.trim())
  if (discoveryPortExplicit && String(discoveryPort) !== env.BRIDGE_DISCOVERY_PORT.trim()) {
    throw new Error('invalid BRIDGE_DISCOVERY_PORT; use an integer 1..65535')
  }
  const dshBase = (env.DSH_BASE || DEFAULT_DSH_BASE).trim() || DEFAULT_DSH_BASE
  const dshHome = (env.DSH_HOME || join(home, '.dsh')).trim() || join(home, '.dsh')
  const token = (env.BRIDGE_TOKEN || '').trim()
  const tlsCert = (env.BRIDGE_TLS_CERT || join(stateDir, 'bridge-cert.pem')).trim()
  const tlsKey = (env.BRIDGE_TLS_KEY || join(stateDir, 'bridge-key.pem')).trim()
  const allowInsecureHttp = flag(env.BRIDGE_ALLOW_INSECURE_HTTP)
  let url
  try {
    url = new URL(dshBase)
  } catch {
    throw new Error(`invalid DSH_BASE: ${dshBase}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`invalid DSH_BASE scheme: ${dshBase}`)
  }
  return Object.freeze({
    port,
    discoveryPort,
    discoveryPortExplicit,
    stateDir,
    dshBase,
    dshHome,
    token: token || null,
    tlsCert,
    tlsKey,
    allowInsecureHttp,
    watchAcceptMacMic: env.WATCH_ACCEPT_MAC_MIC === '1',
  })
}

/** True when a stored base URL is usable (not blank, not the doc placeholder). */
export function isPairedBase (base) {
  const b = String(base || '').trim()
  return b.length > 0 && b !== PLACEHOLDER_BASE
}
