import { ReadableStream } from 'node:stream/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compareVersions, fetchRelease, findUpdate } from '../../../src/update/registry.js';

const integrity = `sha512-${'a'.repeat(86)}==`;
function manifest(version = '3.1.0') {
  return {
    name: '@eyaeya/xgg-cli',
    version,
    dependencies: { '@eyaeya/xgg-core': `^${version}` },
    engines: { node: '>=20.11' },
    dist: { tarball: `https://registry.npmjs.org/cli-${version}.tgz`, integrity },
  };
}

function reply(value: unknown): Response {
  return new Response(JSON.stringify(value));
}

afterEach(() => vi.useRealTimers());

describe('stable updater registry', () => {
  it('checks the official registry first and preserves integrity and engine metadata', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(reply(manifest()));
    const result = await findUpdate('3.0.1', { fetch: fetchFn });
    expect(result).toMatchObject({
      currentVersion: '3.0.1',
      latestVersion: '3.1.0',
      updateAvailable: true,
      fallback: false,
      warnings: [],
      release: { registry: 'https://registry.npmjs.org', integrity, nodeEngine: '>=20.11' },
    });
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(fetchFn).toHaveBeenCalledWith(
      'https://registry.npmjs.org/@eyaeya%2fxgg-cli/latest',
      expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) }),
    );
  });

  it('falls back on invalid official metadata and identifies mirror freshness uncertainty', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(reply({ name: 'not-xgg' }))
      .mockResolvedValueOnce(reply(manifest()));
    const result = await findUpdate('3.0.1', { fetch: fetchFn });
    expect(result.fallback).toBe(true);
    expect(result.release.registry).toBe('https://registry.npmmirror.com');
    expect(result.warnings.join(' ')).toContain('may lag');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('does not downgrade when a mirror is behind the current installation', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('unreachable secret detail'))
      .mockResolvedValueOnce(reply(manifest('3.0.0')));
    const result = await findUpdate('3.0.1', { fetch: fetchFn });
    expect(result.updateAvailable).toBe(false);
    expect(result.warnings.join(' ')).toContain('downgrades are disabled');
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('uses only an explicit registry and preserves a registry base path', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(reply(manifest('3.0.1')));
    const result = await findUpdate('3.0.1', {
      fetch: fetchFn,
      registry: 'https://packages.example.org/npm/',
    });
    expect(result.updateAvailable).toBe(false);
    expect(fetchFn).toHaveBeenCalledWith(
      'https://packages.example.org/npm/@eyaeya%2fxgg-cli/latest',
      expect.anything(),
    );
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('reports mirror lag even when the mirror was explicitly selected', async () => {
    const result = await findUpdate('3.0.1', {
      fetch: vi.fn<typeof fetch>().mockResolvedValue(reply(manifest())),
      registry: 'https://registry.npmmirror.com',
    });
    expect(result.fallback).toBe(false);
    expect(result.warnings.join(' ')).toContain('freshness is unverified');
  });

  it('fails rather than reporting up to date when all registries are unavailable', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockRejectedValue(new Error('secret response body'));
    await expect(findUpdate('3.0.1', { fetch: fetchFn })).rejects.toThrow(
      'Unable to check updates',
    );
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('pins an exact release when fetching another install source', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(reply(manifest('3.1.0')));
    await expect(fetchRelease('https://registry.npmmirror.com', '3.0.1', fetchFn)).rejects.toThrow(
      'invalid release metadata',
    );
    expect(fetchFn).toHaveBeenCalledWith(
      'https://registry.npmmirror.com/@eyaeya%2fxgg-cli/3.0.1',
      expect.anything(),
    );
  });

  it.each([
    'http://registry.example.org',
    'https://user:private@registry.example.org',
    'https://registry.example.org?token=private',
    'https://registry.example.org/#private',
    'invalid-private-url',
  ])('rejects unsafe registry configuration before fetching: %s', async (registry) => {
    const fetchFn = vi.fn<typeof fetch>();
    await expect(fetchRelease(registry, 'latest', fetchFn)).rejects.toThrow('HTTPS URL');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('rejects large streamed bodies without needing content-length', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('a'.repeat(1024 * 1024 + 1)));
    await expect(fetchRelease('https://registry.npmjs.org', 'latest', fetchFn)).rejects.toThrow(
      'size limit',
    );
  });

  it('rejects oversized declared metadata before reading it', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response('{}', { headers: { 'content-length': String(2 * 1024 * 1024) } }),
      );
    await expect(fetchRelease('https://registry.npmjs.org', 'latest', fetchFn)).rejects.toThrow(
      'size limit',
    );
  });

  it('bounds a stalled request even if the transport ignores the abort signal', async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    const pending = fetchRelease('https://registry.npmjs.org', 'latest', fetchFn, 25);
    const assertion = expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    expect(fetchFn.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it('does not expose server response bodies or transport exception text', async () => {
    for (const fetchFn of [
      vi.fn<typeof fetch>().mockRejectedValue(new Error('private credential')),
      vi.fn<typeof fetch>().mockResolvedValue(new Response('private credential')),
      vi.fn<typeof fetch>().mockResolvedValue(new Response('private credential', { status: 401 })),
    ]) {
      await expect(
        fetchRelease('https://registry.npmjs.org', 'latest', fetchFn),
      ).rejects.not.toThrow('private credential');
    }
  });

  it('applies the timeout to a stalled response body as well as the headers', async () => {
    vi.useFakeTimers();
    let closeBody = () => {};
    const response = new Response(
      new ReadableStream({
        start(controller) {
          closeBody = () => controller.close();
        },
      }),
    );
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response);
    const pending = fetchRelease('https://registry.npmjs.org', 'latest', fetchFn, 25);
    const assertion = expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    closeBody();
  });

  it('compares numerically and rejects prereleases, leading zeroes and unbounded numbers', () => {
    expect(compareVersions('3.10.0', '3.9.9')).toBe(1);
    expect(compareVersions('3.9.9', '3.10.0')).toBe(-1);
    expect(compareVersions('3.0.1', '3.0.1')).toBe(0);
    for (const version of ['3.01.0', '3.1.0-beta.1', '3.1', '9007199254740992.0.0']) {
      expect(() => compareVersions(version, '3.0.1')).toThrow('stable');
    }
  });
});
