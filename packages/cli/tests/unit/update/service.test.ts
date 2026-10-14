import { describe, expect, it, vi } from 'vitest';
import { UpdateInstallError } from '../../../src/update/install.js';
import {
  DEFAULT_REGISTRIES,
  type UpdateCheck,
  type UpdateRelease,
} from '../../../src/update/registry.js';
import { type UpdateDependencies, runUpdate } from '../../../src/update/service.js';

const currentVersion = '3.0.0';
const packageRoot = '/virtual/npm/lib/node_modules/@eyaeya/xgg-cli';
const official = DEFAULT_REGISTRIES[0];
const mirror = DEFAULT_REGISTRIES[1];

function release(registry = official as string): UpdateRelease {
  return {
    version: '3.1.0',
    registry,
    tarball: `${registry}/@eyaeya/xgg-cli/-/xgg-cli-3.1.0.tgz`,
    integrity: `sha512-${'a'.repeat(86)}==`,
  };
}

function harness(overrides: Partial<UpdateCheck> = {}) {
  const found: UpdateCheck = {
    currentVersion,
    latestVersion: '3.1.0',
    updateAvailable: true,
    release: release(),
    fallback: false,
    warnings: [],
    ...overrides,
  };
  const deps = {
    detect: vi
      .fn<UpdateDependencies['detect']>()
      .mockResolvedValue({ supported: true, packageRoot }),
    find: vi.fn<UpdateDependencies['find']>().mockResolvedValue(found),
    fetchRelease: vi.fn<UpdateDependencies['fetchRelease']>().mockResolvedValue(release(mirror)),
    install: vi.fn<UpdateDependencies['install']>().mockResolvedValue({
      version: found.latestVersion,
      previousVersion: currentVersion,
      packageRoot,
    }),
  } satisfies UpdateDependencies;
  return { deps, found };
}

