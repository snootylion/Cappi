import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

/** Non-secret, machine/DSH-home scoped watch-Speech consent; never Mac-mic consent. */
export interface WatchConsent { version: 1; scope: 'watch-asr'; consent: boolean; locale: string }
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'

async function checkAncestors(target: string): Promise<void> {
  let current = path.resolve(target)
  for (;;) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('Consent path must not contain symlinks') }
    catch (error) { if (!missing(error)) throw error }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
}

function privateStat(stat: Stats, directory: boolean): void {
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
      (stat.mode & 0o777) !== (directory ? 0o700 : 0o600) ||
      (process.getuid && stat.uid !== process.getuid()) || (!directory && stat.nlink !== 1)) {
    throw new Error('Consent storage must be owned, private and not linked (0700 directory / 0600 file)')
  }
}

async function checkedDirectory(file: string, create: boolean): Promise<void> {
  if (!path.isAbsolute(file)) throw new Error('Consent path must be absolute')
  const directory = path.dirname(file)
  await checkAncestors(file)
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 })
  await checkAncestors(file)
  privateStat(await lstat(directory), true)
}

export async function readWatchConsent(file: string): Promise<WatchConsent | undefined> {
  try {
    await checkedDirectory(file, false)
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await handle.stat()
      privateStat(stat, false)
      if (stat.size > 1024) throw new Error('Consent record too large')
      const value: unknown = JSON.parse(await handle.readFile('utf8'))
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid consent record')
      const record = value as Record<string, unknown>
      if (Object.keys(record).sort().join(',') !== 'consent,locale,scope,version' || record.version !== 1 || record.scope !== 'watch-asr' || typeof record.consent !== 'boolean' || typeof record.locale !== 'string' || !record.locale || record.locale.length > 80) throw new Error('Invalid consent record')
      return record as unknown as WatchConsent
    } finally { await handle.close() }
  } catch (error) { if (missing(error)) return undefined; throw error }
}

export async function writeWatchConsent(file: string, record: WatchConsent, canCommit: () => boolean = () => true): Promise<void> {
  await checkedDirectory(file, true)
  try { privateStat(await lstat(file), false) } catch (error) { if (!missing(error)) throw error }
  const temporary = path.join(path.dirname(file), `.consent-${randomUUID()}.tmp`)
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8')
      await handle.sync()
    } finally { await handle.close() }
    await checkedDirectory(file, false)
    try { privateStat(await lstat(file), false) } catch (error) { if (!missing(error)) throw error }
    if (!canCommit()) throw new Error('Consent write cancelled');
    await rename(temporary, file)
    const directory = await open(path.dirname(file), constants.O_RDONLY | constants.O_NOFOLLOW)
    try { await directory.sync() } finally { await directory.close() }
  } finally {
    try { await unlink(temporary) } catch (error) { if (!missing(error)) throw error }
  }
}
