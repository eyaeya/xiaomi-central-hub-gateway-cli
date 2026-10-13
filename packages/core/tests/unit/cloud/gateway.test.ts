import { describe, expect, it, vi } from 'vitest';
import { loginGatewayViaCloud } from '../../../src/cloud/gateway.js';
import type { CloudTransport } from '../../../src/cloud/transport.js';
import { ConfigError, SchemaError } from '../../../src/transport/errors.js';

const code = '12' + '34' + '56'; // Synthetic secret; never a captured login code.
const base = {
  did: 'router-example',
  agentBinary: { binary: 'node', args: ['cli.js'] },
  isLive: async () => false,
};

describe('cloud gateway bootstrap', () => {
  it('uses the verified RPC shape and passes the code only into login', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ url: 'http://gateway.test:8086' })
      .mockResolvedValueOnce({ passcode: code });
    const login = vi.fn().mockResolvedValue({ ok: true });
    const result = await loginGatewayViaCloud({ request } as unknown as CloudTransport, {
      ...base,
      login,
    });
    expect(request.mock.calls).toEqual([
      ['/home/rpc/router-example', { method: 'miIO.get_autowebconfig_url', params: [] }],
      ['/home/rpc/router-example', { method: 'miIO.get_central_link_passcode', params: [] }],
    ]);
    expect(login).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'http://gateway.test:8086',
        passcode: code,
      }),
    );
    expect(result).toEqual({
      ok: true,
      host: 'http://gateway.test:8086',
      reused: false,
      source: 'mijia-cloud',
    });
    expect(JSON.stringify(result)).not.toContain(code);
  });

  it('reuses a live daemon without requesting or consuming a new code', async () => {
    const request = vi.fn();
    const login = vi.fn();
    const result = await loginGatewayViaCloud({ request } as unknown as CloudTransport, {
      ...base,
      baseUrl: 'http://gateway.test:8086',
      isLive: async () => true,
      login,
    });
    expect(result.reused).toBe(true);
    expect(request).not.toHaveBeenCalled();
    expect(login).not.toHaveBeenCalled();
  });

  it.each([{ token: code }, { passcode: 123 }, { result: { passcode: code } }])(
    'rejects unknown credential shapes without exposing them',
    async (response) => {
      const request = vi.fn().mockResolvedValue(response);
      const login = vi.fn();
      try {
        await loginGatewayViaCloud({ request } as unknown as CloudTransport, {
          ...base,
          baseUrl: 'http://gateway.test:8086',
          login,
        });
        expect.fail('must reject');
      } catch (error) {
        expect(error).toBeInstanceOf(SchemaError);
        expect(JSON.stringify(error)).not.toContain(code);
      }
      expect(login).not.toHaveBeenCalled();
    },
  );

  it.each(['ftp://gateway.test', 'http://user:secret@gateway.test', 'http://gateway.test/?code=x'])(
    'rejects unsafe discovered addresses before fetching a code: %s',
    async (url) => {
      const request = vi.fn().mockResolvedValue({ url });
      await expect(
        loginGatewayViaCloud({ request } as unknown as CloudTransport, base),
      ).rejects.toBeInstanceOf(ConfigError);
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it('does not retry a failed login or accept a DID with path syntax', async () => {
    const request = vi.fn().mockResolvedValue({ passcode: code });
    const login = vi.fn().mockRejectedValue(new Error('handshake failed'));
    await expect(
      loginGatewayViaCloud({ request } as unknown as CloudTransport, {
        ...base,
        baseUrl: 'http://gateway.test:8086',
        login,
      }),
    ).rejects.toThrow('handshake failed');
    expect(login).toHaveBeenCalledTimes(1);
    await expect(
      loginGatewayViaCloud({ request } as unknown as CloudTransport, {
        ...base,
        did: '../other',
      }),
    ).rejects.toBeInstanceOf(ConfigError);
  });
});
