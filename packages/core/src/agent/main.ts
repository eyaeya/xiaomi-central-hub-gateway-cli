import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../session/store.js';
import type { HandshakeResult } from '../transport/handshake.js';
import type { BinaryTransport } from '../transport/index.js';
import { connectWs, runPasscodeHandshake, toWsUrl } from '../transport/index.js';
import { resolveAgentEndpoint } from './ipc-path.js';
import { runAgent } from './process.js';

export interface RunAgentMainOptions {
  /** http(s) base URL of the gateway, used as the session-file key + WS target. */
  host: string;
  /** Single-use 6–8 digit login code (consumed during handshake). */
  passcode: string;
  /** Agent version string written into the session file. */
  agentVersion: string;
  /** Override the v2 session-file path (defaults to env / `~/.xgg/session.json`). */
  sessionFile?: string;
  /** Directory for the Unix domain socket on POSIX. Defaults to `tmpdir()`. */
  socketBaseDir?: string;
  /** Inactivity window after which the agent self-exits. Default 60 min. */
  idleMs?: number;
  /** Where to write the single `READY <json>` line. Default `process.stdout`. */
  out?: NodeJS.WritableStream;
  /** Test seam: open an in-process transport instead of a real WS. */
  connect?: (host: string) => Promise<BinaryTransport>;
}

export interface RunAgentMainHandle {
  /** Resolves when the agent loop exits (idle timeout, WS drop, or external SIGTERM). */
  done: Promise<void>;
  /** Trigger a graceful shutdown of the agent loop. */
  stop: () => Promise<void>;
  /** The socket path the IPC server is listening on. */
  socketPath: string;
}

interface ReadyPayload {
  socketPath: string;
  agentStartedAt: string;
  agentVersion: string;
}

/**
 * Child-side bootstrap for the per-host agent: open WS, run handshake, start
 * the IPC server, persist the v2 session entry, then emit the single
 * `READY <json>` line the parent CLI is waiting on. The returned handle lets
 * test harnesses drive shutdown deterministically; in production the binary
 * just `await`s `handle.done` and exits.
 */
export async function runAgentMain(opts: RunAgentMainOptions): Promise<RunAgentMainHandle> {
  const endpoint = resolveAgentEndpoint({
    host: opts.host,
    baseDir: opts.socketBaseDir ?? tmpdir(),
    platform: process.platform,
  });
  const transport = opts.connect
    ? await opts.connect(opts.host)
    : await connectWs({ url: toWsUrl(opts.host) });

  let handshake: HandshakeResult;
  try {
    handshake = await runPasscodeHandshake({
      passcode: opts.passcode,
      transport,
    });
  } catch (e) {
    transport.close();
    throw e;
  }

  const agentStartedAt = new Date().toISOString();
  const agent = await runAgent({
    host: opts.host,
    transport,
    handshake,
    socketPath: endpoint.path,
    idleMs: opts.idleMs ?? 60 * 60 * 1000,
    meta: { agentStartedAt, agentVersion: opts.agentVersion },
  });

  const store = new SessionStore({
    path: opts.sessionFile ?? defaultSessionFilePath(),
  });
  await store.write({
    host: opts.host,
    pid: process.pid,
    socketPath: endpoint.path,
    agentStartedAt,
    agentVersion: opts.agentVersion,
    lastValidatedAt: agentStartedAt,
  });

  const ready: ReadyPayload = {
    socketPath: endpoint.path,
    agentStartedAt,
    agentVersion: opts.agentVersion,
  };
  const out = opts.out ?? process.stdout;
  out.write(`READY ${JSON.stringify(ready)}\n`);

  // Whenever the agent exits, remove the session entry so a fresh `xgg login`
  // is required next time. We intentionally don't await this in `done` — the
  // process is going down anyway and the parent has already moved on.
  const done = agent.done.then(async () => {
    try {
      await store.delete(opts.host);
    } catch {
      // best-effort: tolerate fs errors during shutdown
    }
  });

  return {
    socketPath: endpoint.path,
    done,
    stop: agent.stop,
  };
}

function defaultSessionFilePath(): string {
  const fromEnv = process.env.XGG_SESSION_FILE;
  if (fromEnv) return fromEnv;
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) throw new Error('cannot locate home directory (HOME/USERPROFILE unset)');
  return join(home, '.xgg', 'session.json');
}
