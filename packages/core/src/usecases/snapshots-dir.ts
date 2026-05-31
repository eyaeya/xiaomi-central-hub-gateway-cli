import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Default directory under which pre-write snapshots are written.
 * Uses the same 8-hex-char host hash as the agent IPC socket name
 * (see ipc-path.ts), so snapshot dirs and sockets for the same gateway
 * sit side by side.
 */
export function defaultSnapshotsDir(baseUrl: string): string {
  const hash = createHash('sha256').update(baseUrl).digest('hex').slice(0, 8);
  return join(homedir(), '.xgg', 'snapshots', hash);
}
