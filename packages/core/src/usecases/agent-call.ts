import type { IpcClient } from '../agent/ipc-client.js';
import { createIpcClient } from '../agent/ipc-client.js';
import type { SessionStore } from '../session/index.js';
import { AuthExpiredError, NetworkError, NotConfirmedError } from '../transport/errors.js';

export type IpcClientFactory = (socketPath: string) => IpcClient;

export interface AgentCallInputs {
  baseUrl: string;
  method: string;
  params: unknown;
  store: SessionStore;
  /** Test seam: defaults to a real `createIpcClient`. */
  ipcClient?: IpcClientFactory;
  /** Per-call deadline (ms) applied client-side. Default 10_000. */
  timeoutMs?: number;
  /** Whether the call mutates gateway state. Timeout error class depends on this. */
  kind?: 'read' | 'write';
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
 *     (`GatewayError` from the gateway, `NetworkError` for timeouts).
 */
export async function agentCall(input: AgentCallInputs): Promise<unknown> {
  const entry = await input.store.read(input.baseUrl);
  const factory = input.ipcClient ?? defaultIpcClient;
  const client = factory(entry.socketPath);
  const timeoutMs = input.timeoutMs ?? 10_000;
  let timerId: ReturnType<typeof setTimeout> | undefined;
  try {
    const call = client.request(input.method, input.params);
    const kind = input.kind ?? 'read';
    const timer = new Promise<never>((_, reject) => {
      timerId = setTimeout(() => {
        const msg = `agent IPC call ${input.method} timed out after ${timeoutMs}ms`;
        reject(
          kind === 'write'
            ? new NotConfirmedError(msg, { method: input.method })
            : new NetworkError(msg),
        );
      }, timeoutMs);
    });
    return await Promise.race([call, timer]);
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
    if (timerId !== undefined) clearTimeout(timerId);
    client.close();
  }
}

function defaultIpcClient(socketPath: string): IpcClient {
  return createIpcClient({ path: socketPath });
}
