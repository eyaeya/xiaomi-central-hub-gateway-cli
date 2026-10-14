import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_NAME = '@eyaeya/xgg-cli';
const CORE_NAME = '@eyaeya/xgg-core';
const ownRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Small injected boundary: unit tests never touch the real filesystem or network. */
export interface InstallFileSystem {
  readFile(path: string): Promise<string>;
  writeFile(path: string, value: string): Promise<void>;
  realpath(path: string): Promise<string>;
  isSymbolicLink(path: string): Promise<boolean>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  mkdtemp(prefix: string): Promise<string>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface RunOptions {
  cwd?: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export type InstallRunner = (
  file: string,
  args: string[],
  options: RunOptions,
) => Promise<{ stdout: string }>;

export interface InstallOptions {
  packageRoot?: string;
  fs?: InstallFileSystem;
  run?: InstallRunner;
  npmCliPath?: string;
  execPath?: string;
  env?: NodeJS.ProcessEnv;
  pid?: number;
  isProcessAlive?: (pid: number) => boolean;
}

interface Release {
  version: string;
  registry: string;
  tarball: string;
  integrity: string;
}

interface Manifest {
  name?: string;
  version?: string;
  bin?: { xgg?: string };
  dependencies?: Record<string, string>;
}

export class UpdateInstallError extends Error {
  constructor(
    message: string,
    readonly retrySafe: boolean,
    readonly recoveryNeeded = false,
  ) {
    super(message);
    this.name = 'UpdateInstallError';
  }
}

const realFs: InstallFileSystem = {
  readFile: (path) => fs.readFile(path, 'utf8'),
  writeFile: (path, value) => fs.writeFile(path, value, { mode: 0o600 }),
  realpath: (path) => fs.realpath(path),
  isSymbolicLink: async (path) => (await fs.lstat(path)).isSymbolicLink(),
  exists: async (path) => {
    try {
      await fs.lstat(path);
      return true;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return false;
      throw error;
    }
  },
  mkdir: async (path) => {
    await fs.mkdir(path, { mode: 0o700 });
  },
  mkdtemp: (prefix) => fs.mkdtemp(prefix),
  rename: (from, to) => fs.rename(from, to),
  remove: (path) => fs.rm(path, { recursive: true, force: true }),
};

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

// Do not surface npm stderr: it can contain private registry credentials or config.
const realRun: InstallRunner = (file, args, options) =>
  new Promise((done, reject) => {
    execFile(
      file,
      args,
      {
        ...('cwd' in options ? { cwd: options.cwd } : {}),
        env: options.env,
        timeout: options.timeoutMs,
        maxBuffer: 256 * 1024,
        windowsHide: true,
        shell: false,
      },
      (error, stdout) => {
        if (error) {
          const code = errorCode(error);
          reject(
            new Error(
              `Update subprocess failed${code && /^[A-Z0-9_-]{1,40}$/i.test(code) ? ` (${code})` : ''}; check npm availability, network and prefix permissions.`,
            ),
          );
        } else done({ stdout });
      },
    );
  });

function runtime(options: InstallOptions) {
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env), XGG_AUTO_UPDATE: '0' };
  for (const key of Object.keys(env)) {
    // npm's engine checks must describe the running Node, never a configured
    // target version. Modern npm also sets flatOptions.nodeVersion itself.
    if (/^npm_config_node[_-]version$/i.test(key)) delete env[key];
  }
  return {
    io: options.fs ?? realFs,
    run: options.run ?? realRun,
    execPath: options.execPath ?? process.execPath,
    env,
    pid: options.pid ?? process.pid,
    alive:
      options.isProcessAlive ??
      ((pid: number) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (error) {
          // Permission-denied still means a process exists; never steal that lock.
          return errorCode(error) !== 'ESRCH';
        }
      }),
  };
}

async function readManifest(io: InstallFileSystem, path: string): Promise<Manifest> {
  const value: unknown = JSON.parse(await io.readFile(join(path, 'package.json')));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid installed package manifest.');
  }
  return value as Manifest;
}

