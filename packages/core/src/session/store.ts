import { isUtf8 } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { SessionFile, StoredSession } from '../schemas/session.js';
import { AuthRequiredError, SchemaError } from '../transport/errors.js';

export interface SessionStoreOptions {
  path: string;
}

export type StoredSessionIdentity = Pick<
  StoredSession,
  'agentStartedAt' | 'host' | 'pid' | 'socketPath'
>;

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

// Verified against the original v1 schema at e499290a98c425416a2e76e07f31ef9a9ccbd03f
// and its v2 migration at 28535f6f65a2f0e9898b1f78ee8811e1fbadf51b.
// The historical schemas were permissive Zod objects, but deletion must be
// stricter than parsing: any extra or mismatched data is preserved for manual
// recovery instead of being guessed to be a disposable legacy session.
const LegacyStoredSession = z
  .object({
    host: z.string().url(),
    passcode: z.string().regex(/^\d{6,8}$/),
    createdAt: z.string().datetime(),
    lastValidatedAt: z.string().datetime(),
  })
  .strict();

const LegacySessionFile = z
  .object({
    version: z.literal(1),
    sessions: z.record(z.string(), LegacyStoredSession),
  })
  .strict()
  .superRefine((file, context) => {
    for (const [host, session] of Object.entries(file.sessions)) {
      if (host !== session.host) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'session record key must match session host',
          path: ['sessions', host, 'host'],
        });
      }
    }
  });

/**
 * Per-host session persistence backed by a single JSON file (mode 0600).
 *
 * The on-disk layout is `{ version: 2, sessions: { [host]: StoredSession } }`,
 * holding the per-host agent endpoint (pid + socketPath) — never the passcode,
 * which is single-use on the gateway side. An exact structural match for the
 * verified v1 envelope is deleted because its passcodes have already been
 * consumed. Every near-v1, unknown, or future format is preserved instead.
 *
 * Every mutation takes a filesystem lock next to the session file, re-reads
 * while holding that cross-process lock, and replaces the file with a fully
 * written same-directory temporary file. Ordinary reads rely on atomic rename;
 * unknown, malformed, and future-version files are never replaced.
 */
export class SessionStore {
  private readonly path: string;

  constructor(opts: SessionStoreOptions) {
    this.path = opts.path;
  }

  async write(session: StoredSession): Promise<void> {
    const validatedSession = StoredSession.parse(session);
    await this.withLock(async (path) => {
      let file: SessionFile;
      try {
        file = await this.readFile(path);
      } catch (e) {
        // F47 (2026-05-30) — narrow the swallow window. ENOENT and the
        // explicitly verified legacy envelope are the only "start fresh"
        // signals.
        // Anything else (corrupt JSON, EACCES, ZodError on a different
        // host's entry) was previously masked by the catch-all — the
        // previous behavior reset the file and wrote OUR session,
        // destroying every other host's stored entry. Surface the
        // failure so the user can decide whether to discard.
        if (!isMissingFile(e) && !(e instanceof LegacySessionFileError)) throw e;
        file = { version: 2, sessions: {} };
      }
      file.sessions[validatedSession.host] = validatedSession;
      await this.replaceFile(path, file);
    });
  }

  async read(host: string): Promise<StoredSession> {
    let file: SessionFile;
    try {
      file = await this.readFileForRead();
    } catch (e) {
      if (e instanceof LegacySessionFileError) throw e;
      if (isMissingFile(e)) throw new AuthRequiredError(`No session file at ${this.path}`);
      throw e;
    }
    const entry = file.sessions[host];
    if (!entry) {
      throw new AuthRequiredError(`No session for host ${host}`);
    }
    return entry;
  }

  /**
   * Return all host keys currently stored in the session file.
   * Returns `[]` when the file is missing or after an exact legacy v1 cleanup.
   * Invalid or unknown files raise a schema error and remain byte-for-byte
   * unchanged.
   */
  async hosts(): Promise<string[]> {
    let file: SessionFile;
    try {
      file = await this.readFileForRead();
    } catch (e) {
      // F47 (2026-05-30) — see write() for the narrowing rationale.
      // ENOENT and verified-v1 cleanup mean "no usable session file"; any
      // other error (corruption, EACCES, schema parse failure) surfaces.
      if (!isMissingFile(e) && !(e instanceof LegacySessionFileError)) throw e;
      return [];
    }
    return Object.keys(file.sessions);
  }

  async delete(host: string): Promise<void> {
    await this.deleteMatching(host);
  }

  /**
   * Delete a session only while the stored entry still belongs to the expected
   * daemon instance. The comparison and delete happen under the same
   * cross-process lock, so an older daemon cannot remove a replacement entry.
   */
  async deleteIfMatch(expected: StoredSessionIdentity): Promise<boolean> {
    return this.deleteMatching(expected.host, (current) => sameSessionIdentity(current, expected));
  }

  private async deleteMatching(
    host: string,
    matches: (current: StoredSession) => boolean = () => true,
  ): Promise<boolean> {
    return this.withLock(async (path) => {
      let file: SessionFile;
      try {
        file = await this.readFile(path);
      } catch (e) {
        // F47 (2026-05-30) — same shape as hosts()/write(): ENOENT and an
        // already-cleaned verified v1 are best-effort no-ops. Every invalid
        // schema or I/O failure surfaces instead.
        if (!isMissingFile(e) && !(e instanceof LegacySessionFileError)) throw e;
        return false;
      }
      const current = file.sessions[host];
      if (!current || !matches(current)) return false;
      delete file.sessions[host];
      await this.replaceFile(path, file);
      return true;
    });
  }

  private async readFileForRead(): Promise<SessionFile> {
    try {
      return await this.readFile(this.path, false);
    } catch (e) {
      if (!(e instanceof LegacySessionFileError)) throw e;
      // Legacy cleanup is a mutation. Re-read under the same lock used by
      // write/delete so a concurrent v2 replacement is never unlinked.
      return this.withLock((path) => this.readFile(path, true));
    }
  }

  private async readFile(path: string, removeLegacy = true): Promise<SessionFile> {
    const bytes = await fs.readFile(path);
    if (!isUtf8(bytes)) throw sessionSchemaError(this.path, 'invalid_utf8');
    const raw = bytes.toString('utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      if (e instanceof SyntaxError) throw sessionSchemaError(this.path, 'invalid_json');
      throw e;
    }

    const result = SessionFile.safeParse(parsed);
    if (result.success) return result.data;

    if (LegacySessionFile.safeParse(parsed).success) {
      if (removeLegacy) await fs.unlink(path);
      throw new LegacySessionFileError(
        'legacy v1 session file detected; agent endpoint not available',
        {
          hint: 'Run `xgg login --code <CODE>` to start an agent for this gateway.',
        },
      );
    }

    throw sessionSchemaError(this.path, 'schema_mismatch');
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

function sameSessionIdentity(left: StoredSession, right: StoredSessionIdentity): boolean {
  return (
    left.host === right.host &&
    left.pid === right.pid &&
    left.socketPath === right.socketPath &&
    left.agentStartedAt === right.agentStartedAt
  );
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

function sessionSchemaError(
  path: string,
  reason: 'invalid_utf8' | 'invalid_json' | 'schema_mismatch',
): SchemaError {
  const description =
    reason === 'invalid_utf8'
      ? 'contains invalid UTF-8'
      : reason === 'invalid_json'
        ? 'contains invalid JSON'
        : 'is not a v2 session file';
  return new SchemaError(`Session file at ${path} ${description}`, {
    sessionPath: path,
    reason,
  });
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
