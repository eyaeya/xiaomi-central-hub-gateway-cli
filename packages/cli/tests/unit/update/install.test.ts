import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type InstallFileSystem,
  type InstallOptions,
  type InstallRunner,
  UpdateInstallError,
  detectInstall,
  installUpdate,
} from '../../../src/update/install.js';

const MODULES = '/prefix/lib/node_modules';
const ROOT = `${MODULES}/@eyaeya/xgg-cli`;
const BACKUP = `${MODULES}/@eyaeya/.xgg-cli-previous`;
const LOCK = `${MODULES}/@eyaeya/.xgg-cli-update.lock`;
const NPM = '/tools/npm-cli.js';
const RELEASE = {
  version: '3.1.0',
  registry: 'https://registry.npmjs.org',
  tarball: 'https://registry.npmjs.org/@eyaeya/xgg-cli/-/xgg-cli-3.1.0.tgz',
  integrity: `sha512-${'A'.repeat(86)}==`,
};

function coded(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

class MemoryFs implements InstallFileSystem {
  readonly files = new Map<string, string | null>();
  readonly links = new Map<string, string>();
  readonly renames: [string, string][] = [];
  failRename?: (from: string, to: string) => boolean;
  failRemove?: (path: string) => boolean;
  serial = 0;
  add(path: string, value: string | null = null): void {
    this.files.set(path, value);
    if (path !== '/') this.add(dirname(path));
  }
  async readFile(path: string): Promise<string> {
    const value = this.files.get(path);
    if (typeof value !== 'string') throw coded('ENOENT');
    return value;
  }
  async writeFile(path: string, value: string): Promise<void> {
    this.add(path, value);
  }
  async realpath(path: string): Promise<string> {
    if (this.links.has(path)) return this.links.get(path) as string;
    if (!this.files.has(path)) throw coded('ENOENT');
    return path;
  }
  async isSymbolicLink(path: string): Promise<boolean> {
    return this.links.has(path);
  }
  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.links.has(path);
  }
  async mkdir(path: string): Promise<void> {
    if (await this.exists(path)) throw coded('EEXIST');
    this.add(path);
  }
  async mkdtemp(prefix: string): Promise<string> {
    const path = `${prefix}${++this.serial}`;
    this.add(path);
    return path;
  }
  async rename(from: string, to: string): Promise<void> {
    this.renames.push([from, to]);
    if (this.failRename?.(from, to)) throw coded('EACCES');
    if (!this.files.has(from)) throw coded('ENOENT');
    if (this.files.has(to)) throw coded('EEXIST');
    for (const [path, value] of [...this.files]) {
      if (path === from || path.startsWith(`${from}/`)) {
        this.files.delete(path);
        this.files.set(`${to}${path.slice(from.length)}`, value);
      }
    }
  }
  async remove(path: string): Promise<void> {
    if (this.failRemove?.(path)) throw coded('EACCES');
    for (const key of this.files.keys()) {
      if (key === path || key.startsWith(`${path}/`)) this.files.delete(key);
    }
  }
  package(root: string, version: string, name = '@eyaeya/xgg-cli'): void {
    this.add(
      join(root, 'package.json'),
      JSON.stringify({ name, version, bin: { xgg: './dist/cli.js' } }),
    );
    this.add(join(root, 'dist/cli.js'), 'test binary');
    this.add(
      join(root, 'node_modules/@eyaeya/xgg-core/package.json'),
      JSON.stringify({ name: '@eyaeya/xgg-core', version }),
    );
  }
  version(root = ROOT): string {
    return JSON.parse(String(this.files.get(join(root, 'package.json')))).version as string;
  }
}

