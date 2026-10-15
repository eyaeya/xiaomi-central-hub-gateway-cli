import { createHash, randomUUID } from 'node:crypto';
import * as nativeFs from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = 'xgg-rule-authoring';
const MARKER = /^<!-- xgg-skill-content-build: sha256-([0-9a-f]{64}) -->\r?$/gm;
const MARKER_LINE = /^<!-- xgg-skill-content-build: sha256-[0-9a-f]{64} -->\r?\n?/gm;
const ownRoot = fileURLToPath(new URL('../../', import.meta.url));

/** The entire filesystem boundary is injectable; unit tests use no real files. */
export interface SkillFileSystem {
  lstat(path: string): Promise<{ kind: 'file' | 'directory' | 'link' | 'other'; size: number }>;
  readdir(path: string): Promise<string[]>;
  readFile(path: string): Promise<Buffer>;
  readlink(path: string): Promise<string>;
  writeFile(path: string, bytes: Buffer): Promise<void>;
  realpath(path: string): Promise<string>;
  mkdir(path: string, recursive?: boolean): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface SkillSyncOptions {
  packageRoot?: string;
  home?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  fs?: SkillFileSystem;
  pid?: number;
  isProcessAlive?: (pid: number) => boolean;
  token?: () => string;
}

export interface SkillSyncResult {
  status: 'current' | 'updated' | 'not-installed' | 'partial';
  digest: string;
  updatedPaths: string[];
  backups: Array<{ path: string; backupPath: string; customized: boolean }>;
  issues: Array<{ path: string; reason: string }>;
}

const realFs: SkillFileSystem = {
  lstat: async (path) => {
    const stat = await nativeFs.lstat(path);
    return {
      kind: stat.isSymbolicLink()
        ? 'link'
        : stat.isDirectory()
          ? 'directory'
          : stat.isFile()
            ? 'file'
            : 'other',
      size: stat.size,
    };
  },
  readdir: (path) => nativeFs.readdir(path),
  readFile: (path) => nativeFs.readFile(path),
  readlink: (path) => nativeFs.readlink(path),
  writeFile: (path, bytes) => nativeFs.writeFile(path, bytes, { mode: 0o600 }),
  realpath: (path) => nativeFs.realpath(path),
  mkdir: async (path, recursive = false) => {
    await nativeFs.mkdir(path, { recursive, mode: 0o700 });
  },
  rename: (from, to) => nativeFs.rename(from, to),
  remove: (path) => nativeFs.rm(path, { recursive: true, force: true }),
};

function code(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

function missing(error: unknown): boolean {
  return code(error) === 'ENOENT' || code(error) === 'ENOTDIR';
}

class SkillProblem extends Error {}

async function exists(io: SkillFileSystem, path: string): Promise<boolean> {
  try {
    await io.lstat(path);
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

async function resolveRoot(
  io: SkillFileSystem,
  entry: string,
): Promise<{ target: string; present: boolean }> {
  let cursor = entry;
  for (let depth = 0; depth < 16; depth += 1) {
    let stat: Awaited<ReturnType<SkillFileSystem['lstat']>>;
    try {
      stat = await io.lstat(cursor);
    } catch (error) {
      if (!missing(error)) throw error;
      // Follow a dangling registration to the exact absent leaf so its journal
      // can restore it, even when that leaf is outside conventional Agent roots.
      return {
        target: join(await io.realpath(dirname(cursor)), basename(cursor)),
        present: false,
      };
    }
    if (stat.kind !== 'link') return { target: await io.realpath(cursor), present: true };
    // Relative leaf links are relative to their physical parent directory,
    // which may itself be reached through a different Agent directory alias.
    cursor = resolve(await io.realpath(dirname(cursor)), await io.readlink(cursor));
  }
  throw new SkillProblem('Skill alias chain exceeds the safe limit; preserved.');
}

function overlap(left: string, right: string): boolean {
  const distance = relative(left, right);
  return distance === '' || (!distance.startsWith('..') && !isAbsolute(distance));
}

function hashFiles(files: Map<string, Buffer>, stripMarker: boolean): string {
  const hash = createHash('sha256');
  for (const name of [...files.keys()].sort()) {
    let bytes = files.get(name) as Buffer;
    if (stripMarker && name === 'SKILL.md') {
      bytes = Buffer.from(bytes.toString('utf8').replace(MARKER_LINE, ''), 'utf8');
    }
    hash.update(name).update('\0').update(String(bytes.length)).update('\0').update(bytes);
  }
  return hash.digest('hex');
}

interface Tree {
  files: Map<string, Buffer>;
  digest: string;
  fingerprint: string;
  marker: string;
  version?: string;
}

async function readTree(io: SkillFileSystem, root: string): Promise<Tree> {
  if ((await io.lstat(root)).kind !== 'directory') {
    throw new SkillProblem('Skill target must resolve to a real directory.');
  }
  const files = new Map<string, Buffer>();
  let totalBytes = 0;
  const walk = async (prefix: string, depth: number): Promise<void> => {
    if (depth > 12) throw new SkillProblem('Skill tree exceeds the safe traversal limit.');
    const entries = await io.readdir(join(root, prefix));
    if (entries.length > 1024) throw new SkillProblem('Skill tree exceeds the safe file limit.');
    for (const entry of entries.sort()) {
      if (!entry || entry === '.' || entry === '..' || /[/\\\0]/.test(entry)) {
        throw new SkillProblem('Skill tree contains an unsafe entry name.');
      }
      const name = prefix ? `${prefix}/${entry}` : entry;
      const stat = await io.lstat(join(root, name));
      if (stat.kind === 'directory') await walk(name, depth + 1);
      else if (stat.kind === 'file') {
        totalBytes += stat.size;
        if (files.size >= 1024 || totalBytes > 16 * 1024 * 1024) {
          throw new SkillProblem('Skill tree exceeds the safe size limit.');
        }
        const bytes = await io.readFile(join(root, name));
        if (bytes.length !== stat.size) throw new SkillProblem('Skill changed during inspection.');
        files.set(name, bytes);
      } else throw new SkillProblem('Skill tree contains an internal link or non-regular file.');
    }
  };
  await walk('', 0);
  const skill = files.get('SKILL.md')?.toString('utf8') ?? '';
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(skill)?.[1] ?? '';
  const markers = [...skill.matchAll(MARKER)];
  if (!/^name:\s*xgg-rule-authoring\s*$/m.test(frontmatter) || markers.length !== 1) {
    throw new SkillProblem(
      'Unrecognized Skill identity or missing published build marker; preserved.',
    );
  }
  const version = /^本指南随 xgg v(\d+\.\d+\.\d+) 发布/m.exec(skill)?.[1];
  return {
    files,
    digest: hashFiles(files, true),
    fingerprint: hashFiles(files, false),
    marker: markers[0]?.[1] as string,
    ...(version ? { version } : {}),
  };
}

function newer(left: string, right: string): boolean {
  const a = left.split('.').map(BigInt);
  const b = right.split('.').map(BigInt);
  const index = a.findIndex((value, i) => value !== b[i]);
  return index >= 0 && (a[index] as bigint) > (b[index] as bigint);
}

async function discoveredPaths(
  io: SkillFileSystem,
  home: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  issues: SkillSyncResult['issues'],
): Promise<string[]> {
  const paths = new Set<string>();
  const addRoot = (root: string) => paths.add(join(root, NAME));
  const config = env.XDG_CONFIG_HOME?.trim() || join(home, '.config');
  for (const root of [
    join(home, '.agents/skills'),
    join(home, '.cursor/skills'),
    join(home, '.gemini/skills'),
    join(home, '.copilot/skills'),
    join(home, '.openclaw/skills'),
    join(env.CODEX_HOME?.trim() || join(home, '.codex'), 'skills'),
    join(env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude'), 'skills'),
    join(home, '.gemini/antigravity/skills'),
    join(home, '.gemini/antigravity-cli/skills'),
    join(home, '.codeium/windsurf/skills'),
    join(home, '.snowflake/cortex/skills'),
    join(home, '.deepagents/agent/skills'),
    join(home, '.tabnine/agent/skills'),
    join(home, '.posit/assistant/skills'),
    join(home, '.astrbot/data/skills'),
    join(config, 'kimchi/harness/skills'),
    join(config, 'agents/skills'),
    join(config, 'opencode/skills'),
  ])
    addRoot(root);
  for (const key of ['VIBE_HOME', 'HERMES_HOME', 'AUTOHAND_HOME', 'GROK_HOME']) {
    if (env[key]?.trim()) addRoot(join(env[key] as string, 'skills'));
  }
  for (const raw of (env.XGG_SKILL_DIRS ?? '').split(delimiter)) {
    if (!raw.trim()) continue;
    const target = resolve(raw.trim());
    paths.add(basename(target) === NAME ? target : join(target, NAME));
  }
  // Bounded directory-name discovery supports other Agent installations without
  // crawling private files or assuming that installing a CLI registers a Skill.
  const children = async (root: string, dotOnly: boolean): Promise<void> => {
    let names: string[];
    try {
      names = await io.readdir(root);
    } catch (error) {
      if (missing(error)) return;
      issues.push({
        path: root,
        reason: 'Additional Agent Skill locations could not be inspected.',
      });
      return;
    }
    if (names.length > 2048) {
      issues.push({
        path: root,
        reason: 'Additional Agent discovery exceeds its directory limit.',
      });
      return;
    }
    for (const name of names) {
      if (name === '.' || name === '..' || /[/\\\0]/.test(name)) continue;
      if (dotOnly && !name.startsWith('.')) continue;
      if (['.git', '.npm', '.cache', '.local', '.Trash'].includes(name)) continue;
      const skillsRoot = join(root, name, 'skills');
      try {
        const stat = await io.lstat(skillsRoot);
        if (stat.kind !== 'directory' && stat.kind !== 'link') continue;
      } catch {
        // An unrelated private application directory is not evidence of an
        // installed Agent Skill. Known and explicitly configured roots remain
        // unconditional candidates and still report their access failures.
        continue;
      }
      addRoot(skillsRoot);
    }
  };
  await children(home, true);
  await children(config, false);
  const ancestors: string[] = [];
  let cursor = cwd;
  let projectFound = false;
  for (let i = 0; i < 32 && cursor !== home; i += 1) {
    ancestors.push(cursor);
    if (
      (await exists(io, join(cursor, '.git'))) ||
      (await exists(io, join(cursor, 'skills-lock.json')))
    ) {
      projectFound = true;
      break;
    }
    if (dirname(cursor) === cursor) break;
    cursor = dirname(cursor);
  }
  for (const root of projectFound ? ancestors : [cwd]) {
    for (const agent of [
      '.agents',
      '.claude',
      '.codex',
      '.cursor',
      '.github',
      '.opencode',
      '.gemini',
      '.windsurf',
    ]) {
      addRoot(join(root, agent, 'skills'));
    }
  }
  return [...paths].map((path) => resolve(path));
}

interface Journal {
  target: string;
  stage: string;
  backup: string;
  before: string;
  after: string;
  customized: boolean;
}

interface Owner {
  pid: number;
  token: string;
  journal?: Journal;
}

async function syncTarget(
  io: SkillFileSystem,
  target: string,
  source: Tree,
  result: SkillSyncResult,
  options: SkillSyncOptions,
): Promise<void> {
  const key = createHash('sha256').update(target).digest('hex').slice(0, 24);
  const lock = join(dirname(target), `.xgg-skill-${key}.lock`);
  const reclaim = `${lock}.reclaim`;
  const parent = dirname(target);
  const backupParent = basename(parent) === 'skills' ? dirname(parent) : parent;
  const archive = join(backupParent, '.xgg-skill-backups', key);
  const ownerFile = join(lock, 'owner.json');
  const pid = options.pid ?? process.pid;
  const token = (options.token ?? randomUUID)();
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(token)) throw new SkillProblem('Invalid Skill update token.');
  const alive =
    options.isProcessAlive ??
    ((value: number) => {
      try {
        process.kill(value, 0);
        return true;
      } catch (error) {
        return code(error) !== 'ESRCH';
      }
    });
  const readOwner = async (): Promise<Owner> => {
    const value = JSON.parse((await io.readFile(ownerFile)).toString('utf8')) as Owner;
    if (
      typeof value !== 'object' ||
      value === null ||
      !Number.isSafeInteger(value.pid) ||
      value.pid < 1 ||
      typeof value.token !== 'string' ||
      !/^[a-zA-Z0-9-]{1,80}$/.test(value.token)
    ) {
      throw new SkillProblem('Incomplete Skill update lock; preserve it for recovery.');
    }
    return value;
  };
  const save = (owner: Owner) => io.writeFile(ownerFile, Buffer.from(JSON.stringify(owner)));
  const recover = async (owner: Owner): Promise<void> => {
    const journal = owner.journal;
    if (!journal) return;
    if (
      journal.target !== target ||
      journal.stage !== join(dirname(target), `.xgg-skill-stage-${owner.token}`) ||
      journal.backup !== join(archive, owner.token) ||
      !/^[0-9a-f]{64}$/.test(journal.before) ||
      !/^[0-9a-f]{64}$/.test(journal.after)
    ) {
      throw new SkillProblem('Invalid Skill recovery journal; preserved for manual recovery.');
    }
    const backupExists = await exists(io, journal.backup);
    const targetExists = await exists(io, target);
    if (backupExists) {
      if ((await io.realpath(archive)) !== archive) {
        throw new SkillProblem('Skill recovery backup path contains a link; preserved.');
      }
      if ((await readTree(io, journal.backup)).fingerprint !== journal.before) {
        throw new SkillProblem('Skill backup changed; preserved for manual recovery.');
      }
      if (!targetExists) await io.rename(journal.backup, target);
      else if ((await readTree(io, target)).fingerprint === journal.after) {
        result.updatedPaths.push(target);
        result.backups.push({
          path: target,
          backupPath: journal.backup,
          customized: journal.customized,
        });
      } else {
        throw new SkillProblem(
          'Interrupted Skill update has conflicting active files; backup preserved.',
        );
      }
    } else if (!targetExists || (await readTree(io, target)).fingerprint !== journal.before) {
      throw new SkillProblem(
        'Interrupted Skill update needs recovery; retained files were not removed.',
      );
    }
    if (await exists(io, journal.stage)) {
      if ((await readTree(io, journal.stage)).fingerprint !== journal.after) {
        throw new SkillProblem('Interrupted Skill stage changed; preserved for manual recovery.');
      }
      await io.remove(journal.stage);
    }
  };
  if (await exists(io, reclaim)) throw new SkillProblem('Another Skill recovery is in progress.');
  try {
    await io.mkdir(lock);
  } catch (error) {
    if (code(error) !== 'EEXIST') throw error;
    if ((await io.lstat(lock)).kind !== 'directory')
      throw new SkillProblem('Unsafe Skill update lock.');
    const owner = await readOwner();
    if (alive(owner.pid)) throw new SkillProblem('Another process is updating this Skill.');
    try {
      await io.mkdir(reclaim);
    } catch {
      throw new SkillProblem('Another Skill recovery is in progress.');
    }
    try {
      const current = await readOwner();
      if (current.token !== owner.token || alive(current.pid))
        throw new SkillProblem('Skill lock ownership changed.');
      await recover(current);
      await io.remove(lock);
      await io.mkdir(lock);
      await save({ pid, token });
    } finally {
      await io.remove(reclaim);
    }
  }
  let retainLock = false;
  let stage: string | undefined;
  let stageOwned = false;
  let moved = false;
  let activated = false;
  let journal: Journal | undefined;
  await save({ pid, token });
  try {
    const old = await readTree(io, target);
    if (old.version && source.version && newer(old.version, source.version)) {
      throw new SkillProblem(
        'Installed Skill is newer than this CLI; preserved without downgrade.',
      );
    }
    if (old.fingerprint === source.fingerprint) return;
    stage = join(dirname(target), `.xgg-skill-stage-${token}`);
    await io.mkdir(stage);
    stageOwned = true;
    for (const [name, bytes] of source.files) {
      await io.mkdir(dirname(join(stage, name)), true);
      await io.writeFile(join(stage, name), bytes);
    }
    if ((await readTree(io, stage)).fingerprint !== source.fingerprint) {
      throw new SkillProblem('Staged Skill did not match the bundled release.');
    }
    if (
      (await readTree(io, target)).fingerprint !== old.fingerprint ||
      (await io.realpath(target)) !== target
    ) {
      throw new SkillProblem('Installed Skill changed during staging; preserved.');
    }
    const archiveBase = dirname(archive);
    for (const path of [archiveBase, archive]) {
      if ((await exists(io, path)) && (await io.realpath(path)) !== path) {
        throw new SkillProblem('Skill backup path contains a link.');
      }
    }
    await io.mkdir(archive, true);
    if ((await io.realpath(archive)) !== archive)
      throw new SkillProblem('Skill backup path contains a link.');
    journal = {
      target,
      stage,
      backup: join(archive, token),
      before: old.fingerprint,
      after: source.fingerprint,
      customized: old.digest !== old.marker,
    };
    if (await exists(io, journal.backup))
      throw new SkillProblem('Skill backup already exists; preserved.');
    await save({ pid, token, journal });
    await io.rename(target, journal.backup);
    moved = true;
    await io.rename(stage, target);
    activated = true;
    if ((await readTree(io, target)).fingerprint !== source.fingerprint) {
      throw new SkillProblem('Activated Skill did not match the bundled release.');
    }
    moved = false;
    result.updatedPaths.push(target);
    result.backups.push({
      path: target,
      backupPath: journal.backup,
      customized: journal.customized,
    });
  } catch (error) {
    if (moved && journal) {
      try {
        if (activated) {
          // Keep the failed active tree as evidence; never discard uncertain files.
          await io.rename(target, `${journal.backup}-failed`);
        }
        await io.rename(journal.backup, target);
      } catch {
        retainLock = true;
        throw new SkillProblem(
          `Skill activation and rollback failed; backup preserved at ${journal.backup}.`,
        );
      }
    }
    throw error;
  } finally {
    if (!retainLock) {
      if (stage && stageOwned) await io.remove(stage).catch(() => undefined);
      if ((await readOwner()).token === token) await io.remove(lock);
    }
  }
}

/** Offline repair only. The caller is responsible for verifying the npm installation. */
export async function syncInstalledSkills(
  options: SkillSyncOptions = {},
): Promise<SkillSyncResult> {
  const io = options.fs ?? realFs;
  const packageRoot = resolve(options.packageRoot ?? ownRoot);
  const sourcePath = join(packageRoot, 'skills', NAME);
  const result: SkillSyncResult = {
    status: 'not-installed',
    digest: '',
    updatedPaths: [],
    backups: [],
    issues: [],
  };
  let source: Tree;
  let realPackage: string;
  try {
    realPackage = await io.realpath(packageRoot);
    if ((await io.realpath(sourcePath)) !== join(realPackage, 'skills', NAME)) {
      throw new SkillProblem('Bundled Skill must be contained in the installed CLI package.');
    }
    source = await readTree(io, sourcePath);
    const manifest = JSON.parse(
      (await io.readFile(join(packageRoot, 'package.json'))).toString('utf8'),
    ) as { version?: string };
    if (source.digest !== source.marker || !source.version || source.version !== manifest.version)
      throw new SkillProblem('Bundled Skill identity, version or content digest is invalid.');
    result.digest = source.digest;
  } catch (error) {
    result.status = 'partial';
    result.issues.push({
      path: sourcePath,
      reason:
        error instanceof SkillProblem
          ? error.message
          : 'Bundled Skill could not be read; no installed Skill was changed.',
    });
    return result;
  }
  let candidates: string[];
  try {
    candidates = await discoveredPaths(
      io,
      resolve(options.home ?? homedir()),
      resolve(options.cwd ?? process.cwd()),
      options.env ?? process.env,
      result.issues,
    );
  } catch (error) {
    result.status = 'partial';
    result.issues.push({
      path: options.home ?? homedir(),
      reason:
        error instanceof SkillProblem
          ? error.message
          : 'Agent Skill locations could not be inspected.',
    });
    return result;
  }
  const seen = new Set<string>();
  let installed = false;
  for (const candidate of candidates) {
    let target = candidate;
    try {
      const registered = await exists(io, candidate);
      let resolved: Awaited<ReturnType<typeof resolveRoot>>;
      try {
        resolved = await resolveRoot(io, candidate);
      } catch (error) {
        if (!registered && missing(error)) continue;
        throw error;
      }
      target = resolved.target;
      if (!resolved.present) {
        const key = createHash('sha256').update(target).digest('hex').slice(0, 24);
        if (!(await exists(io, join(dirname(target), `.xgg-skill-${key}.lock`)))) {
          if (registered)
            throw new SkillProblem(
              'Skill alias target is missing and has no recovery journal; preserved.',
            );
          continue;
        }
      }
      installed = true;
      if (seen.has(target)) continue;
      seen.add(target);
      // A registration linked directly to the validated bundle already follows
      // package activation. Preserve it without creating external copies/locks.
      if (resolved.present && target === join(realPackage, 'skills', NAME)) continue;
      if (
        basename(target) !== NAME ||
        overlap(realPackage, target) ||
        overlap(target, realPackage)
      ) {
        throw new SkillProblem(
          'Skill target overlaps the CLI or has an unsafe resolved path; preserved.',
        );
      }
      // Reject unrelated development Skills before creating any lock directories.
      if (resolved.present) await readTree(io, target);
      await syncTarget(io, target, source, result, options);
    } catch (error) {
      result.issues.push({
        path: target,
        reason:
          error instanceof SkillProblem
            ? error.message
            : 'Skill synchronization failed; inspect permissions and retained recovery files.',
      });
    }
  }
  result.status = result.issues.length
    ? 'partial'
    : result.updatedPaths.length
      ? 'updated'
      : installed
        ? 'current'
        : 'not-installed';
  return result;
}
