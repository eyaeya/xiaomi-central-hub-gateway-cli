import { ConfigError } from '@eyaeya/xgg-core';
import { UpdateInstallError, detectInstall, installUpdate } from './install.js';
import { DEFAULT_REGISTRIES, fetchRelease, findUpdate } from './registry.js';

export interface UpdateOptions {
  check?: boolean | undefined;
  registry?: string | undefined;
}

export interface UpdateDependencies {
  detect: typeof detectInstall;
  find: typeof findUpdate;
  fetchRelease: typeof fetchRelease;
  install: typeof installUpdate;
}

const defaults: UpdateDependencies = {
  detect: detectInstall,
  find: findUpdate,
  fetchRelease,
  install: installUpdate,
};

/** Does not touch gateway state, credentials, or external Agent Skill directories. */
export async function runUpdate(
  currentVersion: string,
  options: UpdateOptions = {},
  deps: UpdateDependencies = defaults,
) {
  const installation = await deps.detect();
  if (!options.check && !installation.supported) {
    throw new ConfigError('This installation cannot be self-updated.', {
      domain: 'update',
      reason: installation.reason,
      hint: 'Use the original package manager to upgrade, or use xgg update --check.',
    });
  }
  const found = await deps.find(currentVersion, { registry: options.registry });
  const result = {
    ok: true,
    status: found.updateAvailable ? 'available' : 'current',
    currentVersion,
    latestVersion: found.latestVersion,
    updateAvailable: found.updateAvailable,
    source: found.release.registry,
    fallback: found.fallback,
    freshness:
      found.fallback || found.release.registry !== DEFAULT_REGISTRIES[0]
        ? 'mirror-may-lag'
        : 'source-latest',
    warnings: found.warnings,
    installSupported: installation.supported,
    ...(installation.reason ? { installHint: installation.reason } : {}),
  };
  if (options.check || !found.updateAvailable) return result;

  try {
    await deps.install(found.release, { packageRoot: installation.packageRoot });
  } catch (error) {
    if (!(error instanceof UpdateInstallError) || !error.retrySafe) {
      throw new ConfigError('Update could not safely continue.', {
        domain: 'update',
        recoveryNeeded: error instanceof UpdateInstallError && error.recoveryNeeded,
        hint:
          error instanceof UpdateInstallError
            ? error.message
            : 'Retry xgg update after checking installation permissions.',
      });
    }
    // A selected exact version is never changed during download fallback.
    // An explicit registry is an override, not permission to contact other registries.
    const mirror = DEFAULT_REGISTRIES[1];
    if (options.registry || found.release.registry !== DEFAULT_REGISTRIES[0] || !mirror) {
      throw new ConfigError('Update installation failed; the previous installation was retained.', {
        domain: 'update',
        hint: 'Retry xgg update when the registry is reachable, or select --registry <https-url>.',
      });
    }
    try {
      const fallback = await deps.fetchRelease(mirror, found.latestVersion);
      // Metadata from an independent mirror must agree with the official artifact digest.
      if (fallback.integrity !== found.release.integrity) throw new Error('Integrity mismatch');
      await deps.install(fallback, { packageRoot: installation.packageRoot });
      result.source = mirror;
      result.fallback = true;
      result.freshness = 'official-version-mirror-download';
      result.warnings = [
        ...result.warnings,
        'Downloaded the exact official version through npmmirror.',
      ];
    } catch (fallbackError) {
      if (fallbackError instanceof UpdateInstallError && !fallbackError.retrySafe) {
        throw new ConfigError('Update could not safely continue.', {
          domain: 'update',
          recoveryNeeded: fallbackError.recoveryNeeded,
          hint: fallbackError.message,
        });
      }
      throw new ConfigError('Update installation failed on both registries.', {
        domain: 'update',
        hint: 'The previous installation was retained. Retry later or choose --registry <https-url>.',
      });
    }
  }
  return {
    ...result,
    status: 'updated',
    currentVersion: found.latestVersion,
    previousVersion: currentVersion,
    updateAvailable: false,
    installedVersion: found.latestVersion,
  };
}
