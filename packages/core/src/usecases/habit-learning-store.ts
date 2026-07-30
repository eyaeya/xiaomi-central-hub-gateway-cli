import { randomUUID } from 'node:crypto';
import { promises as fs, constants as fsConstants } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

export interface HabitLearningStudyStoreOptions {
  /** Exact directory for one study. The directory itself must not be a symlink. */
  path: string;
  /** Maximum time to wait for the study's single-writer lock. */
  lockTimeoutMs?: number;
  /** Delay between lock acquisition attempts. */
  lockRetryMs?: number;
  /** Grace period before an empty, unpublished lock directory can be reclaimed. */
  orphanLockStaleMs?: number;
}

export interface HabitLearningStudyStorePaths {
  study: string;
  state: string;
  journal: string;
  lock: string;
}

export interface HabitLearningJournalAppendResult {
  records: number;
  bytes: number;
}

/**
 * Operations available while holding the study's cross-process writer lock.
 *
 * Capture code should append a complete poll batch first and then replace the
 * checkpoint state in the same callback. The journal is fsynced before
 * appendJournal() resolves; state replacement is also fsynced before
 * writeState() resolves.
 */
export interface HabitLearningStudyTransaction {
  readState<T = unknown>(): Promise<T | undefined>;
  writeState(state: unknown): Promise<void>;
  appendJournal(
    records: readonly Readonly<Record<string, unknown>>[],
  ): Promise<HabitLearningJournalAppendResult>;
}

interface LockOwner {
  token: string;
  pid: number;
  createdAt: string;
}

interface LockSnapshot {
  dev: number;
  ino: number;
  entries: string[];
  mtimeMs: number;
  owner?: LockOwner;
  ownerFile?: string;
}

const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_LOCK_RETRY_MS = 25;
const DEFAULT_ORPHAN_LOCK_STALE_MS = 2_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Minimal private persistence primitive for one household habit-learning study.
 *
 * The store owns three fixed paths below the supplied study directory:
 * `state.json`, `journal.ndjson`, and `.writer.lock`. It never follows a
 * symlink at the study root or either data-file path. The study directory is
 * forced to 0700 and data/owner files to 0600, independent of the caller's
 * umask.
 */
export class HabitLearningStudyStore {
  readonly paths: Readonly<HabitLearningStudyStorePaths>;

  private readonly lockTimeoutMs: number;
  private readonly lockRetryMs: number;
  private readonly orphanLockStaleMs: number;

  constructor(options: HabitLearningStudyStoreOptions) {
    const study = resolve(options.path);
    this.paths = Object.freeze({
      study,
      state: join(study, 'state.json'),
      journal: join(study, 'journal.ndjson'),
      lock: join(study, '.writer.lock'),
    });
    this.lockTimeoutMs = positiveInteger(
      options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
      'lockTimeoutMs',
    );
    this.lockRetryMs = positiveInteger(options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS, 'lockRetryMs');
    this.orphanLockStaleMs = nonNegativeInteger(
      options.orphanLockStaleMs ?? DEFAULT_ORPHAN_LOCK_STALE_MS,
      'orphanLockStaleMs',
    );
  }

  /** Create or harden the private study directory and existing data files. */
  async initialize(): Promise<void> {
    await assertNotSymlinkIfPresent(this.paths.study, 'study root');
    await fs.mkdir(this.paths.study, { recursive: true, mode: 0o700 });
    await hardenPrivateDirectory(this.paths.study, 'study root');

    await hardenRegularFileIfPresent(this.paths.state, 'habit-learning state');
    await hardenRegularFileIfPresent(this.paths.journal, 'habit-learning journal');
    await assertLockPathIfPresent(this.paths.lock);
  }

  /** Read the atomically replaced checkpoint without taking the writer lock. */
  async readState<T = unknown>(): Promise<T | undefined> {
    await this.initialize();
    return this.readStateUnlocked<T>();
  }

  /**
   * Read all complete NDJSON records. A malformed or partial record is surfaced
   * instead of being silently discarded; recovery policy belongs to the
   * journal layer above this storage primitive.
   */
  async readJournal<T = unknown>(): Promise<T[]> {
    await this.initialize();
    const raw = await readPrivateFileIfPresent(this.paths.journal, 'habit-learning journal');
    if (raw === undefined || raw.length === 0) return [];

    const lines = raw.split('\n');
    if (lines.at(-1) === '') lines.pop();
    return lines.map((line, index) => {
      if (line.length === 0) {
        throw new Error(`Invalid empty habit-learning journal record at line ${index + 1}`);
      }
      try {
        return JSON.parse(line) as T;
      } catch (error) {
        throw new Error(`Invalid habit-learning journal JSON at line ${index + 1}`, {
          cause: error,
        });
      }
    });
  }

