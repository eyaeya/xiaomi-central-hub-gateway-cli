import { dirname } from 'node:path';
import { NetworkError, NotConfirmedError } from '../transport/errors.js';
import type { HandshakeResult } from '../transport/handshake.js';
import type { BinaryTransport } from '../transport/index.js';
import { JsonRpcRouter, SessionChannel } from '../transport/index.js';
import { defaultAgentRuntimeDir } from './ipc-path.js';
import { type IpcServerHandle, createIpcServer } from './ipc-server.js';
import { createFileMutationLeaseCoordinator } from './mutation-lease.js';

export interface RunAgentOptions {
  host: string;
  transport: BinaryTransport;
  handshake: HandshakeResult;
  socketPath: string;
  /** Stable runtime directory shared by replacement daemons for the host lease. */
  mutationLockDir?: string;
  /** Inactivity window after which the agent exits cleanly. */
  idleMs: number;
  /** Optional per-call timeout for forwarded JSON-RPC requests. Default 10_000. */
  rpcTimeoutMs?: number;
  /** Optional agent metadata returned by the `$ping` meta-method. */
  meta?: { agentStartedAt: string; agentVersion: string };
  /** Test seam: defaults to the real local IPC server factory. */
  createServer?: typeof createIpcServer;
}

export interface AgentHandle {
  socketPath: string;
  /** Resolves once the agent has fully exited (idle timeout, stop(), or WS drop). */
  done: Promise<void>;
  /** Trigger a graceful shutdown. Idempotent. */
  stop: () => Promise<void>;
}

/**
 * Long-lived per-host agent: owns one authenticated WS (via BinaryTransport +
 * HandshakeResult) and serves CLI commands over a local IPC socket. Exits when
 * any of:
 *
 *   - `stop()` is called,
 *   - `idleMs` elapses with no IPC request,
 *   - the WS dies (router read loop fails).
 *
 * Each IPC request is forwarded to the gateway as a JSON-RPC call through the
 * shared `JsonRpcRouter`. Errors from the router (timeouts, gateway errors)
 * propagate to the IPC client via the same envelope shape as direct calls.
 */
export async function runAgent(opts: RunAgentOptions): Promise<AgentHandle> {
  const channel = new SessionChannel({
    send: opts.handshake.clientSend,
    recv: opts.handshake.clientRecv,
  });
  const router = new JsonRpcRouter({
    transport: opts.transport,
    channel,
    defaultTimeoutMs: opts.rpcTimeoutMs ?? 10_000,
  });
  const mutationLeases = createFileMutationLeaseCoordinator({
    host: opts.host,
    baseDir:
      opts.mutationLockDir ??
      (opts.socketPath.startsWith('\\\\.\\pipe\\')
        ? defaultAgentRuntimeDir()
        : dirname(opts.socketPath)),
  });
  let stopping = false;
  let cleanupPromise: Promise<void> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let idleDeadline = Date.now() + opts.idleMs;
  let lastActivityAt = new Date().toISOString();
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });

  let server: IpcServerHandle | null = null;

  const cleanup = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    stopping = true;
    cleanupPromise = (async () => {
      const errors: unknown[] = [];
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
      // Freeze the current ticket before stopping accept. Durable write fences
      // remain owned until the old gateway router/transport is fully stopped.
      mutationLeases.beginDaemonShutdown();
      if (server) {
        try {
          await server.close();
        } catch (e) {
          errors.push(e);
        }
        server = null;
      }
      let transportQuiesced = false;
      try {
        await router.stop();
        transportQuiesced = true;
      } catch (e) {
        errors.push(e);
      }
      if (transportQuiesced) {
        try {
          await mutationLeases.close();
        } catch (e) {
          errors.push(e);
        }
      }
      // Otherwise fail closed: an unverified physical transport close may
      // still flush old frames. Preserve the ticket/fence until process death
      // makes it stale-reclaimable instead of admitting a replacement daemon.
      resolveDone();
      if (errors.length > 0) {
        throw new AggregateError(errors, 'agent cleanup failed');
      }
    })();
    return cleanupPromise;
  };

  const resetIdle = (): void => {
    if (stopping) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleDeadline = Date.now() + opts.idleMs;
    lastActivityAt = new Date().toISOString();
    idleTimer = setTimeout(() => {
      // A live holder must not lose its lease halfway through a slow gateway
      // workflow. A fenced holder is intentionally recoverable via explicit
      // logout, so idle expiry stops its transport while preserving the
      // durable fence for that recovery path.
      if (mutationLeases.status().active && !mutationLeases.status().fenced) {
        resetIdle();
      } else {
        void cleanup().catch(() => {});
      }
    }, opts.idleMs);
  };

  try {
    router.start();
    server = await (opts.createServer ?? createIpcServer)({
      path: opts.socketPath,
      mutationLeases,
      closeMutationLeases: false,
      onShutdown: () => {
        void cleanup().catch(() => {});
      },
      handler: async ({ method, params, timeoutMs, kind }, context) => {
        const isMeta = method.startsWith('$');
        // Only renew the idle window on real gateway traffic. Cheap meta probes
        // (status, health checks) must not keep the daemon alive indefinitely.
        if (!isMeta) resetIdle();
        if (method === '$ping') {
          return {
            ok: true,
            host: opts.host,
            agentStartedAt: opts.meta?.agentStartedAt ?? null,
            agentVersion: opts.meta?.agentVersion ?? null,
            shutdownViaIpc: true,
            idleMs: opts.idleMs,
            idleMsRemaining: Math.max(0, idleDeadline - Date.now()),
            lastActivityAt,
            mutationLease: mutationLeases.status(),
          };
        }
        // Forward to the gateway honouring the caller's deadline (so `--timeout`
        // isn't silently clamped to the router default) and classifying a timeout
        // by call kind: a write that times out *after* being sent is "not
        // confirmed" (state may or may not have applied), not a plain network
        // failure. That distinction survives the IPC boundary via reviveError.
        try {
          return await router.request(method, params, {
            ...(timeoutMs !== undefined && { timeoutMs }),
            onTimeout: (ms) =>
              kind === 'write'
                ? new NotConfirmedError(
                    `gateway call ${method} was not confirmed within ${ms}ms (the write may or may not have applied)`,
                    { method },
                  )
                : new NetworkError(`gateway call ${method} timed out after ${ms}ms`),
          });
        } catch (error) {
          if (error instanceof NotConfirmedError) {
            context?.fenceMutation(`gateway write ${method} was not confirmed`);
          }
          throw error;
        }
      },
    });

    resetIdle();
  } catch (originalError) {
    try {
      await cleanup();
    } catch {
      // Rollback is best-effort; the bootstrap failure remains the root cause.
    }
    throw originalError;
  }

  // WS drop / unrecoverable decrypt failure → router.done resolves → cleanup.
  void router.done.then(() => cleanup()).catch(() => {});

  return {
    socketPath: opts.socketPath,
    done,
    stop: cleanup,
  };
}
