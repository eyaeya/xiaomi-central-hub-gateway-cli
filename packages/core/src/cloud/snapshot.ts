// SPDX-License-Identifier: GPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface CloudSnapshotInput {
  operation: string;
  target: Record<string, unknown>;
  request: Record<string, unknown>;
  before?: unknown;
  snapshotsDir?: string;
}

/** Device write checkpoints are private audit records, not action rollback backups. */
export async function writeCloudSnapshot(input: CloudSnapshotInput): Promise<string> {
  const root = resolve(input.snapshotsDir ?? join(homedir(), '.xgg', 'snapshots', 'cloud'));
  const timestamp = new Date().toISOString();
  const dir = join(root, `cloud-${timestamp.replace(/[:.]/g, '-')}-${randomUUID()}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'operation.json');
  await writeFile(
    path,
    `${JSON.stringify(
      {
        version: 1,
        domain: 'cloud',
        timestamp,
        operation: input.operation,
        target: input.target,
        request: input.request,
        ...(input.before !== undefined && { before: input.before }),
        rollbackAvailable: false,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600, flag: 'wx' },
  );
  return path;
}
