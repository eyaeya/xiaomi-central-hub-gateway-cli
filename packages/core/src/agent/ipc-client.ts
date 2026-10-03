import { type Socket, createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { NetworkError, NotConfirmedError } from '../transport/errors.js';
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
  /** Connection-bound mutation workflow lease. Set by withMutationWorkflow(). */
  leaseId?: string;
}

export interface IpcClient {
  request: (method: string, params: unknown, opts?: IpcCallOptions) => Promise<unknown>;
  /** Resolve when the current daemon-side socket has actually closed. */
  waitForClose?: () => Promise<void>;
  close: () => void;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  method: string;
  kind: 'read' | 'write';
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
  let socketClosed: Promise<void> | null = null;
  let closed = false;
  let nextId = 1;
  const pending = new Map<number, Pending>();

  const interrupted = (request: Pending, cause: NetworkError): Error =>
    request.kind === 'write'
      ? new NotConfirmedError(
          `agent IPC write ${request.method} was not confirmed (the gateway write may or may not have applied)`,
          {
            method: request.method,
            causeCode: cause.code,
            causeMessage: cause.message,
            hint: 'inspect live state before retrying the write',
          },
        )
      : cause;

  const failAll = (e: NetworkError): void => {
    for (const p of pending.values()) p.reject(interrupted(p, e));
    pending.clear();
  };

  const connect = async (): Promise<Socket> => {
    if (socket && !socket.destroyed) return socket;
    if (connecting) return connecting;
    connecting = new Promise<Socket>((resolve, reject) => {
      const s = createConnection(opts.path);
      socketClosed = new Promise<void>((resolveClosed) => {
        s.once('close', resolveClosed);
      });
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
    rl.on('error', () => {
      // readline re-emits input stream errors independently of the Socket.
      // Contain EPIPE/reset during daemon shutdown instead of crashing the CLI.
    });
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
      if (opts?.leaseId !== undefined) frame.leaseId = opts.leaseId;
      // Serialization failures happen before submission and are not ambiguous
      // writes. Do not leave a pending entry behind when JSON.stringify throws.
      const line = `${JSON.stringify(frame)}\n`;
      return new Promise<unknown>((resolve, reject) => {
        const request: Pending = { resolve, reject, method, kind: opts?.kind ?? 'read' };
        pending.set(id, request);
        s.write(line, (e) => {
          if (e) {
            pending.delete(id);
            reject(interrupted(request, new NetworkError(`agent IPC write failed: ${e.message}`)));
          }
        });
      });
    },
    waitForClose: () => socketClosed ?? Promise.resolve(),
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
