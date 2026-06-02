import { type Socket, createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { NetworkError } from '../transport/errors.js';
import { reviveError } from './ipc-server.js';

export interface IpcClientOptions {
  path: string;
}

/** Per-call hints forwarded to the daemon's router over the IPC frame. */
export interface IpcCallOptions {
  /** Deadline (ms) the daemon's router should apply to this gateway call. */
  timeoutMs?: number;
  /** Whether the call mutates gateway state — drives the daemon's timeout error class. */
  kind?: 'read' | 'write';
}

export interface IpcClient {
  request: (method: string, params: unknown, opts?: IpcCallOptions) => Promise<unknown>;
  close: () => void;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

interface ResponseFrame {
  id: number;
  result?: unknown;
  error?: { code: string; message: string; hint?: string };
}

/**
 * NDJSON client over `node:net`. Lazily opens the socket on the first
 * `request()` call and reuses it for subsequent ones until `close()`.
 *
 * `request()` rejects with `NetworkError` if the socket dies (server crash,
 * socket file removed, etc.) — pending requests share the same fate.
 */
export function createIpcClient(opts: IpcClientOptions): IpcClient {
  let socket: Socket | null = null;
  let connecting: Promise<Socket> | null = null;
  let closed = false;
  let nextId = 1;
  const pending = new Map<number, Pending>();

  const failAll = (e: Error): void => {
    for (const p of pending.values()) p.reject(e);
    pending.clear();
  };

  const connect = async (): Promise<Socket> => {
    if (socket && !socket.destroyed) return socket;
    if (connecting) return connecting;
    connecting = new Promise<Socket>((resolve, reject) => {
      const s = createConnection(opts.path);
      const onErr = (e: Error): void => {
        s.off('connect', onOk);
        reject(new NetworkError(`agent IPC connect failed: ${e.message}`));
      };
      const onOk = (): void => {
        s.off('error', onErr);
        resolve(s);
      };
      s.once('error', onErr);
      s.once('connect', onOk);
    });
    try {
      socket = await connecting;
    } finally {
      connecting = null;
    }
    const rl = createInterface({ input: socket, crlfDelay: Number.POSITIVE_INFINITY });
    rl.on('line', (line) => {
      try {
        const frame = JSON.parse(line) as ResponseFrame;
        const p = pending.get(frame.id);
        if (!p) return;
        pending.delete(frame.id);
        if (frame.error) {
          p.reject(reviveError(frame.error as Parameters<typeof reviveError>[0]));
        } else {
          p.resolve(frame.result);
        }
      } catch {
        // Malformed line — drop it; the server is the source of truth.
      }
    });
    socket.on('close', () => {
      failAll(new NetworkError('agent IPC connection closed'));
      socket = null;
    });
    socket.on('error', () => {
      // 'close' fires after this; failAll runs there.
    });
    return socket;
  };

  return {
    request: async (method, params, opts) => {
      if (closed) throw new NetworkError('agent IPC client closed');
      const s = await connect();
      const id = nextId++;
      const frame: Record<string, unknown> = { id, method, params };
      if (opts?.timeoutMs !== undefined) frame.timeoutMs = opts.timeoutMs;
      if (opts?.kind !== undefined) frame.kind = opts.kind;
      return new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        s.write(`${JSON.stringify(frame)}\n`, (e) => {
          if (e) {
            pending.delete(id);
            reject(new NetworkError(`agent IPC write failed: ${e.message}`));
          }
        });
      });
    },
    close: () => {
      closed = true;
      if (socket) {
        socket.end();
        socket.destroy();
      }
      failAll(new NetworkError('agent IPC client closed'));
    },
  };
}
