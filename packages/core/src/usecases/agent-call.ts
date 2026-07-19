import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  KNOWN_GATEWAY_WRITE_METHODS,
  isKnownGatewayWriteMethod,
} from '../agent/gateway-write-methods.js';
import { assertAgentIdentity } from '../agent/identity.js';
import type { IpcClient } from '../agent/ipc-client.js';
import { createIpcClient } from '../agent/ipc-client.js';
import { canonicalGatewayKey } from '../agent/ipc-path.js';
import type { SessionStore } from '../session/index.js';
import { notConfirmedAfterAcknowledgement } from '../transport/confirmation.js';
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
  // Backwards-compatible low-level escape hatch: callers historically used
  // agentCall(kind:'write') directly. The daemon now rejects every unleased
  // write, so give a standalone write a single-RPC workflow automatically.
  // Compound typed mutations still wrap their whole pre-read/RMW/write flow at
  // the resource boundary; this fallback cannot make an already-finished
  // pre-read atomic.
  if (!workflow && kind === 'write') {
    return withMutationWorkflow(
      {
        baseUrl: input.baseUrl,
        store: input.store,
        operation: `agent-call:${input.method}`,
        ...(input.ipcClient !== undefined && { ipcClient: input.ipcClient }),
        ...(input.timeoutMs !== undefined && { timeoutMs: input.timeoutMs }),
      },
      async () => {
        const result = await agentCall({ ...input, kind });
        // loadBackup acknowledges an asynchronous restore. A standalone raw
        // write must not release its lease at the ACK boundary; wait for the
        // terminal progress read just like the typed/CLI funnels. An explicitly
        // enclosing workflow remains responsible for its own progress policy.
        if (input.method === '/api/loadBackup') {
          await waitForRawBackupLoad(input, result);
        }
        return result;
      },
    );
  }
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

async function waitForRawBackupLoad(input: AgentCallInputs, response: unknown): Promise<void> {
  const from = readRawBackupSource(input.params);
  const progressId = readRawBackupProgressId(response);
  if (from === null || progressId === null) {
    throw new NotConfirmedError(
      'backup load was accepted without enough progress metadata to confirm restore completion',
      { method: input.method, from, progressId },
    );
  }
  if (progressId === 0) return;

  const pollTimeoutMs = 60_000;
  const deadline = Date.now() + pollTimeoutMs;
  for (;;) {
    let raw: unknown;
    try {
      raw = await agentCall({
        baseUrl: input.baseUrl,
        method: '/api/getBackupProgress',
        params: { from, params: { progress_id: progressId } },
        store: input.store,
        ...(input.ipcClient !== undefined && { ipcClient: input.ipcClient }),
        ...(input.timeoutMs !== undefined && { timeoutMs: input.timeoutMs }),
      });
    } catch (error) {
      throw notConfirmedAfterAcknowledgement(
        error,
        'raw backup load was acknowledged but terminal restore progress could not be confirmed',
        {
          operation: 'agent-call:/api/loadBackup',
          phase: 'progress-confirmation',
          method: input.method,
          from,
          progressId,
          hint: 'log out, log in again, and inspect live state before retrying or making any later mutation',
        },
      );
    }
    const progress = readRawBackupProgress(raw, { from, progressId });
    if (progress >= 100) return;
    if (Date.now() >= deadline) {
      throw new NotConfirmedError(
        `backup progress polling timed out after ${pollTimeoutMs}ms (progressId=${progressId}, last=${progress})`,
        { method: input.method, from, progressId, lastProgress: progress, pollTimeoutMs },
      );
    }
    await sleep(1_000);
  }
}

function readRawBackupSource(params: unknown): string | null {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return null;
  const from = (params as Record<string, unknown>).from;
  return typeof from === 'string' && from.length > 0 ? from : null;
}

function readRawBackupProgressId(response: unknown): number | null {
  if (isRawBackupProgressId(response)) return response;
  if (response === null || typeof response !== 'object' || Array.isArray(response)) return null;
  const value = response as Record<string, unknown>;
  if (isRawBackupProgressId(value.progress_id)) {
    return value.progress_id;
  }
  if (isRawBackupProgressId(value.progressId)) {
    return value.progressId;
  }
  return null;
}

function isRawBackupProgressId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function readRawBackupProgress(
  response: unknown,
  context: { from: string; progressId: number },
): number {
  if (response === null || typeof response !== 'object' || Array.isArray(response)) {
    throw new NotConfirmedError(
      'raw backup load was acknowledged but its progress response is malformed',
      {
        operation: 'agent-call:/api/loadBackup',
        phase: 'progress-confirmation',
        ...context,
      },
    );
  }
  const progress = (response as Record<string, unknown>).progress;
  if (typeof progress !== 'number' || !Number.isFinite(progress)) {
    throw new NotConfirmedError(
      'raw backup load was acknowledged but its progress response is malformed',
      {
        operation: 'agent-call:/api/loadBackup',
        phase: 'progress-confirmation',
        ...context,
      },
    );
  }
  return progress;
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