/** Resolve npm's JavaScript entry; npm.cmd is never passed to a shell on Windows. */
async function npmScript(options: InstallOptions): Promise<string> {
  const { io, env, execPath } = runtime(options);
  const candidates = [
    options.npmCliPath,
    env.npm_execpath,
    join(dirname(execPath), 'node_modules/npm/bin/npm-cli.js'),
    join(dirname(execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
    ...(env.PATH ?? env.Path ?? '')
      .split(delimiter)
      .flatMap((directory) => [
        join(directory, 'npm'),
        join(directory, 'node_modules/npm/bin/npm-cli.js'),
        join(directory, '../lib/node_modules/npm/bin/npm-cli.js'),
      ]),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const real = await io.realpath(candidate);
      if (/[\\/]npm-cli\.js$/.test(real)) return real;
    } catch {
      // Try the next installed npm location; no shell or PATH command execution.
    }
  }
  throw new Error('Cannot locate npm-cli.js. Install npm for the active Node.js runtime first.');
}

export async function detectInstall(
  packageRoot = ownRoot,
  options: InstallOptions = {},
): Promise<{ supported: boolean; packageRoot: string; reason?: string }> {
  const { io, run, execPath, env } = runtime(options);
  // An interrupted rename can be recovered by invoking the preserved CLI with
  // `node <scope>/.xgg-cli-previous/dist/cli.js update`.
  const supplied = resolve(packageRoot);
  const root =
    basename(supplied) === '.xgg-cli-previous' ? join(dirname(supplied), 'xgg-cli') : supplied;
  try {
    const exists = await io.exists(root);
    let inspectionRoot = exists ? root : join(dirname(root), '.xgg-cli-previous');
    let manifest: Manifest;
    try {
      manifest = await readManifest(io, inspectionRoot);
    } catch {
      // Explicitly invoking the preserved CLI is the recovery entry point when
      // activation left a malformed or missing manifest at the normal location.
      if (basename(supplied) !== '.xgg-cli-previous')
        throw new Error('Invalid installed manifest.');
      inspectionRoot = supplied;
      manifest = await readManifest(io, inspectionRoot);
    }
    if (
      basename(supplied) === '.xgg-cli-previous' &&
      (manifest.name !== CLI_NAME || manifest.bin?.xgg !== './dist/cli.js')
    ) {
      inspectionRoot = supplied;
      manifest = await readManifest(io, inspectionRoot);
    }
    if (manifest.name !== CLI_NAME || manifest.bin?.xgg !== './dist/cli.js') {
      return {
        supported: false,
        packageRoot: root,
        reason:
          'Only the published npm global CLI can self-update; source checkouts must use git/pnpm.',
      };
    }
    if (await io.isSymbolicLink(inspectionRoot)) {
      return {
        supported: false,
        packageRoot: root,
        reason: 'Linked installations must be updated using their original package manager.',
      };
    }
    const realRoot = exists
      ? await io.realpath(root)
      : join(await io.realpath(dirname(root)), basename(root));
    if (/(^|[\\/])(?:_npx|\.pnpm)([\\/]|$)/.test(realRoot)) {
      return {
        supported: false,
        packageRoot: realRoot,
        reason: 'npx and pnpm installations must be updated using their original package manager.',
      };
    }
    const npm = await npmScript(options);
    const global = await run(execPath, [npm, 'root', '--global'], { env, timeoutMs: 10000 });
    const globalModules = await io.realpath(global.stdout.trim());
    if (realRoot !== join(globalModules, '@eyaeya', 'xgg-cli')) {
      return {
        supported: false,
        packageRoot: realRoot,
        reason:
          'This is not the active npm global installation. Update it with its original package manager and prefix.',
      };
    }
    return { supported: true, packageRoot: realRoot };
  } catch {
    return {
      supported: false,
      packageRoot: root,
      reason:
        'Cannot verify the active npm global installation. Check npm and prefix permissions; no files were changed.',
    };
  }
}

interface LockOwner {
  pid: number;
  token: string;
}

async function acquireLock(root: string, options: InstallOptions): Promise<() => Promise<void>> {
  const { io, alive, pid } = runtime(options);
  const path = join(dirname(root), '.xgg-cli-update.lock');
  const reclaim = `${path}.reclaim`;
  const token = randomUUID();
  const ownerPath = join(path, 'owner.json');
  const readOwner = async (): Promise<LockOwner | undefined> => {
    try {
      const owner = JSON.parse(await io.readFile(ownerPath)) as Partial<LockOwner>;
      if (
        Number.isSafeInteger(owner.pid) &&
        Number(owner.pid) > 0 &&
        typeof owner.token === 'string'
      ) {
        return owner as LockOwner;
      }
    } catch {
      /* A creator may still be writing the owner: fail closed. */
    }
    return undefined;
  };
  const busy = () =>
    new UpdateInstallError(
      'Another update owns this installation lock. Wait for it to finish; an incomplete lock needs manual inspection.',
      false,
    );
  if (await io.exists(reclaim)) throw busy();
  try {
    await io.mkdir(path);
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
    const owner = await readOwner();
    if (!owner || alive(owner.pid)) throw busy();
    // Only one stale-owner recovery at a time. Recheck after acquiring the guard.
    try {
      await io.mkdir(reclaim);
    } catch {
      throw busy();
    }
    try {
      const current = await readOwner();
      if (!current || current.token !== owner.token || alive(current.pid)) throw busy();
      await io.remove(path);
      await io.mkdir(path);
      await io.writeFile(ownerPath, JSON.stringify({ pid, token }));
    } finally {
      await io.remove(reclaim);
    }
  }
  // If a reclaimer raced our initial mkdir, retaining our new live owner still
  // makes its second owner check fail closed.
  await io.writeFile(ownerPath, JSON.stringify({ pid, token }));
  return async () => {
    if ((await readOwner())?.token === token) await io.remove(path);
  };
}

function validateRelease(release: Release): void {
  if (
    !/^\d+\.\d+\.\d+$/.test(release.version) ||
    !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(release.integrity)
  ) {
    throw new Error(
      'Update requires a stable version and SHA-512 integrity from trusted registry metadata.',
    );
  }
  for (const raw of [release.registry, release.tarball]) {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
      throw new Error('Update registry and tarball must use HTTPS without embedded credentials.');
    }
  }
}

