import { StableVersion, UpdateHttpsUrl, UpdatePackageMetadata } from '@eyaeya/xgg-core';

export const DEFAULT_REGISTRIES = [
  'https://registry.npmjs.org',
  'https://registry.npmmirror.com',
] as const;

const MAX_METADATA_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 2500;

export type UpdateRelease = {
  version: string;
  registry: string;
  tarball: string;
  integrity: string;
  nodeEngine?: string;
};

export type UpdateCheck = {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  release: UpdateRelease;
  fallback: boolean;
  warnings: string[];
};

/** Messages are fixed: fetch errors and invalid server payloads can contain secrets. */
export class UpdateRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpdateRegistryError';
  }
}

export function compareVersions(left: string, right: string): number {
  if (!StableVersion.safeParse(left).success || !StableVersion.safeParse(right).success) {
    throw new UpdateRegistryError('Update versions must be stable major.minor.patch versions.');
  }
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function normalizeRegistry(value: string): string {
  if (!UpdateHttpsUrl.safeParse(value).success) {
    throw new UpdateRegistryError(
      'Update registry must be an HTTPS URL without credentials, query, or fragment.',
    );
  }
  return new URL(value).href.replace(/\/+$/, '');
}

async function readMetadata(response: Response): Promise<unknown> {
  const size = response.headers.get('content-length');
  if ((size !== null && Number(size) > MAX_METADATA_BYTES) || !response.body) {
    throw new UpdateRegistryError('Update registry metadata is empty or exceeds the size limit.');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_METADATA_BYTES) {
        void reader.cancel().catch(() => {});
        throw new UpdateRegistryError('Update registry metadata exceeds the size limit.');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')) as unknown;
}

/** Fetching an exact version is used when installation must fall back to another registry. */
export async function fetchRelease(
  registry: string,
  version = 'latest',
  fetchFn: typeof fetch = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<UpdateRelease> {
  const source = normalizeRegistry(registry);
  if (version !== 'latest' && !StableVersion.safeParse(version).success) {
    throw new UpdateRegistryError('Requested update version must be a stable release.');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new UpdateRegistryError('Update timeout must be between 1 and 60000 milliseconds.');
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new UpdateRegistryError('Update registry request timed out.'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      timeout,
      (async () => {
        const response = await fetchFn(`${source}/@eyaeya%2fxgg-cli/${version}`, {
          signal: controller.signal,
          redirect: 'error',
          headers: { accept: 'application/json' },
        });
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          throw new UpdateRegistryError('Update registry did not return package metadata.');
        }
        const parsed = UpdatePackageMetadata.safeParse(await readMetadata(response));
        if (!parsed.success || (version !== 'latest' && parsed.data.version !== version)) {
          throw new UpdateRegistryError('Update registry returned invalid release metadata.');
        }
        return {
          version: parsed.data.version,
          registry: source,
          tarball: parsed.data.dist.tarball,
          integrity: parsed.data.dist.integrity,
          ...(parsed.data.engines ? { nodeEngine: parsed.data.engines.node } : {}),
        };
      })(),
    ]);
  } catch (error) {
    if (error instanceof UpdateRegistryError) throw error;
    throw new UpdateRegistryError(
      'Update registry request failed or returned unreadable metadata.',
    );
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export async function findUpdate(
  currentVersion: string,
  options: {
    registry?: string | undefined;
    fetch?: typeof fetch | undefined;
    timeoutMs?: number | undefined;
  } = {},
): Promise<UpdateCheck> {
  compareVersions(currentVersion, currentVersion);
  const registries =
    options.registry !== undefined ? [normalizeRegistry(options.registry)] : DEFAULT_REGISTRIES;
  const warnings: string[] = [];
  for (const [index, registry] of registries.entries()) {
    try {
      const release = await fetchRelease(registry, 'latest', options.fetch, options.timeoutMs);
      const mirror = release.registry !== DEFAULT_REGISTRIES[0];
      const fallback = index > 0;
      if (mirror || fallback) {
        warnings.push(
          'Mirror metadata may lag the official registry; latest freshness is unverified.',
        );
      }
      if (compareVersions(release.version, currentVersion) < 0) {
        warnings.push(
          'The registry version is older than this installation; downgrades are disabled.',
        );
      }
      return {
        currentVersion,
        latestVersion: release.version,
        updateAvailable: compareVersions(release.version, currentVersion) > 0,
        release,
        fallback,
        warnings,
      };
    } catch {
      warnings.push(
        index === 0
          ? 'Primary update registry unavailable.'
          : 'Fallback update registry unavailable.',
      );
    }
  }
  throw new UpdateRegistryError(
    'Unable to check updates from the configured registries. Check network access or use --registry with an accessible HTTPS npm registry.',
  );
}
