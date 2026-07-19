import { dirname } from 'node:path';
import { assertAgentIdentity } from '../agent/identity.js';
import { createIpcClient } from '../agent/ipc-client.js';
import { defaultAgentRuntimeDir } from '../agent/ipc-path.js';
import { createFileMutationLeaseCoordinator } from '../agent/mutation-lease.js';
import type { StoredSession } from '../schemas/session.js';
import type { SessionStore } from '../session/index.js';
import { AuthRequiredError, NetworkError } from '../transport/errors.js';

export type SignalFn = (pid: number, signal: NodeJS.Signals | 0) => boolean;

/** Subset of the `$ping` reply logout needs to confirm daemon identity. */
export interface LogoutLiveness {
  /** `agentStartedAt` the live daemon reports (null if it omits it). */
  agentStartedAt: string | null;
  /** Production probe result after validating canonical host + daemon start. */
  identityMatches?: boolean;
  /** Ambiguous `$shutdown.prepare` failure after a matched `$ping`. */
  prepareError?: unknown;
  /** Ask a matched/prepared daemon to stop through this pinned IPC connection. */
  requestShutdown?: () => Promise<void>;
  /** Resolve only after the prepared daemon-side IPC connection has closed. */
  waitForClose?: () => Promise<void>;
  /** Release the shutdown-preparation connection (real probe only). */
  close?: () => void;
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
  /** Maximum wait for an in-flight mutation before shutdown. Default 60_000. */
  mutationWaitMs?: number;
  /** Stable host-lock directory. Defaults to the recorded socket's directory. */
  mutationLockDir?: string;
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
 * Production shutdown is requested through the same IPC connection whose
 * canonical host + `agentStartedAt` identity was verified before
 * `$shutdown.prepare`; this avoids signalling a bare pid that may be recycled.
 * The signal seam remains for older/custom probes. When the probe can't
 * confirm our daemon, we only remove the orphaned session (and recover a
 * durable write fence) after confirming the recorded pid is dead.
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

  const mutationWaitMs = input.mutationWaitMs ?? 60_000;
  const probe = input.probe ?? defaultProbe(input.probeTimeoutMs ?? 2000, mutationWaitMs, entry);
  const live = await probe(entry.socketPath);
  const isOurDaemon =
    live !== null && (live.identityMatches ?? live.agentStartedAt === entry.agentStartedAt);

  const sig = input.signal ?? defaultSignal;
  if (live === null) {
    if (sig(entry.pid, 0)) {
      throw new NetworkError(
        'recorded agent pid is still alive but its IPC socket is unreachable',
        {
          hint: 'do not clear the session or mutation fence until the recorded process has exited',
        },
      );
    }

    // A daemon may have died after sending a write but before observing its
    // acknowledgement/readback. Recover that persistent fence under the same
    // stable per-host bakery ticket used by live daemons, so a replacement
    // cannot mutate concurrently with this one-shot offline logout recovery.
    await recoverPersistentMutationFences(input, entry, mutationWaitMs);
    await input.store.deleteIfMatch(entry);
    return { ok: true, host: input.baseUrl, wasRunning: false };
  }

