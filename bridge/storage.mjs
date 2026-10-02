// bridge/storage.mjs — external runtime state (bridge token file).
//
// Functions only: importing this module performs no I/O. The token lives in
// the configured state directory (see config.mjs), never in the source tree,
// and is created with owner-only permissions (0600).

import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const TOKEN_FILE_NAME = 'token'

/** Private-directory mode for stored state (token, character selection). */
export const STATE_DIR_MODE = 0o700
/** Owner-only mode for stored secrets. */
export const TOKEN_FILE_MODE = 0o600

export function tokenFilePath (stateDir) {
  return join(stateDir, TOKEN_FILE_NAME)
}

function readTokenFile (path, readFile) {
  try {
    const text = readFile(path, 'utf8').trim()
    return text || null
  } catch {
    return null
  }
}

/**
 * Resolve the bridge token without side effects beyond an optional
 * single file write: explicit env token wins, otherwise the state-dir file,
 * otherwise a freshly generated random token persisted with mode 0600.
 *
 * `legacyPath` (the pre-release source-tree `token` file) is consulted
 * read-only for one release cycle to migrate upgraders, then ignored; it is
 * never written.
 */
export function loadOrCreateToken ({ stateDir, envToken = null, legacyPath = null, fs = null } = {}) {
  if (!stateDir) throw new Error('stateDir is required')
  const files = fs ?? { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync }
  const fromEnv = typeof envToken === 'string' && envToken.trim() ? envToken.trim() : null
  if (fromEnv) return fromEnv
  ensurePrivateDir(stateDir, files)
  const path = tokenFilePath(stateDir)
  const stored = files.existsSync(path) ? readTokenFile(path, files.readFileSync ?? readFileSync) : null
  if (stored) {
    // Pre-existing files may predate the 0600 policy (or the umask); tighten now.
    try { (files.chmodSync ?? chmodSync)(path, TOKEN_FILE_MODE) } catch { /* best effort */ }
    return stored
  }
  let migrated = null
  if (legacyPath && files.existsSync(legacyPath)) {
    migrated = readTokenFile(legacyPath, files.readFileSync ?? readFileSync)
  }
  const token = migrated || randomUUID().replace(/-/g, '').slice(0, 24)
  files.mkdirSync(stateDir, { recursive: true, mode: STATE_DIR_MODE })
  files.writeFileSync(path, token + '\n', { mode: TOKEN_FILE_MODE })
  try { (files.chmodSync ?? chmodSync)(path, TOKEN_FILE_MODE) } catch { /* best effort */ }
  return token
}

/**
 * Ensure the state directory exists with private permissions. The mode is
 * enforced even when the directory already exists (mkdir's mode applies only
 * on creation), so migrated/upgraded state never lingers world-readable.
 */
export function ensurePrivateDir (stateDir, fs = null) {
  const files = fs ?? { mkdirSync, chmodSync }
  files.mkdirSync(stateDir, { recursive: true, mode: STATE_DIR_MODE })
  try { (files.chmodSync ?? chmodSync)(stateDir, STATE_DIR_MODE) } catch { /* best effort */ }
}

/** Ensure the state directory exists with private permissions. */
export function ensureStateDir (stateDir, fs = null) {
  ensurePrivateDir(stateDir, fs)
}
