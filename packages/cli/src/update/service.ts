import { ConfigError } from '@eyaeya/xgg-core';
import { UpdateInstallError, detectInstall, installUpdate } from './install.js';
import { DEFAULT_REGISTRIES, fetchRelease, findUpdate } from './registry.js';
import { type SkillSyncResult, syncInstalledSkills } from './skills.js';

export interface UpdateOptions {
  check?: boolean | undefined;
  registry?: string | undefined;
  /** The foreground hook already repaired the current package before checking the network. */
  skipCurrentSkillSync?: boolean | undefined;
}

export interface UpdateDependencies {
  detect: typeof detectInstall;
  find: typeof findUpdate;
  fetchRelease: typeof fetchRelease;
  install: typeof installUpdate;
  syncSkills: typeof syncInstalledSkills;
}

const defaults: UpdateDependencies = {
  detect: detectInstall,
  find: findUpdate,
  fetchRelease,
  install: installUpdate,
  syncSkills: syncInstalledSkills,
};

/** Skill failures never discard a verified CLI installation or expose subprocess diagnostics. */
export async function synchronizeSkills(
  packageRoot: string,
  sync: typeof syncInstalledSkills = syncInstalledSkills,
): Promise<SkillSyncResult> {
  try {
    return await sync({ packageRoot });
  } catch {
    return {
      status: 'partial',
      digest: '',
      updatedPaths: [],
      backups: [],
      issues: [
        { path: packageRoot, reason: 'Skill synchronization failed; run xgg update to retry.' },
      ],
    };
  }
}

/** Does not touch gateway state or credentials. External Skills use the verified package copy. */
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
  if (options.check) return result;
  if (!found.updateAvailable) {
    if (options.skipCurrentSkillSync) return result;
    const skills = await synchronizeSkills(installation.packageRoot, deps.syncSkills);
    return {
      ...result,
      skills,
      warnings:
        skills.status === 'partial'
          ? [
              ...result.warnings,
              'CLI is current, but Agent Skill synchronization is incomplete. Review skills.issues before retrying.',
            ]
          : result.warnings,
    };
  }

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
  const skills = await synchronizeSkills(installation.packageRoot, deps.syncSkills);
  return {
    ...result,
    status: 'updated',
    currentVersion: found.latestVersion,
    previousVersion: currentVersion,
    updateAvailable: false,
    installedVersion: found.latestVersion,
    skills,
    warnings:
      skills.status === 'partial'
        ? [
            ...result.warnings,
            'CLI was updated, but Agent Skill synchronization is incomplete. Review skills.issues before retrying.',
          ]
        : result.warnings,
  };
}
