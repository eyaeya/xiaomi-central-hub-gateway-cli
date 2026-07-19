import { WebSocket } from 'ws';
import { NetworkError } from './errors.js';
import type { BinaryTransport } from './fake.js';

export interface ConnectWsOptions {
  url: string;
  /** Milliseconds to wait for the initial 'open' event before aborting. */
  connectTimeoutMs?: number;
  /** Maximum bytes accepted in one WebSocket message. Default 32 MiB. */
  maxFrameBytes?: number;
  /** Maximum complete messages buffered while no receive() is pending. Default 64. */
  maxQueuedFrames?: number;
  /** Maximum cumulative bytes buffered while no receive() is pending. Default 64 MiB. */
  maxQueuedBytes?: number;
  /**
   * Application-level keepalive interval in ms. When set (> 0), connectWs
   * starts sending a WebSocket protocol-level ping frame every `keepaliveMs`
   * ms. Default `25_000` (gateway typically idles a TCP connection after
   * ~60s). Set to `0` (or any value ≤ 0) to disable — useful for stub/fake
   * transport tests that drive frames by hand.
   */
  keepaliveMs?: number;
  /**
   * Tolerated consecutive missed pongs before the socket is torn down. M14
   * F4 fix: the original implementation killed the daemon after a single
   * missed pong, which caused premature session loss on transient network
   * jitter. Default `3` (tolerates ~75 s of pong silence at the 25 s
   * interval; comparable to TCP keepalive defaults). Set to `1` to restore
   * the legacy fail-fast behavior.
   */
  maxMissedPongs?: number;
}

// The frame ceiling includes encrypted protocol overhead. Keep it above the
// DATA decoder's compressed-body default while remaining explicitly bounded.
export const DEFAULT_MAX_WS_FRAME_BYTES = 32 * 1024 * 1024;
export const DEFAULT_MAX_WS_QUEUED_FRAMES = 64;
export const DEFAULT_MAX_WS_QUEUED_BYTES = 64 * 1024 * 1024;

function receiveLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new NetworkError(`${name} must be a positive safe integer`, {
      [name]: resolved,
    });
  }
  return resolved;
}

/**
 * Pure driver interface for the keepalive loop: exposed for unit tests so the
 * miss-tolerance logic can be exercised without spinning up a real WebSocket.
 */
export interface KeepaliveDriver {
  isOpen(): boolean;
  ping(): void;
  terminate(): void;
  fail(err: Error): void;
  onPong(handler: () => void): void;
  onClose(handler: () => void): void;
}

export interface KeepaliveOptions {
  intervalMs: number;
  /** Tolerated consecutive missed pongs before terminating. Default 3. */
  maxMissedPongs?: number;
}

/**
 * Start an app-level WS keepalive loop on a driver. Every `intervalMs` we
 * send a ping; any pong resets an internal "unansweredPings" counter. When
 * the counter exceeds `maxMissedPongs` the driver is failed + terminated.
 *
 * Returns a cancel function that stops the loop without firing `fail` or
 * `terminate`. The loop also self-cancels on the driver's close event.
 */
export function startKeepalive(driver: KeepaliveDriver, opts: KeepaliveOptions): () => void {
  const maxMisses = opts.maxMissedPongs ?? 3;
  let unansweredPings = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  const stop = (): void => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  driver.onPong(() => {
    unansweredPings = 0;
  });
  driver.onClose(stop);

  timer = setInterval(() => {
    if (!timer) return;
    if (!driver.isOpen()) return;
    unansweredPings += 1;
    if (unansweredPings > maxMisses) {
      driver.fail(
        new NetworkError(
          `ws keepalive: ${maxMisses} consecutive pings unanswered (gateway stopped responding)`,
        ),
      );
      driver.terminate();
      stop();
      return;
    }
    driver.ping();
  }, opts.intervalMs);

  if (typeof timer.unref === 'function') timer.unref();

  return stop;
}

