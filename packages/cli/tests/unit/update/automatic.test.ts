import { createHash } from 'node:crypto';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type AutomaticDependencies,
  isAutomaticUpdateEligible,
  maybeAutomaticUpdate,
} from '../../../src/update/automatic.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const CURRENT_VERSION = '3.0.0';
const PACKAGE_ROOT = '/virtual/npm/lib/node_modules/@eyaeya/xgg-cli';
const STATE_ROOT = '/virtual/user/.xgg/updates';
const KEY = createHash('sha256').update(path.resolve(PACKAGE_ROOT)).digest('hex').slice(0, 24);
const STATE_FILE = path.join(STATE_ROOT, `${KEY}.json`);
const safeArgs = ['cloud', 'device', 'list'];

function result(status = 'current'): Awaited<ReturnType<AutomaticDependencies['run']>> {
  return {
    ok: true,
    status,
    currentVersion: status === 'updated' ? '3.1.0' : CURRENT_VERSION,
    latestVersion: '3.1.0',
    updateAvailable: false,
    source: 'https://registry.npmjs.org',
    fallback: false,
    freshness: 'source-latest',
    warnings: [],
    installSupported: true,
  };
}

/** Atomic in-memory operations reproduce exclusive claims without real disk access. */
function harness() {
  const files = new Map<string, string>();
  let clock = Date.UTC(2026, 9, 14, 12);
  const io = {
    mkdir: vi.fn(async () => undefined),
    readFile: vi.fn(async (name: string) => {
      const content = files.get(name);
      if (content === undefined) throw Object.assign(new Error('missing file'), { code: 'ENOENT' });
      return content;
    }),
    writeFile: vi.fn(
      async (name: string, content: string, options?: { flag?: string; mode?: number }) => {
        if (options?.flag === 'wx' && files.has(name)) {
          throw Object.assign(new Error('existing claim'), { code: 'EEXIST' });
        }
        files.set(name, content);
      },
    ),
    rename: vi.fn(async (from: string, to: string) => {
      const content = files.get(from);
      if (content === undefined) throw new Error('missing temporary file');
      files.set(to, content);
      files.delete(from);
    }),
    readdir: vi.fn(async (directory: string) =>
      [...files.keys()]
        .filter((name) => path.dirname(name) === directory)
        .map((name) => path.basename(name)),
    ),
    unlink: vi.fn(async (name: string) => {
      files.delete(name);
    }),
  };
  const detect = vi
    .fn<AutomaticDependencies['detect']>()
    .mockResolvedValue({ supported: true, packageRoot: PACKAGE_ROOT });
  const run = vi.fn<AutomaticDependencies['run']>().mockResolvedValue(result());
  const notify = vi.fn();
  const deps: AutomaticDependencies = {
    fs: io as unknown as AutomaticDependencies['fs'],
    now: () => clock,
    stateRoot: STATE_ROOT,
    packageRoot: PACKAGE_ROOT,
    detect,
    run,
    notify,
  };
  return {
    files,
    io,
    deps,
    detect,
    run,
    notify,
    now: () => clock,
    advance: (elapsed: number) => {
      clock += elapsed;
    },
    invoke: (argv = safeArgs, env: NodeJS.ProcessEnv = {}) =>
      maybeAutomaticUpdate(CURRENT_VERSION, argv, env, deps),
  };
}

afterEach(() => vi.restoreAllMocks());

