import {
  AuthExpiredError,
  AuthRequiredError,
  ConfigError,
  GatewayError,
  NetworkError,
  type RuleLogEntry,
  SchemaError,
} from '@eyaeya/xgg-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorToExit } from '../../../src/errors.js';
import { buildProgram } from '../../../src/program.js';

/* ------------------------------------------------------------------ */
/* Reset process.exitCode so tests don't bleed into each other        */
/* ------------------------------------------------------------------ */
beforeEach(() => {
  process.exitCode = 0;
});

afterEach(() => {
  process.exitCode = 0;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/* ------------------------------------------------------------------ */
/* Mock @eyaeya/xgg-core — keep ConfigError + parseTimestamp/filterRuleLogs  */
/* real so we exercise the CLI's parsing/filtering wiring end-to-end. */
/* Only the transport-touching fetchRuleLogs is stubbed.              */
/* ------------------------------------------------------------------ */
vi.mock('@eyaeya/xgg-core', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    fetchRuleLogs: vi.fn(),
    // listAvailVarsForRule is part of the broader rule-command surface
    // mocked in sibling tests (lint.test.ts) — keep parity even though
    // logs.ts doesn't call it directly, in case program wiring reaches
    // for it during command construction.
    listAvailVarsForRule: vi.fn().mockResolvedValue([]),
  };
});

const coreMock = (await import('@eyaeya/xgg-core')) as typeof import('@eyaeya/xgg-core') & {
  fetchRuleLogs: ReturnType<typeof vi.fn>;
  listAvailVarsForRule: ReturnType<typeof vi.fn>;
};

/* Capture stdout so we can assert pretty-vs-json render shape */
let stdoutChunks: string[];
beforeEach(() => {
  stdoutChunks = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  });
});

function makeEntry(overrides: Partial<RuleLogEntry> = {}): RuleLogEntry {
  const timestamp = overrides.timestamp ?? Date.parse('2026-05-29T10:00:00Z');
  return {
    timestamp,
    iso: new Date(timestamp).toISOString(),
    graphId: overrides.graphId ?? 'r1',
    rawType: overrides.rawType ?? 'i',
    level: overrides.level ?? 'info',
    message: overrides.message ?? 'hello',
    raw: overrides.raw ?? `3|${timestamp}|i|${overrides.graphId ?? 'r1'}|hello`,
    ...overrides,
  };
}

