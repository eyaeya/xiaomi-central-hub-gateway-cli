import { randomUUID } from 'node:crypto';
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
import { isKnownGatewayWriteMethod } from './gateway-write-methods.js';
import {
  type MutationLeaseCoordinator,
  createInMemoryMutationLeaseCoordinator,
} from './mutation-lease.js';

export interface IpcRequest {
  method: string;
  params: unknown;
  /** Per-call deadline (ms) the client wants the daemon's router to honour. */
  timeoutMs?: number;
  /** Whether the call mutates gateway state — drives the timeout error class. */
  kind?: 'read' | 'write';
  /** Connection-bound mutation workflow lease. */
  leaseId?: string;
}

export interface IpcHandlerContext {
  connectionId: string;
  leaseId?: string;
  /** Preserve the active lease after an ambiguous write until daemon shutdown. */
  fenceMutation: (reason: string) => void;
}

export type IpcHandler = (req: IpcRequest, context: IpcHandlerContext) => Promise<unknown>;

export interface IpcServerOptions {
  path: string;
  handler: IpcHandler;
  /** Production injects a cross-process coordinator; fake servers use an in-memory one. */
  mutationLeases?: MutationLeaseCoordinator;
  /** Let the owning agent close leases after its gateway transport stops. */
  closeMutationLeases?: boolean;
  /** Production callback for a prepared, identity-pinned IPC self-shutdown. */
  onShutdown?: () => void;
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
  const mutationLeases = opts.mutationLeases ?? createInMemoryMutationLeaseCoordinator();

