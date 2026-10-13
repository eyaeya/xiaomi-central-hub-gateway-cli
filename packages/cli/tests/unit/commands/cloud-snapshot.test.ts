import { mkdir, writeFile } from 'node:fs/promises';
import { writeCloudSnapshot } from '@eyaeya/xgg-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
}));

describe('private cloud mutation snapshots', () => {
  afterEach(() => vi.clearAllMocks());

  it('writes an exclusive private audit record without auth fields', async () => {
    const path = await writeCloudSnapshot({
      operation: 'device.set',
      target: { did: 'test-device' },
      request: { siid: 2, piid: 1, value: true },
      before: { value: false },
      snapshotsDir: '/private/audit',
    });
    expect(path).toMatch(/^\/private\/audit\/cloud-.+\/operation\.json$/);
    expect(mkdir).toHaveBeenCalledWith(expect.any(String), { recursive: true, mode: 0o700 });
    expect(writeFile).toHaveBeenCalledWith(path, expect.any(String), { mode: 0o600, flag: 'wx' });
    const raw = vi.mocked(writeFile).mock.calls[0]?.[1];
    const data = JSON.parse(String(raw));
    expect(data).toMatchObject({
      domain: 'cloud',
      rollbackAvailable: false,
      before: { value: false },
    });
    expect(Object.keys(data).sort()).toEqual([
      'before',
      'domain',
      'operation',
      'request',
      'rollbackAvailable',
      'target',
      'timestamp',
      'version',
    ]);
  });

  it('propagates disk failure so the caller can stop before writing the device', async () => {
    vi.mocked(writeFile).mockRejectedValueOnce(new Error('read-only filesystem'));
    await expect(
      writeCloudSnapshot({
        operation: 'scene.run',
        target: { sceneId: 'test-scene' },
        request: {},
      }),
    ).rejects.toThrow('read-only filesystem');
  });
});
