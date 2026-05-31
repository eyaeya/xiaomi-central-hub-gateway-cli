export class MiotSpecFetchError extends Error {
  override readonly name = 'MiotSpecFetchError';
  constructor(
    message: string,
    public readonly url: string,
    public readonly status?: number,
    override readonly cause?: unknown,
  ) {
    super(message);
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
  const url = `${baseUrl}?type=${encodeURIComponent(urn)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { method: 'GET', signal: controller.signal });
    if (!res.ok) {
      throw new MiotSpecFetchError(
        `MIoT spec fetch failed: ${res.status} ${res.statusText}`,
        url,
        res.status,
      );
    }
    try {
      return await res.json();
    } catch (jsonErr) {
      throw new MiotSpecFetchError('MIoT spec malformed JSON', url, res.status, jsonErr);
    }
  } catch (err) {
    if (err instanceof MiotSpecFetchError) throw err;
    throw new MiotSpecFetchError(
      `MIoT spec fetch error: ${(err as Error).message}`,
      url,
      undefined,
      err,
    );
  } finally {
    clearTimeout(timer);
  }
}