  /** Convenience wrapper for one locked atomic state replacement. */
  async writeState(state: unknown): Promise<void> {
    await this.withLock((transaction) => transaction.writeState(state));
  }

  /** Convenience wrapper for one locked append-and-fsync operation. */
  async appendJournal(
    records: readonly Readonly<Record<string, unknown>>[],
  ): Promise<HabitLearningJournalAppendResult> {
    return this.withLock((transaction) => transaction.appendJournal(records));
  }

  /**
   * Run a capture mutation while holding the study's single-writer lock.
   *
   * The lock is process-scoped and represented by an immutable token/PID owner
   * record. A live PID is never reclaimed. A dead PID is reclaimed only after
   * the exact directory generation and owner record are re-read unchanged.
   */
  async withLock<T>(
    operation: (transaction: HabitLearningStudyTransaction) => Promise<T>,
  ): Promise<T> {
    await this.initialize();
    const owner = await this.acquireLock();
    const transaction: HabitLearningStudyTransaction = Object.freeze({
      readState: <Value = unknown>() => this.readStateUnlocked<Value>(),
      writeState: (state: unknown) => this.writeStateUnlocked(state),
      appendJournal: (records: readonly Readonly<Record<string, unknown>>[]) =>
        this.appendJournalUnlocked(records),
    });

    try {
      return await operation(transaction);
    } finally {
      await this.releaseLock(owner);
    }
  }

  private async readStateUnlocked<T>(): Promise<T | undefined> {
    const raw = await readPrivateFileIfPresent(this.paths.state, 'habit-learning state');
    if (raw === undefined) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch (error) {
      throw new Error(`Invalid habit-learning state JSON at ${this.paths.state}`, {
        cause: error,
      });
    }
  }

