import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { SessionStore } from '../session/index.js';
import type { IpcClientFactory } from './agent-call.js';
import { dumpAll } from './dump-all.js';
import { defaultSnapshotsDir } from './snapshots-dir.js';

export interface DumpBeforeWriteInputs {
  baseUrl: string;
  store: SessionStore;
  ipcClient?: IpcClientFactory;
  timeoutMs?: number;
  /**
   * Directory under which `<iso>/dump.json` is written.
   * Default: `defaultSnapshotsDir(baseUrl)` — `~/.xgg/snapshots/<host-hash>/`.
   */
  snapshotsDir?: string;
}

export async function dumpBeforeWrite(input: DumpBeforeWriteInputs): Promise<string> {
  const dump = await dumpAll({
    baseUrl: input.baseUrl,
    store: input.store,
    ...(input.ipcClient !== undefined && { ipcClient: input.ipcClient }),
    ...(input.timeoutMs !== undefined && { timeoutMs: input.timeoutMs }),
  });
  const dir = resolve(input.snapshotsDir ?? defaultSnapshotsDir(input.baseUrl));
  const iso = new Date().toISOString().replace(/[:.]/g, '-');
  const snapshotDir = join(dir, iso);
  await mkdir(snapshotDir, { recursive: true });
  const path = join(snapshotDir, 'dump.json');
  await writeFile(path, JSON.stringify(dump, null, 2), { mode: 0o600 });
  return path;
}
