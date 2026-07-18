import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { SessionStore } from '../session/store.js';
import type { HandshakeResult } from '../transport/handshake.js';
import type { BinaryTransport } from '../transport/index.js';
import { connectWs, runPasscodeHandshake, toWsUrl } from '../transport/index.js';
import { defaultAgentRuntimeDir, resolveAgentInstanceEndpoint } from './ipc-path.js';
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
  /** Directory for the Unix domain socket on POSIX. Defaults to a private user runtime dir. */
  socketBaseDir?: string;
  /** Inactivity window after which the agent self-exits. Default 60 min. */
  idleMs?: number;
  /** Where to write the single `READY <json>` line. Default `process.stdout`. */
  out?: NodeJS.WritableStream;
  /** Test seam: open an in-process transport instead of a real WS. */
  connect?: (host: string) => Promise<BinaryTransport>;
  /** Test seam: defaults to a file-backed SessionStore at `sessionFile`. */
  sessionStore?: Pick<SessionStore, 'deleteIfMatch' | 'write'>;
  /** Test seam: controls the per-instance timestamp used for ownership. */
  now?: () => Date;
  /** Test seam: defaults to a random per-daemon endpoint nonce. */
  instanceId?: string;
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
  // Keep only the non-secret host in the long-lived `done` closure below; the
  // passcode in `opts` must be collectible once the handshake finishes.
  const host = opts.host;
  const socketBaseDir = opts.socketBaseDir ?? defaultAgentRuntimeDir();
  if (process.platform !== 'win32') await ensurePrivateRuntimeDir(socketBaseDir);
  const endpoint = resolveAgentInstanceEndpoint({
    host,
    baseDir: socketBaseDir,
    platform: process.platform,
    instanceId: opts.instanceId ?? randomUUID(),
  });
  const store =
    opts.sessionStore ??
    new SessionStore({
      path: opts.sessionFile ?? defaultSessionFilePath(),
    });
  const transport = opts.connect
    ? await opts.connect(host)
    : await connectWs({ url: toWsUrl(host) });

  let handshake: HandshakeResult;
  try {
    handshake = await runPasscodeHandshake({
      passcode: opts.passcode,
      transport,
    });
  } catch (originalError) {
    try {
      transport.close();
    } catch {
      // Preserve the handshake failure even if transport rollback also fails.
    }
    throw originalError;
  }

  const agentStartedAt = (opts.now?.() ?? new Date()).toISOString();
  const agent = await runAgent({
    host,
    transport,
    handshake,
    socketPath: endpoint.path,
    idleMs: opts.idleMs ?? 60 * 60 * 1000,
    meta: { agentStartedAt, agentVersion: opts.agentVersion },
  });

  const session = {
    host,
    pid: process.pid,
    socketPath: endpoint.path,
    agentStartedAt,
    agentVersion: opts.agentVersion,
    lastValidatedAt: agentStartedAt,
  };

  const ready: ReadyPayload = {
    socketPath: endpoint.path,
    agentStartedAt,
    agentVersion: opts.agentVersion,
  };
  let sessionWritten = false;
  try {
    await store.write(session);
    sessionWritten = true;
    const out = opts.out ?? process.stdout;
    await writeReady(out, `READY ${JSON.stringify(ready)}\n`);
  } catch (originalError) {
    if (sessionWritten) {
      try {
        await store.deleteIfMatch(session);
      } catch {
        // Best-effort rollback; an ownership mismatch deliberately preserves a replacement.
      }
    }
    try {
      await agent.stop();
    } catch {
      // Preserve the bootstrap failure even if transport/IPC cleanup also fails.
    }
    throw originalError;
  }

  // Whenever the agent exits, remove its session only if this instance still
  // owns the host entry. A replacement daemon may already have published a
  // newer identity at the same key.
  const done = agent.done.then(async () => {
    try {
      await store.deleteIfMatch(session);
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

async function ensurePrivateRuntimeDir(path: string): Promise<void> {
  await fs.mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`agent runtime path is not a directory: ${path}`);
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(`agent runtime directory is not owned by the current user: ${path}`);
  }
  await fs.chmod(path, 0o700);
}

async function writeReady(out: NodeJS.WritableStream, line: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const removeErrorListener = (): void => {
      out.off('error', onError);
    };
    const onError = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    out.once('error', onError);
    try {
      out.write(line, (error?: Error | null) => {
        if (settled) return;
        settled = true;
        if (error) {
          reject(error);
          // Node emits the corresponding 'error' after the write callback.
          // Keep the listener through that turn so the rollback path does not
          // cause an unhandled stream error, then remove it for nonstandard
          // WritableStream implementations that only invoke the callback.
          setImmediate(removeErrorListener);
          return;
        }
        removeErrorListener();
        resolve();
      });
    } catch (error) {
      settled = true;
      removeErrorListener();
      reject(error);
    }
  });
}

function defaultSessionFilePath(): string {
  const fromEnv = process.env.XGG_SESSION_FILE;
  if (fromEnv) return fromEnv;
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) throw new Error('cannot locate home directory (HOME/USERPROFILE unset)');
  return join(home, '.xgg', 'session.json');
}
