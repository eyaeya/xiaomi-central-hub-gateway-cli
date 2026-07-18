import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { SessionFile, StoredSession } from '../schemas/session.js';
import { AuthRequiredError } from '../transport/errors.js';

export interface SessionStoreOptions {
  path: string;
}

interface LockOwner {
  token: string;
  pid: number;
  createdAt: string;
}

interface LockOwnerEntry {
  owner: LockOwner;
  file: string;
}

interface LockSnapshot {
  owners: LockOwnerEntry[];
  entries: string[];
  mtimeMs: number;
}

const LOCK_TIMEOUT_MS = 10_000;
const ORPHAN_LOCK_STALE_MS = 2_000;
const LOCK_RETRY_MIN_MS = 20;
const LOCK_RETRY_JITTER_MS = 30;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class LegacySessionFileError extends AuthRequiredError {}

/**
 * Per-host session persistence backed by a single JSON file (mode 0600).
 *
 * The on-disk layout is `{ version: 2, sessions: { [host]: StoredSession } }`,
 * holding the per-host agent endpoint (pid + socketPath) — never the passcode,
 * which is single-use on the gateway side. Reading a v1 file (the M2 shape that
 * stored a passcode) deletes it and raises `AuthRequiredError` so the CLI can
 * prompt the user to `xgg login` again.
 *
 * Every mutation takes a filesystem lock next to the session file, re-reads
 * while holding that cross-process lock, and replaces the file with a fully
 * written same-directory temporary file. Ordinary reads rely on atomic rename;
 * legacy-file cleanup rechecks under the mutation lock before unlinking.
 */
export class SessionStore {
  private readonly path: string;

  constructor(opts: SessionStoreOptions) {
    this.path = opts.path;
  }

  async write(session: StoredSession): Promise<void> {
    StoredSession.parse(session);
    await this.withLock(async (path) => {
      let file: SessionFile;
      try {
        file = await this.readFile(path, true);
      } catch (e) {
        // F47 (2026-05-30) — narrow the swallow window. ENOENT (file
        // doesn't exist yet) and AuthRequiredError (v1 legacy file just
        // deleted by readFile) are the canonical "start fresh" signals.
        // Anything else (corrupt JSON, EACCES, ZodError on a different
        // host's entry) was previously masked by the catch-all — the
        // previous behavior reset the file and wrote OUR session,
        // destroying every other host's stored entry. Surface the
        // failure so the user can decide whether to discard.
        if (!isMissingFile(e) && !(e instanceof AuthRequiredError)) throw e;
        file = { version: 2, sessions: {} };
      }
      file.sessions[session.host] = session;
      await this.replaceFile(path, file);
    });
  }

  async read(host: string): Promise<StoredSession> {
    let file: SessionFile;
    try {
      file = await this.readFileForRead();
    } catch (e) {
      if (e instanceof AuthRequiredError) throw e;
      throw new AuthRequiredError(`No session file at ${this.path}`);
    }
    const entry = file.sessions[host];
    if (!entry) {
      throw new AuthRequiredError(`No session for host ${host}`);
    }
    return entry;
  }

  /**
   * Return all host keys currently stored in the session file.
   * Returns `[]` when the file is missing, empty, or a legacy v1 file
   * (which is deleted as a side-effect of readFile).
   */
  async hosts(): Promise<string[]> {
    let file: SessionFile;
    try {
      file = await this.readFileForRead();
    } catch (e) {
      // F47 (2026-05-30) — see write() for the narrowing rationale.
      // ENOENT + AuthRequiredError mean "no usable session file"; any
      // other error (corruption, EACCES, schema parse failure) deserves
      // to surface so errorToExit can produce the right SCHEMA exit.
      if (!isMissingFile(e) && !(e instanceof AuthRequiredError)) throw e;
      return [];
    }
    return Object.keys(file.sessions);
  }

  async delete(host: string): Promise<void> {
    await this.withLock(async (path) => {
      let file: SessionFile;
      try {
        file = await this.readFile(path, true);
      } catch (e) {
        // F47 (2026-05-30) — same shape as hosts()/write(): ENOENT and
        // v1-legacy (AuthRequiredError) are best-effort no-ops, everything
        // else surfaces. Logout's auto-resolve relies on this distinction
        // — silent corruption used to make `xgg logout` report success
        // while leaving a stale entry intact.
        if (!isMissingFile(e) && !(e instanceof AuthRequiredError)) throw e;
        return;
      }
      delete file.sessions[host];
      await this.replaceFile(path, file);
    });
  }