  private async writeStateUnlocked(state: unknown): Promise<void> {
    const serialized = serializeState(state);
    await assertRegularFileOrMissing(this.paths.state, 'habit-learning state');

    const temporaryPath = join(
      this.paths.study,
      `.${basename(this.paths.state)}.${process.pid}.${randomUUID()}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;

    try {
      handle = await fs.open(temporaryPath, numericOpenFlags('exclusive-write'), 0o600);
      await handle.writeFile(serialized, 'utf8');
      await handle.chmod(0o600);
      await handle.sync();
      await handle.close();
      handle = undefined;

      // Reject an existing symlink/non-file even though rename would replace a
      // symlink rather than follow it. Refusal keeps the storage contract
      // explicit and exposes tampering to the caller.
      await assertRegularFileOrMissing(this.paths.state, 'habit-learning state');
      await fs.rename(temporaryPath, this.paths.state);
      await syncDirectory(this.paths.study);
    } finally {
      await handle?.close().catch(() => {});
      await unlinkIfPresent(temporaryPath);
    }
  }

  private async appendJournalUnlocked(
    records: readonly Readonly<Record<string, unknown>>[],
  ): Promise<HabitLearningJournalAppendResult> {
    if (records.length === 0) return { records: 0, bytes: 0 };
    const serialized = records
      .map((record, index) => serializeJournalRecord(record, index))
      .join('');
    await assertRegularFileOrMissing(this.paths.journal, 'habit-learning journal');

    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      try {
        handle = await fs.open(this.paths.journal, numericOpenFlags('append'), 0o600);
      } catch (error) {
        if (hasErrorCode(error, 'ELOOP')) {
          throw new Error(`Refusing symbolic-link habit-learning journal: ${this.paths.journal}`, {
            cause: error,
          });
        }
        throw error;
      }
      const stat = await handle.stat();
      if (!stat.isFile()) {
        throw new Error(`Habit-learning journal is not a regular file: ${this.paths.journal}`);
      }
      await handle.chmod(0o600);
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
    } finally {
      await handle?.close();
    }
    await syncDirectory(this.paths.study);
    return {
      records: records.length,
      bytes: Buffer.byteLength(serialized),
    };
  }

  private async acquireLock(): Promise<LockOwner> {
    const deadline = performance.now() + this.lockTimeoutMs;

    while (performance.now() < deadline) {
      let created = false;
      try {
        await fs.mkdir(this.paths.lock, { mode: 0o700 });
        created = true;
        await fs.chmod(this.paths.lock, 0o700);
        await syncDirectory(this.paths.study);

        const owner: LockOwner = {
          token: randomUUID(),
          pid: process.pid,
          createdAt: new Date().toISOString(),
        };
        try {
          await this.publishLockOwner(owner);
        } catch (error) {
          await this.removeEmptyOwnedLock().catch(() => {});
          if (isMissing(error)) continue;
          throw error;
        }

        if (await this.isSoleLockOwner(owner)) return owner;
        await this.releaseLock(owner);
      } catch (error) {
        if (created) await this.removeEmptyOwnedLock().catch(() => {});
        if (!hasErrorCode(error, 'EEXIST')) throw error;
        await this.reclaimStaleLock();
      }

      await delay(this.lockRetryMs);
    }

    const snapshot = await this.readLockSnapshot();
    const ownerDescription = snapshot?.owner
      ? `pid ${snapshot.owner.pid}, created ${snapshot.owner.createdAt}`
      : 'unknown owner';
    throw new Error(
      `Timed out waiting ${this.lockTimeoutMs}ms for habit-learning study lock ` +
        `${this.paths.lock} (${ownerDescription})`,
    );
  }

  private async publishLockOwner(owner: LockOwner): Promise<void> {
    const ownerFile = lockOwnerFile(owner.token);
    const ownerPath = join(this.paths.lock, ownerFile);
    const temporaryPath = join(
      this.paths.study,
      `.${basename(this.paths.lock)}.owner-${owner.token}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;

    try {
      handle = await fs.open(temporaryPath, numericOpenFlags('exclusive-write'), 0o600);
      await handle.writeFile(JSON.stringify(owner), 'utf8');
      await handle.chmod(0o600);
      await handle.sync();
      await handle.close();
      handle = undefined;

      await fs.rename(temporaryPath, ownerPath);
      await syncDirectory(this.paths.lock);
    } finally {
      await handle?.close().catch(() => {});
      await unlinkIfPresent(temporaryPath);
    }
  }

  private async isSoleLockOwner(owner: LockOwner): Promise<boolean> {
    const snapshot = await this.readLockSnapshot();
    return (
      snapshot?.entries.length === 1 &&
      snapshot.ownerFile === lockOwnerFile(owner.token) &&
      snapshot.owner !== undefined &&
      sameOwner(snapshot.owner, owner)
    );
  }

  private async releaseLock(owner: LockOwner): Promise<void> {
    const snapshot = await this.readLockSnapshot();
    if (
      !snapshot ||
      snapshot.entries.length !== 1 ||
      snapshot.ownerFile !== lockOwnerFile(owner.token) ||
      snapshot.owner === undefined ||
      !sameOwner(snapshot.owner, owner)
    ) {
      return;
    }

    await fs.unlink(join(this.paths.lock, snapshot.ownerFile));
    try {
      await fs.rmdir(this.paths.lock);
    } catch (error) {
      if (!isMissing(error) && !hasErrorCode(error, 'ENOTEMPTY')) throw error;
    }
    await syncDirectory(this.paths.study);
  }

  private async reclaimStaleLock(): Promise<void> {
    const observed = await this.readLockSnapshot();
    if (!observed) return;

    if (
      observed.entries.length === 1 &&
      observed.owner !== undefined &&
      observed.ownerFile !== undefined
    ) {
      if (isProcessAlive(observed.owner.pid)) return;
      const current = await this.readLockSnapshot();
      if (
        !current ||
        !sameLockSnapshot(current, observed) ||
        current.owner === undefined ||
        current.ownerFile === undefined ||
        isProcessAlive(current.owner.pid)
      ) {
        return;
      }

      try {
        await fs.unlink(join(this.paths.lock, current.ownerFile));
      } catch (error) {
        // Another contender may have reclaimed the exact same dead owner
        // between our final read and unlink. Let this acquirer retry instead
        // of turning ordinary recovery contention into a storage failure.
        if (isMissing(error)) return;
        throw error;
      }
      try {
        await fs.rmdir(this.paths.lock);
      } catch (error) {
        if (!isMissing(error) && !hasErrorCode(error, 'ENOTEMPTY')) throw error;
      }
      await syncDirectory(this.paths.study);
      return;
    }

    // Unknown files, malformed owner records, and multi-owner directories are
    // never deleted automatically. Only an unchanged, genuinely empty lock
    // directory can be treated as a publisher that died before owner rename.
    if (observed.entries.length !== 0 || !isOldEnough(observed.mtimeMs, this.orphanLockStaleMs)) {
      return;
    }
    const current = await this.readLockSnapshot();
    if (
      !current ||
      current.entries.length !== 0 ||
      !sameDirectoryGeneration(current, observed) ||
      !isOldEnough(current.mtimeMs, this.orphanLockStaleMs)
    ) {
      return;
    }
    try {
      await fs.rmdir(this.paths.lock);
    } catch (error) {
      if (!isMissing(error) && !hasErrorCode(error, 'ENOTEMPTY')) throw error;
    }
    await syncDirectory(this.paths.study);
  }

  private async removeEmptyOwnedLock(): Promise<void> {
    const snapshot = await this.readLockSnapshot();
    if (!snapshot || snapshot.entries.length !== 0) return;
    try {
      await fs.rmdir(this.paths.lock);
    } catch (error) {
      if (!isMissing(error) && !hasErrorCode(error, 'ENOTEMPTY')) throw error;
    }
    await syncDirectory(this.paths.study);
  }

  private async readLockSnapshot(): Promise<LockSnapshot | undefined> {
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(this.paths.lock);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing symbolic-link habit-learning lock: ${this.paths.lock}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Habit-learning lock is not a directory: ${this.paths.lock}`);
    }

    let entries: string[];
    try {
      entries = (await fs.readdir(this.paths.lock)).sort();
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }

    const snapshot: LockSnapshot = {
      dev: stat.dev,
      ino: stat.ino,
      entries,
      mtimeMs: stat.mtimeMs,
    };
    if (entries.length !== 1) return snapshot;

    const ownerFile = entries[0];
    if (ownerFile === undefined || !isLockOwnerFile(ownerFile)) return snapshot;
    const ownerPath = join(this.paths.lock, ownerFile);
    let ownerStat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      ownerStat = await fs.lstat(ownerPath);
    } catch (error) {
      if (isMissing(error)) return this.readLockSnapshot();
      throw error;
    }
    if (ownerStat.isSymbolicLink() || !ownerStat.isFile()) return snapshot;

    let raw: string;
    try {
      raw = await readRegularFile(ownerPath, 'habit-learning lock owner');
    } catch (error) {
      if (isMissing(error)) return this.readLockSnapshot();
      throw error;
    }
    const owner = parseLockOwner(raw);
    if (owner === undefined || lockOwnerFile(owner.token) !== ownerFile) return snapshot;
    return { ...snapshot, owner, ownerFile };
  }
}

function serializeState(state: unknown): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(state, null, 2);
  } catch (error) {
    throw new TypeError('Habit-learning state must be JSON-serializable', { cause: error });
  }
  if (serialized === undefined) {
    throw new TypeError('Habit-learning state must be JSON-serializable');
  }
  return `${serialized}\n`;
}

function serializeJournalRecord(record: Readonly<Record<string, unknown>>, index: number): string {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    throw new TypeError(`Habit-learning journal record ${index} must be a JSON object`);
  }

  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(record);
  } catch (error) {
    throw new TypeError(`Habit-learning journal record ${index} must be JSON-serializable`, {
      cause: error,
    });
  }
  if (serialized === undefined) {
    throw new TypeError(`Habit-learning journal record ${index} must be JSON-serializable`);
  }

  let normalized: unknown;
  try {
    normalized = JSON.parse(serialized);
  } catch (error) {
    throw new TypeError(`Habit-learning journal record ${index} produced invalid JSON`, {
      cause: error,
    });
  }
  if (typeof normalized !== 'object' || normalized === null || Array.isArray(normalized)) {
    throw new TypeError(`Habit-learning journal record ${index} must serialize to a JSON object`);
  }
  return `${serialized}\n`;
}

async function readPrivateFileIfPresent(path: string, label: string): Promise<string | undefined> {
  try {
    return await readRegularFile(path, label);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function readRegularFile(path: string, label: string): Promise<string> {
  await assertRegularFileOrMissing(path, label);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    try {
      handle = await fs.open(path, numericOpenFlags('read'));
    } catch (error) {
      if (hasErrorCode(error, 'ELOOP')) {
        throw new Error(`Refusing symbolic-link ${label}: ${path}`, { cause: error });
      }
      throw error;
    }
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`${label} is not a regular file: ${path}`);
    await handle.chmod(0o600);
    return await handle.readFile('utf8');
  } finally {
    await handle?.close();
  }
}

async function hardenRegularFileIfPresent(path: string, label: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    await assertRegularFileOrMissing(path, label);
    try {
      handle = await fs.open(path, numericOpenFlags('read'));
    } catch (error) {
      if (hasErrorCode(error, 'ELOOP')) {
        throw new Error(`Refusing symbolic-link ${label}: ${path}`, { cause: error });
      }
      throw error;
    }
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`${label} is not a regular file: ${path}`);
    await handle.chmod(0o600);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function assertRegularFileOrMissing(path: string, label: string): Promise<void> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(path);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic-link ${label}: ${path}`);
  if (!stat.isFile()) throw new Error(`${label} is not a regular file: ${path}`);
}

async function assertNotSymlinkIfPresent(path: string, label: string): Promise<void> {
  try {
    if ((await fs.lstat(path)).isSymbolicLink()) {
      throw new Error(`Refusing symbolic-link ${label}: ${path}`);
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function assertLockPathIfPresent(path: string): Promise<void> {
  try {
    await hardenPrivateDirectory(path, 'habit-learning lock');
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
}

async function hardenPrivateDirectory(path: string, label: string): Promise<void> {
  const stat = await fs.lstat(path);
  if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic-link ${label}: ${path}`);
  if (!stat.isDirectory()) throw new Error(`${label} is not a directory: ${path}`);

  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    try {
      handle = await fs.open(path, numericOpenFlags('directory-read'));
    } catch (error) {
      if (hasErrorCode(error, 'ELOOP')) {
        throw new Error(`Refusing symbolic-link ${label}: ${path}`, { cause: error });
      }
      throw error;
    }
    const openedStat = await handle.stat();
    if (!openedStat.isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
    await handle.chmod(0o700);
  } finally {
    await handle?.close();
  }
}

function numericOpenFlags(kind: 'append' | 'directory-read' | 'exclusive-write' | 'read'): number {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  if (kind === 'append') {
    return fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | noFollow;
  }
  if (kind === 'exclusive-write') {
    return fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow;
  }
  if (kind === 'directory-read') {
    return fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | noFollow;
  }
  return fsConstants.O_RDONLY | noFollow;
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
      !Number.isFinite(Date.parse(value.createdAt)) ||
      Object.keys(value).length !== 3
    ) {
      return undefined;
    }
    return { token: value.token, pid: value.pid, createdAt: value.createdAt };
  } catch {
    return undefined;
  }
}

function isLockOwnerFile(name: string): boolean {
  const match = /^owner-(.+)\.json$/.exec(name);
  return match?.[1] !== undefined && UUID_PATTERN.test(match[1]);
}

function lockOwnerFile(token: string): string {
  return `owner-${token}.json`;
}

function sameOwner(left: LockOwner, right: LockOwner): boolean {
  return left.token === right.token && left.pid === right.pid && left.createdAt === right.createdAt;
}

function sameDirectoryGeneration(left: LockSnapshot, right: LockSnapshot): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameLockSnapshot(left: LockSnapshot, right: LockSnapshot): boolean {
  return (
    sameDirectoryGeneration(left, right) &&
    left.entries.length === right.entries.length &&
    left.entries.every((entry, index) => entry === right.entries[index]) &&
    left.owner !== undefined &&
    right.owner !== undefined &&
    sameOwner(left.owner, right.owner) &&
    left.ownerFile === right.ownerFile
  );
}

function isOldEnough(mtimeMs: number, staleMs: number): boolean {
  const ageMs = Date.now() - mtimeMs;
  return ageMs >= staleMs;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM proves that the PID exists. Unknown errors are conservatively
    // treated as live so storage cannot steal a lock from a possible writer.
    return !hasErrorCode(error, 'ESRCH');
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(path, 'r');
    await handle.sync();
  } catch (error) {
    if (
      !hasErrorCode(error, 'EINVAL') &&
      !hasErrorCode(error, 'EISDIR') &&
      !hasErrorCode(error, 'ENOTSUP') &&
      !hasErrorCode(error, 'EPERM')
    ) {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await fs.unlink(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isMissing(error: unknown): boolean {
  return hasErrorCode(error, 'ENOENT');
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === code
  );
}
