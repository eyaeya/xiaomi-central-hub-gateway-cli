import { describe, expect, it, vi } from 'vitest';
import {
  type CloudStore,
  cloudLoginComplete,
  cloudLoginStart,
  cloudLogout,
  cloudStatus,
} from '../../../src/cloud/auth.js';
import { AuthRequiredError, NetworkError, SchemaError } from '../../../src/transport/errors.js';

function memoryStore() {
  const files = new Map<string, unknown>();
  const store: CloudStore = {
    read: async (path) => files.get(path),
    write: async (path, value) => {
      files.set(path, value);
    },
    remove: async (path) => {
      files.delete(path);
    },
  };
  return { files, store };
}
const reply = (value: unknown) => new Response(`&&&START&&&${JSON.stringify(value)}`);
const qr = {
  code: 0,
  lp: 'https://c3.lp.account.xiaomi.com/lp/s',
  qr: 'https://account.xiaomi.com/qr/test',
  loginUrl: 'https://c3.account.xiaomi.com/longPolling/login',
};

describe('cloud account auth', () => {
  it('starts and completes QR authorization without returning credentials', async () => {
    const { files, store } = memoryStore();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        reply({ code: 70016, location: 'https://account.xiaomi.com/pass/login?_sign=synthetic' }),
      )
      .mockResolvedValueOnce(reply(qr))
      .mockResolvedValueOnce(
        reply({
          code: 0,
          ssecurity: 'AAECAwQFBgcICQoLDA0ODw==',
          cUserId: 'synthetic-user',
          userId: 'synthetic-user-id',
          passToken: 'synthetic-pass-token',
          location: 'https://sts.api.io.mi.com/sts',
        }),
      )
      .mockResolvedValueOnce(
        new Response('ok', {
          headers: { 'set-cookie': 'serviceToken=synthetic-service-token; Path=/; Secure' },
        }),
      );
    const options = { authFile: '/auth', fetch: fetcher, store, now: () => 1000 };
    await expect(cloudLoginStart(options)).resolves.toEqual({
      authenticated: false,
      status: 'pending',
      qrUrl: qr.qr,
      loginUrl: qr.loginUrl,
      expiresAt: new Date(121_000).toISOString(),
      nextAction: 'xgg cloud login --complete',
      reused: false,
    });
    expect(files.has('/auth.pending')).toBe(true);
    await expect(cloudLoginComplete(options)).resolves.toEqual({ authenticated: true });
    expect(files.has('/auth.pending')).toBe(false);
    expect(files.get('/auth')).toMatchObject({
      serviceToken: 'synthetic-service-token',
      passToken: 'synthetic-pass-token',
    });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('never sends account credentials to an external callback URL', async () => {
    const { files, store } = memoryStore();
    files.set('/auth.pending', {
      version: 1,
      expiresAt: 5000,
      credentials: { ua: 'test' },
      login: qr,
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      reply({
        code: 0,
        location: 'https://attacker.invalid/callback',
        ssecurity: 'AAECAwQFBgcICQoLDA0ODw==',
        cUserId: 'synthetic-user',
        passToken: 'synthetic-pass-token',
      }),
    );
    await expect(
      cloudLoginComplete({ authFile: '/auth', store, fetch: fetcher, now: () => 1000 }),
    ).rejects.toBeInstanceOf(SchemaError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects and removes expired pending login before making any request', async () => {
    const { files, store } = memoryStore();
    files.set('/auth.pending', {
      version: 1,
      expiresAt: 1000,
      credentials: { ua: 'test' },
      login: qr,
    });
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      cloudLoginComplete({ authFile: '/auth', store, fetch: fetcher, now: () => 5000 }),
    ).rejects.toBeInstanceOf(AuthRequiredError);
    expect(files.has('/auth.pending')).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reports absent authorization without a network call', async () => {
    const { store } = memoryStore();
    const fetcher = vi.fn<typeof fetch>();
    await expect(cloudStatus({ authFile: '/auth', store, fetch: fetcher })).resolves.toEqual({
      authenticated: false,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('removes both local credential and pending files on logout', async () => {
    const { files, store } = memoryStore();
    files.set('/auth', { serviceToken: 'synthetic' });
    files.set('/auth.pending', {});
    await cloudLogout({ authFile: '/auth', store });
    expect(files.size).toBe(0);
  });

  it('reuses an unexpired QR attempt instead of replacing the code shown to the user', async () => {
    const { files, store } = memoryStore();
    files.set('/auth.pending', {
      version: 1,
      expiresAt: 9000,
      credentials: { ua: 'test' },
      login: qr,
    });
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      cloudLoginStart({ authFile: '/auth', store, fetch: fetcher, now: () => 1000 }),
    ).resolves.toMatchObject({
      authenticated: false,
      status: 'pending',
      reused: true,
      qrUrl: qr.qr,
      expiresAt: new Date(9000).toISOString(),
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('only explicit restart recovers a corrupt credential file and replaces pending QR data', async () => {
    const { files, store } = memoryStore();
    files.set('/auth', { serviceToken: 42 });
    files.set('/auth.pending', { private: 'stale-pending' });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        reply({ code: 70016, location: 'https://account.xiaomi.com/pass/login?_sign=synthetic' }),
      )
      .mockResolvedValueOnce(reply(qr));
    const options = { authFile: '/auth', store, fetch: fetcher, now: () => 1000 };
    await expect(cloudLoginStart(options)).rejects.toBeInstanceOf(SchemaError);
    expect(files.get('/auth')).toEqual({ serviceToken: 42 });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(cloudLoginStart({ ...options, restart: true })).resolves.toMatchObject({
      authenticated: false,
      reused: false,
      qrUrl: qr.qr,
    });
    expect(files.has('/auth')).toBe(false);
    expect(files.get('/auth.pending')).toMatchObject({ login: { lp: qr.lp, qr: qr.qr } });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps the same QR and returns pending when a bounded scan wait elapses', async () => {
    const { files, store } = memoryStore();
    files.set('/auth.pending', {
      version: 1,
      expiresAt: 90000,
      credentials: { ua: 'test' },
      login: qr,
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new DOMException('wait', 'TimeoutError'));
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      await expect(
        cloudLoginComplete({
          authFile: '/auth',
          store,
          fetch: fetcher,
          now: () => 1000,
          timeoutMs: 5000,
        }),
      ).resolves.toMatchObject({ authenticated: false, status: 'pending', qrUrl: qr.qr });
      expect(timeout).toHaveBeenCalledWith(20_000);
      expect(files.has('/auth.pending')).toBe(true);
      expect(files.has('/auth')).toBe(false);
    } finally {
      timeout.mockRestore();
    }
  });

  it('does not mistake a genuine network failure or external cancellation for waiting', async () => {
    const { files, store } = memoryStore();
    files.set('/auth.pending', {
      version: 1,
      expiresAt: 90000,
      credentials: { ua: 'test' },
      login: qr,
    });
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('private failure URL'));
    await expect(
      cloudLoginComplete({ authFile: '/auth', store, fetch: fetcher, now: () => 1000 }),
    ).rejects.toBeInstanceOf(NetworkError);
    await expect(
      cloudLoginComplete({
        authFile: '/auth',
        store,
        fetch: fetcher,
        now: () => 1000,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ details: { domain: 'cloud', reason: 'cancelled' } });
    expect(files.has('/auth.pending')).toBe(true);
  });

  it('returns pending when the server sends headers before the bounded wait aborts its body', async () => {
    const { files, store } = memoryStore();
    files.set('/auth.pending', {
      version: 1,
      expiresAt: 90000,
      credentials: { ua: 'test' },
      login: qr,
    });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      async (_url, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason));
            },
          }),
        ),
    );
    await expect(
      cloudLoginComplete({ authFile: '/auth', store, fetch: fetcher, now: () => 1000, waitMs: 10 }),
    ).resolves.toMatchObject({ authenticated: false, status: 'pending', qrUrl: qr.qr });
    expect(files.has('/auth.pending')).toBe(true);
  });

  it('expires and clears an authorization that reaches its deadline while waiting', async () => {
    const { files, store } = memoryStore();
    files.set('/auth.pending', {
      version: 1,
      expiresAt: 5000,
      credentials: { ua: 'test' },
      login: qr,
    });
    let now = 1000;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      now = 5000;
      throw new DOMException('wait', 'TimeoutError');
    });
    await expect(
      cloudLoginComplete({ authFile: '/auth', store, fetch: fetcher, now: () => now }),
    ).rejects.toMatchObject({ details: { reason: 'qr-expired' } });
    expect(files.has('/auth.pending')).toBe(false);
  });

  it.each([0, -1, 1.5, 60001])(
    'rejects invalid bounded wait %s before network access',
    async (waitMs) => {
      const { store } = memoryStore();
      const fetcher = vi.fn<typeof fetch>();
      await expect(cloudLoginComplete({ store, fetch: fetcher, waitMs })).rejects.toThrow(
        'between 1 and 60000',
      );
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
});
