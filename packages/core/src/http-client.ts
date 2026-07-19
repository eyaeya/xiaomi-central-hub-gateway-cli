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

interface PreparedMiotSpecRequest {
  url: string;
  timeoutMs: number;
}

// F66g/#77: cache successful specs by their effective registry request URL,
// not by URN alone. A caller's timeout is an in-flight deadline policy rather
// than response identity, so a resolved same-URL value can be reused across
// later timeouts while concurrent requests only dedupe when both URL and
// timeout match. Different deadlines therefore never share an AbortController.
const resolvedSpecCache = new Map<string, unknown>();
const inFlightSpecCache = new Map<string, Promise<unknown>>();
let specCacheGeneration = 0;

/** Test-only helper: clear the module-level cache for unit isolation. */
export function __resetSpecCache(): void {
  specCacheGeneration += 1;
  resolvedSpecCache.clear();
  inFlightSpecCache.clear();
}

export async function fetchMiotSpec(
  urn: string,
  opts: FetchMiotSpecOptions = {},
): Promise<unknown> {
  // Constructing the effective URL before any lookup prevents a resolved
  // entry for another registry from bypassing validation of this call.
  const request = prepareMiotSpecRequest(urn, opts);
  if (resolvedSpecCache.has(request.url)) return resolvedSpecCache.get(request.url);

  const policyKey = JSON.stringify([request.url, request.timeoutMs]);
  const cached = inFlightSpecCache.get(policyKey);
  if (cached) return cached;

  const generation = specCacheGeneration;
  const promise = doFetchMiotSpec(urn, request).then((raw) => {
    // Specs are treated as stable within a process. When different timeout
    // policies race, keep the first successful response as the resolved value.
    // A test reset also fences older in-flight work from repopulating the cache.
    if (generation === specCacheGeneration && !resolvedSpecCache.has(request.url)) {
      resolvedSpecCache.set(request.url, raw);
    }
    return raw;
  });
  inFlightSpecCache.set(policyKey, promise);
  // Remove only this exact URL+timeout entry. A failed short-deadline request
  // must not evict or replace a longer request for the same registry URL.
  void promise.then(
    () => {
      if (inFlightSpecCache.get(policyKey) === promise) inFlightSpecCache.delete(policyKey);
    },
    () => {
      if (inFlightSpecCache.get(policyKey) === promise) inFlightSpecCache.delete(policyKey);
    },
  );
  return promise;
}

function prepareMiotSpecRequest(urn: string, opts: FetchMiotSpecOptions): PreparedMiotSpecRequest {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const requestUrl = new URL(baseUrl);
    requestUrl.searchParams.set('type', urn);
    // URL fragments never reach an HTTP server and therefore are not part of
    // the effective registry request identity.
    requestUrl.hash = '';
    return { url: requestUrl.toString(), timeoutMs };
  } catch (cause) {
    throw new MiotSpecFetchError('MIoT spec registry URL is invalid', baseUrl, { cause, urn });
  }
}

async function doFetchMiotSpec(urn: string, request: PreparedMiotSpecRequest): Promise<unknown> {
  const { url, timeoutMs } = request;
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
