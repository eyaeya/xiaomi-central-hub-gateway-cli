import { AsyncLocalStorage } from 'node:async_hooks';
import {
  KNOWN_GATEWAY_WRITE_METHODS,
  isKnownGatewayWriteMethod,
} from '../agent/gateway-write-methods.js';
import { assertAgentIdentity } from '../agent/identity.js';
import type { IpcClient } from '../agent/ipc-client.js';
import { createIpcClient } from '../agent/ipc-client.js';
import { canonicalGatewayKey } from '../agent/ipc-path.js';
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
export { KNOWN_GATEWAY_WRITE_METHODS, isKnownGatewayWriteMethod };

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

export interface MutationWorkflowInputs {
  baseUrl: string;
  store: SessionStore;
  operation: string;
  /** Test seam: defaults to a real `createIpcClient`. */
  ipcClient?: IpcClientFactory;
  /** Deadline for local identity/meta calls. Default 10_000. */
  timeoutMs?: number;
  /** Maximum wait for another compatible mutation workflow. Default 60_000. */
  leaseTimeoutMs?: number;
}

interface MutationWorkflowContext {
  gatewayKey: string;
  client: IpcClient;
  leaseId: string;
  acknowledgedWrites: number;
}

const mutationWorkflow = new AsyncLocalStorage<MutationWorkflowContext>();

/**
 * Run a complete gateway mutation against one pinned daemon connection while
 * holding the canonical-host workflow lease. All nested `agentCall()` calls —
 * snapshot reads, validation, writes, and readback — inherit the connection.
 */
export async function withMutationWorkflow<T>(
  input: MutationWorkflowInputs,
  run: () => Promise<T>,
): Promise<T> {
  const gatewayKey = canonicalGatewayKey(input.baseUrl);
  const inherited = mutationWorkflow.getStore();
  if (inherited) {
    if (inherited.gatewayKey !== gatewayKey) {
      throw new ConfigError('a mutation workflow cannot switch gateway hosts');
    }
    return run();
  }

  const timeoutMs = input.timeoutMs ?? 10_000;
  const leaseTimeoutMs = input.leaseTimeoutMs ?? 60_000;
  if (!Number.isSafeInteger(leaseTimeoutMs) || leaseTimeoutMs <= 0) {
    throw new ConfigError('mutation lease timeout must be a positive integer');
  }
  const entry = await input.store.read(input.baseUrl);
  const factory = input.ipcClient ?? defaultIpcClient;
  const client = factory(entry.socketPath);
  let leaseId: string | undefined;
  let context: MutationWorkflowContext | undefined;
  let result: T | undefined;
  let failure: unknown;
  try {
    const ping = await withTimeout(
      client.request('$ping', null, { timeoutMs, kind: 'read' }),
      timeoutMs,
      () => new NetworkError(`agent identity probe timed out after ${timeoutMs}ms`),
    );
    assertAgentIdentity(ping, entry);
    const acquired = await withTimeout(
      client.request(
        '$mutation.acquire',
        { operation: input.operation, waitTimeoutMs: leaseTimeoutMs },
        { timeoutMs: leaseTimeoutMs, kind: 'read' },
      ),
      leaseTimeoutMs + 250,
      () => new NetworkError(`mutation lease acquisition timed out after ${leaseTimeoutMs}ms`),
    );
    leaseId = parseAcquiredLease(acquired);
    context = { gatewayKey, client, leaseId, acknowledgedWrites: 0 };
    result = await mutationWorkflow.run(context, run);
  } catch (error) {
    failure = mapAgentEndpointError(error, input.baseUrl);
    const shouldFence =
      error instanceof NotConfirmedError || (context?.acknowledgedWrites ?? 0) > 0;
    if (leaseId && shouldFence) {
      await bestEffortFence(client, leaseId, timeoutMs);
    }
  }

  if (leaseId) {
    try {
      await withTimeout(
        client.request('$mutation.release', { leaseId }, { timeoutMs, kind: 'read', leaseId }),
        timeoutMs,
        () => new NetworkError('timed out releasing the mutation workflow lease'),
      );
    } catch (error) {
      if (failure === undefined && (context?.acknowledgedWrites ?? 0) > 0) {
        // The run completed and its gateway writes were acknowledged, but a
        // lost release request/response means the caller cannot know whether
        // the daemon finalized the workflow. Fence best-effort (connection
        // close is the fallback) and force inspect-before-retry semantics.
        await bestEffortFence(client, leaseId, timeoutMs);
        failure = new NotConfirmedError(
          `mutation workflow "${input.operation}" applied gateway writes but its lease release was not confirmed`,
          {
            operation: input.operation,
            acknowledgedWrites: context?.acknowledgedWrites ?? 0,
            phase: 'lease-release',
          },
        );
      } else if (failure === undefined) {
        failure = mapAgentEndpointError(error, input.baseUrl);
      }
    }
  }
  client.close();
  if (failure !== undefined) throw failure;
  return result as T;
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
  const workflow = mutationWorkflow.getStore();
  if (workflow) {
    if (workflow.gatewayKey !== canonicalGatewayKey(input.baseUrl)) {
      throw new ConfigError('agent call attempted to switch hosts inside a mutation workflow');
    }
    const timeoutMs = input.timeoutMs ?? 10_000;
    try {
      const result = await withTimeout(
        workflow.client.request(input.method, input.params, {
          timeoutMs,
          kind,
          leaseId: workflow.leaseId,
        }),
        timeoutMs,
        () => {
          const msg = `agent IPC call ${input.method} timed out after ${timeoutMs}ms`;
          return kind === 'write'
            ? new NotConfirmedError(msg, { method: input.method })
            : new NetworkError(msg);
        },
      );
      if (kind === 'write') workflow.acknowledgedWrites += 1;
      return result;
    } catch (error) {
      throw mapAgentEndpointError(error, input.baseUrl);
    }
  }
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
    throw mapAgentEndpointError(e, input.baseUrl);
  } finally {
    client.close();
  }
}

function parseAcquiredLease(raw: unknown): string {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new NetworkError('agent returned an invalid mutation lease response');
  }
  const leaseId = (raw as Record<string, unknown>).leaseId;
  if (typeof leaseId !== 'string' || leaseId.length === 0) {
    throw new NetworkError('agent returned an invalid mutation lease id');
  }
  return leaseId;
}

function mapAgentEndpointError(error: unknown, baseUrl: string): unknown {
  if (
    error instanceof NetworkError &&
    /IPC connect failed|IPC connection closed|IPC client closed/.test(error.message)
  ) {
    return new AuthExpiredError('agent endpoint is unreachable; the daemon likely exited', {
      host: baseUrl,
    });
  }
  return error;
}

async function bestEffortFence(
  client: IpcClient,
  leaseId: string,
  timeoutMs: number,
): Promise<void> {
  await withTimeout(
    client.request('$mutation.fence', { leaseId }, { timeoutMs, kind: 'read', leaseId }),
    timeoutMs,
    () => new NetworkError('timed out fencing an unconfirmed mutation workflow'),
  ).catch(() => {});
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
