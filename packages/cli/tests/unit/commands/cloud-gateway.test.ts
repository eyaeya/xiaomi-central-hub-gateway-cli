import { resolve } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ transport: vi.fn(), gateway: vi.fn() }));
vi.mock('@eyaeya/xgg-core', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  createCloudTransport: mocks.transport,
  loginGatewayViaCloud: mocks.gateway,
}));

import { cloudGatewayCommand } from '../../../src/commands/cloud-gateway.js';

const host = 'http://gateway.example:8086';
const result = { ok: true, host, reused: false, source: 'mijia-cloud' };

describe('cloud gateway login continuation', () => {
  let stdout: string;
  beforeEach(() => {
    vi.clearAllMocks();
    for (const name of ['XGG_CLOUD_AUTH_FILE', 'XGG_BASE_URL', 'XGG_SESSION_FILE'])
      vi.stubEnv(name, '');
    stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      stdout += String(data);
      return true;
    });
    mocks.gateway.mockResolvedValue(result);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  const run = (args: string[]) =>
    new Command('cloud')
      .addCommand(cloudGatewayCommand())
      .exitOverride()
      .parseAsync(args, { from: 'user' });

  it('returns the resolved base URL and an explicit status command after cloud discovery', async () => {
    await run(['gateway', 'login', '--did', 'test-router']);
    expect(JSON.parse(stdout)).toEqual({
      ...result,
      baseUrl: host,
      nextCommand: { argv: ['xgg', 'status', '--base-url', host] },
      nextAction: `xgg status --base-url ${host}`,
    });
    expect(mocks.gateway).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ did: 'test-router' }),
    );
    expect(mocks.gateway.mock.calls[0]?.[1]).not.toHaveProperty('baseUrl');
  });

  it('preserves explicit custom session files and safely quotes special characters', async () => {
    const sessionFile = "/virtual/session A/it's $(not-a-command);`also-not-a-command`.json";
    await run([
      'gateway',
      'login',
      '--did',
      'test-router',
      '--base-url',
      host,
      '--session-file',
      sessionFile,
    ]);
    expect(mocks.gateway).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ baseUrl: host, sessionFile }),
    );
    expect(JSON.parse(stdout)).toMatchObject({
      baseUrl: host,
      nextCommand: { argv: ['xgg', 'status', '--base-url', host, '--session-file', sessionFile] },
      nextAction:
        "xgg status --base-url http://gateway.example:8086 --session-file '/virtual/session A/it'\\''s $(not-a-command);`also-not-a-command`.json'",
    });
    expect(stdout).not.toContain('passcode');
  });

  it('captures environment-selected base URL and resolves relative session files for the next command', async () => {
    vi.stubEnv('XGG_BASE_URL', host);
    vi.stubEnv('XGG_SESSION_FILE', 'sessions/custom session.json');
    await run(['gateway', 'login', '--did', 'test-router']);
    expect(mocks.gateway).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ baseUrl: host, sessionFile: 'sessions/custom session.json' }),
    );
    expect(JSON.parse(stdout).nextCommand.argv).toEqual([
      'xgg',
      'status',
      '--base-url',
      host,
      '--session-file',
      resolve('sessions/custom session.json'),
    ]);
  });

  it('prefers explicit session selection over the environment without persisting a default gateway', async () => {
    vi.stubEnv('XGG_BASE_URL', 'http://other-gateway.example:8086');
    vi.stubEnv('XGG_SESSION_FILE', 'sessions/environment.json');
    await run([
      'gateway',
      'login',
      '--did',
      'test-router',
      '--base-url',
      host,
      '--session-file',
      '/virtual/explicit.json',
    ]);
    expect(mocks.gateway).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ baseUrl: host, sessionFile: '/virtual/explicit.json' }),
    );
    expect(JSON.parse(stdout).nextCommand.argv).toEqual([
      'xgg',
      'status',
      '--base-url',
      host,
      '--session-file',
      '/virtual/explicit.json',
    ]);
    expect(process.env.XGG_BASE_URL).toBe('http://other-gateway.example:8086');
    expect(process.env.XGG_SESSION_FILE).toBe('sessions/environment.json');
  });
});
