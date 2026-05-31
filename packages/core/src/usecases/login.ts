import { type SpawnAgentOptions, type SpawnAgentResult, spawnAgent } from '../agent/spawn.js';
import { ConfigError } from '../transport/errors.js';

export type SpawnFn = (opts: SpawnAgentOptions) => Promise<SpawnAgentResult>;

export interface LoginInputs {
  baseUrl: string;
  passcode: string;
  /** Optional override for the agent session-file path. */
  sessionFile?: string;
  /** Resolved `{binary, args}` used to invoke the agent child. */
  agentBinary: { binary: string; args: string[] };
  /** Test seam: defaults to the real `spawnAgent`. */
  spawn?: SpawnFn;
  /** Max time to wait for the agent's READY line. Default 15_000. */
  readyTimeoutMs?: number;
}

export interface LoginResult {
  ok: true;
  host: string;
  pid: number;
  socketPath: string;
  agentStartedAt: string;
  agentVersion: string;
}

/**
 * Fork the per-host agent and wait for its READY line. The single-use
 * `passcode` is passed via env (`XGG_LOGIN_CODE`) so it never appears in
 * `ps`; the child consumes it during handshake and then scrubs it. The
 * v2 session entry is written by the child once its IPC socket is up.
 */
export async function login(input: LoginInputs): Promise<LoginResult> {
  if (!/^\d{6,8}$/.test(input.passcode)) {
    throw new ConfigError('passcode must be 6–8 digits');
  }
  if (!/^https?:\/\//.test(input.baseUrl)) {
    throw new ConfigError('base-url must be an http(s) URL');
  }
  const args = [...input.agentBinary.args, 'agent', 'serve', '--host', input.baseUrl];
  if (input.sessionFile) args.push('--session-file', input.sessionFile);
  const fn = input.spawn ?? spawnAgent;
  const childEnv: NodeJS.ProcessEnv = { ...process.env, XGG_LOGIN_CODE: input.passcode };
  const result = await fn({
    binary: input.agentBinary.binary,
    args,
    env: childEnv,
    readyTimeoutMs: input.readyTimeoutMs ?? 15_000,
  });
  return {
    ok: true,
    host: input.baseUrl,
    pid: result.pid,
    socketPath: result.socketPath,
    agentStartedAt: result.agentStartedAt,
    agentVersion: result.agentVersion,
  };
}
