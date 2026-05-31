import type { StoredSession } from '../schemas/session.js';
import type { SessionStore } from '../session/index.js';
import { AuthRequiredError } from '../transport/errors.js';

export type SignalFn = (pid: number, signal: NodeJS.Signals | 0) => boolean;

export interface LogoutInputs {
  baseUrl: string;
  store: SessionStore;
  /** Test seam: defaults to `process.kill`. Returns `false` on ESRCH. */
  signal?: SignalFn;
}

export interface LogoutResult {
  ok: true;
  host: string;
  /** Whether a live agent was found and signalled at logout time. */
  wasRunning: boolean;
}

/**
 * Tear down the per-host agent and remove its session entry.
 *
 * Idempotent: if no session is recorded for `baseUrl`, raises
 * `AuthRequiredError`. If a session exists but the agent process has already
 * exited (ESRCH), the entry is still removed and `wasRunning: false` is
 * returned. We don't wait for the agent to actually exit — the agent's own
 * cleanup will remove the (now-orphaned) socket on its way out.
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
  const sig = input.signal ?? defaultSignal;
  const wasRunning = sig(entry.pid, 'SIGTERM');
  await input.store.delete(input.baseUrl);
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
