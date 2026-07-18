import { NetworkError, SchemaError } from './transport/errors.js';

const MIOT_SPEC_DEPENDENCY = 'miot-spec-registry';

interface MiotSpecErrorContext {
  status?: number;
  timeoutMs?: number;
  cause?: unknown;
  urn?: string;
}

function publicRegistryUrl(rawUrl: string, urn?: string): string {
  try {
    const url = new URL(rawUrl);
    url.username = '';
    url.password = '';
    url.hash = '';
    // Never trust query values inherited from a configured base URL. Only the
    // URN supplied separately by fetchMiotSpec is safe to expose.
    url.search = '';
    if (urn !== undefined) url.searchParams.set('type', urn);
    return url.toString();
  } catch {
    return '<invalid-miot-spec-registry-url>';
  }
}

function errorDetails(rawUrl: string, context: MiotSpecErrorContext): Record<string, unknown> {
  const details: Record<string, unknown> = {
    dependency: MIOT_SPEC_DEPENDENCY,
    url: publicRegistryUrl(rawUrl, context.urn),
  };
  if (context.status !== undefined) details.status = context.status;
  if (context.timeoutMs !== undefined) details.timeoutMs = context.timeoutMs;
  return details;
}

export class MiotSpecFetchError extends NetworkError {
  override readonly name = 'MiotSpecFetchError';
  readonly url: string;
  readonly status: number | undefined;
  override readonly cause: unknown;

  constructor(message: string, rawUrl: string, context: MiotSpecErrorContext = {}) {
    super(message, errorDetails(rawUrl, context));
    this.url = publicRegistryUrl(rawUrl, context.urn);
    this.status = context.status;
    this.cause = context.cause;
  }
}

export class MiotSpecContentError extends SchemaError {
  override readonly name = 'MiotSpecContentError';
  readonly url: string;
  readonly status: number | undefined;
  override readonly cause: unknown;

  constructor(message: string, rawUrl: string, context: MiotSpecErrorContext = {}) {
    super(message, errorDetails(rawUrl, context));
    this.url = publicRegistryUrl(rawUrl, context.urn);
    this.status = context.status;
    this.cause = context.cause;
  }
}

export interface FetchMiotSpecOptions {
  timeoutMs?: number;
  baseUrl?: string;
}

const DEFAULT_BASE_URL = 'https://miot-spec.org/miot-spec-v2/instance';
const DEFAULT_TIMEOUT_MS = 5000;

// F66g: per-process cache. Bundle parity — gateway.6cbc85.js spec-translator
// (bundle:0x61f50) fetches miot-spec.org once per session + caches by URN;
// ai-config-v5.28b650.js holds the result in a per-page-load Map. xgg daemon
// is the analogous long-lived process, so an indefinite Map<urn, Promise> is
// safe: specs do not change within a daemon lifetime. We cache the *promise*
// (not the resolved value) so concurrent callers for the same URN dedupe onto
// one in-flight fetch. Failures are evicted so a retry actually retries.
const specCache = new Map<string, Promise<unknown>>();

/** Test-only helper: clear the module-level cache for unit isolation. */
export function __resetSpecCache(): void {
  specCache.clear();
}

export async function fetchMiotSpec(
  urn: string,
  opts: FetchMiotSpecOptions = {},
): Promise<unknown> {
  const cached = specCache.get(urn);
  if (cached) return cached;

  const promise = doFetchMiotSpec(urn, opts);
  specCache.set(urn, promise);
  // Evict on failure so retries actually retry. Use .then to keep the original
  // promise identity for concurrent callers and avoid double-handling.
  promise.catch(() => {
    if (specCache.get(urn) === promise) specCache.delete(urn);
  });
  return promise;
}

async function doFetchMiotSpec(urn: string, opts: FetchMiotSpecOptions): Promise<unknown> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let url: string;
  try {
    const requestUrl = new URL(baseUrl);
    requestUrl.searchParams.set('type', urn);
    url = requestUrl.toString();
  } catch (cause) {
    throw new MiotSpecFetchError('MIoT spec registry URL is invalid', baseUrl, { cause, urn });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { method: 'GET', signal: controller.signal });
    if (!res.ok) {
      throw new MiotSpecFetchError(
        `MIoT spec registry request failed with HTTP ${res.status}`,
        url,
        { status: res.status, urn },
      );
    }
    try {
      return await res.json();
    } catch (jsonErr) {
      if (controller.signal.aborted) {
        throw new MiotSpecFetchError(
          `MIoT spec registry request timed out after ${timeoutMs}ms`,
          url,
          { status: res.status, timeoutMs, cause: jsonErr, urn },
        );
      }
      throw new MiotSpecContentError('MIoT spec registry returned malformed JSON', url, {
        status: res.status,
        cause: jsonErr,
        urn,
      });
    }
  } catch (err) {
    if (err instanceof MiotSpecFetchError || err instanceof MiotSpecContentError) throw err;
    const timedOut = controller.signal.aborted;
    throw new MiotSpecFetchError(
      timedOut
        ? `MIoT spec registry request timed out after ${timeoutMs}ms`
        : 'MIoT spec registry request failed',
      url,
      {
        ...(timedOut ? { timeoutMs } : {}),
        cause: err,
        urn,
      },
    );
  } finally {
    clearTimeout(timer);
  }
}
