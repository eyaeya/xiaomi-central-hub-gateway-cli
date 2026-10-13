import { chmod, mkdir, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { Command } from 'commander';
import QRCode from 'qrcode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ start: vi.fn(), complete: vi.fn() }));
vi.mock('@eyaeya/xgg-core', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  cloudLoginStart: mocks.start,
  cloudLoginComplete: mocks.complete,
}));
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  mkdir: vi.fn(),
  chmod: vi.fn(),
  readdir: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
  unlink: vi.fn(),
  rmdir: vi.fn(),
}));

import { AuthRequiredError } from '@eyaeya/xgg-core';
import { cloudLoginCommand, removeCloudLoginQr } from '../../../src/commands/cloud-login.js';

const pending = {
  authenticated: false,
  status: 'pending',
  qrUrl: 'https://account.xiaomi.com/qr/synthetic',
  loginUrl: 'https://account.xiaomi.com/login/synthetic',
  expiresAt: '2030-01-01T00:02:00.000Z',
  nextAction: 'xgg cloud login --complete',
  reused: false,
};

describe('Agent cloud QR login', () => {
  let stdout: string;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('XGG_CLOUD_AUTH_FILE', '');
    stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdout += String(data);
      return true;
    });
    mocks.start.mockResolvedValue(pending);
    mocks.complete.mockResolvedValue({ authenticated: true });
    vi.mocked(readdir).mockResolvedValue(['login.png'] as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  const run = (args: string[]) =>
    new Command('cloud')
      .option('--auth-file <path>')
      .option('--timeout <ms>', 'HTTP timeout', '15000')
      .option('--pretty')
      .addCommand(cloudLoginCommand())
      .exitOverride()
      .parseAsync(args, { from: 'user' });

  it('locally renders a real PNG with private permissions and JSON-only Agent instructions', async () => {
    const encode = vi.spyOn(QRCode, 'toBuffer');
    await run(['--auth-file', '/virtual/account A/auth.json', 'login']);
    const output = JSON.parse(stdout);
    expect(output).toMatchObject({
      ...pending,
      nextAction: "xgg cloud --auth-file '/virtual/account A/auth.json' login --complete",
      nextCommand: {
        argv: [
          'xgg',
          'cloud',
          '--auth-file',
          '/virtual/account A/auth.json',
          'login',
          '--complete',
        ],
      },
      ok: true,
    });
    expect(output.qrImagePath).toMatch(
      /^\/virtual\/account A\/auth\.json\.qr\/login-[a-f0-9]{24}\.png$/,
    );
    expect(output.qrMarkdown).toBe(`![米家扫码登录](<${output.qrImagePath}>)`);
    expect(output.instructions).toContain('米家 App');
    expect(encode).toHaveBeenCalledWith(pending.loginUrl, expect.objectContaining({ type: 'png' }));
    expect(mkdir).toHaveBeenCalledWith('/virtual/account A/auth.json.qr', {
      recursive: true,
      mode: 0o700,
    });
    expect(chmod).toHaveBeenCalledWith('/virtual/account A/auth.json.qr', 0o700);
    expect(writeFile).toHaveBeenCalledWith(expect.any(String), expect.any(Buffer), {
      mode: 0o600,
      flag: 'wx',
    });
    const png = vi.mocked(writeFile).mock.calls[0]?.[1] as Buffer;
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(rename).toHaveBeenCalledWith(expect.any(String), output.qrImagePath);
    expect(stdout.trim().split('\n')).toHaveLength(1);
  });

  it('bounds completion independently of HTTP timeout and preserves waiting QR output', async () => {
    mocks.complete.mockResolvedValue({ ...pending, reused: true });
    await run(['--auth-file', '/virtual/auth', '--timeout', '7000', 'login', '--complete']);
    expect(mocks.complete).toHaveBeenCalledWith({
      authFile: '/virtual/auth',
      timeoutMs: 7000,
      waitMs: 20000,
    });
    expect(JSON.parse(stdout)).toMatchObject({ status: 'pending', reused: true });
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('removes the QR after authorization succeeds without displaying a stale image', async () => {
    await run(['--auth-file', '/virtual/auth', 'login', '--complete', '--wait-ms', '5000']);
    expect(mocks.complete).toHaveBeenCalledWith({
      authFile: '/virtual/auth',
      timeoutMs: 15000,
      waitMs: 5000,
    });
    expect(JSON.parse(stdout)).toEqual({ ok: true, authenticated: true });
    expect(unlink).toHaveBeenCalledWith('/virtual/auth.qr/login.png');
    expect(rmdir).toHaveBeenCalledWith('/virtual/auth.qr');
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('restarts explicitly and uses the same env-selected auth location', async () => {
    vi.stubEnv('XGG_CLOUD_AUTH_FILE', '/virtual/another-auth');
    await run(['login', '--restart']);
    expect(mocks.start).toHaveBeenCalledWith({
      authFile: '/virtual/another-auth',
      timeoutMs: 15000,
      restart: true,
    });
    expect(unlink).toHaveBeenCalledWith('/virtual/another-auth.qr/login.png');
    expect(JSON.parse(stdout).qrImagePath).toMatch(
      /^\/virtual\/another-auth\.qr\/login-[a-f0-9]{24}\.png$/,
    );
    expect(JSON.parse(stdout).nextCommand.argv).toEqual([
      'xgg',
      'cloud',
      '--auth-file',
      '/virtual/another-auth',
      'login',
      '--complete',
    ]);
  });

  it('keeps the default completion command simple', async () => {
    await run(['login']);
    expect(JSON.parse(stdout)).toMatchObject({
      nextAction: 'xgg cloud login --complete',
      nextCommand: { argv: ['xgg', 'cloud', 'login', '--complete'] },
    });
  });

  it('changes the image path for a new pending attempt and reuses it while waiting', async () => {
    await run(['--auth-file', '/virtual/auth', 'login']);
    const first = JSON.parse(stdout).qrImagePath;
    stdout = '';
    mocks.complete.mockResolvedValue({ ...pending, reused: true });
    await run(['--auth-file', '/virtual/auth', 'login', '--complete']);
    expect(JSON.parse(stdout).qrImagePath).toBe(first);
    stdout = '';
    mocks.start.mockResolvedValue({
      ...pending,
      expiresAt: '2030-01-01T00:03:00.000Z',
    });
    await run(['--auth-file', '/virtual/auth', 'login', '--restart']);
    expect(JSON.parse(stdout).qrImagePath).not.toBe(first);
    expect(JSON.parse(stdout).qrMarkdown).not.toContain(first);
  });

  it('cleans legacy and hashed QR images but preserves unrelated files and the current pending image', async () => {
    await run(['--auth-file', '/virtual/auth', 'login']);
    const currentImage = JSON.parse(stdout).qrImagePath as string;
    const currentName = currentImage.slice(currentImage.lastIndexOf('/') + 1);
    vi.mocked(unlink).mockClear();
    vi.mocked(readdir).mockResolvedValue([
      currentName,
      'login.png',
      'login-aaaaaaaaaaaaaaaaaaaaaaaa.png',
      'notes.txt',
      'login-user-picture.png',
      'nested',
    ] as never);
    await removeCloudLoginQr('/virtual/auth', currentImage);
    expect(vi.mocked(unlink).mock.calls.map(([path]) => path)).toEqual([
      '/virtual/auth.qr/login.png',
      '/virtual/auth.qr/login-aaaaaaaaaaaaaaaaaaaaaaaa.png',
    ]);
    expect(rmdir).not.toHaveBeenCalled();
    vi.mocked(unlink).mockClear();
    await removeCloudLoginQr('/virtual/auth');
    expect(unlink).toHaveBeenCalledWith(currentImage);
    expect(unlink).not.toHaveBeenCalledWith('/virtual/auth.qr/notes.txt');
    expect(unlink).not.toHaveBeenCalledWith('/virtual/auth.qr/login-user-picture.png');
  });

  it('preserves account and wait options as argv and safely quotes shell metacharacters', async () => {
    const authFile = "/virtual/account A/it's $(not-a-command);`also-not-a-command`.json";
    await run([
      '--auth-file',
      authFile,
      '--timeout',
      '7000',
      '--pretty',
      'login',
      '--wait-ms',
      '5000',
    ]);
    const output = JSON.parse(stdout);
    expect(output.nextCommand.argv).toEqual([
      'xgg',
      'cloud',
      '--auth-file',
      authFile,
      '--timeout',
      '7000',
      '--pretty',
      'login',
      '--complete',
      '--wait-ms',
      '5000',
    ]);
    // Metacharacters remain inside POSIX single quotes; the embedded apostrophe
    // is represented by closing the quote, escaping the apostrophe, and reopening.
    expect(output.nextAction).toBe(
      "xgg cloud --auth-file '/virtual/account A/it'\\''s $(not-a-command);`also-not-a-command`.json' --timeout 7000 --pretty login --complete --wait-ms 5000",
    );
    expect(output.nextCommand.argv).not.toContain('--restart');
  });

  it('quotes a trailing newline in an auth path instead of terminating the shell command', async () => {
    const authFile = '/virtual/auth\n';
    await run(['--auth-file', authFile, 'login']);
    const output = JSON.parse(stdout);
    expect(output.nextAction).toBe("xgg cloud --auth-file '/virtual/auth\n' login --complete");
    expect(output.nextCommand.argv[3]).toBe(authFile);
  });

  it('cleans expired QR but keeps pending artifacts on network failure', async () => {
    mocks.complete.mockRejectedValue(
      new AuthRequiredError('expired', { domain: 'cloud', reason: 'qr-expired' }),
    );
    await expect(run(['--auth-file', '/virtual/auth', 'login', '--complete'])).rejects.toThrow(
      'expired',
    );
    expect(unlink).toHaveBeenCalledWith('/virtual/auth.qr/login.png');
    vi.mocked(unlink).mockClear();
    mocks.complete.mockRejectedValue(new Error('network unavailable'));
    await expect(run(['--auth-file', '/virtual/auth', 'login', '--complete'])).rejects.toThrow(
      'network unavailable',
    );
    expect(unlink).not.toHaveBeenCalled();
  });

  it('cleans only known files and allows absent or nonempty artifact directories', async () => {
    vi.mocked(unlink).mockRejectedValueOnce(
      Object.assign(new Error('missing'), { code: 'ENOENT' }),
    );
    vi.mocked(rmdir).mockRejectedValueOnce(
      Object.assign(new Error('not empty'), { code: 'ENOTEMPTY' }),
    );
    await expect(removeCloudLoginQr('/virtual/auth')).resolves.toBeUndefined();
  });

  it.each([
    ['login', '--complete', '--restart'],
    ['login', '--complete', '--wait-ms', '0'],
    ['login', '--complete', '--wait-ms', '60001'],
  ])('rejects conflicting flags or invalid waits before authentication: %j', async (...args) => {
    await expect(run(args)).rejects.toThrow();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });
});