describe('automatic update eligibility', () => {
  it.each([
    ['status'],
    ['device', 'list'],
    ['device', 'get', 'sample-device'],
    ['device', 'spec', 'sample-device'],
    ['rule', 'list'],
    ['rule', 'view', 'sample-rule'],
    ['rule', 'get', 'sample-rule'],
    ['variable', 'list'],
    ['variable', 'get', 'sample-variable'],
    ['variable', 'get-value', 'sample-variable'],
    ['backup', 'list'],
    ['cloud', 'status'],
    ['cloud', 'home', 'list'],
    ['cloud', 'device', 'list', '--pretty'],
    ['cloud', 'device', 'spec', '--did', 'sample-device'],
    ['cloud', 'device', 'get', '--did', 'sample-device', '--source', 'device'],
    ['cloud', 'scene', 'list'],
    ['cloud', 'consumable', 'list'],
  ])('opts in finite safe read %j', (...argv) => {
    expect(isAutomaticUpdateEligible(argv, {})).toBe(true);
  });

  it.each([
    [],
    ['login'],
    ['logout'],
    ['agent', 'serve'],
    ['api', '/api/getGraph'],
    ['update'],
    ['light', 'formula', 'brightness'],
    ['light', 'formula', 'temperature'],
    ['light', 'formula', 'brightness-beta'],
    ['cloud', 'login'],
    ['cloud', 'logout'],
    ['cloud', 'gateway', 'login'],
    ['cloud', 'device', 'set'],
    ['cloud', 'device', 'action'],
    ['cloud', 'scene', 'run'],
    ['cloud', 'speaker', 'run'],
    ['cloud', 'speaker', 'play'],
    ['cloud', 'device', 'watch'],
    ['rule', 'new'],
    ['rule', 'enable'],
    ['rule', 'disable'],
    ['rule', 'trigger'],
    ['rule', 'delete'],
    ['rule', 'set'],
    ['rule', 'node', 'add'],
    ['rule', 'edge', 'add'],
    ['variable', 'set-value'],
    ['variable', 'create'],
    ['variable', 'watch'],
    ['backup', 'load'],
    ['backup', 'delete'],
    ['backup', 'create'],
    ['future-command', 'list'],
    ['--help'],
    ['--version'],
    ['-V'],
    ['help', 'status'],
    ['status', '--help'],
    ['status', '-h'],
    ['status', '--version'],
    ['device', 'list', '--watch'],
    ['device', 'list', '--watch=true'],
    ['rule', 'view', '--follow'],
    ['rule', 'view', '--follow=true'],
  ])('excludes mutation, session, daemon, help or stream %j', (...argv) => {
    expect(isAutomaticUpdateEligible(argv, {})).toBe(false);
  });

  it.each([
    { XGG_AUTO_UPDATE: '0' },
    { XGG_UPDATE_HANDOFF: '1' },
    { CI: '1' },
    { CI: 'true' },
    { CI: 'yes' },
  ])('respects opt-out or handoff environment %j before doing any work', async (env) => {
    const h = harness();
    expect(await h.invoke(safeArgs, env)).toBe(false);
    expect(h.io.readFile).not.toHaveBeenCalled();
    expect(h.detect).not.toHaveBeenCalled();
    expect(h.run).not.toHaveBeenCalled();
  });

  it.each([{ CI: '0' }, { CI: 'false' }, { XGG_AUTO_UPDATE: '1' }])(
    'permits explicitly non-CI environment %j',
    (env) => {
      expect(isAutomaticUpdateEligible(safeArgs, env)).toBe(true);
    },
  );
});

