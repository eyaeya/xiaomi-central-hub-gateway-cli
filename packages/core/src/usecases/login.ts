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
 * `passcode` is sent over the child's anonymous stdin pipe, never in the
 * detached child's argv or environment. This does not hide a `--code` value
 * from the short-lived parent CLI's argv or the invoking shell's history.
 * The v2 session entry is written by the child once its IPC socket is up.
 */
export async function login(input: LoginInputs): Promise<LoginResult> {
  if (!/^\d{6,8}$/.test(input.passcode)) {
    throw new ConfigError('passcode must be 6–8 digits');
  }

  let baseUrl: URL;
  try {
    baseUrl = new URL(input.baseUrl);
  } catch {
    throw new ConfigError('base-url must be an http(s) URL');
  }
  if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
    throw new ConfigError('base-url must be an http(s) URL');
  }
  if (baseUrl.username !== '' || baseUrl.password !== '') {
    throw new ConfigError('base-url must not include username or password');
  }
  const canonicalBaseUrl = baseUrl.origin;

  const args = [...input.agentBinary.args, 'agent', 'serve', '--host', canonicalBaseUrl];
  if (input.sessionFile) args.push('--session-file', input.sessionFile);
  const fn = input.spawn ?? spawnAgent;
  const result = await fn({
    binary: input.agentBinary.binary,
    args,
    passcode: input.passcode,
    readyTimeoutMs: input.readyTimeoutMs ?? 15_000,
  });
  return {
    ok: true,
    host: canonicalBaseUrl,
    pid: result.pid,
    socketPath: result.socketPath,
    agentStartedAt: result.agentStartedAt,
    agentVersion: result.agentVersion,
  };
}
