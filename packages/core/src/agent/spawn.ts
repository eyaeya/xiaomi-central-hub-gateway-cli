import { type ChildProcess, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { AuthExpiredError, AuthRequiredError, NetworkError } from '../transport/errors.js';

export interface SpawnAgentOptions {
  /** Absolute path to the binary that runs the agent's child mode (typically `process.execPath`). */
  binary: string;
  /** Args passed to the binary — e.g. `[cliEntry, 'agent', '--serve', '--host', host]`. */
  args: string[];
  /** Environment for the child. Defaults to inheriting from parent. Pass the
   * single-use login code here (XGG_LOGIN_CODE) so it stays out of `ps`. */
  env?: NodeJS.ProcessEnv;
  /** Max time to wait for the child's READY line before failing the spawn. */
  readyTimeoutMs?: number;
}

export interface SpawnAgentResult {
  pid: number;
  socketPath: string;
  agentStartedAt: string;
  agentVersion: string;
}

interface ReadyPayload {
  socketPath: string;
  agentStartedAt: string;
  agentVersion: string;
}

/**
 * Spawn the agent as a detached child and wait for it to publish its IPC
 * endpoint. Resolves once the child writes a single `READY <json>` line to
 * stdout; rejects on early exit or timeout.
 *
 * After resolve, the child is `unref()`'d so the parent CLI can exit while the
 * agent keeps running. stdout/stderr pipes are closed on the parent's side —
 * the child should subsequently log via its own facility (file, syslog) if at
 * all.
 */
export async function spawnAgent(opts: SpawnAgentOptions): Promise<SpawnAgentResult> {
  const child: ChildProcess = spawn(opts.binary, opts.args, {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: opts.env ?? process.env,
  });

  return new Promise<SpawnAgentResult>((resolve, reject) => {
    const timeoutMs = opts.readyTimeoutMs ?? 5_000;
    const stderrChunks: Buffer[] = [];
    let settled = false;

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      settle(() => {
        child.kill('SIGTERM');
        reject(new NetworkError(`agent did not signal READY within ${timeoutMs}ms`));
      });
    }, timeoutMs);

    child.stderr?.on('data', (c: Buffer) => stderrChunks.push(c));

    child.on('error', (e) => {
      settle(() => reject(new NetworkError(`failed to spawn agent: ${e.message}`)));
    });

    child.on('exit', (code, signal) => {
      if (settled) return;
      settle(() => {
        const stderr = Buffer.concat(stderrChunks).toString().trim();
        const innerAuth = innerAuthError(stderr);
        if (innerAuth) {
          reject(innerAuth);
          return;
        }
        reject(
          new NetworkError(
            `agent exited (code=${code} signal=${signal}) before READY: ${stderr || '(no stderr)'}`,
          ),
        );
      });
    });

    if (!child.stdout) {
      settle(() => reject(new NetworkError('child stdout pipe missing')));
      return;
    }

    const rl = createInterface({
      input: child.stdout,
      crlfDelay: Number.POSITIVE_INFINITY,
    });

    const unrefStream = (s: NodeJS.ReadableStream | null): void => {
      if (!s) return;
      const maybe = s as unknown as { unref?: () => void };
      if (typeof maybe.unref === 'function') maybe.unref();
    };

    rl.on('line', (line) => {
      if (settled) return;
      const match = /^READY (.+)$/.exec(line);
      if (!match) return; // ignore non-READY lines (verbose startup logging is OK)
      try {
        const payload = JSON.parse(match[1] ?? '') as Partial<ReadyPayload>;
        if (
          typeof payload.socketPath !== 'string' ||
          typeof payload.agentStartedAt !== 'string' ||
          typeof payload.agentVersion !== 'string'
        ) {
          throw new Error('READY payload missing required fields');
        }
        const pid = child.pid;
        if (pid === undefined) throw new Error('child pid missing');
        settle(() => {
          rl.close();
          // For piped stdio, child.stdout/stderr are Sockets at runtime even
          // though @types/node declares them as Readable. unref'ing the
          // underlying handle is what lets the parent CLI exit while the agent
          // keeps running.
          unrefStream(child.stdout);
          unrefStream(child.stderr);
          child.unref();
          resolve({
            pid,
            socketPath: payload.socketPath as string,
            agentStartedAt: payload.agentStartedAt as string,
            agentVersion: payload.agentVersion as string,
          });
        });
      } catch (e) {
        settle(() => {
          child.kill('SIGTERM');
          reject(new NetworkError(`bad READY line from agent: ${(e as Error).message}`));
        });
      }
    });
  });
}

// F20: when the agent child dies before READY because the gateway rejected the
// login, its stderr carries a JSON envelope like
// `{"ok":false,"error":{"code":"AUTH_REQUIRED",...}}`. Surfacing this as a
// generic NetworkError (exit 1) loses the actionable signal — callers that
// want to distinguish "re-prompt for code" from "retry on network glitch"
// would have to grep the message. Re-throw as AuthRequired/Expired so the
// existing errorToExit mapping yields exit 3.
function innerAuthError(stderr: string): AuthRequiredError | AuthExpiredError | null {
  if (!stderr) return null;
  const match = stderr.match(/\{[\s\S]*"code"\s*:\s*"(AUTH_REQUIRED|AUTH_EXPIRED)"[\s\S]*\}/);
  if (!match) return null;
  try {
    const envelope = JSON.parse(match[0]) as {
      error?: { code?: string; message?: string };
    };
    const code = envelope.error?.code;
    const message = envelope.error?.message ?? 'gateway rejected authentication';
    if (code === 'AUTH_REQUIRED') return new AuthRequiredError(message);
    if (code === 'AUTH_EXPIRED') return new AuthExpiredError(message);
  } catch {
    // Fall through — not a valid JSON envelope, treat as generic network failure.
  }
  return null;
}