  const liveSockets = new Set<Socket>();
  const server: Server = createServer((socket: Socket) => {
    const connectionId = randomUUID();
    liveSockets.add(socket);
    const rl = createInterface({ input: socket, crlfDelay: Number.POSITIVE_INFINITY });
    socket.on('error', () => {
      // Client-side aborts are scoped to this connection; keep the server alive.
      socket.destroy();
    });
    socket.on('close', () => {
      liveSockets.delete(socket);
      rl.close();
      mutationLeases.connectionClosed(connectionId);
    });
    rl.on('error', () => {
      // readline forwards input stream errors on its own EventEmitter. Without
      // this listener an ordinary peer reset can become an uncaught exception.
      socket.destroy();
    });
    rl.on('line', (line) => {
      void handleLine(
        line,
        socket,
        opts.handler,
        mutationLeases,
        connectionId,
        opts.onShutdown,
      ).catch(() => {
        // handleLine serialises normal handler failures. Any remaining failure
        // belongs to this connection and must not escape to the daemon process.
        socket.destroy();
      });
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

  let closePromise: Promise<void> | null = null;

  return {
    close: () => {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        for (const s of liveSockets) s.destroy();
        liveSockets.clear();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        if (opts.closeMutationLeases !== false) await mutationLeases.close();
      })();
      return closePromise;
    },
  };
}

async function handleLine(
  line: string,
  socket: Socket,
  handler: IpcHandler,
  mutationLeases: MutationLeaseCoordinator,
  connectionId: string,
  onShutdown: (() => void) | undefined,
): Promise<void> {
  let id: number | undefined;
  let exitLeaseRequest: (() => void) | undefined;
  let write = false;
  let leaseId: string | undefined;
  try {
    const parsed = JSON.parse(line) as {
      id: number;
      method: string;
      params: unknown;
      timeoutMs?: number;
      kind?: 'read' | 'write';
      leaseId?: string;
    };
    id = parsed.id;
    leaseId = parsed.leaseId;
    if (parsed.method === '$mutation.acquire') {
      const params = parseMutationAcquireParams(parsed.params);
      const acquired = await mutationLeases.acquire(
        connectionId,
        params.operation,
        params.waitTimeoutMs,
      );
      await writeLine(socket, { id, result: { leaseId: acquired } });
      return;
    }
    if (parsed.method === '$shutdown.prepare') {
      const waitTimeoutMs = parseWaitTimeout(parsed.params, '$shutdown.prepare');
      await mutationLeases.prepareShutdown(connectionId, waitTimeoutMs);
      await writeLine(socket, { id, result: { ok: true } });
      return;
    }
    if (parsed.method === '$shutdown.commit') {
      mutationLeases.commitShutdown(connectionId);
      await writeLine(socket, { id, result: { ok: true } });
      // Flush the acknowledgement before shutdown destroys this connection.
      // The owner check above pins authorization to the same IPC connection
      // whose full daemon identity logout already verified.
      onShutdown?.();
      return;
    }
    if (parsed.method === '$mutation.release') {
      const releasedLeaseId = parseLeaseId(parsed.params);
      await mutationLeases.release(connectionId, releasedLeaseId);
      await writeLine(socket, { id, result: { ok: true } });
      return;
    }
    if (parsed.method === '$mutation.fence') {
      const fencedLeaseId = parseLeaseId(parsed.params);
      mutationLeases.fence(connectionId, fencedLeaseId, 'client reported unconfirmed write');
      await writeLine(socket, { id, result: { ok: true } });
      return;
    }
    write = parsed.kind === 'write' || isKnownGatewayWriteMethod(parsed.method);
    exitLeaseRequest = await mutationLeases.enter(connectionId, leaseId, write);
    const result = await handler(
      {
        method: parsed.method,
        params: parsed.params,
        ...(parsed.timeoutMs !== undefined && { timeoutMs: parsed.timeoutMs }),
        ...(write
          ? { kind: 'write' as const }
          : parsed.kind !== undefined && { kind: parsed.kind }),
        ...(leaseId !== undefined && { leaseId }),
      },
      {
        connectionId,
        ...(leaseId !== undefined && { leaseId }),
        fenceMutation: (reason) => mutationLeases.fence(connectionId, leaseId, reason),
      },
    );
    const written = await writeLine(socket, { id, result });
    if (write && !written) {
      mutationLeases.fence(connectionId, leaseId, 'write acknowledgement was not delivered');
    }
  } catch (e) {
    const env = errorEnvelope(e);
    await writeLine(socket, id === undefined ? { id: 0, error: env } : { id, error: env });
  } finally {
    exitLeaseRequest?.();
  }
}

function parseMutationAcquireParams(params: unknown): { operation: string; waitTimeoutMs: number } {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new ConfigError('$mutation.acquire requires object params');
  }
  const value = params as Record<string, unknown>;
  if (typeof value.operation !== 'string' || value.operation.length === 0) {
    throw new ConfigError('$mutation.acquire requires a non-empty operation');
  }
  if (!Number.isSafeInteger(value.waitTimeoutMs) || (value.waitTimeoutMs as number) <= 0) {
    throw new ConfigError('$mutation.acquire requires a positive integer waitTimeoutMs');
  }
  return { operation: value.operation, waitTimeoutMs: value.waitTimeoutMs as number };
}

function parseWaitTimeout(params: unknown, method: string): number {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new ConfigError(`${method} requires object params`);
  }
  const waitTimeoutMs = (params as Record<string, unknown>).waitTimeoutMs;
  if (!Number.isSafeInteger(waitTimeoutMs) || (waitTimeoutMs as number) <= 0) {
    throw new ConfigError(`${method} requires a positive integer waitTimeoutMs`);
  }
  return waitTimeoutMs as number;
}

function parseLeaseId(params: unknown): string {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new ConfigError('mutation lease operation requires object params');
  }
  const leaseId = (params as Record<string, unknown>).leaseId;
  if (typeof leaseId !== 'string' || leaseId.length === 0) {
    throw new ConfigError('mutation lease operation requires leaseId');
  }
  return leaseId;
}

/**
 * Write one response without allowing peer disconnects to reject handleLine.
 *
 * `socket.destroyed` is only a snapshot: the peer can close between that check
 * and the asynchronous write. The callback plus error/close listeners contain
 * that race within this connection and report `false` instead of throwing.
 */
function writeLine(socket: Socket, payload: unknown): Promise<boolean> {
  if (socket.destroyed || socket.writableEnded || !socket.writable) {
    return Promise.resolve(false);
  }
  const line = `${JSON.stringify(payload)}\n`;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (written: boolean): void => {
      if (settled) return;
      settled = true;
      socket.off('close', onClose);
      socket.off('error', onError);
      resolve(written);
    };
    const onClose = (): void => finish(false);
    const onError = (): void => finish(false);

    socket.once('close', onClose);
    socket.once('error', onError);
    try {
      socket.write(line, (error) => finish(error === undefined || error === null));
    } catch {
      // A close can race synchronously with socket.write as well.
      finish(false);
    }
  });
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