describe('automatic update state and failure isolation', () => {
  it('keeps offline lighting calculations free of update state, installation probes, and network', async () => {
    const h = harness();
    const argv = [
      'light',
      'formula',
      'brightness',
      '--latitude',
      '23.129',
      '--min',
      '10',
      '--max',
      '100',
    ];
    expect(await h.invoke(argv, { XGG_AUTO_UPDATE: '1', CI: 'false' })).toBe(false);
    expect(h.io.readFile).not.toHaveBeenCalled();
    expect(h.io.mkdir).not.toHaveBeenCalled();
    expect(h.detect).not.toHaveBeenCalled();
    expect(h.run).not.toHaveBeenCalled();
  });

  it('runs a first safe invocation, honors registry override, and records a successful check atomically', async () => {
    const h = harness();
    const registry = 'https://packages.example.test';
    expect(await h.invoke(safeArgs, { XGG_UPDATE_REGISTRY: registry })).toBe(false);
    expect(h.run).toHaveBeenCalledOnce();
    expect(h.run).toHaveBeenCalledWith(CURRENT_VERSION, { registry });
    expect(JSON.parse(h.files.get(STATE_FILE) ?? '{}')).toEqual({
      attemptedAt: h.now(),
      succeededAt: h.now(),
    });
    expect(h.io.mkdir).toHaveBeenCalledWith(STATE_ROOT, { recursive: true, mode: 0o700 });
    expect(h.io.rename).toHaveBeenCalledTimes(2);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('returns true only after installation so the caller can hand off before executing the query', async () => {
    const h = harness();
    h.run.mockResolvedValue(result('updated'));
    expect(await h.invoke()).toBe(true);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('throttles successful checks for a rolling 24 hours, including across a calendar-day boundary', async () => {
    const h = harness();
    await h.invoke();
    h.advance(DAY - 1);
    await h.invoke();
    expect(h.run).toHaveBeenCalledOnce();
    h.advance(1);
    await h.invoke();
    expect(h.run).toHaveBeenCalledTimes(2);
  });

  it('backs off failed attempts for a full hour even when the hour bucket changes', async () => {
    const h = harness();
    h.advance(HOUR - 1);
    h.run.mockRejectedValue(new Error('offline'));
    expect(await h.invoke()).toBe(false);
    h.advance(HOUR - 1);
    await h.invoke();
    expect(h.run).toHaveBeenCalledOnce();
    h.advance(1);
    await h.invoke();
    expect(h.run).toHaveBeenCalledTimes(2);
    expect(JSON.parse(h.files.get(STATE_FILE) ?? '{}')).toEqual({ attemptedAt: h.now() });
    expect(h.notify).toHaveBeenCalledWith(expect.stringContaining('Update deferred'));
  });

  it('reserves one concurrent check per installation without starting duplicate installers', async () => {
    const h = harness();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.run.mockImplementation(async () => {
      await barrier;
      return result('updated');
    });
    const first = h.invoke();
    const second = h.invoke();
    await vi.waitFor(() => expect(h.run).toHaveBeenCalledOnce());
    release();
    expect(await Promise.all([first, second])).toEqual([true, false]);
    expect([...h.files.keys()].filter((name) => name.endsWith('.claim'))).toHaveLength(1);
  });

  it.each(['{', 'null', '{}', '[]', '{"attemptedAt":"bad","succeededAt":{}}'])(
    'recovers from malformed state %s',
    async (state) => {
      const h = harness();
      h.files.set(STATE_FILE, state);
      await h.invoke();
      expect(h.run).toHaveBeenCalledOnce();
      expect(JSON.parse(h.files.get(STATE_FILE) ?? '{}').succeededAt).toBe(h.now());
    },
  );

  it('does not suppress checks indefinitely after the local clock moves backwards', async () => {
    const h = harness();
    h.files.set(
      STATE_FILE,
      JSON.stringify({ attemptedAt: h.now() + DAY, succeededAt: h.now() + DAY }),
    );
    await h.invoke();
    expect(h.run).toHaveBeenCalledOnce();
  });

  it('skips unsupported installs without creating claims or fetching releases', async () => {
    const h = harness();
    h.detect.mockResolvedValue({
      supported: false,
      packageRoot: PACKAGE_ROOT,
      reason: 'Source checkout.',
    });
    expect(await h.invoke()).toBe(false);
    expect(h.io.mkdir).not.toHaveBeenCalled();
    expect(h.run).not.toHaveBeenCalled();
  });

  it('fails open when state storage is unavailable, preserving the pending command', async () => {
    const h = harness();
    h.io.writeFile.mockRejectedValue(Object.assign(new Error('read only'), { code: 'EACCES' }));
    await expect(h.invoke()).resolves.toBe(false);
    expect(h.run).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('preserves the installed result if saving the successful throttle fails', async () => {
    const h = harness();
    h.run.mockResolvedValue(result('updated'));
    h.io.rename.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('disk full'));
    expect(await h.invoke()).toBe(true);
    expect(h.run).toHaveBeenCalledOnce();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('keeps automatic failure notices on stderr without contaminating JSON stdout or exit status', async () => {
    const h = harness();
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const beforeExitCode = process.exitCode;
    h.run.mockRejectedValue(new Error('private network diagnostic'));
    const { notify: _notify, ...deps } = h.deps;
    expect(await maybeAutomaticUpdate(CURRENT_VERSION, safeArgs, {}, deps)).toBe(false);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('[xgg update] Update deferred'));
    expect(String(stderr.mock.calls[0]?.[0])).not.toContain('private network diagnostic');
    expect(process.exitCode).toBe(beforeExitCode);
  });

  it('cleans up only expired reservations belonging to this installation', async () => {
    const h = harness();
    const old = path.join(STATE_ROOT, `${KEY}-${Math.floor((h.now() - 3 * DAY) / HOUR)}.claim`);
    const recent = path.join(STATE_ROOT, `${KEY}-${Math.floor((h.now() - DAY) / HOUR)}.claim`);
    const unrelated = path.join(STATE_ROOT, 'other-installation-0.claim');
    for (const name of [old, recent, unrelated]) h.files.set(name, '');
    await h.invoke();
    expect(h.files.has(old)).toBe(false);
    expect(h.files.has(recent)).toBe(true);
    expect(h.files.has(unrelated)).toBe(true);
    expect(h.io.unlink).toHaveBeenCalledOnce();
    expect(h.io.unlink).toHaveBeenCalledWith(old);
  });
});
