import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { SessionStore } from '../session/index.js';
import type { IpcClientFactory } from './agent-call.js';
import { type RollbackBackupContext, collectRollbackSnapshot } from './rollback-snapshot.js';
import { defaultSnapshotsDir } from './snapshots-dir.js';

export interface DumpBeforeWriteInputs {
  baseUrl: string;
  store: SessionStore;
  ipcClient?: IpcClientFactory;
  timeoutMs?: number;
  /**
   * Directory under which `<iso>-<uuid>/dump.json` is written.
   * Default: `defaultSnapshotsDir(baseUrl)` — `~/.xgg/snapshots/<host-hash>/`.
   */
  snapshotsDir?: string;
  /** Backup state required to roll back a backup load/delete mutation. */
  backup?: RollbackBackupContext;
}

export async function dumpBeforeWrite(input: DumpBeforeWriteInputs): Promise<string> {
  // Collect before touching the filesystem. Any missing resource makes the
  // checkpoint fail closed and leaves no path a caller could mistake for a
  // usable rollback artifact.
  const snapshot = await collectRollbackSnapshot(
    {
      baseUrl: input.baseUrl,
      store: input.store,
      ...(input.ipcClient !== undefined && { ipcClient: input.ipcClient }),
      ...(input.timeoutMs !== undefined && { timeoutMs: input.timeoutMs }),
    },
    {
      ...(input.backup !== undefined && { backup: input.backup }),
    },
  );
  const contents = JSON.stringify(snapshot, null, 2);
  const dir = resolve(input.snapshotsDir ?? defaultSnapshotsDir(input.baseUrl));
  const iso = new Date().toISOString().replace(/[:.]/g, '-');
  // UUID suffix prevents simultaneous mutations in the same millisecond from
  // sharing a path and overwriting one another's checkpoint.
  const snapshotDir = join(dir, `${iso}-${randomUUID()}`);
  const path = join(snapshotDir, 'dump.json');

  await mkdir(dir, { recursive: true, mode: 0o700 });
  await mkdir(snapshotDir, { mode: 0o700 });
  try {
    await writeAtomically(path, contents);
    return path;
  } catch (error) {
    // This directory is UUID-scoped to the current call, so removing it cannot
    // affect another checkpoint. A failed write must not leave a partial file.
    await rm(snapshotDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function writeAtomically(path: string, contents: string): Promise<void> {
  const temporaryPath = join(dirname(path), `.dump.json.${process.pid}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    await syncDirectory(dirname(path));
    await syncDirectory(dirname(dirname(path)));
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code: unknown }).code)
        : '';
    // Directory fsync is unavailable on some supported filesystems. The file
    // was still synced before the atomic rename, so only those known platform
    // limitations are safe to ignore.
    if (!['EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM'].includes(code)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}
