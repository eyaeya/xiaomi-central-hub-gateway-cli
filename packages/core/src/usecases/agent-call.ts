import { assertAgentIdentity } from '../agent/identity.js';
import type { IpcClient } from '../agent/ipc-client.js';
import { createIpcClient } from '../agent/ipc-client.js';
import type { SessionStore } from '../session/index.js';
import {
  AuthExpiredError,
  ConfigError,
  NetworkError,
  NotConfirmedError,
} from '../transport/errors.js';

export type IpcClientFactory = (socketPath: string) => IpcClient;
export type AgentCallKind = 'read' | 'write';

/**
 * Gateway methods already proven to mutate state by a typed core call site.
 *
 * This is a conflict detector, not an allowlist: unknown/future methods remain
 * usable with either explicit intent. Keeping the known set here prevents a
 * low-level caller from silently downgrading an established write to the
 * default read timeout semantics.
 */
export const KNOWN_GATEWAY_WRITE_METHODS: readonly string[] = Object.freeze([
  '/api/changeGraphConfig',
  '/api/createBackup',
  '/api/createVar',
  '/api/deleteBackup',
  '/api/deleteGraph',
  '/api/deleteVar',
  '/api/downloadBackup',
  '/api/loadBackup',
  '/api/setBackupConfig',
  '/api/setGraph',
  '/api/setVarConfig',
  '/api/setVarValue',
]);

export function isKnownGatewayWriteMethod(method: string): boolean {
  return KNOWN_GATEWAY_WRITE_METHODS.includes(method);
}

export function resolveAgentCallKind(method: string, requestedKind?: AgentCallKind): AgentCallKind {
  // Keep the public JavaScript entry point honest too: TypeScript callers are
  // narrowed by AgentCallKind, but runtime consumers can still pass arbitrary
  // strings. Reject them before session access instead of forwarding an
  // invalid IPC frame or applying the wrong timeout classification.
  if (requestedKind !== undefined && requestedKind !== 'read' && requestedKind !== 'write') {
    throw new ConfigError('agent call kind must be either "read" or "write"', {
      requestedKind,
    });
  }
  if (isKnownGatewayWriteMethod(method) && requestedKind !== 'write') {
    throw new ConfigError(
      `known gateway write method "${method}" requires explicit write intent (use kind "write")`,
      {
        method,
        requestedKind: requestedKind ?? null,
        requiredKind: 'write',
      },
    );
  }
  return requestedKind ?? 'read';
}

export interface AgentCallInputs {
  baseUrl: string;
  method: string;
  params: unknown;
  store: SessionStore;
  /** Test seam: defaults to a real `createIpcClient`. */
  ipcClient?: IpcClientFactory;
  /** Per-call deadline (ms) applied client-side. Default 10_000. */
  timeoutMs?: number;
  /**
   * Whether the call mutates gateway state. Known writes require explicit
   * `write`; unknown methods default to `read`. Timeout error class depends on
   * the resolved value.
   */
  kind?: AgentCallKind;
}

/**
 * Forward a JSON-RPC call to the per-host agent over its IPC socket. The
 * `params` payload is passed through verbatim; the agent's router serialises
 * and encrypts it before sending it on to the gateway.
 *
 * Failure mapping:
 *   - No session entry → `AuthRequiredError` (raised by `store.read`).
 *   - IPC connect fails (ECONNREFUSED, socket missing) → `AuthExpiredError`
 *     with a hint to re-login (the agent died; session metadata is stale).
 *   - IPC connects but the call rejects → original error propagates
 *     (`GatewayError` from the gateway, `NetworkError` for read timeouts,
 *     `NotConfirmedError` for write timeouts).
 */
export async function agentCall(input: AgentCallInputs): Promise<unknown> {
  const kind = resolveAgentCallKind(input.method, input.kind);
  const entry = await input.store.read(input.baseUrl);
  const factory = input.ipcClient ?? defaultIpcClient;
  const client = factory(entry.socketPath);
  const timeoutMs = input.timeoutMs ?? 10_000;
  try {
    const ping = await withTimeout(
      client.request('$ping', null, { timeoutMs, kind: 'read' }),
      timeoutMs,
      () => new NetworkError(`agent identity probe timed out after ${timeoutMs}ms`),
    );
    assertAgentIdentity(ping, entry);

    // Forward the deadline + kind to the daemon so its router applies the same
    // timeout (not its 10s default) and classifies a write timeout as
    // NotConfirmedError. The local timer below is a backstop for a wedged
    // daemon that never replies; both layers agree on the error class.
    return await withTimeout(
      client.request(input.method, input.params, { timeoutMs, kind }),
      timeoutMs,
      () => {
        const msg = `agent IPC call ${input.method} timed out after ${timeoutMs}ms`;
        return kind === 'write'
          ? new NotConfirmedError(msg, { method: input.method })
          : new NetworkError(msg);
      },
    );
  } catch (e) {
    if (
      e instanceof NetworkError &&
      /IPC connect failed|IPC connection closed|IPC client closed/.test(e.message)
    ) {
      throw new AuthExpiredError('agent endpoint is unreachable; the daemon likely exited', {
        host: input.baseUrl,
      });
    }
    throw e;
  } finally {
    client.close();
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutError: () => Error,
): Promise<T> {
  let timerId: ReturnType<typeof setTimeout> | undefined;
  try {
    const timer = new Promise<never>((_, reject) => {
      timerId = setTimeout(() => reject(timeoutError()), timeoutMs);
    });
    return await Promise.race([promise, timer]);
  } finally {
    if (timerId !== undefined) clearTimeout(timerId);
  }
}

function defaultIpcClient(socketPath: string): IpcClient {
  return createIpcClient({ path: socketPath });
}