/**
 * Convert a user-facing http(s) base URL (e.g. `http://<host>:8086`) to the
 * gateway's WS handshake endpoint. The path `/centrallinkws/` is fixed by the
 * gateway firmware.
 */
export function toWsUrl(baseUrl: string): string {
  const u = new URL(baseUrl);
  const scheme = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${u.host}/centrallinkws/`;
}

/**
 * Open a real WebSocket and adapt it to the same `BinaryTransport` interface that
 * the handshake state machine and `JsonRpcRouter` consume.
 *
 * Lifetime model:
 *   - Resolves only after the underlying socket reaches OPEN (or the connect
 *     deadline elapses → `NetworkError`).
 *   - Buffered frames arrive via `'message'` and queue if no consumer is
 *     currently `await`ing `receive()`.
 *   - Any post-connect transport failure (`'error'` or `'close'`) latches into
 *     `receiveError`, discards queued frames, and rejects current/future
 *     `receive()` calls.
 *   - `close()` is idempotent.
 */
export async function connectWs(opts: ConnectWsOptions): Promise<BinaryTransport> {
  const maxFrameBytes = receiveLimit(
    opts.maxFrameBytes,
    DEFAULT_MAX_WS_FRAME_BYTES,
    'maxFrameBytes',
  );
  const maxQueuedFrames = receiveLimit(
    opts.maxQueuedFrames,
    DEFAULT_MAX_WS_QUEUED_FRAMES,
    'maxQueuedFrames',
  );
  const maxQueuedBytes = receiveLimit(
    opts.maxQueuedBytes,
    DEFAULT_MAX_WS_QUEUED_BYTES,
    'maxQueuedBytes',
  );

  const ws = new WebSocket(opts.url, {
    maxPayload: maxFrameBytes,
    perMessageDeflate: false,
  });
  ws.binaryType = 'nodebuffer';

  const queue: Buffer[] = [];
  let queuedBytes = 0;
  let resolveNext: ((b: Buffer) => void) | null = null;
  let rejectNext: ((e: unknown) => void) | null = null;
  let receiveError: NetworkError | null = null;
  let cancelKeepalive: (() => void) | null = null;
  let resolvePhysicalClose!: () => void;
  let rejectPhysicalClose!: (error: Error) => void;
  const physicalClose = new Promise<void>((resolve, reject) => {
    resolvePhysicalClose = resolve;
    rejectPhysicalClose = reject;
  });

  const failTransport = (err: NetworkError, terminate = false): void => {
    if (receiveError) return;
    receiveError = err;
    queue.length = 0;
    queuedBytes = 0;
    if (cancelKeepalive) cancelKeepalive();
    cancelKeepalive = null;
    if (rejectNext) {
      const r = rejectNext;
      resolveNext = null;
      rejectNext = null;
      r(err);
    }
    if (terminate && ws.readyState !== WebSocket.CLOSED) {
      try {
        ws.terminate();
      } catch {
        // already closing/closed
      }
    }
  };

  ws.on('message', (data, isBinary) => {
    if (receiveError) return;
    if (!isBinary) {
      failTransport(new NetworkError('ws protocol violation: expected a binary message'), true);
      return;
    }

    const buf = Buffer.isBuffer(data)
      ? data
      : Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.from(data as ArrayBuffer);
    if (buf.length > maxFrameBytes) {
      failTransport(
        new NetworkError(`ws frame exceeds maxFrameBytes (${maxFrameBytes} bytes)`, {
          frameBytes: buf.length,
          maxFrameBytes,
        }),
        true,
      );
      return;
    }
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      rejectNext = null;
      r(buf);
      return;
    }

    if (queue.length + 1 > maxQueuedFrames) {
      failTransport(
        new NetworkError(`ws receive queue exceeds maxQueuedFrames (${maxQueuedFrames})`, {
          maxQueuedFrames,
          queuedBytes,
          queuedFrames: queue.length,
        }),
        true,
      );
      return;
    }
    if (queuedBytes + buf.length > maxQueuedBytes) {
      failTransport(
        new NetworkError(`ws receive queue exceeds maxQueuedBytes (${maxQueuedBytes} bytes)`, {
          frameBytes: buf.length,
          maxQueuedBytes,
          queuedBytes,
          queuedFrames: queue.length,
        }),
        true,
      );
      return;
    }
    queue.push(buf);
    queuedBytes += buf.length;
  });

  ws.on('error', (err) => {
    const code = 'code' in err ? String(err.code) : undefined;
    const payloadTooLarge =
      code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' ||
      /max payload size exceeded/i.test(err.message);
    failTransport(
      payloadTooLarge
        ? new NetworkError(`ws frame exceeds maxFrameBytes (${maxFrameBytes} bytes)`, {
            cause: err.message,
            maxFrameBytes,
          })
        : new NetworkError(`ws receive failed: ${err.message}`, {
            ...(code !== undefined && { causeCode: code }),
          }),
      payloadTooLarge,
    );
  });

  ws.on('close', () => {
    failTransport(new NetworkError('ws closed by peer'));
    resolvePhysicalClose();
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new NetworkError(`ws connect timeout: ${opts.url}`));
    }, opts.connectTimeoutMs ?? 5000);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(new NetworkError(`ws connect failed: ${err.message}`));
    });
  });

  // App-level keepalive — gateway WS sits idle for ~60s before NAT/firewall
  // can drop it. The `ws` library answers RFC-6455 pings automatically but
  // does not initiate them; we issue our own and tear the socket down only
  // after `maxMissedPongs` consecutive ping intervals without a pong (M14 F4
  // — a single missed pong used to kill the daemon and force re-login).
  const keepaliveMs = opts.keepaliveMs ?? 25_000;
  if (keepaliveMs > 0 && !receiveError && ws.readyState === WebSocket.OPEN) {
    cancelKeepalive = startKeepalive(
      {
        isOpen: () => ws.readyState === WebSocket.OPEN,
        ping: () => {
          try {
            ws.ping();
          } catch {
            // close handler will surface the error
          }
        },
        terminate: () => {
          try {
            ws.terminate();
          } catch {
            // already gone
          }
        },
        fail: (err) =>
          failTransport(
            err instanceof NetworkError
              ? err
              : new NetworkError(`ws keepalive failed: ${err.message}`),
          ),
        onPong: (h) => {
          ws.on('pong', h);
        },
        onClose: (h) => {
          ws.on('close', h);
        },
      },
      {
        intervalMs: keepaliveMs,
        ...(opts.maxMissedPongs !== undefined && { maxMissedPongs: opts.maxMissedPongs }),
      },
    );
  }

  return {
    send(frame: Buffer): void {
      if (receiveError || ws.readyState !== WebSocket.OPEN) {
        throw new NetworkError('ws not open');
      }
      ws.send(frame, { binary: true });
    },
    receive(): Promise<Buffer> {
      if (receiveError) return Promise.reject(receiveError);
      const head = queue.shift();
      if (head !== undefined) {
        queuedBytes -= head.length;
        return Promise.resolve(head);
      }
      return new Promise<Buffer>((resolve, reject) => {
        resolveNext = resolve;
        rejectNext = reject;
      });
    },
    close(): Promise<void> {
      failTransport(new NetworkError('ws closed by client'));
      if (ws.readyState === WebSocket.CLOSED) {
        resolvePhysicalClose();
      } else {
        try {
          // Shutdown must discard Sender-queued frames, not gracefully flush
          // them after the cross-daemon mutation ticket is released.
          ws.terminate();
        } catch (error) {
          rejectPhysicalClose(
            new NetworkError(
              `ws physical close failed: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
        }
      }
      return physicalClose;
    },
  };
}