describe('explicit update orchestration', () => {
  it('checks without installing and reports availability independently of authentication', async () => {
    const { deps } = harness();
    const result = await runUpdate(currentVersion, { check: true }, deps);
    expect(result).toMatchObject({
      ok: true,
      status: 'available',
      currentVersion,
      latestVersion: '3.1.0',
      updateAvailable: true,
      source: official,
      freshness: 'source-latest',
      installSupported: true,
    });
    expect(deps.find).toHaveBeenCalledWith(currentVersion, { registry: undefined });
    expect(deps.install).not.toHaveBeenCalled();
    expect(deps.fetchRelease).not.toHaveBeenCalled();
  });

  it('allows check-only in unsupported installations with actionable installation guidance', async () => {
    const { deps } = harness();
    deps.detect.mockResolvedValue({
      supported: false,
      packageRoot,
      reason: 'Use the original pnpm installation.',
    });
    expect(await runUpdate(currentVersion, { check: true }, deps)).toMatchObject({
      status: 'available',
      installSupported: false,
      installHint: 'Use the original pnpm installation.',
    });
    expect(deps.install).not.toHaveBeenCalled();
  });

  it('rejects unsupported self-update before contacting a registry', async () => {
    const { deps } = harness();
    deps.detect.mockResolvedValue({
      supported: false,
      packageRoot,
      reason: 'Use git/pnpm for this source checkout.',
    });
    await expect(runUpdate(currentVersion, {}, deps)).rejects.toMatchObject({
      details: { domain: 'update', reason: expect.stringContaining('git/pnpm') },
    });
    expect(deps.find).not.toHaveBeenCalled();
    expect(deps.install).not.toHaveBeenCalled();
  });

  it.each(['3.0.0', '2.9.0'])(
    'does not install a current or older registry version %s',
    async (latestVersion) => {
      const { deps } = harness({
        latestVersion,
        updateAvailable: false,
        release: { ...release(), version: latestVersion },
      });
      expect(await runUpdate(currentVersion, {}, deps)).toMatchObject({
        status: 'current',
        updateAvailable: false,
      });
      expect(deps.install).not.toHaveBeenCalled();
    },
  );

  it('installs exactly the selected release into the detected package root', async () => {
    const { deps, found } = harness();
    const result = await runUpdate(currentVersion, {}, deps);
    expect(deps.install).toHaveBeenCalledOnce();
    expect(deps.install).toHaveBeenCalledWith(found.release, { packageRoot });
    expect(result).toMatchObject({
      status: 'updated',
      currentVersion: '3.1.0',
      previousVersion: currentVersion,
      updateAvailable: false,
    });
  });

  it('uses the exact official version and matching digest when the staged download falls back', async () => {
    const { deps } = harness();
    deps.install.mockRejectedValueOnce(new UpdateInstallError('Staged download failed.', true));
    const result = await runUpdate(currentVersion, {}, deps);
    expect(deps.fetchRelease).toHaveBeenCalledOnce();
    expect(deps.fetchRelease).toHaveBeenCalledWith(mirror, '3.1.0');
    expect(deps.install).toHaveBeenCalledTimes(2);
    expect(deps.install).toHaveBeenNthCalledWith(2, release(mirror), { packageRoot });
    expect(result).toMatchObject({
      status: 'updated',
      source: mirror,
      fallback: true,
      freshness: 'official-version-mirror-download',
      warnings: [expect.stringContaining('exact official version')],
    });
  });

  it('refuses mirror installation when its artifact digest differs from official metadata', async () => {
    const { deps } = harness();
    deps.install.mockRejectedValueOnce(new UpdateInstallError('Staged download failed.', true));
    deps.fetchRelease.mockResolvedValue({
      ...release(mirror),
      integrity: `sha512-${'b'.repeat(86)}==`,
    });
    await expect(runUpdate(currentVersion, {}, deps)).rejects.toMatchObject({
      details: { domain: 'update' },
    });
    expect(deps.install).toHaveBeenCalledOnce();
  });

  it('does not change sources when an explicit registry installation fails', async () => {
    const registry = 'https://packages.example.test';
    const { deps } = harness({ release: release(registry) });
    deps.install.mockRejectedValue(new UpdateInstallError('Staged download failed.', true));
    const result = runUpdate(currentVersion, { registry }, deps);
    await expect(result).rejects.toThrow('Update installation failed');
    expect(deps.find).toHaveBeenCalledWith(currentVersion, { registry });
    expect(deps.fetchRelease).not.toHaveBeenCalled();
    expect(deps.install).toHaveBeenCalledOnce();
  });

  it('does not retry the same mirror after a mirror-selected installation fails', async () => {
    const { deps } = harness({ release: release(mirror), fallback: true });
    deps.install.mockRejectedValue(new UpdateInstallError('Staged download failed.', true));
    await expect(runUpdate(currentVersion, {}, deps)).rejects.toThrow('Update installation failed');
    expect(deps.fetchRelease).not.toHaveBeenCalled();
    expect(deps.install).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    'reports mirror freshness honestly even with an explicit mirror override (fallback=%s)',
    async (fallback) => {
      const { deps } = harness({ release: release(mirror), fallback });
      expect(
        await runUpdate(currentVersion, { check: true, registry: mirror }, deps),
      ).toMatchObject({
        source: mirror,
        freshness: 'mirror-may-lag',
        fallback,
      });
    },
  );

  it.each([
    new Error('private diagnostic must not leak'),
    new UpdateInstallError('Another update owns the installation lock.', false),
    new UpdateInstallError('Restore the preserved package before retrying.', false, true),
  ])(
    'does not attempt mirror fallback after an unsafe or unknown installation error',
    async (error) => {
      const { deps } = harness();
      deps.install.mockRejectedValue(error);
      const attempt = runUpdate(currentVersion, {}, deps);
      await expect(attempt).rejects.toMatchObject({
        details: {
          domain: 'update',
          recoveryNeeded: error instanceof UpdateInstallError && error.recoveryNeeded,
        },
      });
      await expect(attempt).rejects.not.toThrow('private diagnostic must not leak');
      expect(deps.fetchRelease).not.toHaveBeenCalled();
      expect(deps.install).toHaveBeenCalledOnce();
    },
  );

  it('preserves recovery-needed guidance when fallback activation cannot be rolled back', async () => {
    const { deps } = harness();
    deps.install
      .mockRejectedValueOnce(new UpdateInstallError('Staged download failed.', true))
      .mockRejectedValueOnce(
        new UpdateInstallError('Restore the preserved package before retrying.', false, true),
      );
    await expect(runUpdate(currentVersion, {}, deps)).rejects.toMatchObject({
      details: {
        domain: 'update',
        recoveryNeeded: true,
        hint: 'Restore the preserved package before retrying.',
      },
    });
    expect(deps.install).toHaveBeenCalledTimes(2);
  });

  it('propagates check failure instead of claiming an offline installation is current', async () => {
    const { deps } = harness();
    deps.find.mockRejectedValue(
      new Error('Unable to check updates from the configured registries.'),
    );
    await expect(runUpdate(currentVersion, { check: true }, deps)).rejects.toThrow(
      'Unable to check updates',
    );
    expect(deps.install).not.toHaveBeenCalled();
  });
});
