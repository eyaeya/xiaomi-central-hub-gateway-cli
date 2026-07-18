import { GatewayError, NetworkError } from './errors.js';
import type { BinaryTransport } from './fake.js';
import type { SessionChannel } from './session-channel.js';

export interface JsonRpcRouterOptions {
  transport: BinaryTransport;
  channel: SessionChannel;
  /** Default per-request timeout in ms. Override per call via `request(_, _, {timeoutMs})`. */
  defaultTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Multiplexes JSON-RPC requests/responses over a single `SessionChannel`.
 *
 * Wire model:
 *   - Each outgoing request gets a monotonically increasing `id`.
 *   - The reader loop dispatches incoming 0x05 frames to the pending entry by id.
 *   - Frames whose id doesn't match a pending request are dropped silently in M2
 *     (gateway-pushed events are not yet wired through this router).
 *
 * Failure modes mapped to typed errors:
 *   - server `error` object → `GatewayError` (carries `gatewayCode` + `data`)
 *   - per-request deadline elapsed → `NetworkError("...timed out...")`, or the
 *     error returned by the caller's `onTimeout(timeoutMs)` factory (the daemon
 *     uses this to map a write timeout to `NotConfirmedError` — the router stays
 *     transport-generic and never hard-codes write/read semantics)
 *   - transport close / decrypt failure → all pending rejected, loop exits
 */
export class JsonRpcRouter {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private running = false;
  private loop: Promise<void> | null = null;
  private readonly defaultTimeoutMs: number;
  /**
   * Resolves once the router's read loop has exited (transport close,
   * unrecoverable decrypt failure, or explicit `stop()`). Lets the agent
   * driver observe WS death without polling.
   */
  readonly done: Promise<void>;
  private resolveDone!: () => void;

  constructor(private readonly opts: JsonRpcRouterOptions) {
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 5000;
    this.done = new Promise<void>((r) => {
      this.resolveDone = r;
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.readLoop().finally(() => this.resolveDone());
  }

  async stop(): Promise<void> {
    this.running = false;
    this.opts.transport.close();
    if (this.loop) {
      try {
        await this.loop;
      } catch {
        // readLoop only throws via rejected pending entries; nothing to surface here.
      }
      this.loop = null;
    }
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new NetworkError('router stopped'));
    }
    this.pending.clear();
  }

  request(
    method: string,
    params: unknown,
    opts?: { timeoutMs?: number; onTimeout?: (timeoutMs: number) => Error },
  ): Promise<unknown> {
    if (!this.running) throw new Error('router not started');
    const id = this.nextId++;
    const timeoutMs = opts?.timeoutMs ?? this.defaultTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          opts?.onTimeout
            ? opts.onTimeout(timeoutMs)
            : new NetworkError(`request ${id} (${method}) timeout after ${timeoutMs}ms`),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.opts.transport.send(
          this.opts.channel.sendJson({ jsonrpc: '2.0', id, method, params }),
        );
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  private async readLoop(): Promise<void> {
    while (this.running) {
      let frame: Buffer;
      try {
        frame = await this.opts.transport.receive();
      } catch (e) {
        this.failAllPending(new NetworkError(`WS read failed: ${(e as Error).message ?? e}`));
        return;
      }
      let response: JsonRpcResponse;
      try {
        response = this.opts.channel.recvJson(frame) as JsonRpcResponse;
      } catch (e) {
        // Unrecoverable wire-level failure (bad GCM tag, malformed/oversized
        // compressed JSON, wrong type byte, …). Close the transport so callers
        // cannot accidentally continue on a session whose receive counter and
        // protocol state can no longer be trusted.
        this.failAllPending(
          new NetworkError(`session decode failed: ${(e as Error).message ?? e}`),
        );
        this.opts.transport.close();
        return;
      }
      const pending = this.pending.get(response.id);
      if (!pending) continue; // unknown id (e.g. server-pushed event) — ignored in M2
      this.pending.delete(response.id);
      clearTimeout(pending.timer);
      if (response.error) {
        pending.reject(
          new GatewayError(response.error.message, {
            gatewayCode: response.error.code,
            data: response.error.data,
          }),
        );
      } else {
        pending.resolve(response.result);
      }
    }
  }

  private failAllPending(e: unknown): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
  }
}
