import { promises as fs } from 'node:fs';
import { type Server, type Socket, createServer } from 'node:net';
import { createInterface } from 'node:readline';
import {
  AuthExpiredError,
  AuthRequiredError,
  ConfigError,
  GatewayError,
  NetworkError,
  NotConfirmedError,
  NotFoundError,
  SchemaError,
  XggError,
  type XggErrorCode,
} from '../transport/errors.js';

export interface IpcRequest {
  method: string;
  params: unknown;
}

export type IpcHandler = (req: IpcRequest) => Promise<unknown>;

export interface IpcServerOptions {
  path: string;
  handler: IpcHandler;
}

export interface IpcServerHandle {
  close: () => Promise<void>;
}

interface ErrorEnvelope {
  code: XggErrorCode;
  message: string;
  hint?: string;
}

/**
 * NDJSON server over `node:net`. One request per line, replies preserve `id`.
 *
 * Connections are kept open after a handler throws so a single CLI process can
 * pipeline multiple JSON-RPC calls without paying reconnect cost. The Unix
 * socket is created with `0o600` permissions; the Named Pipe variant inherits
 * the per-user DACL implicit in `net.createServer().listen()` on Windows.
 */
export async function createIpcServer(opts: IpcServerOptions): Promise<IpcServerHandle> {
  const isPipe = opts.path.startsWith('\\\\.\\pipe\\');

  if (!isPipe) {
    await fs.unlink(opts.path).catch(() => {});
  }

  const liveSockets = new Set<Socket>();
  const server: Server = createServer((socket: Socket) => {
    liveSockets.add(socket);
    const rl = createInterface({ input: socket, crlfDelay: Number.POSITIVE_INFINITY });
    socket.on('error', () => {
      // Client-side aborts surface here; keep the server alive.
    });
    socket.on('close', () => liveSockets.delete(socket));
    rl.on('line', (line) => {
      void handleLine(line, socket, opts.handler);
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onErr = (e: Error): void => {
      server.off('listening', onOk);
      reject(e);
    };
    const onOk = (): void => {
      server.off('error', onErr);
      resolve();
    };
    server.once('error', onErr);
    server.once('listening', onOk);
    const prevUmask = isPipe ? 0 : process.umask(0o077);
    try {
      server.listen(opts.path);
    } finally {
      if (!isPipe) process.umask(prevUmask);
    }
  });

  return {
    close: async () => {
      for (const s of liveSockets) s.destroy();
      liveSockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (!isPipe) {
        await fs.unlink(opts.path).catch(() => {});
      }
    },
  };
}

async function handleLine(line: string, socket: Socket, handler: IpcHandler): Promise<void> {
  let id: number | undefined;
  try {
    const parsed = JSON.parse(line) as { id: number; method: string; params: unknown };
    id = parsed.id;
    const result = await handler({ method: parsed.method, params: parsed.params });
    writeLine(socket, { id, result });
  } catch (e) {
    const env = errorEnvelope(e);
    writeLine(socket, id === undefined ? { id: 0, error: env } : { id, error: env });
  }
}

function writeLine(socket: Socket, payload: unknown): void {
  if (socket.destroyed) return;
  socket.write(`${JSON.stringify(payload)}\n`);
}

function errorEnvelope(e: unknown): ErrorEnvelope {
  if (e instanceof XggError) {
    const env: ErrorEnvelope = { code: e.code, message: e.message };
    const hint = e.details?.hint;
    if (typeof hint === 'string') env.hint = hint;
    return env;
  }
  return { code: 'UNKNOWN', message: e instanceof Error ? e.message : String(e) };
}

/** Reconstruct an XggError subclass from a wire envelope. Used by the client. */
export function reviveError(env: ErrorEnvelope): XggError {
  const details = env.hint ? { hint: env.hint } : undefined;
  switch (env.code) {
    case 'CONFIG':
      return new ConfigError(env.message, details);
    case 'AUTH_REQUIRED':
      return new AuthRequiredError(env.message, details);
    case 'AUTH_EXPIRED':
      return new AuthExpiredError(env.message, details);
    case 'NETWORK':
      return new NetworkError(env.message, details);
    case 'SCHEMA':
      return new SchemaError(env.message, details ?? {});
    case 'GATEWAY':
      return new GatewayError(env.message, details ?? {});
    case 'NOT_CONFIRMED':
      return new NotConfirmedError(env.message, details);
    // F44 (2026-05-30) — daemon-thrown NotFoundError used to fall through
    // to the UNKNOWN branch on the CLI side, so instanceof NotFoundError
    // checks (and the corresponding CLI hint mapping) silently broke
    // across the IPC boundary. Listed in errors.test.ts F44 enumeration.
    case 'NOT_FOUND':
      return new NotFoundError(env.message, details);
    default:
      return new XggError('UNKNOWN', env.message, details);
  }
}
