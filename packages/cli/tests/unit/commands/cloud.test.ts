import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  api: {
    listDevices: vi.fn(),
    deviceSpec: vi.fn(),
    getProperty: vi.fn(),
    getProperties: vi.fn(),
    resolveDevice: vi.fn(),
    specByType: vi.fn(),
    setProperty: vi.fn(),
    action: vi.fn(),
    listHomes: vi.fn(),
    listScenes: vi.fn(),
    runScene: vi.fn(),
    listConsumables: vi.fn(),
    statistics: vi.fn(),
    speaker: vi.fn(),
  },
  transport: vi.fn(),
  start: vi.fn(),
  complete: vi.fn(),
  status: vi.fn(),
  logout: vi.fn(),
  snapshot: vi.fn(),
  gatewayLogin: vi.fn(),
}));

vi.mock('../../../src/commands/cloud-login.js', () => ({
  cloudLoginCommand: () => new Command('login'),
  removeCloudLoginQr: vi.fn(),
}));

vi.mock('@eyaeya/xgg-core', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  CloudClient: vi.fn(() => mocks.api),
  createCloudTransport: mocks.transport,
  cloudLoginStart: mocks.start,
  cloudLoginComplete: mocks.complete,
  cloudStatus: mocks.status,
  cloudLogout: mocks.logout,
  writeCloudSnapshot: mocks.snapshot,
  loginGatewayViaCloud: mocks.gatewayLogin,
}));

import { AuthRequiredError, ConfigError, NetworkError } from '@eyaeya/xgg-core';
import { cloudCommand } from '../../../src/commands/cloud.js';
import { errorToExit, formatErrorJson } from '../../../src/errors.js';

