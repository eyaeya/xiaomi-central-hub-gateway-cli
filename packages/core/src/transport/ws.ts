import { WebSocket } from 'ws';
import { NetworkError } from './errors.js';
import type { BinaryTransport } from './fake.js';

export interface ConnectWsOptions {
  url: string;
  /** Milliseconds to wait for the initial 'open' event before aborting. */
  connectTimeoutMs?: number;
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
 *     `receiveError`; the next `receive()` call (or any pending one) rejects.
 *   - `close()` is idempotent.
 *
 * Not unit-tested in M2 — exercised end-to-end against a real gateway in Task 11.
 */
export async function connectWs(opts: ConnectWsOptions): Promise<BinaryTransport> {
  const ws = new WebSocket(opts.url, { perMessageDeflate: false });
  ws.binaryType = 'nodebuffer';

  const queue: Buffer[] = [];
  let resolveNext: ((b: Buffer) => void) | null = null;
  let rejectNext: ((e: unknown) => void) | null = null;
  let receiveError: Error | null = null;

  const failPending = (err: Error): void => {
    receiveError ??= err;
    if (rejectNext) {
      const r = rejectNext;
      resolveNext = null;
      rejectNext = null;
      r(err);
    }
  };

  ws.on('message', (data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      rejectNext = null;
      r(buf);
    } else {
      queue.push(buf);
    }
  });

  ws.on('error', (err) => {
    failPending(err);
  });

  ws.on('close', () => {
    failPending(new NetworkError('ws closed by peer'));
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
  let cancelKeepalive: (() => void) | null = null;
  if (keepaliveMs > 0) {
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
        fail: (err) => failPending(err),
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
      if (ws.readyState !== WebSocket.OPEN) throw new NetworkError('ws not open');
      ws.send(frame, { binary: true });
    },
    receive(): Promise<Buffer> {
      const head = queue.shift();
      if (head !== undefined) return Promise.resolve(head);
      if (receiveError) return Promise.reject(receiveError);
      return new Promise<Buffer>((resolve, reject) => {
        resolveNext = resolve;
        rejectNext = reject;
      });
    },
    close(): void {
      if (cancelKeepalive) cancelKeepalive();
      cancelKeepalive = null;
      try {
        ws.close();
      } catch {
        // already closing/closed — nothing to do
      }
    },
  };
}