  private async readFileForRead(): Promise<SessionFile> {
    try {
      return await this.readFile(this.path, false);
    } catch (e) {
      if (!(e instanceof LegacySessionFileError)) throw e;
      // Legacy cleanup is itself a mutation. Re-read under the same lock used
      // by write/delete so a concurrent v2 replacement is never unlinked.
      return this.withLock((path) => this.readFile(path, true));
    }
  }

  private async readFile(path: string, removeLegacy: boolean): Promise<SessionFile> {
    const raw = await fs.readFile(path, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'version' in parsed &&
      (parsed as { version: unknown }).version !== 2
    ) {
      if (removeLegacy) await fs.unlink(path).catch(() => {});
      throw new LegacySessionFileError(
        'legacy v1 session file detected; agent endpoint not available',
        {
          hint: 'Run `xgg login --code <CODE>` to start an agent for this gateway.',
        },
      );
    }
    return SessionFile.parse(parsed);
  }

  private async replaceFile(path: string, file: SessionFile): Promise<void> {
    const parent = dirname(path);
    const temporaryPath = join(parent, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;

    try {
      handle = await fs.open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(file, null, 2), 'utf8');
      await handle.chmod(0o600);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporaryPath, path);
      await syncDirectory(parent);
    } finally {
      await handle?.close().catch(() => {});
      await fs.unlink(temporaryPath).catch((e: unknown) => {
        if (!isMissingFile(e)) throw e;
      });
    }
  }

  private async withLock<T>(operation: (path: string) => Promise<T>): Promise<T> {
    const path = await resolveMutationPath(this.path);
    await fs.mkdir(dirname(path), { recursive: true });
    const owner = await this.acquireLock(path);
    try {
      return await operation(path);
    } finally {
      await this.releaseLock(path, owner);
    }
  }

  private async acquireLock(path: string): Promise<LockOwner> {
    const lockPath = this.lockPath(path);
    const deadline = performance.now() + LOCK_TIMEOUT_MS;

    while (performance.now() < deadline) {
      try {
        await fs.mkdir(lockPath, { mode: 0o700 });
        const owner: LockOwner = {
          token: randomUUID(),
          pid: process.pid,
          createdAt: new Date().toISOString(),
        };
        try {
          await this.publishLockOwner(path, owner);
        } catch (e) {
          await this.removeLockDirectory(path, [this.lockOwnerFile(owner.token)], true).catch(
            () => {},
          );
          // A stale reclaimer can remove an empty directory between mkdir()
          // and owner publication. That is ordinary lock contention, not a
          // storage failure; retry with a fresh generation token.
          if (isMissingFile(e)) continue;
          throw e;
        }

        // mkdir() and publishing the owner record are separate syscalls. A
        // long-paused process can otherwise resume after a stale reclaimer has
        // removed and recreated the path, accidentally publishing into another
        // owner's directory. Only a sole, exact owner record proves acquisition.
        if (await this.isSoleLockOwner(path, owner)) return owner;
        await this.removeLockDirectory(path, [this.lockOwnerFile(owner.token)], true);
        continue;
      } catch (e) {
        if (!hasErrorCode(e, 'EEXIST')) throw e;
      }

      await this.reclaimStaleLock(path);
      await delay(LOCK_RETRY_MIN_MS + Math.floor(Math.random() * LOCK_RETRY_JITTER_MS));
    }

    const snapshot = await this.readLockSnapshot(path);
    const currentOwner = snapshot?.owners[0]?.owner;
    const ownerDescription = currentOwner
      ? `pid ${currentOwner.pid}, created ${currentOwner.createdAt}`
      : 'unknown owner';
    throw new Error(
      `Timed out waiting ${LOCK_TIMEOUT_MS}ms for session lock ${lockPath} (${ownerDescription})`,
    );
  }

  private async releaseLock(path: string, owner: LockOwner): Promise<void> {
    const current = await this.readLockSnapshot(path);
    const ownEntry = current?.owners.find(({ owner: candidate }) => sameOwner(candidate, owner));
    if (!ownEntry) return;
    // A delayed acquirer may have published a second owner record but cannot
    // enter its critical section until it becomes the sole owner. Remove only
    // our token-specific record and let that contender retry safely.
    await this.removeLockDirectory(path, [ownEntry.file], true);
  }

  private async reclaimStaleLock(path: string): Promise<void> {
    const observed = await this.readLockSnapshot(path);
    if (!observed) return;

    if (observed.owners.length > 0) {
      // A fully published canonical owner is immutable. Once its PID is
      // confirmed absent, the process cannot still hold the critical section;
      // do not let wall-clock rollback make that dead-owner lock permanent.
      if (observed.owners.some(({ owner }) => isProcessAlive(owner.pid))) return;

      // Re-read immediately before removal. Token-specific filenames prevent
      // an observation of old owners from being applied to a replacement lock.
      const current = await this.readLockSnapshot(path);
      if (
        !current ||
        !sameOwnerEntries(current.owners, observed.owners) ||
        current.owners.some(({ owner }) => isProcessAlive(owner.pid))
      ) {
        return;
      }
      await this.removeLockDirectory(
        path,
        current.owners.map(({ file }) => file),
        true,
      );
      return;
    }

    // A missing/corrupt owner record can only be recovered conservatively.
    // Give a process ample time to finish publishing its owner record, then require
    // the directory to remain ownerless before removing it.
    if (isWithinOrphanGrace(observed.mtimeMs)) return;
    const current = await this.readLockSnapshot(path);
    if (
      current &&
      current.owners.length === 0 &&
      current.entries.length === 0 &&
      !isWithinOrphanGrace(current.mtimeMs) &&
      sameEntries(current.entries, observed.entries)
    ) {
      // Unknown files are never lock artifacts and must not be deleted. Only
      // an empty, long-orphaned directory is safe to remove automatically.
      await this.removeLockDirectory(path, [], true);
    }
  }

  private async readLockSnapshot(path: string): Promise<LockSnapshot | undefined> {
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(this.lockPath(path));
    } catch (e) {
      if (isMissingFile(e)) return undefined;
      throw e;
    }
    if (!stat.isDirectory()) {
      throw new Error(`Session lock path is not a directory: ${this.lockPath(path)}`);
    }

    let entries: string[];
    try {
      entries = await fs.readdir(this.lockPath(path));
    } catch (e) {
      if (isMissingFile(e)) return undefined;
      throw e;
    }

    const owners: LockOwnerEntry[] = [];
    for (const candidate of entries.filter(isLockOwnerFile).sort()) {
      try {
        const candidatePath = join(this.lockPath(path), candidate);
        if (!(await fs.lstat(candidatePath)).isFile()) continue;
        const parsed = parseLockOwner(await fs.readFile(candidatePath, 'utf8'));
        if (parsed && this.lockOwnerFile(parsed.token) === candidate) {
          owners.push({ owner: parsed, file: candidate });
        }
      } catch (e) {
        if (!isMissingFile(e) && !hasErrorCode(e, 'EISDIR')) throw e;
      }
    }
    return { owners, entries, mtimeMs: stat.mtimeMs };
  }

  private async isSoleLockOwner(path: string, owner: LockOwner): Promise<boolean> {
    const snapshot = await this.readLockSnapshot(path);
    return (
      snapshot?.entries.length === 1 &&
      snapshot.owners.length === 1 &&
      snapshot.owners[0]?.file === this.lockOwnerFile(owner.token) &&
      sameOwner(snapshot.owners[0].owner, owner)
    );
  }

  private async publishLockOwner(path: string, owner: LockOwner): Promise<void> {
    // Build and fsync the immutable owner record outside the canonical lock
    // directory, then publish it with rename. A crash can therefore leave an
    // empty lock directory or an unrelated temporary file, but never a
    // truncated canonical owner that permanently blocks stale recovery.
    const temporaryPath = `${this.lockPath(path)}.owner-${owner.token}.tmp`;
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(owner), 'utf8');
      await handle.chmod(0o600);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporaryPath, this.lockOwnerPath(path, owner.token));
    } finally {
      await handle?.close().catch(() => {});
      await fs.unlink(temporaryPath).catch((e: unknown) => {
        if (!isMissingFile(e)) throw e;
      });
    }
  }

  private async removeLockDirectory(
    path: string,
    entries: string[],
    tolerateReplacement: boolean,
  ): Promise<void> {
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(this.lockPath(path));
    } catch (e) {
      if (isMissingFile(e)) return;
      throw e;
    }
    if (!stat.isDirectory()) {
      throw new Error(`Refusing to remove non-directory session lock: ${this.lockPath(path)}`);
    }

    for (const entry of entries) {
      if (basename(entry) !== entry) continue;
      try {
        await fs.unlink(join(this.lockPath(path), entry));
      } catch (e) {
        if (!isMissingFile(e)) throw e;
      }
    }
    try {
      await fs.rmdir(this.lockPath(path));
    } catch (e) {
      if (!isMissingFile(e) && !(tolerateReplacement && hasErrorCode(e, 'ENOTEMPTY'))) throw e;
    }
  }

  private lockPath(path: string): string {
    return `${path}.lock`;
  }

  private lockOwnerFile(token: string): string {
    return `owner-${token}.json`;
  }

  private lockOwnerPath(path: string, token: string): string {
    return join(this.lockPath(path), this.lockOwnerFile(token));
  }
}

