import { describe, expect, it, vi } from 'vitest';
import type { CloudStore } from '../../../src/cloud/auth.js';
import { createCloudTransport } from '../../../src/cloud/transport.js';
import {
  AuthRequiredError,
  GatewayError,
  NetworkError,
  NotConfirmedError,
  SchemaError,
} from '../../../src/transport/errors.js';

const auth = {
  ua: 'test-agent',
  ssecurity: 'AAECAwQFBgcICQoLDA0ODw==',
  cUserId: 'synthetic-user',
  serviceToken: 'test-service-token',
  passToken: 'test-pass-token',
  userId: 'test-user',
};
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function fakeStore(): CloudStore {
  const files = new Map<string, unknown>([['/auth', auth]]);
  return {
    read: async (path) => files.get(path),
    write: async (path, value) => {
      files.set(path, value);
    },
    remove: async (path) => {
      files.delete(path);
    },
  };
}

describe('cloud transport', () => {
  it('sends encrypted parameters and returns only the parsed result', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(reply({ code: 0, result: [{ value: true }] }));
    const result = await createCloudTransport({
      authFile: '/auth',
      store: fakeStore(),
      fetch: fetcher,
    }).request('/miotspec/prop/get', { params: [] });
    expect(result).toEqual([{ value: true }]);
    const call = fetcher.mock.calls[0];
    if (!call) throw new Error('Expected one request');
    const [url, init] = call;
    expect(url).toBe('https://api.mijia.tech/app/miotspec/prop/get');
    expect(init?.redirect).toBe('manual');
    const body = new URLSearchParams(init?.body as string);
    expect(body.get('data')).not.toContain('params');
    expect(body.get('signature')).toBeTruthy();
  });

  it('refreshes a rejected read once before retrying with the new cookie', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(reply({ code: 401 }))
      .mockResolvedValueOnce(
        reply({ code: 0, location: 'https://sts.api.io.mi.com/sts', ssecurity: auth.ssecurity }),
      )
      .mockResolvedValueOnce(
        new Response('ok', {
          headers: { 'set-cookie': 'serviceToken=refreshed-token; Path=/; Secure' },
        }),
      )
      .mockResolvedValueOnce(reply({ code: 0, result: true }));
    await expect(
      createCloudTransport({ authFile: '/auth', store: fakeStore(), fetch: fetcher }).request(
        '/home/test',
        {},
      ),
    ).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(4);
    const headers = new Headers(fetcher.mock.calls[3]?.[1]?.headers);
    expect(headers.get('Cookie')).toContain('serviceToken=refreshed-token');
  });

  it('recognizes an HTTP-200 Unauthorized envelope from Xiaomi cloud', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(reply({ code: 3, message: 'Unauthorized' }))
      .mockResolvedValueOnce(reply({ code: 70016 }));
    await expect(
      createCloudTransport({ authFile: '/auth', store: fakeStore(), fetch: fetcher }).request(
        '/home/test',
        {},
      ),
    ).rejects.toBeInstanceOf(AuthRequiredError);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not replay a physical write after timeout', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(reply({ code: 0, result: {} }))
      .mockRejectedValueOnce(new Error('sensitive serviceToken=do-not-show'));
    const transport = createCloudTransport({
      authFile: '/auth',
      store: fakeStore(),
      fetch: fetcher,
    });
    await expect(
      transport.request('/miotspec/action', { params: {} }, { mutation: true }),
    ).rejects.toBeInstanceOf(NotConfirmedError);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(
      fetcher.mock.calls.filter(([url]) => String(url).endsWith('/miotspec/action')),
    ).toHaveLength(1);
  });

  it('does not retry a write rejected by authorization after successful preflight', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(reply({ code: 0, result: {} }))
      .mockResolvedValueOnce(reply({ code: 401 }));
    const transport = createCloudTransport({
      authFile: '/auth',
      store: fakeStore(),
      fetch: fetcher,
    });
    await expect(
      transport.request('/miotspec/prop/set', {}, { mutation: true }),
    ).rejects.toBeInstanceOf(AuthRequiredError);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(['invalid ciphertext', '[null]', '{"code":0}', '{"code":"invalid","result":true}'])(
    'marks an unreadable write reply as unconfirmed (%s)',
    async (raw) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(reply({ code: 0, result: {} }))
        .mockResolvedValueOnce(new Response(raw));
      await expect(
        createCloudTransport({ authFile: '/auth', store: fakeStore(), fetch: fetcher }).request(
          '/miotspec/action',
          {},
          { mutation: true },
        ),
      ).rejects.toBeInstanceOf(NotConfirmedError);
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );

  it('stops before writes when preflight network fails', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('secret network URL'));
    await expect(
      createCloudTransport({ authFile: '/auth', store: fakeStore(), fetch: fetcher }).request(
        '/miotspec/action',
        {},
        { mutation: true },
      ),
    ).rejects.toBeInstanceOf(NetworkError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed envelopes without leaking remote content', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply({ secret: 'do-not-show' }));
    const transport = createCloudTransport({
      authFile: '/auth',
      store: fakeStore(),
      fetch: fetcher,
    });
    try {
      await transport.request('/home/test', {});
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaError);
      expect(JSON.stringify(error)).not.toContain('do-not-show');
    }
  });

  it('gets public specs without cloud credentials', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply({ services: [] }));
    const store = fakeStore();
    await store.remove('/auth');
    await expect(
      createCloudTransport({ authFile: '/auth', store, fetch: fetcher }).getSpec(
        'urn:miot-spec-v2:device:light:0000A001:synthetic:1',
      ),
    ).resolves.toEqual({ services: [] });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).has('Cookie')).toBe(false);
  });

  it.each([-10001, -10003])(
    'does not reinterpret MIoT service error %s as account expiry',
    async (code) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(reply({ code, message: 'private upstream text' }));
      await expect(
        createCloudTransport({ authFile: '/auth', store: fakeStore(), fetch: fetcher }).request(
          '/home/test',
          {},
        ),
      ).rejects.toBeInstanceOf(GatewayError);
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
});