describe('xgg rule logs --follow bounded observation', () => {
  let stderrChunks: string[];
  const block = (entries: RuleLogEntry[] = []) => ({
    entries,
    unparsed: [],
    blocksRead: 1,
    cursorWrapped: false,
  });
  const run = (...flags: string[]) => {
    const program = buildProgram();
    program.exitOverride();
    return program.parseAsync(['node', 'xgg', 'rule', 'logs', 'r1', '--json', ...flags]);
  };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('XGG_BASE_URL', 'http://127.0.0.1:0');
    coreMock.fetchRuleLogs.mockReset();
    stderrChunks = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });
  });

  it.each(['--max-events', '--duration-ms', '--interval-ms'])(
    'requires --follow for %s before making a request',
    async (flag) => {
      await expect(run(flag, '1')).rejects.toMatchObject({
        code: 'CONFIG',
        __xggCmd: 'rule.logs',
        message: expect.stringContaining('require --follow'),
      });
      expect(coreMock.fetchRuleLogs).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['--interval-ms', '0'],
    ['--max-blocks', '0'],
    ['--duration-ms', '0'],
    ['--duration-ms', '1e3'],
    ['--max-events', '-1'],
    ['--timeout', '0'],
    ['--timeout', 'NaN'],
  ])('rejects %s=%s before fetching', async (flag, value) => {
    await expect(run('--follow', `${flag}=${value}`)).rejects.toBeInstanceOf(ConfigError);
    expect(coreMock.fetchRuleLogs).not.toHaveBeenCalled();
  });

  it('--max-events 0 keeps the initial dump and exits without scheduling a poll', async () => {
    coreMock.fetchRuleLogs.mockResolvedValue(block([makeEntry()]));
    await run('--follow', '--max-events', '0');
    expect(JSON.parse(stdoutChunks.join('')).entries).toHaveLength(1);
    expect(coreMock.fetchRuleLogs).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('counts only new matching entries, truncates a full batch, and preserves JSON framing', async () => {
    const initial = makeEntry({ raw: 'initial', message: 'initial' });
    coreMock.fetchRuleLogs
      .mockResolvedValueOnce(block([initial]))
      .mockResolvedValueOnce(
        block([
          initial,
          makeEntry({ raw: 'other-rule', graphId: 'r2' }),
          makeEntry({ raw: 'new-1', message: 'first new' }),
          makeEntry({ raw: 'new-2', message: 'second new' }),
          makeEntry({ raw: 'new-3', message: 'over limit' }),
        ]),
      );
    const promise = run('--follow', '--max-events', '2', '--interval-ms', '100');
    await vi.runAllTimersAsync();
    await promise;
    const lines = stdoutChunks
      .join('')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ ok: true, count: 1 });
    expect(lines.slice(1).map((line) => line.message)).toEqual(['first new', 'second new']);
    expect(coreMock.fetchRuleLogs).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops at the duration even if no event arrives, without a final extra poll', async () => {
    coreMock.fetchRuleLogs.mockResolvedValue(block());
    const started = Date.now();
    const promise = run('--follow', '--duration-ms', '250', '--interval-ms', '100');
    await vi.runAllTimersAsync();
    await promise;
    expect(coreMock.fetchRuleLogs).toHaveBeenCalledTimes(3);
    expect(Date.now() - started).toBe(250);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not schedule a poll after an in-flight initial read exceeds the duration', async () => {
    coreMock.fetchRuleLogs.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve(block()), 200)),
    );
    const promise = run('--follow', '--duration-ms', '100', '--interval-ms', '50');
    await vi.runAllTimersAsync();
    await promise;
    expect(coreMock.fetchRuleLogs).toHaveBeenCalledTimes(1);
  });

  it.each([
    [new AuthExpiredError('expired'), 3],
    [new AuthRequiredError('missing'), 3],
    [new SchemaError('drift', {}), 4],
    [new ConfigError('invalid'), 5],
    [new GatewayError('rejected', {}), 1],
    [new Error('unexpected'), 1],
  ])(
    'preserves %s and its exit mapping after a successful initial read',
    async (failure, exitCode) => {
      coreMock.fetchRuleLogs.mockResolvedValueOnce(block()).mockRejectedValueOnce(failure);
      const promise = run('--follow', '--interval-ms', '100');
      const result = promise.catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      expect(await result).toBe(failure);
      expect(failure).toMatchObject({ __xggCmd: 'rule.logs' });
      expect(errorToExit(failure).code).toBe(exitCode);
      expect(coreMock.fetchRuleLogs).toHaveBeenCalledTimes(2);
      expect(stderrChunks).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('backs off only network errors and stops after three retries, preserving the error', async () => {
    const failure = new NetworkError('connection unavailable');
    coreMock.fetchRuleLogs.mockRejectedValue(failure);
    const times: number[] = [];
    coreMock.fetchRuleLogs.mockImplementation(async () => {
      times.push(Date.now());
      throw failure;
    });
    const result = run('--follow', '--interval-ms', '100').catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(await result).toBe(failure);
    expect(times.map((time) => time - (times[0] ?? 0))).toEqual([0, 250, 750, 1750]);
    expect(stderrChunks.join('')).toContain('retry 3/3 in 1000ms');
    expect(stderrChunks.join('')).toContain('retry limit reached');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resets consecutive failure count after a successful poll without duplicating entries', async () => {
    const initial = makeEntry({ raw: 'initial' });
    const fresh = makeEntry({ raw: 'fresh', message: 'recovered' });
    coreMock.fetchRuleLogs
      .mockResolvedValueOnce(block([initial]))
      .mockRejectedValueOnce(new NetworkError('first interruption'))
      .mockResolvedValueOnce(block([initial]))
      .mockRejectedValueOnce(new NetworkError('second interruption'))
      .mockResolvedValueOnce(block([initial, fresh]));
    const promise = run('--follow', '--max-events', '1', '--interval-ms', '100');
    await vi.runAllTimersAsync();
    await promise;
    expect(coreMock.fetchRuleLogs).toHaveBeenCalledTimes(5);
    expect(stderrChunks.join('').match(/retry 1\/3/g)).toHaveLength(2);
    expect(stdoutChunks.join('').trim().split('\n')).toHaveLength(2);
  });

  it('does not report successful observation if the duration expires during a network outage', async () => {
    const failure = new NetworkError('connection unavailable');
    coreMock.fetchRuleLogs.mockResolvedValueOnce(block()).mockRejectedValue(failure);
    const result = run('--follow', '--duration-ms', '200', '--interval-ms', '100').catch(
      (error: unknown) => error,
    );
    await vi.runAllTimersAsync();
    expect(await result).toBe(failure);
    expect(coreMock.fetchRuleLogs).toHaveBeenCalledTimes(2);
  });
});