async function resolveMutationPath(path: string, depth = 0): Promise<string> {
  if (depth > 32) throw new Error(`Too many symbolic links while resolving session path: ${path}`);
  try {
    return await fs.realpath(path);
  } catch (e) {
    if (!isMissingFile(e)) throw e;
  }

  try {
    const stat = await fs.lstat(path);
    if (stat.isSymbolicLink()) {
      const target = resolve(dirname(path), await fs.readlink(path));
      return resolveMutationPath(target, depth + 1);
    }
  } catch (e) {
    if (!isMissingFile(e)) throw e;
  }

  const parent = dirname(path);
  if (parent === path) return path;
  return join(await resolveMutationPath(parent, depth + 1), basename(path));
}

function isLockOwnerFile(name: string): boolean {
  const match = /^owner-(.+)\.json$/.exec(name);
  return match?.[1] !== undefined && UUID_PATTERN.test(match[1]);
}

function sameEntries(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((entry, index) => entry === sortedRight[index]);
}

function sameOwner(left: LockOwner, right: LockOwner): boolean {
  return left.token === right.token && left.pid === right.pid && left.createdAt === right.createdAt;
}

function sameOwnerEntries(left: LockOwnerEntry[], right: LockOwnerEntry[]): boolean {
  if (left.length !== right.length) return false;
  return left.every(({ owner, file }, index) => {
    const other = right[index];
    return other !== undefined && file === other.file && sameOwner(owner, other.owner);
  });
}

