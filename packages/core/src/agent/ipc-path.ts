import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
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
 * Canonical identity of the gateway endpoint the agent actually connects to.
 *
 * Gateway WebSocket traffic always targets the fixed `/centrallinkws/` path,
 * so user-supplied paths, queries, fragments and trailing slashes are not part
 * of the gateway identity. URL parsing also normalises hostname case and
 * default ports for us.
 */
export function canonicalGatewayKey(host: string): string {
  const url = new URL(host);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('gateway host must use http: or https:');
  }
  const scheme = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${url.host}`;
}

/** Private-by-default POSIX runtime directory for agent Unix sockets. */
export function defaultAgentRuntimeDir(): string {
  const xdgRuntimeDir = process.env.XDG_RUNTIME_DIR;
  if (xdgRuntimeDir) return join(xdgRuntimeDir, 'xgg');
  return join(homedir(), '.xgg', 'run');
}

/**
 * Map a gateway host URL to the local IPC endpoint its per-host agent listens on.
 *
 * The hash uses 128 bits of SHA-256 over the canonical WebSocket origin. That
 * keeps accidental collisions impractical while retaining a short enough
 * basename for the POSIX socket path limit.
 *
 * Platform is injected (not read from `process.platform`) so callers from a
 * non-target platform — or tests — can resolve either form deterministically.
 */
export function resolveAgentEndpoint(input: ResolveAgentEndpointInput): AgentEndpoint {
  const gatewayKey = canonicalGatewayKey(input.host);
  const hash = createHash('sha256').update(gatewayKey).digest('hex').slice(0, 32);
  if (input.platform === 'win32') {
    return { kind: 'pipe', path: `\\\\.\\pipe\\xgg-agent-${hash}` };
  }
  return { kind: 'unix', path: join(input.baseDir, `agent-${hash}.sock`) };
}