function harness() {
  const io = new MemoryFs();
  io.package(ROOT, '3.0.1');
  io.add(NPM, 'npm JavaScript');
  const calls: { file: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const controls: {
    installError?: Error;
    badIntegrity?: boolean;
    coreVersion?: string;
    failActiveSmoke?: boolean;
    beforeInstall?: () => Promise<void>;
  } = {};
  const run: InstallRunner = async (file, args, options) => {
    calls.push({ file, args, env: options.env });
    if (args[1] === 'root') return { stdout: `${MODULES}\n` };
    if (args[1] === 'install') {
      await controls.beforeInstall?.();
      if (controls.installError) throw controls.installError;
      const stage = args[args.indexOf('--prefix') + 1] as string;
      const stagedRoot = join(stage, 'node_modules/@eyaeya/xgg-cli');
      io.package(stagedRoot, RELEASE.version);
      if (controls.coreVersion) {
        io.add(
          join(stagedRoot, 'node_modules/@eyaeya/xgg-core/package.json'),
          JSON.stringify({ name: '@eyaeya/xgg-core', version: controls.coreVersion }),
        );
      }
      io.add(
        join(stage, 'package-lock.json'),
        JSON.stringify({
          packages: {
            'node_modules/@eyaeya/xgg-cli': {
              version: RELEASE.version,
              integrity: controls.badIntegrity ? 'sha512-wrong' : RELEASE.integrity,
              resolved: RELEASE.tarball,
            },
          },
        }),
      );
      return { stdout: '' };
    }
    const binary = args[0] as string;
    const root = dirname(dirname(binary));
    if (controls.failActiveSmoke && root === ROOT && io.version() === RELEASE.version) {
      throw new Error('simulated activation failure');
    }
    if (args[1] === '--version') return { stdout: `${io.version(root)}\n` };
    return { stdout: 'Usage: xgg [options] [command]\n' };
  };
  const options: InstallOptions = {
    fs: io,
    run,
    npmCliPath: NPM,
    execPath: '/tools/node',
    packageRoot: ROOT,
    env: {},
    pid: 42,
    isProcessAlive: (pid) => pid === 42,
  };
  return { io, calls, controls, options };
}

describe('staged global npm installer', () => {
  it('detects only the active npm global package without treating cwd as an install target', async () => {
    const { io, options } = harness();
    expect(await detectInstall(ROOT, options)).toMatchObject({
      supported: true,
      packageRoot: ROOT,
    });
    io.package('/project/node_modules/@eyaeya/xgg-cli', '3.0.1');
    expect(await detectInstall('/project/node_modules/@eyaeya/xgg-cli', options)).toMatchObject({
      supported: false,
    });
    io.package('/project/packages/cli', '0.0.0', '@xgg/cli');
    expect(await detectInstall('/project/packages/cli', options)).toMatchObject({
      supported: false,
    });
  });

  it('rejects linked, npx, pnpm store and missing npm installations', async () => {
    const { io, options } = harness();
    io.links.set(ROOT, '/source/cli');
    expect(await detectInstall(ROOT, options)).toMatchObject({ supported: false });
    io.links.delete(ROOT);
    for (const path of ['/cache/_npx/entry/node_modules/@eyaeya/xgg-cli', '/store/.pnpm/xgg-cli']) {
      io.package(path, '3.0.1');
      expect(await detectInstall(path, options)).toMatchObject({ supported: false });
    }
    await io.remove(NPM);
    expect(await detectInstall(ROOT, options)).toMatchObject({ supported: false });
  });

  it('pins the selected tarball, integrity and matching core with no scripts or shell, then smoke checks both locations', async () => {
    const { io, options, calls } = harness();
    expect(await installUpdate(RELEASE, options)).toEqual({
      version: '3.1.0',
      previousVersion: '3.0.1',
      packageRoot: ROOT,
    });
    expect(io.version()).toBe('3.1.0');
    const install = calls.find((call) => call.args[1] === 'install');
    expect(install?.file).toBe('/tools/node');
    expect(install?.args).toEqual(
      expect.arrayContaining([
        NPM,
        '--ignore-scripts',
        '--engine-strict',
        '--force=false',
        '--install-strategy=nested',
        '--@eyaeya:registry=https://registry.npmjs.org',
        RELEASE.tarball,
      ]),
    );
    const smokes = calls.filter((call) => call.args[1]?.startsWith('--'));
    expect(smokes.map((call) => call.args[1])).toEqual([
      '--version',
      '--help',
      '--version',
      '--help',
    ]);
    expect(calls.every((call) => call.env.XGG_AUTO_UPDATE === '0')).toBe(true);
    expect(await io.exists(BACKUP)).toBe(false);
    expect(await io.exists(LOCK)).toBe(false);
  });

  it('overrides force config and removes inherited target Node versions for engine checks', async () => {
    const { options, calls } = harness();
    await installUpdate(RELEASE, {
      ...options,
      env: {
        npm_config_force: 'true',
        NPM_CONFIG_NODE_VERSION: '99.0.0',
        'npm_config_node-version': '99.0.0',
      },
    });
    const install = calls.find((call) => call.args[1] === 'install');
    expect(install?.args).toContain('--force=false');
    expect(install?.env.NPM_CONFIG_NODE_VERSION).toBeUndefined();
    expect(install?.env['npm_config_node-version']).toBeUndefined();
  });

  it('rejects an integrity mismatch before executing downloaded code or renaming the installed package', async () => {
    const { io, controls, options, calls } = harness();
    controls.badIntegrity = true;
    await expect(installUpdate(RELEASE, options)).rejects.toMatchObject({
      retrySafe: true,
      recoveryNeeded: false,
    });
    expect(io.version()).toBe('3.0.1');
    expect(io.renames).toEqual([]);
    expect(calls.some((call) => call.args[1] === '--version')).toBe(false);
  });

  it('rejects a mismatched nested core before executing it', async () => {
    const { io, controls, options, calls } = harness();
    controls.coreVersion = '3.2.0';
    await expect(installUpdate(RELEASE, options)).rejects.toThrow('CLI/core identity');
    expect(io.version()).toBe('3.0.1');
    expect(calls.some((call) => call.args[1] === '--version')).toBe(false);
  });

  it('leaves the original package intact on npm failure and permits registry fallback', async () => {
    const { io, controls, options } = harness();
    controls.installError = new Error('simulated npm timeout');
    await expect(installUpdate(RELEASE, options)).rejects.toMatchObject({ retrySafe: true });
    expect(io.version()).toBe('3.0.1');
    expect(io.renames).toEqual([]);
    expect(await io.exists(LOCK)).toBe(false);
  });

  it('restores the previous package when the second rename fails', async () => {
    const { io, options } = harness();
    io.failRename = (from, to) => from.includes('.xgg-cli-stage-') && to === ROOT;
    await expect(installUpdate(RELEASE, options)).rejects.toMatchObject({ retrySafe: true });
    expect(io.version()).toBe('3.0.1');
    expect(await io.exists(BACKUP)).toBe(false);
  });

  it('restores the previous package when post-activation smoke fails', async () => {
    const { io, options, controls } = harness();
    controls.failActiveSmoke = true;
    await expect(installUpdate(RELEASE, options)).rejects.toMatchObject({ retrySafe: true });
    expect(io.version()).toBe('3.0.1');
    expect(io.renames.at(-1)).toEqual([BACKUP, ROOT]);
  });

  it('preserves the recovery copy and disallows fallback when rollback fails', async () => {
    const { io, options, controls } = harness();
    controls.failActiveSmoke = true;
    io.failRename = (from) => from === BACKUP;
    await expect(installUpdate(RELEASE, options)).rejects.toMatchObject({
      retrySafe: false,
      recoveryNeeded: true,
    });
    expect(io.version(BACKUP)).toBe('3.0.1');
  });

  it('does not roll back a verified installation when backup cleanup fails', async () => {
    const { io, options } = harness();
    io.failRemove = (path) => path === BACKUP;
    await expect(installUpdate(RELEASE, options)).resolves.toMatchObject({ version: '3.1.0' });
    expect(io.version()).toBe('3.1.0');
    expect(io.version(BACKUP)).toBe('3.0.1');
  });

  it('refuses equal or older releases without downloading', async () => {
    const { options, calls } = harness();
    await expect(installUpdate({ ...RELEASE, version: '3.0.1' }, options)).rejects.toThrow(
      'equal or older',
    );
    await expect(installUpdate({ ...RELEASE, version: '2.9.0' }, options)).rejects.toThrow(
      'equal or older',
    );
    expect(calls.some((call) => call.args[1] === 'install')).toBe(false);
  });

  it('serializes concurrent update attempts and never steals a live owner', async () => {
    const { options, controls, io } = harness();
    let started: () => void = () => undefined;
    let finish: () => void = () => undefined;
    const ready = new Promise<void>((done) => {
      started = done;
    });
    const pending = new Promise<void>((done) => {
      finish = done;
    });
    controls.beforeInstall = async () => {
      started();
      await pending;
    };
    const first = installUpdate(RELEASE, options);
    await ready;
    await expect(installUpdate(RELEASE, { ...options, pid: 43 })).rejects.toMatchObject({
      retrySafe: false,
    });
    expect(JSON.parse(await io.readFile(join(LOCK, 'owner.json'))).pid).toBe(42);
    finish();
    await first;
  });

  it('reclaims a dead owner but refuses an incomplete owner record', async () => {
    const { io, options } = harness();
    io.add(join(LOCK, 'owner.json'), JSON.stringify({ pid: 99, token: 'dead-owner' }));
    await expect(installUpdate(RELEASE, options)).resolves.toMatchObject({ version: '3.1.0' });
    io.add(LOCK);
    await expect(installUpdate({ ...RELEASE, version: '3.2.0' }, options)).rejects.toMatchObject({
      retrySafe: false,
    });
  });

  it('recovers a process interruption between renames from the preserved CLI', async () => {
    const { io, options } = harness();
    await io.rename(ROOT, BACKUP);
    io.add(join(LOCK, 'owner.json'), JSON.stringify({ pid: 99, token: 'dead-owner' }));
    expect(await detectInstall(BACKUP, options)).toMatchObject({
      supported: true,
      packageRoot: ROOT,
    });
    await expect(
      installUpdate(RELEASE, { ...options, packageRoot: BACKUP }),
    ).resolves.toMatchObject({ version: '3.1.0' });
    expect(io.version()).toBe('3.1.0');
  });

  it('recovers a malformed activated manifest by explicitly invoking the preserved CLI', async () => {
    const { io, options } = harness();
    io.package(BACKUP, '3.0.1');
    io.add(join(ROOT, 'package.json'), 'not json');
    expect(await detectInstall(BACKUP, options)).toMatchObject({
      supported: true,
      packageRoot: ROOT,
    });
    await expect(
      installUpdate(RELEASE, { ...options, packageRoot: BACKUP }),
    ).resolves.toMatchObject({ version: '3.1.0' });
  });

  it('does not overwrite the current tree with a partially removed recovery package', async () => {
    const { io, options, controls } = harness();
    io.package(ROOT, '3.1.0');
    io.package(BACKUP, '3.0.1');
    await io.remove(join(BACKUP, 'node_modules'));
    controls.failActiveSmoke = true;
    await expect(installUpdate({ ...RELEASE, version: '3.2.0' }, options)).rejects.toMatchObject({
      retrySafe: false,
      recoveryNeeded: true,
    });
    expect(io.version()).toBe('3.1.0');
    expect(io.version(BACKUP)).toBe('3.0.1');
    expect(io.renames).toEqual([]);
  });

  it('rejects insecure metadata without starting npm', async () => {
    const { options, calls } = harness();
    await expect(
      installUpdate({ ...RELEASE, registry: 'http://registry.example' }, options),
    ).rejects.toThrow('HTTPS');
    await expect(
      installUpdate(
        { ...RELEASE, tarball: 'https://name:secret@registry.example/file.tgz' },
        options,
      ),
    ).rejects.toThrow('HTTPS');
    expect(calls).toEqual([]);
    expect(new UpdateInstallError('test', false).name).toBe('UpdateInstallError');
  });
});
