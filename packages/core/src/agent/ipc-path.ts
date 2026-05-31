import { createHash } from 'node:crypto';
import { join } from 'node:path';

export type AgentEndpointKind = 'unix' | 'pipe';

export interface AgentEndpoint {
  kind: AgentEndpointKind;
  /** Absolute path (POSIX) or `\\.\pipe\…` name (Windows). */
  path: string;
}

export interface ResolveAgentEndpointInput {
  host: string;
  baseDir: string;
  platform: NodeJS.Platform;
}

/**
 * Map a gateway host URL to the local IPC endpoint its per-host agent listens on.
 *
 * The hash collapses the URL to 8 hex chars (32 bits of sha256) — collision risk
 * is irrelevant for a single user managing one or two gateways, and the short
 * form keeps the POSIX socket path under the OS-imposed 104-byte limit.
 *
 * Platform is injected (not read from `process.platform`) so callers from a
 * non-target platform — or tests — can resolve either form deterministically.
 */
export function resolveAgentEndpoint(input: ResolveAgentEndpointInput): AgentEndpoint {
  const hash = createHash('sha256').update(input.host).digest('hex').slice(0, 8);
  if (input.platform === 'win32') {
    return { kind: 'pipe', path: `\\\\.\\pipe\\xgg-agent-${hash}` };
  }
  return { kind: 'unix', path: join(input.baseDir, `agent-${hash}.sock`) };
}