describe('cloud CLI', () => {
  let output: string;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('XGG_AGENT_MODE', '');
    vi.stubEnv('XGG_SNAPSHOTS_DIR', '');
    vi.stubEnv('XGG_CLOUD_AUTH_FILE', '');
    vi.stubEnv('XGG_BASE_URL', '');
    output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    mocks.snapshot.mockResolvedValue('/private/cloud/operation.json');
    mocks.api.resolveDevice.mockResolvedValue({ did: 'test-device' });
    mocks.api.getProperties.mockResolvedValue([]);
    mocks.api.specByType.mockResolvedValue({ properties: [], actions: [] });
    mocks.api.getProperty.mockResolvedValue({
      did: 'test-device',
      siid: 2,
      piid: 1,
      code: 0,
      value: false,
      confirmed: true,
    });
    mocks.api.setProperty.mockResolvedValue({ code: 1, confirmed: false, status: 'accepted' });
    mocks.api.action.mockResolvedValue({ code: 0, confirmed: true });
    mocks.api.runScene.mockResolvedValue({ accepted: true });
    mocks.api.speaker.mockResolvedValue({ accepted: true });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  const run = (args: string[]) => cloudCommand().exitOverride().parseAsync(args, { from: 'user' });

  it('lists devices without gateway configuration and inherits auth options', async () => {
    mocks.api.listDevices.mockResolvedValue([{ did: 'test-device', name: 'Test light' }]);
    await run([
      '--auth-file',
      '/private/auth.json',
      '--timeout',
      '9000',
      '--pretty',
      'device',
      'list',
      '--home-id',
      'home-test',
    ]);
    expect(mocks.transport).toHaveBeenCalledWith({
      authFile: '/private/auth.json',
      timeoutMs: 9000,
    });
    expect(mocks.api.listDevices).toHaveBeenCalledWith('home-test');
    expect(JSON.parse(output)).toEqual({
      ok: true,
      devices: [{ did: 'test-device', name: 'Test light' }],
    });
    expect(output).toContain('\n  "ok"');
  });

  it('reports status and clears cloud auth', async () => {
    mocks.status.mockResolvedValue({ authenticated: true });
    await run(['status']);
    expect(JSON.parse(output)).toEqual({ ok: true, authenticated: true });
    output = '';
    await run(['logout']);
    expect(mocks.logout).toHaveBeenCalledTimes(1);
    expect(JSON.parse(output)).toEqual({ ok: true, authenticated: false });
  });

  it('resolves named property reads and rejects ambiguous selectors', async () => {
    await run([
      'device',
      'get',
      '--name',
      'Test light',
      '--home-id',
      'home-test',
      '--property',
      'light.on',
    ]);
    expect(mocks.api.getProperty).toHaveBeenCalledWith(
      { name: 'Test light', homeId: 'home-test' },
      { property: 'light.on' },
      { source: 'auto' },
    );
    await expect(
      run(['device', 'get', '--did', 'test-device', '--name', 'Test light', '--property', 'on']),
    ).rejects.toBeInstanceOf(ConfigError);
    await expect(
      run(['device', 'get', '--did', 'test-device', '--property', 'on', '--siid', '2']),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it('checkpoints the previous property value before sending a write and preserves accepted status', async () => {
    vi.stubEnv('XGG_AGENT_MODE', '1');
    await run([
      'device',
      'set',
      '--did',
      'test-device',
      '--siid',
      '2',
      '--piid',
      '1',
      '--value',
      'true',
      '--snapshots-dir',
      '/private/audit',
    ]);
    expect(mocks.snapshot).toHaveBeenCalledWith({
      operation: 'device.set',
      target: { did: 'test-device' },
      request: { siid: 2, piid: 1, value: true },
      before: {
        did: 'test-device',
        siid: 2,
        piid: 1,
        code: 0,
        value: false,
        confirmed: true,
        sourcePolicy: 'device',
      },
      snapshotsDir: '/private/audit',
    });
    expect(mocks.api.getProperty.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.snapshot.mock.invocationCallOrder[0] ?? 0,
    );
    expect(mocks.snapshot.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.api.setProperty.mock.invocationCallOrder[0] ?? 0,
    );
    expect(mocks.api.setProperty).toHaveBeenCalledWith(
      { did: 'test-device' },
      { siid: 2, piid: 1 },
      true,
    );
    expect(JSON.parse(output).result).toEqual({ code: 1, confirmed: false, status: 'accepted' });
  });

  it.each([
    ['device', 'set', '--did', 'test-device', '--property', 'on', '--value', 'true'],
    ['device', 'action', '--did', 'test-device', '--action', 'toggle'],
    ['scene', 'run', 'scene-test', '--home-id', 'home-test'],
    ['speaker', 'run', '--did', 'test-speaker', '--text', 'test'],
    ['speaker', 'play', '--did', 'test-speaker', '--text', 'test'],
  ])('enforces agent snapshots before any cloud access: %j', async (...args) => {
    vi.stubEnv('XGG_AGENT_MODE', '1');
    await expect(run(args)).rejects.toThrow('requires --snapshots-dir');
    expect(mocks.transport).not.toHaveBeenCalled();
    await expect(
      run([...args, '--snapshots-dir', '/private/audit', '--no-snapshot']),
    ).rejects.toThrow('forbids --no-snapshot');
    expect(mocks.transport).not.toHaveBeenCalled();
  });

  it('does not write when reading or saving the pre-write checkpoint fails', async () => {
    mocks.api.getProperty.mockRejectedValueOnce(new NetworkError('read failed'));
    await expect(
      run(['device', 'set', '--did', 'test-device', '--property', 'on', '--value', 'true']),
    ).rejects.toThrow('read failed');
    expect(mocks.api.getProperty).toHaveBeenCalledTimes(1);
    expect(mocks.api.getProperty).toHaveBeenCalledWith(
      { did: 'test-device' },
      { property: 'on' },
      { source: 'device' },
    );
    expect(mocks.api.setProperty).not.toHaveBeenCalled();
    mocks.snapshot.mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(
      run(['device', 'action', '--did', 'test-device', '--action', 'toggle']),
    ).rejects.toThrow('disk unavailable');
    expect(mocks.api.action).not.toHaveBeenCalled();
  });

  it('does not treat an accepted read as a confirmed pre-write checkpoint', async () => {
    mocks.api.getProperty.mockResolvedValueOnce({ code: 1, confirmed: false, status: 'accepted' });
    await expect(
      run(['device', 'set', '--did', 'test-device', '--property', 'on', '--value', 'true']),
    ).rejects.toThrow('no write was sent');
    expect(mocks.snapshot).not.toHaveBeenCalled();
    expect(mocks.api.setProperty).not.toHaveBeenCalled();
  });

  it('records an explicit unavailable value for a write-only property', async () => {
    mocks.api.getProperty.mockRejectedValueOnce(
      new ConfigError('Property cannot be read', {
        domain: 'cloud',
        reason: 'property-not-readable',
      }),
    );
    await run([
      'device',
      'set',
      '--did',
      'test-device',
      '--property',
      'write-only',
      '--value',
      'true',
    ]);
    expect(mocks.snapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        before: { unavailable: 'property-not-readable' },
      }),
    );
    expect(mocks.api.setProperty).toHaveBeenCalledTimes(1);
  });

  it('passes typed action input and rejects malformed JSON before cloud access', async () => {
    await run([
      'device',
      'action',
      '--did',
      'test-device',
      '--siid',
      '2',
      '--aiid',
      '3',
      '--inputs',
      '[true,20]',
      '--no-snapshot',
    ]);
    expect(mocks.api.action).toHaveBeenCalledWith(
      { did: 'test-device' },
      { siid: 2, aiid: 3, inputs: [true, 20] },
    );
    expect(mocks.snapshot).not.toHaveBeenCalled();
    vi.clearAllMocks();
    await expect(
      run(['device', 'action', '--did', 'test-device', '--action', 'toggle', '--inputs', '{}']),
    ).rejects.toThrow('JSON array');
    await expect(
      run(['device', 'set', '--did', 'test-device', '--property', 'on', '--value', 'not-json']),
    ).rejects.toThrow('valid JSON');
    expect(mocks.transport).not.toHaveBeenCalled();
  });

  it('routes remaining discovery commands and statistics', async () => {
    mocks.api.deviceSpec.mockResolvedValue({ properties: [] });
    mocks.api.listHomes.mockResolvedValue([]);
    mocks.api.listScenes.mockResolvedValue([]);
    mocks.api.listConsumables.mockResolvedValue([]);
    mocks.api.statistics.mockResolvedValue([]);
    await run(['device', 'spec', '--did', 'test-device']);
    await run(['home', 'list']);
    await run(['scene', 'list', '--home-id', 'home-test']);
    await run(['consumable', 'list']);
    await run([
      'statistics',
      '--did',
      'test-device',
      '--key',
      '2.1',
      '--data-type',
      'stat_day_v3',
      '--start',
      '0',
      '--end',
      '3600',
    ]);
    expect(mocks.api.deviceSpec).toHaveBeenCalledWith({ did: 'test-device' });
    expect(mocks.api.listHomes).toHaveBeenCalledTimes(1);
    expect(mocks.api.listScenes).toHaveBeenCalledWith('home-test');
    expect(mocks.api.listConsumables).toHaveBeenCalledWith(undefined);
    expect(mocks.api.statistics).toHaveBeenCalledWith({
      did: 'test-device',
      key: '2.1',
      data_type: 'stat_day_v3',
      limit: 20,
      time_start: 0,
      time_end: 3600,
    });
  });

  it('audits scene and speaker requests without claiming reversible backup', async () => {
    await run(['scene', 'run', 'scene-test', '--home-id', 'home-test']);
    expect(mocks.api.runScene).toHaveBeenCalledWith('scene-test', 'home-test');
    await run(['speaker', 'run', '--name', 'Test speaker', '--text', 'Test instruction']);
    expect(mocks.api.speaker).toHaveBeenCalledWith(
      { name: 'Test speaker' },
      'Test instruction',
      'run',
      true,
    );
    expect(mocks.snapshot).toHaveBeenLastCalledWith({
      operation: 'speaker.run',
      target: { name: 'Test speaker' },
      request: { text: 'Test instruction', quiet: true },
    });
  });

  it('routes bulk and public spec reads without requiring an account operation', async () => {
    await run([
      'device',
      'get',
      '--did',
      'test-device',
      '--properties',
      'light.on,light.brightness',
    ]);
    expect(mocks.api.getProperties).toHaveBeenLastCalledWith(
      { did: 'test-device' },
      [{ property: 'light.on' }, { property: 'light.brightness' }],
      { source: 'auto' },
    );
    expect(JSON.parse(output)).toEqual({ ok: true, sourcePolicy: 'auto', results: [] });
    await run(['device', 'get', '--did', 'test-device']);
    expect(mocks.api.getProperties).toHaveBeenLastCalledWith({ did: 'test-device' }, undefined, {
      source: 'auto',
    });
    await run(['spec', '--type', 'urn:miot-spec-v2:device:light:test']);
    expect(mocks.api.specByType).toHaveBeenCalledWith('urn:miot-spec-v2:device:light:test');
    expect(mocks.status).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it.each([
    ['--properties', 'on,on'],
    ['--properties', 'on,'],
    ['--properties', 'on', '--property', 'on'],
    ['--properties', 'on', '--siid', '2', '--piid', '1'],
  ])('rejects malformed batch selection before network access: %j', async (...args) => {
    await expect(run(['device', 'get', '--did', 'test-device', ...args])).rejects.toBeInstanceOf(
      ConfigError,
    );
    expect(mocks.transport).not.toHaveBeenCalled();
  });

  it.each(['auto', 'device', 'cache'])(
    'forwards an explicit property read source: %s',
    async (source) => {
      await run(['device', 'get', '--did', 'test-device', '--property', 'on', '--source', source]);
      expect(mocks.api.getProperty).toHaveBeenCalledWith(
        { did: 'test-device' },
        { property: 'on' },
        { source },
      );
      expect(JSON.parse(output).sourcePolicy).toBe(source);
    },
  );

  it('rejects unknown read sources before touching the cloud', async () => {
    await expect(
      run(['device', 'get', '--did', 'test-device', '--source', 'invalid']),
    ).rejects.toThrow('--source');
    expect(mocks.transport).not.toHaveBeenCalled();
  });

  it('binds a named write to the resolved DID before reading and checkpointing', async () => {
    await run([
      'device',
      'set',
      '--name',
      'Test light',
      '--home-id',
      'home-test',
      '--property',
      'on',
      '--value',
      'true',
    ]);
    expect(mocks.api.resolveDevice).toHaveBeenCalledWith({
      name: 'Test light',
      homeId: 'home-test',
    });
    expect(mocks.api.getProperty).toHaveBeenCalledWith(
      { did: 'test-device', homeId: 'home-test' },
      { property: 'on' },
      { source: 'device' },
    );
    expect(mocks.api.setProperty).toHaveBeenCalledWith(
      { did: 'test-device', homeId: 'home-test' },
      { property: 'on' },
      true,
    );
    expect(mocks.snapshot).toHaveBeenCalledWith(
      expect.objectContaining({ target: { did: 'test-device', homeId: 'home-test' } }),
    );
  });

  it('requires explicit no-quiet for spoken voice-instruction responses', async () => {
    await run([
      'speaker',
      'run',
      '--did',
      'test-speaker',
      '--text',
      'Test instruction',
      '--no-quiet',
    ]);
    expect(mocks.api.speaker).toHaveBeenCalledWith(
      { did: 'test-speaker' },
      'Test instruction',
      'run',
      false,
    );
    await run(['speaker', 'play', '--did', 'test-speaker', '--text', 'Test speech']);
    expect(mocks.api.speaker).toHaveBeenLastCalledWith(
      { did: 'test-speaker' },
      'Test speech',
      'play',
      false,
    );
  });

  it('does not retry a rejected mutation', async () => {
    mocks.api.action.mockRejectedValueOnce(new NetworkError('timeout', { domain: 'cloud' }));
    await expect(
      run(['device', 'action', '--did', 'test-device', '--action', 'toggle']),
    ).rejects.toThrow('timeout');
    expect(mocks.api.action).toHaveBeenCalledTimes(1);
  });

  it('keeps cloud auth hints separate from gateway login while preserving exit codes', () => {
    const cloudError = new AuthRequiredError('Cloud authorization expired', { domain: 'cloud' });
    expect(errorToExit(cloudError).code).toBe(3);
    expect(formatErrorJson(cloudError).error.hint).toContain('xgg cloud login');
    expect(formatErrorJson(cloudError).error.hint).not.toContain('6-digit');
    const gatewayError = new AuthRequiredError('Gateway authorization expired');
    expect(formatErrorJson(gatewayError).error.hint).toContain('xgg login --code');
  });

  it('bootstraps a gateway with inherited cloud options without a device mutation guard', async () => {
    vi.stubEnv('XGG_AGENT_MODE', '1');
    mocks.gatewayLogin.mockResolvedValue({ ok: true, source: 'cloud', host: 'http://127.0.0.1:0' });
    await run([
      '--auth-file',
      '/private/auth.json',
      '--timeout',
      '7000',
      'gateway',
      'login',
      '--did',
      'test-gateway',
      '--base-url',
      'http://127.0.0.1:0',
    ]);
    expect(mocks.transport).toHaveBeenCalledWith({
      authFile: '/private/auth.json',
      timeoutMs: 7000,
    });
    expect(mocks.gatewayLogin).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        did: 'test-gateway',
        baseUrl: 'http://127.0.0.1:0',
        agentBinary: expect.any(Object),
      }),
    );
    expect(mocks.snapshot).not.toHaveBeenCalled();
    expect(JSON.parse(output)).toEqual({
      ok: true,
      source: 'cloud',
      host: 'http://127.0.0.1:0',
      baseUrl: 'http://127.0.0.1:0',
      nextCommand: { argv: ['xgg', 'status', '--base-url', 'http://127.0.0.1:0'] },
      nextAction: 'xgg status --base-url http://127.0.0.1:0',
    });
    expect(output).not.toContain('passcode');
  });
});
