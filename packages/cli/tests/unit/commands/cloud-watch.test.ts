import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  api: { resolveDevice: vi.fn(), getProperties: vi.fn() },
  transport: vi.fn(),
}));
vi.mock('@eyaeya/xgg-core', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  CloudClient: vi.fn(() => mocks.api),
  createCloudTransport: mocks.transport,
}));

import {
  AuthRequiredError,
  ConfigError,
  GatewayError,
  NetworkError,
  SchemaError,
} from '@eyaeya/xgg-core';
import { cloudWatchCommand } from '../../../src/commands/cloud-watch.js';

function sample(value = false, updateTime = 1) {
  return [
    {
      did: 'test-light',
      siid: 2,
      piid: 1,
      value,
      code: 0,
      confirmed: true,
      status: 'ok',
      updateTime,
    },
  ];
}

describe('cloud device watch', () => {
  let output: string;
  let warning: string;
  let interrupts: number;
  let terminates: number;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    vi.clearAllMocks();
    mocks.api.resolveDevice.mockReset();
    mocks.api.getProperties.mockReset();
    vi.stubEnv('XGG_CLOUD_AUTH_FILE', '');
    output = '';
    warning = '';
    interrupts = process.listenerCount('SIGINT');
    terminates = process.listenerCount('SIGTERM');
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      warning += String(chunk);
      return true;
    });
    mocks.api.resolveDevice.mockResolvedValue({ did: 'test-light' });
    mocks.api.getProperties.mockResolvedValue(sample());
  });
  afterEach(() => {
    expect(process.listenerCount('SIGINT')).toBe(interrupts);
    expect(process.listenerCount('SIGTERM')).toBe(terminates);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  const run = (args: string[]) =>
    cloudWatchCommand().exitOverride().parseAsync(args, { from: 'user' });
  const events = () =>
    output
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));

  it('emits one initial snapshot then only reported value changes, ignoring updateTime changes', async () => {
    mocks.api.getProperties
      .mockResolvedValueOnce(sample(false, 1))
      .mockResolvedValueOnce(sample(false, 2))
      .mockResolvedValueOnce(sample(true, 3));
    const running = run([
      '--name',
      'Test light',
      '--home-id',
      'home-test',
      '--property',
      'light.on',
      '--max-events',
      '2',
    ]);
    await vi.advanceTimersByTimeAsync(6000);
    await running;
    expect(mocks.api.resolveDevice).toHaveBeenCalledTimes(1);
    expect(mocks.api.getProperties).toHaveBeenCalledTimes(3);
    expect(mocks.api.getProperties).toHaveBeenCalledWith(
      { did: 'test-light', homeId: 'home-test' },
      [{ property: 'light.on' }],
      { source: 'device' },
    );
    expect(events()).toEqual([
      {
        ok: true,
        event: 'snapshot',
        source: 'cloud',
        sourcePolicy: 'device',
        mode: 'polling',
        evidence: 'reported',
        observedAt: '2026-01-01T00:00:00.000Z',
        intervalMs: 3000,
        results: sample(false, 1),
      },
      {
        ok: true,
        event: 'change',
        source: 'cloud',
        sourcePolicy: 'device',
        mode: 'polling',
        evidence: 'reported',
        observedAt: '2026-01-01T00:00:06.000Z',
        intervalMs: 3000,
        results: sample(true, 3),
      },
    ]);
  });

  it('counts the initial snapshot toward max-events and forwards batch selection', async () => {
    await run([
      '--did',
      'test-light',
      '--properties',
      'light.on,light.brightness',
      '--max-events',
      '1',
    ]);
    expect(mocks.api.getProperties).toHaveBeenCalledWith(
      { did: 'test-light' },
      [{ property: 'light.on' }, { property: 'light.brightness' }],
      { source: 'device' },
    );
    expect(events()).toHaveLength(1);
    expect(mocks.api.getProperties).toHaveBeenCalledTimes(1);
  });

  it.each(['auto', 'cache'])(
    'marks explicit %s reads so cached evidence is not disguised as direct RPC',
    async (source) => {
      await run(['--did', 'test-light', '--source', source, '--max-events', '1']);
      expect(mocks.api.getProperties).toHaveBeenCalledWith({ did: 'test-light' }, undefined, {
        source,
      });
      expect(events()[0].sourcePolicy).toBe(source);
    },
  );

  it('defaults to a 60-second bound even when no values change', async () => {
    const running = run(['--did', 'test-light']);
    await vi.advanceTimersByTimeAsync(60_000);
    await running;
    expect(events()).toHaveLength(1);
    expect(mocks.api.getProperties).toHaveBeenCalledTimes(20);
    expect(mocks.api.getProperties).toHaveBeenCalledWith({ did: 'test-light' }, undefined, {
      source: 'device',
    });
  });

  it('honors the first of duration and max-events and permits explicit follow', async () => {
    const running = run([
      '--did',
      'test-light',
      '--duration-ms',
      '2500',
      '--max-events',
      '3',
      '--follow',
    ]);
    await vi.advanceTimersByTimeAsync(2500);
    await running;
    expect(events()).toHaveLength(1);
  });

  it('cleans up timer and signal handlers after SIGINT during polling sleep', async () => {
    const running = run(['--did', 'test-light', '--follow']);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    process.emit('SIGINT');
    await running;
    expect(events()).toHaveLength(1);
    expect(mocks.transport.mock.calls[0]?.[0].signal.aborted).toBe(true);
  });

  it('cancels an in-flight read at the duration limit without emitting an error as a value', async () => {
    mocks.api.getProperties.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          const signal = mocks.transport.mock.calls[0]?.[0].signal as AbortSignal;
          signal.addEventListener('abort', () => reject(new NetworkError('cancelled')), {
            once: true,
          });
        }),
    );
    const running = run(['--did', 'test-light', '--duration-ms', '1000']);
    await vi.advanceTimersByTimeAsync(1000);
    await running;
    expect(output).toBe('');
    expect(warning).toBe('');
  });

  it.each([
    new AuthRequiredError('expired', { domain: 'cloud' }),
    new SchemaError('schema drift', { domain: 'cloud' }),
    new GatewayError('offline', { domain: 'cloud' }),
  ])('stops immediately for a non-network error: %s', async (error) => {
    mocks.api.getProperties.mockRejectedValueOnce(error);
    await expect(run(['--did', 'test-light'])).rejects.toBe(error);
    expect(mocks.api.getProperties).toHaveBeenCalledTimes(1);
    expect(events()).toHaveLength(0);
    expect(warning).toBe('');
  });

  it('bounds network retries and never emits failed reads as new values', async () => {
    const error = new NetworkError('temporary failure', { domain: 'cloud' });
    mocks.api.getProperties.mockRejectedValue(error);
    const running = run(['--did', 'test-light', '--interval-ms', '1000']);
    const result = expect(running).rejects.toBe(error);
    await vi.advanceTimersByTimeAsync(2000);
    await result;
    expect(mocks.api.getProperties).toHaveBeenCalledTimes(3);
    expect(events()).toHaveLength(0);
    expect(warning).toContain('retry 1/2');
    expect(warning).toContain('retry 2/2');
  });

  it('retains the last good baseline through transient and accepted-only reads', async () => {
    mocks.api.getProperties
      .mockResolvedValueOnce(sample(false))
      .mockRejectedValueOnce(new NetworkError('unavailable'))
      .mockResolvedValueOnce([
        { did: 'test-light', siid: 2, piid: 1, code: 1, confirmed: false, status: 'accepted' },
      ])
      .mockResolvedValueOnce(sample(false))
      .mockResolvedValueOnce(sample(true));
    const running = run(['--did', 'test-light', '--interval-ms', '1000', '--max-events', '2']);
    await vi.advanceTimersByTimeAsync(4000);
    await running;
    expect(events().map((event) => event.results[0].value)).toEqual([false, true]);
    expect(mocks.api.getProperties).toHaveBeenCalledTimes(5);
  });

  it('does not produce a misleading empty snapshot for devices without readable properties', async () => {
    mocks.api.getProperties.mockResolvedValueOnce([]);
    await expect(run(['--did', 'test-light'])).rejects.toBeInstanceOf(ConfigError);
    expect(output).toBe('');
  });

  it('stops on a failed batch member rather than emit it as a changed property', async () => {
    mocks.api.getProperties.mockResolvedValueOnce([
      ...sample(),
      { did: 'test-light', siid: 2, piid: 2, code: -1, status: 'error', confirmed: false },
    ]);
    await expect(run(['--did', 'test-light'])).rejects.toBeInstanceOf(GatewayError);
    expect(output).toBe('');
  });

  it.each([
    ['--interval-ms', '999'],
    ['--interval-ms', '1.5'],
    ['--interval-ms', '2147483648'],
    ['--duration-ms', '0'],
    ['--duration-ms', ''],
    ['--follow', '--max-events', ''],
    ['--duration-ms', '2147483648'],
    ['--max-events', '-1'],
    ['--properties', 'on,'],
    ['--source', 'invalid'],
  ])('rejects invalid bounds/selections before cloud access: %j', async (...args) => {
    await expect(run(['--did', 'test-light', ...args])).rejects.toBeInstanceOf(ConfigError);
    expect(mocks.transport).not.toHaveBeenCalled();
  });
});