function isWithinOrphanGrace(mtimeMs: number): boolean {
  const ageMs = Date.now() - mtimeMs;
  // A future mtime indicates wall-clock rollback. Removing an ownerless
  // directory is safe because a paused publisher must still pass sole-owner
  // revalidation, so do not let clock skew make the orphan permanent.
  return ageMs >= 0 && ageMs < ORPHAN_LOCK_STALE_MS;
}

function parseLockOwner(raw: string): LockOwner | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value !== 'object' ||
      value === null ||
      !('token' in value) ||
      typeof value.token !== 'string' ||
      !UUID_PATTERN.test(value.token) ||
      !('pid' in value) ||
      typeof value.pid !== 'number' ||
      !Number.isInteger(value.pid) ||
      value.pid <= 0 ||
      !('createdAt' in value) ||
      typeof value.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(value.createdAt))
    ) {
      return undefined;
    }
    return { token: value.token, pid: value.pid, createdAt: value.createdAt };
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM still proves that a process owns this PID; unknown errors are
    // treated conservatively as alive so stale recovery cannot steal a lock.
    return !hasErrorCode(e, 'ESRCH');
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(path, 'r');
    await handle.sync();
  } catch (e) {
    // Some filesystems/platforms do not allow fsync on directories. The file
    // itself was already synced before rename, and rename remains atomic.
    if (
      !hasErrorCode(e, 'EINVAL') &&
      !hasErrorCode(e, 'EISDIR') &&
      !hasErrorCode(e, 'ENOTSUP') &&
      !hasErrorCode(e, 'EPERM')
    ) {
      throw e;
    }
  } finally {
    await handle?.close().catch(() => {});
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True when the error is a Node.js fs ENOENT (file/dir missing). */
function isMissingFile(e: unknown): boolean {
  return hasErrorCode(e, 'ENOENT');
}

function hasErrorCode(e: unknown, code: string): boolean {
  return (
    typeof e === 'object' && e !== null && 'code' in e && (e as { code: unknown }).code === code
  );
}
