import { assertAgentIdentity } from '../agent/identity.js';
import { createIpcClient } from '../agent/ipc-client.js';
import type { SessionStore } from '../session/index.js';

export interface PingPayload {
  host: string;
  agentStartedAt: string;
  idleMs?: number;
  idleMsRemaining?: number;
  lastActivityAt?: string;
}

export type IpcProbe = (socketPath: string) => Promise<PingPayload | null>;

export interface StatusInputs {
  baseUrl: string;
  store: SessionStore;
  /** Test seam: defaults to a real `$ping` over the IPC socket. */
  probe?: IpcProbe;
  /** Probe timeout in ms (default 1000). */
  probeTimeoutMs?: number;
}

export interface StatusResult {
  ok: true;
  host: string;
  pid: number;
  socketPath: string;
  agentStartedAt: string;
  agentVersion: string;
  lastValidatedAt: string;
  /** Whether the IPC `$ping` succeeded against the recorded socket. */
  live: boolean;
  /** Configured idle window in ms (sliding since last gateway call). */
  idleMs?: number;
  /** ms left before the daemon would exit if no further gateway call arrives. */
  idleMsRemaining?: number;
  /** ISO timestamp of the last non-meta IPC request the daemon served. */
  lastActivityAt?: string;
}

/**
 * Report what we know about the per-host agent: stored metadata from the
 * session file plus a live IPC liveness check. A stale entry (live: false)
 * means the agent is gone and the user should `xgg logout && xgg login`.
 */
export async function status(input: StatusInputs): Promise<StatusResult> {
  const s = await input.store.read(input.baseUrl);
  const probe = input.probe ?? defaultProbe(input.probeTimeoutMs ?? 1000);
  const ping = await probe(s.socketPath);
  if (ping !== null) assertAgentIdentity(ping, s);
  return {
    ok: true,
    host: s.host,
    pid: s.pid,
    socketPath: s.socketPath,
    agentStartedAt: s.agentStartedAt,
    agentVersion: s.agentVersion,
    lastValidatedAt: s.lastValidatedAt,
    live: ping !== null,
    ...(ping?.idleMs !== undefined && { idleMs: ping.idleMs }),
    ...(ping?.idleMsRemaining !== undefined && { idleMsRemaining: ping.idleMsRemaining }),
    ...(ping?.lastActivityAt !== undefined && { lastActivityAt: ping.lastActivityAt }),
  };
}

function defaultProbe(timeoutMs: number): IpcProbe {
  return async (socketPath) => {
    const client = createIpcClient({ path: socketPath });
    try {
      const ping = client.request('$ping', null);
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('probe timeout')), timeoutMs),
      );
      const payload = (await Promise.race([ping, timeout])) as PingPayload;
      return payload;
    } catch {
      return null;
    } finally {
      client.close();
    }
  };
}
