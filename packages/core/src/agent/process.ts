import { NetworkError, NotConfirmedError } from '../transport/errors.js';
import type { HandshakeResult } from '../transport/handshake.js';
import type { BinaryTransport } from '../transport/index.js';
import { JsonRpcRouter, SessionChannel } from '../transport/index.js';
import { type IpcServerHandle, createIpcServer } from './ipc-server.js';

export interface RunAgentOptions {
  host: string;
  transport: BinaryTransport;
  handshake: HandshakeResult;
  socketPath: string;
  /** Inactivity window after which the agent exits cleanly. */
  idleMs: number;
  /** Optional per-call timeout for forwarded JSON-RPC requests. Default 10_000. */
  rpcTimeoutMs?: number;
  /** Optional agent metadata returned by the `$ping` meta-method. */
  meta?: { agentStartedAt: string; agentVersion: string };
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
  router.start();

  let stopping = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let idleDeadline = Date.now() + opts.idleMs;
  let lastActivityAt = new Date().toISOString();
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });

  let server: IpcServerHandle | null = null;

  const cleanup = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    if (idleTimer) clearTimeout(idleTimer);
    if (server) await server.close();
    await router.stop();
    opts.transport.close();
    resolveDone();
  };

  const resetIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleDeadline = Date.now() + opts.idleMs;
    lastActivityAt = new Date().toISOString();
    idleTimer = setTimeout(() => {
      void cleanup();
    }, opts.idleMs);
  };

  server = await createIpcServer({
    path: opts.socketPath,
    handler: async ({ method, params, timeoutMs, kind }) => {
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
          idleMs: opts.idleMs,
          idleMsRemaining: Math.max(0, idleDeadline - Date.now()),
          lastActivityAt,
        };
      }
      // Forward to the gateway honouring the caller's deadline (so `--timeout`
      // isn't silently clamped to the router default) and classifying a timeout
      // by call kind: a write that times out *after* being sent is "not
      // confirmed" (state may or may not have applied), not a plain network
      // failure. That distinction survives the IPC boundary via reviveError.
      return router.request(method, params, {
        ...(timeoutMs !== undefined && { timeoutMs }),
        onTimeout: (ms) =>
          kind === 'write'
            ? new NotConfirmedError(
                `gateway call ${method} was not confirmed within ${ms}ms (the write may or may not have applied)`,
                { method },
              )
            : new NetworkError(`gateway call ${method} timed out after ${ms}ms`),
      });
    },
  });

  resetIdle();

  // WS drop / unrecoverable decrypt failure → router.done resolves → cleanup.
  void router.done.then(() => cleanup());

  return {
    socketPath: opts.socketPath,
    done,
    stop: cleanup,
  };
}
