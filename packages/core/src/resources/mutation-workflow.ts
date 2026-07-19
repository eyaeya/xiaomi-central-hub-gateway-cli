import { withMutationWorkflow } from '../usecases/agent-call.js';
import type { ResourceDeps } from './index.js';

/**
 * Put a public typed resource mutation inside the same canonical-host workflow
 * lease used by the CLI. Nested typed mutations reuse the AsyncLocalStorage
 * context, so compound read/modify/write helpers keep one pinned daemon
 * connection without acquiring a second lease.
 */
export function withResourceMutationWorkflow<T>(
  deps: ResourceDeps,
  operation: string,
  run: () => Promise<T>,
): Promise<T> {
  return withMutationWorkflow(
    {
      baseUrl: deps.baseUrl,
      store: deps.store,
      operation,
      ...(deps.ipcClient !== undefined && { ipcClient: deps.ipcClient }),
      ...(deps.timeoutMs !== undefined && { timeoutMs: deps.timeoutMs }),
    },
    run,
  );
}