async function smoke(root: string, version: string, options: InstallOptions): Promise<void> {
  const { io, run, execPath, env } = runtime(options);
  const manifest = await readManifest(io, root);
  const core = await readManifest(io, join(root, 'node_modules/@eyaeya/xgg-core'));
  if (
    manifest.name !== CLI_NAME ||
    manifest.version !== version ||
    manifest.bin?.xgg !== './dist/cli.js' ||
    core.name !== CORE_NAME ||
    core.version !== version
  ) {
    throw new Error('Staged CLI/core identity or exact release version did not match.');
  }
  const binary = join(root, 'dist/cli.js');
  const actual = await run(execPath, [binary, '--version'], { env, timeoutMs: 15000 });
  if (actual.stdout.trim() !== version) throw new Error('Updated CLI version smoke check failed.');
  const help = await run(execPath, [binary, '--help'], { env, timeoutMs: 15000 });
  if (!/Usage:.*xgg/i.test(help.stdout)) throw new Error('Updated CLI help smoke check failed.');
}

export async function installUpdate(
  release: Release,
  options: InstallOptions = {},
): Promise<{ version: string; previousVersion: string; packageRoot: string }> {
  validateRelease(release);
  const detected = await detectInstall(options.packageRoot ?? ownRoot, options);
  if (!detected.supported)
    throw new UpdateInstallError(detected.reason ?? 'Unsupported installation.', false);
  const root = detected.packageRoot;
  const { io, run, execPath, env } = runtime(options);
  const unlock = await acquireLock(root, options);
  const backup = join(dirname(root), '.xgg-cli-previous');
  let stage: string | undefined;
  let movedOld = false;
  let movedNew = false;
  let recoveryNeeded = false;
  try {
    if (await io.exists(backup)) {
      recoveryNeeded = true;
      if ((await io.isSymbolicLink(backup)) || (await io.realpath(backup)) !== backup) {
        throw new Error('Recovery package must be a real sibling directory.');
      }
      if (!(await io.exists(root))) {
        const previous = await readManifest(io, backup);
        if (!previous.version) throw new Error('Invalid recovery package.');
        await smoke(backup, previous.version, options);
        await io.rename(backup, root);
      } else {
        // A crash after activation leaves both copies. If activation failed,
        // restore the preserved old copy before any new staging attempt.
        try {
          const current = await readManifest(io, root);
          if (!current.version) throw new Error('Missing installed version.');
          await smoke(root, current.version, options);
        } catch {
          const previous = await readManifest(io, backup);
          if (previous.name !== CLI_NAME || !previous.version)
            throw new Error('Invalid recovery package.');
          await smoke(backup, previous.version, options);
          await io.remove(root);
          await io.rename(backup, root);
        }
        if (await io.exists(backup)) await io.remove(backup);
      }
      recoveryNeeded = false;
    }
    const previous = await readManifest(io, root);
    if (!previous.version || !/^\d+\.\d+\.\d+$/.test(previous.version))
      throw new Error('Installed version is not a stable release.');
    const left = release.version.split('.').map(Number);
    const right = previous.version.split('.').map(Number);
    const firstDifference = left.findIndex((value, index) => value !== right[index]);
    if (firstDifference < 0 || (left[firstDifference] ?? 0) < (right[firstDifference] ?? 0)) {
      throw new Error('Refusing to replace this installation with an equal or older version.');
    }
    const npm = await npmScript(options);
    stage = await io.mkdtemp(join(dirname(root), '.xgg-cli-stage-'));
    await io.writeFile(
      join(stage, 'package.json'),
      JSON.stringify({
        name: 'xgg-update-stage',
        version: '1.0.0',
        private: true,
        overrides: { [CORE_NAME]: release.version },
      }),
    );
    await run(
      execPath,
      [
        npm,
        'install',
        '--prefix',
        stage,
        '--global=false',
        '--workspaces=false',
        '--ignore-scripts',
        '--engine-strict',
        '--force=false',
        '--install-strategy=nested',
        '--package-lock=true',
        '--audit=false',
        '--fund=false',
        '--bin-links=false',
        '--fetch-retries=0',
        '--fetch-timeout=15000',
        '--registry',
        release.registry,
        `--@eyaeya:registry=${release.registry}`,
        release.tarball,
      ],
      { env, cwd: stage, timeoutMs: 120_000 },
    );
    const lock = JSON.parse(await io.readFile(join(stage, 'package-lock.json'))) as {
      packages?: Record<string, { version?: string; integrity?: string; resolved?: string }>;
    };
    const entry = lock.packages?.[`node_modules/${CLI_NAME}`];
    if (
      entry?.version !== release.version ||
      entry.integrity !== release.integrity ||
      entry.resolved !== release.tarball
    ) {
      throw new Error(
        'Downloaded CLI version, source or integrity does not match the selected release.',
      );
    }
    const stagedRoot = join(stage, 'node_modules/@eyaeya/xgg-cli');
    await smoke(stagedRoot, release.version, options);
    if ((await readManifest(io, root)).version !== previous.version) {
      throw new Error('Installed CLI changed during staging; update stopped without replacing it.');
    }
    await io.rename(root, backup);
    movedOld = true;
    await io.rename(stagedRoot, root);
    movedNew = true;
    await smoke(root, release.version, options);
    // The new package is committed. A backup-cleanup failure must never delete
    // the working new package and attempt rollback from a partly removed copy.
    movedOld = false;
    await io.remove(backup).catch(() => undefined);
    return { version: release.version, previousVersion: previous.version, packageRoot: root };
  } catch (error) {
    if (movedOld) {
      try {
        if (movedNew) await io.remove(root);
        await io.rename(backup, root);
        movedOld = false;
      } catch {
        throw new UpdateInstallError(
          'Update activation and rollback failed. The previous package is preserved at the sibling .xgg-cli-previous directory; restore it before retrying.',
          false,
          true,
        );
      }
    }
    if (error instanceof UpdateInstallError) throw error;
    if (recoveryNeeded) {
      throw new UpdateInstallError(
        'Interrupted update recovery failed. Preserve the sibling .xgg-cli-previous directory and restore it before retrying.',
        false,
        true,
      );
    }
    const code = errorCode(error);
    const message = code
      ? `Update filesystem operation failed (${/^[A-Z0-9_-]{1,40}$/i.test(code) ? code : 'unknown'}). Check prefix permissions.`
      : error instanceof Error
        ? error.message.slice(0, 350)
        : 'Update staging failed.';
    throw new UpdateInstallError(message, true);
  } finally {
    if (stage) await io.remove(stage).catch(() => undefined);
    await unlock().catch(() => undefined);
  }
}
