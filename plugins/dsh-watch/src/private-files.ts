// Private runtime files: reject symlink ancestors, never follow files, and fail
// closed on permission/persistence errors. No predictable staging filenames.
import { randomUUID } from 'node:crypto';
import { constants, lstatSync, mkdirSync, openSync, closeSync, fchmodSync, fstatSync, fsyncSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';

export function checkPrivatePath(file: string): void {
  const absolute = path.resolve(file);
  let at = path.parse(absolute).root;
  for (const part of absolute.slice(at.length).split(path.sep).filter(Boolean)) {
    at = path.join(at, part);
    try {
      const st = lstatSync(at);
      if (st.isSymbolicLink()) throw new Error('private storage path contains a symlink');
      if (at !== absolute && !st.isDirectory()) throw new Error('private storage ancestor is not a directory');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
}
export function privateDirectory(dir: string): void {
  checkPrivatePath(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  checkPrivatePath(dir);
  const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isDirectory()) throw new Error('private storage is not a directory');
    fchmodSync(fd, 0o700);
    if ((fstatSync(fd).mode & 0o777) !== 0o700) throw new Error('private directory must have mode 0700');
  } finally { closeSync(fd); }
}
export function readPrivateFile(file: string): string | undefined {
  checkPrivatePath(file);
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
  try {
    if (!fstatSync(fd).isFile()) throw new Error('private storage is not a regular file');
    fchmodSync(fd, 0o600);
    if ((fstatSync(fd).mode & 0o777) !== 0o600) throw new Error('private file must have mode 0600');
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}
export function writePrivateFile(file: string, content: string | Buffer): void {
  checkPrivatePath(file);
  const existing = (() => { try { return lstatSync(file); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; } })();
  if (existing && !existing.isFile()) throw new Error('private destination is not a regular file');
  const tmp = path.join(path.dirname(file), `.private-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    fchmodSync(fd, 0o600);
    if ((fstatSync(fd).mode & 0o777) !== 0o600) throw new Error('private file must have mode 0600');
    writeFileSync(fd, content, 'utf8'); fsyncSync(fd); closeSync(fd); fd = undefined;
    checkPrivatePath(file);
    const current = (() => { try { return lstatSync(file); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; } })();
    if (current && !current.isFile()) throw new Error('private destination changed');
    renameSync(tmp, file);
    const dirFd = openSync(path.dirname(file), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(tmp); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
}
