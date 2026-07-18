import { createIpcClient } from '../agent/ipc-client.js';
import type { StoredSession } from '../schemas/session.js';
import type { SessionStore } from '../session/index.js';
import { AuthRequiredError } from '../transport/errors.js';

export type SignalFn = (pid: number, signal: NodeJS.Signals | 0) => boolean;

/** Subset of the `$ping` reply logout needs to confirm daemon identity. */
export interface LogoutLiveness {
  /** `agentStartedAt` the live daemon reports (null if it omits it). */
  agentStartedAt: string | null;
}

/** Probe the recorded socket for a live daemon. Resolves null when unreachable. */
export type LogoutProbe = (socketPath: string) => Promise<LogoutLiveness | null>;

export interface LogoutInputs {
  baseUrl: string;
  store: SessionStore;
  /** Test seam: defaults to `process.kill`. Returns `false` on ESRCH. */
  signal?: SignalFn;
  /** Test seam: defaults to a real `$ping` over the recorded socket. */
  probe?: LogoutProbe;
  /**
   * Probe timeout in ms (default 2000 — a touch more grace than status.ts's
   * 1000ms because logout *acts* on the result: we'd rather wait a beat than
   * wrongly decide the daemon is gone and skip the kill). A reachable daemon
   * answers the local `$ping` in well under a millisecond (the socket connect
   * itself resolves/rejects immediately — it's a unix socket / named pipe, not
   * TCP), so this bound only ever bites a wedged daemon.
   */
  probeTimeoutMs?: number;
}

export interface LogoutResult {
  ok: true;
  host: string;
  /** Whether a live, identity-matched agent was found and signalled at logout. */
  wasRunning: boolean;
}

/**
 * Tear down the per-host agent and remove its session entry.
 *
 * Idempotent: if no session is recorded for `baseUrl`, raises
 * `AuthRequiredError`.
 *
 * We only `SIGTERM` the recorded pid when a live daemon answers `$ping` on the
 * recorded socket *and* identifies itself as the same instance the session
 * describes (its `agentStartedAt` matches). A bare pid is not safe to signal:
 * after a crash or reboot the session file keeps a stale pid that the OS may
 * have recycled for an unrelated (same-user) process — killing it would be
 * collateral damage. When the probe can't confirm our daemon, we skip the
 * signal and conditionally drop the (now-orphaned) session entry; any
 * genuinely-alive daemon we couldn't reach will still self-exit on its idle
 * timeout and clean up its per-instance socket.
 */
export async function logout(input: LogoutInputs): Promise<LogoutResult> {
  let entry: StoredSession;
  try {
    entry = await input.store.read(input.baseUrl);
  } catch (e) {
    if (e instanceof AuthRequiredError) {
      throw new AuthRequiredError(`no session for ${input.baseUrl}`);
    }
    throw e;
  }

  const probe = input.probe ?? defaultProbe(input.probeTimeoutMs ?? 2000);
  const live = await probe(entry.socketPath);
  const isOurDaemon = live !== null && live.agentStartedAt === entry.agentStartedAt;

  const sig = input.signal ?? defaultSignal;
  const wasRunning = isOurDaemon ? sig(entry.pid, 'SIGTERM') : false;

  // The probe and signal happen without the session-file lock. A replacement
  // login can publish a new daemon while either is in flight, so logout must
  // only remove the exact entry it originally inspected.
  await input.store.deleteIfMatch(entry);
  return { ok: true, host: input.baseUrl, wasRunning };
}

function defaultSignal(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    // EPERM (we don't own the pid) or unknown — re-throw so the CLI surfaces it.
    throw e;
  }
}

function defaultProbe(timeoutMs: number): LogoutProbe {
  return async (socketPath) => {
    const client = createIpcClient({ path: socketPath });
    try {
      const ping = client.request('$ping', null);
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('probe timeout')), timeoutMs),
      );
      const payload = (await Promise.race([ping, timeout])) as {
        agentStartedAt?: string | null;
      };
      return { agentStartedAt: payload.agentStartedAt ?? null };
    } catch {
      return null;
    } finally {
      client.close();
    }
  };
}