  let wasRunning = false;
  try {
    if (isOurDaemon && live.prepareError !== undefined) {
      if (sig(entry.pid, 0)) {
        throw new NetworkError('agent shutdown preparation was not confirmed while its pid lives', {
          hint:
            live.prepareError instanceof Error
              ? live.prepareError.message
              : String(live.prepareError),
        });
      }
      await recoverPersistentMutationFences(input, entry, mutationWaitMs);
      await input.store.deleteIfMatch(entry);
      return { ok: true, host: input.baseUrl, wasRunning: false };
    }

    if (isOurDaemon && live.requestShutdown) {
      wasRunning = true;
      try {
        await live.requestShutdown();
      } catch (error) {
        // A lost commit response can mean the daemon exited between processing
        // the self-stop and acknowledging it. Recover only when its pid is now
        // definitely dead; a live pid fails closed.
        if (live.waitForClose) {
          await localTimeout(
            live.waitForClose(),
            mutationWaitMs + 250,
            'agent IPC close timeout after ambiguous shutdown commit',
          ).catch(() => {});
        }
        if (!(await waitForPidExit(entry.pid, sig, mutationWaitMs))) {
          throw new NetworkError('agent IPC shutdown request was not confirmed', {
            hint: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } else {
      wasRunning = isOurDaemon ? sig(entry.pid, 'SIGTERM') : false;
    }
    if (isOurDaemon && live.waitForClose) {
      try {
        await localTimeout(
          live.waitForClose(),
          mutationWaitMs + 250,
          'agent shutdown confirmation timeout',
        );
      } catch (error) {
        throw new NetworkError('agent did not confirm shutdown after the logout signal', {
          hint: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (isOurDaemon) {
      // IPC closes before runAgent stops its gateway router/transport and
      // releases the stable ticket. Reacquire that ticket before returning:
      // this both waits through normal cleanup and recovers a durable fence if
      // the daemon crashed after closing IPC but before releasing its lease.
      await recoverPersistentMutationFences(input, entry, mutationWaitMs);
    }

    // The probe and signal happen without the session-file lock. A replacement
    // login can publish a new daemon while either is in flight, so logout must
    // only remove the exact entry it originally inspected.
    await input.store.deleteIfMatch(entry);
    return { ok: true, host: input.baseUrl, wasRunning };
  } finally {
    live?.close?.();
  }
}

async function recoverPersistentMutationFences(
  input: LogoutInputs,
  entry: StoredSession,
  waitTimeoutMs: number,
): Promise<void> {
  const mutationLeases = createFileMutationLeaseCoordinator({
    host: input.baseUrl,
    baseDir:
      input.mutationLockDir ??
      (entry.socketPath.startsWith('\\\\.\\pipe\\')
        ? defaultAgentRuntimeDir()
        : dirname(entry.socketPath)),
  });
  try {
    await mutationLeases.prepareShutdown('logout-fence-recovery', waitTimeoutMs);
    mutationLeases.commitShutdown('logout-fence-recovery');
    mutationLeases.beginDaemonShutdown();
  } finally {
    await mutationLeases.close();
  }
}

function defaultSignal(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM' && signal === 0) return true;
    // EPERM (we don't own the pid) or unknown — re-throw so the CLI surfaces it.
    throw e;
  }
}

function defaultProbe(
  timeoutMs: number,
  mutationWaitMs: number,
  expected: StoredSession,
): LogoutProbe {
  return async (socketPath) => {
    const client = createIpcClient({ path: socketPath });
    let payload: {
      host?: unknown;
      agentStartedAt?: string | null;
      shutdownViaIpc?: unknown;
    };
    try {
      payload = (await localTimeout(
        client.request('$ping', null),
        timeoutMs,
        'probe timeout',
      )) as typeof payload;
    } catch {
      client.close();
      return null;
    }
    const shutdownViaIpc = payload.shutdownViaIpc === true;
    try {
      assertAgentIdentity(payload, expected);
    } catch {
      client.close();
      return {
        agentStartedAt: payload.agentStartedAt ?? null,
        identityMatches: false,
      };
    }
    if (!shutdownViaIpc) {
      // Backward compatibility: older daemons do not implement the two-step
      // self-stop protocol. Do not send an unknown meta-method; return the
      // matched connection for the existing SIGTERM fallback.
      return {
        agentStartedAt: payload.agentStartedAt ?? null,
        identityMatches: true,
        waitForClose: () => client.waitForClose?.() ?? Promise.resolve(),
        close: () => client.close(),
      };
    }
    try {
      // This connection now blocks new mutation acquisitions and waits for a
      // live workflow to release. A fenced workflow is immediately eligible
      // for shutdown, making logout the explicit ambiguity-recovery path.
      await localTimeout(
        client.request('$shutdown.prepare', { waitTimeoutMs: mutationWaitMs }),
        mutationWaitMs + 250,
        'mutation shutdown wait timeout',
      );
      return {
        agentStartedAt: payload.agentStartedAt ?? null,
        identityMatches: true,
        ...(shutdownViaIpc && {
          requestShutdown: async () => {
            await localTimeout(
              client.request('$shutdown.commit', null),
              timeoutMs,
              'agent IPC shutdown request timeout',
            );
          },
        }),
        waitForClose: () => client.waitForClose?.() ?? Promise.resolve(),
        close: () => client.close(),
      };
    } catch (error) {
      client.close();
      return {
        agentStartedAt: payload.agentStartedAt ?? null,
        identityMatches: true,
        prepareError: error,
        close: () => client.close(),
      };
    }
  };
}

async function waitForPidExit(
  pid: number,
  signal: SignalFn,
  waitTimeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + waitTimeoutMs;
  while (Date.now() < deadline) {
    if (!signal(pid, 0)) return true;
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, deadline - Date.now())));
  }
  return !signal(pid, 0);
}

async function localTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    });
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
