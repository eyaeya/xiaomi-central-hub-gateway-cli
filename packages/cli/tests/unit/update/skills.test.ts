import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type SkillFileSystem, syncInstalledSkills } from '../../../src/update/skills.js';

const NAME = 'xgg-rule-authoring';
const ROOT = '/prefix/lib/node_modules/@eyaeya/xgg-cli';
const SOURCE = `${ROOT}/skills/${NAME}`;
const HOME = '/user';
const TARGET = `${HOME}/.agents/skills/${NAME}`;

function coded(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

class MemoryFs implements SkillFileSystem {
  files = new Map<string, Buffer | null>([['/', null]]);
  links = new Map<string, string>();
  renames: Array<[string, string]> = [];
  failRename?: ((from: string, to: string) => boolean) | undefined;
  failRemove?: ((path: string) => boolean) | undefined;
  denyMkdir?: (path: string) => boolean;
  afterRename?: (from: string, to: string) => void;
  beforeWrite?: (path: string) => void;
  beforeRead?: (path: string) => void;
  failReaddir?: (path: string) => boolean;
  add(path: string, value: Buffer | string | null = null): void {
    if (path !== '/' && !this.files.has(dirname(path))) this.add(dirname(path));
    this.files.set(path, typeof value === 'string' ? Buffer.from(value) : value);
  }
  resolved(input: string, followLeaf = true, depth = 0): string {
    if (depth > 20) throw coded('ELOOP');
    const path = resolve(input);
    for (const [link, target] of this.links) {
      if ((followLeaf && path === link) || path.startsWith(`${link}/`)) {
        return this.resolved(
          `${resolve(dirname(link), target)}${path.slice(link.length)}`,
          followLeaf,
          depth + 1,
        );
      }
    }
    return path;
  }
  async lstat(input: string): Promise<{ kind: 'file' | 'directory' | 'link'; size: number }> {
    const path = this.resolved(input, false);
    let ancestor = dirname(path);
    while (ancestor !== '/') {
      if (this.files.has(ancestor) && this.files.get(ancestor) !== null) throw coded('ENOTDIR');
      ancestor = dirname(ancestor);
    }
    if (this.links.has(path)) return { kind: 'link', size: 0 };
    if (!this.files.has(path)) throw coded('ENOENT');
    const value = this.files.get(path);
    return { kind: value === null ? 'directory' : 'file', size: value?.length ?? 0 };
  }
  async readdir(input: string): Promise<string[]> {
    const path = this.resolved(input);
    if (this.failReaddir?.(path)) throw coded('EACCES');
    if (!this.files.has(path)) throw coded('ENOENT');
    if (this.files.get(path) !== null) throw coded('ENOTDIR');
    return [
      ...new Set(
        [...this.files.keys(), ...this.links.keys()]
          .filter((key) => key !== path && dirname(key) === path)
          .map((key) => basename(key)),
      ),
    ];
  }
  async readFile(path: string): Promise<Buffer> {
    this.beforeRead?.(path);
    const bytes = this.files.get(this.resolved(path));
    if (!bytes) throw coded('ENOENT');
    return Buffer.from(bytes);
  }
  async readlink(path: string): Promise<string> {
    const target = this.links.get(this.resolved(path, false));
    if (target === undefined) throw coded('EINVAL');
    return target;
  }
  async writeFile(input: string, bytes: Buffer): Promise<void> {
    this.beforeWrite?.(input);
    const path = this.resolved(input);
    if (this.files.get(dirname(path)) !== null) throw coded('ENOENT');
    this.files.set(path, Buffer.from(bytes));
  }
  async realpath(path: string): Promise<string> {
    const real = this.resolved(path);
    if (!this.files.has(real)) throw coded('ENOENT');
    return real;
  }
  async mkdir(input: string, recursive = false): Promise<void> {
    const path = this.resolved(input);
    if (this.denyMkdir?.(path)) throw coded('EACCES');
    if (this.files.has(path)) {
      if (recursive && this.files.get(path) === null) return;
      throw coded('EEXIST');
    }
    if (!recursive && this.files.get(dirname(path)) !== null) throw coded('ENOENT');
    this.add(path);
  }
  async rename(from: string, to: string): Promise<void> {
    this.renames.push([from, to]);
    if (this.failRename?.(from, to)) throw coded('EACCES');
    if (!this.files.has(from)) throw coded('ENOENT');
    if (this.files.has(to)) throw coded('EEXIST');
    if (this.files.get(dirname(to)) !== null) throw coded('ENOENT');
    for (const [path, value] of [...this.files]) {
      if (path === from || path.startsWith(`${from}/`)) {
        this.files.delete(path);
        this.files.set(`${to}${path.slice(from.length)}`, value);
      }
    }
    this.afterRename?.(from, to);
  }
  async remove(path: string): Promise<void> {
    if (this.failRemove?.(path)) throw coded('EACCES');
    for (const key of this.files.keys()) {
      if (key === path || key.startsWith(`${path}/`)) this.files.delete(key);
    }
  }
  snapshot(root: string): Record<string, string> {
    return Object.fromEntries(
      [...this.files]
        .filter(([key, bytes]) => key.startsWith(`${root}/`) && bytes !== null)
        .map(([key, bytes]) => [key.slice(root.length + 1), bytes?.toString('base64') ?? '']),
    );
  }
}

function fixture(version: string, extras: Record<string, string> = {}): Record<string, string> {
  const files = {
    'SKILL.md': `---\nname: ${NAME}\ndescription: Test\n---\n\n本指南随 xgg v${version} 发布。\n`,
    'references/guide.md': `Guide ${version}\n`,
    ...extras,
  };
  const hash = createHash('sha256');
  for (const [name, text] of Object.entries(files).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const bytes = Buffer.from(text);
    hash.update(name).update('\0').update(String(bytes.length)).update('\0').update(bytes);
  }
  files['SKILL.md'] += `<!-- xgg-skill-content-build: sha256-${hash.digest('hex')} -->\n`;
  return files;
}

function put(io: MemoryFs, root: string, files: Record<string, string>): void {
  for (const [name, bytes] of Object.entries(files)) io.add(join(root, name), bytes);
}

function harness() {
  const io = new MemoryFs();
  io.add(HOME);
  io.add('/project');
  io.add(`${ROOT}/package.json`, JSON.stringify({ version: '3.2.1' }));
  put(io, SOURCE, fixture('3.2.1', { 'references/new.md': 'New bundled guide\n' }));
  let serial = 0;
  const options = {
    fs: io,
    packageRoot: ROOT,
    home: HOME,
    cwd: '/project',
    env: {},
    pid: 123,
    isProcessAlive: () => false,
    token: () => `test-${++serial}`,
  };
  return { io, options, run: () => syncInstalledSkills(options) };
}

describe('installed Agent Skill synchronization', () => {
  it('does not create registrations when the Skill has never been installed', async () => {
    const h = harness();
    expect(await h.run()).toMatchObject({ status: 'not-installed', updatedPaths: [], issues: [] });
    expect(h.io.renames).toEqual([]);
    expect(h.io.files.has(TARGET)).toBe(false);
  });

  it('ignores ordinary home and configuration dotfiles instead of reporting false partial failures', async () => {
    const h = harness();
    put(h.io, TARGET, fixture('3.2.1', { 'references/new.md': 'New bundled guide\n' }));
    h.io.add(`${HOME}/.zshrc`, 'shell settings');
    h.io.add(`${HOME}/.npmrc`, 'npm settings');
    h.io.add(`${HOME}/.gitconfig`, 'git settings');
    h.io.add(`${HOME}/.config/plain-file`, 'ordinary configuration');
    h.io.add(`${HOME}/.cursor`, 'not an Agent directory');
    h.io.add('/project/.claude', 'not a project Agent directory');
    expect(await h.run()).toMatchObject({ status: 'current', issues: [], updatedPaths: [] });
  });

  it('reports genuine discovery permission failures while updating other accessible targets', async () => {
    const h = harness();
    put(h.io, TARGET, fixture('3.2.0'));
    h.io.add(`${HOME}/.config`);
    h.io.failReaddir = (path) => path === `${HOME}/.config`;
    const result = await h.run();
    expect(result.status).toBe('partial');
    expect(result.updatedPaths).toEqual([TARGET]);
    expect(result.issues).toEqual([
      {
        path: `${HOME}/.config`,
        reason: 'Additional Agent Skill locations could not be inspected.',
      },
    ]);
  });

  it('replaces the complete old tree offline and retains an exact backup outside skills', async () => {
    const h = harness();
    put(h.io, TARGET, fixture('3.2.0', { 'references/obsolete.md': 'Old\n' }));
    const before = h.io.snapshot(TARGET);
    const result = await h.run();
    expect(result).toMatchObject({
      status: 'updated',
      updatedPaths: [TARGET],
      issues: [],
      backups: [{ path: TARGET, customized: false }],
    });
    expect(h.io.snapshot(TARGET)).toEqual(h.io.snapshot(SOURCE));
    const backup = result.backups[0]?.backupPath as string;
    expect(backup).not.toContain('/skills/');
    expect(h.io.snapshot(backup)).toEqual(before);
    expect(await h.run()).toMatchObject({ status: 'current', updatedPaths: [], issues: [] });
  });

  it('backs up customized published content including binary extras before replacement', async () => {
    const h = harness();
    put(h.io, TARGET, fixture('3.2.0'));
    h.io.add(`${TARGET}/references/guide.md`, 'User customization');
    h.io.add(`${TARGET}/private.bin`, Buffer.from([0, 255, 17]));
    const before = h.io.snapshot(TARGET);
    const result = await h.run();
    expect(result.backups[0]?.customized).toBe(true);
    expect(h.io.snapshot(result.backups[0]?.backupPath as string)).toEqual(before);
    expect(h.io.snapshot(TARGET)).toEqual(h.io.snapshot(SOURCE));
  });

  it('preserves top-level aliases and updates their real target only once', async () => {
    const h = harness();
    put(h.io, TARGET, fixture('3.2.0'));
    h.io.add(`${HOME}/.claude/skills`);
    h.io.links.set(`${HOME}/.claude/skills/${NAME}`, TARGET);
    h.io.add(`${HOME}/.config/opencode/skills`);
    h.io.links.set(`${HOME}/.config/opencode/skills/${NAME}`, TARGET);
    const result = await h.run();
    expect(result.updatedPaths).toEqual([TARGET]);
    expect(result.backups).toHaveLength(1);
    expect(h.io.links.size).toBe(2);
    expect(h.io.snapshot(TARGET)).toEqual(h.io.snapshot(SOURCE));
  });

  it('resolves a relative leaf alias against its real parent and leaves the lexical lookalike untouched', async () => {
    const h = harness();
    const actual = `/shared/releases/${NAME}`;
    const lookalike = `${HOME}/.claude/releases/${NAME}`;
    put(h.io, actual, fixture('3.2.0'));
    put(h.io, lookalike, fixture('3.2.0', { 'references/local.md': 'Keep lexical copy' }));
    const before = h.io.snapshot(lookalike);
    h.io.add('/shared/skills');
    h.io.links.set(`${HOME}/.claude/skills`, '/shared/skills');
    h.io.links.set(`/shared/skills/${NAME}`, `../releases/${NAME}`);
    const result = await h.run();
    expect(result.status).toBe('updated');
    expect(result.updatedPaths).toEqual([actual]);
    expect(h.io.snapshot(actual)).toEqual(h.io.snapshot(SOURCE));
    expect(h.io.snapshot(lookalike)).toEqual(before);
    expect(h.io.links.get(`${HOME}/.claude/skills`)).toBe('/shared/skills');
    expect(h.io.links.get(`/shared/skills/${NAME}`)).toBe(`../releases/${NAME}`);
  });

  it('discovers custom configuration roots and an explicit directory without network metadata', async () => {
    const h = harness();
    const custom = `/custom/codex/skills/${NAME}`;
    const explicit = `/registered/${NAME}`;
    put(h.io, custom, fixture('3.2.0'));
    put(h.io, explicit, fixture('3.2.0'));
    const result = await syncInstalledSkills({
      ...h.options,
      env: { CODEX_HOME: '/custom/codex', XGG_SKILL_DIRS: '/registered' },
    });
    expect(result.updatedPaths.sort()).toEqual([custom, explicit].sort());
  });

  it('keeps custom-layout backups under the writable target parent, not its parent account directory', async () => {
    const h = harness();
    const custom = `${HOME}/${NAME}`;
    put(h.io, custom, fixture('3.2.0'));
    h.io.denyMkdir = (path) => path.startsWith('/.xgg-skill-backups');
    const result = await syncInstalledSkills({ ...h.options, env: { XGG_SKILL_DIRS: custom } });
    expect(result.status).toBe('updated');
    expect(result.backups[0]?.backupPath.startsWith(`${HOME}/.xgg-skill-backups/`)).toBe(true);
    expect(h.io.snapshot(custom)).toEqual(h.io.snapshot(SOURCE));
  });

  it('finds a project ancestor registration but preserves the development Skill without a marker', async () => {
    const h = harness();
    h.io.add('/project/.git');
    h.io.add('/project/src/nested');
    const projectSkill = `/project/.agents/skills/${NAME}`;
    const development = `/project/.claude/skills/${NAME}`;
    put(h.io, projectSkill, fixture('3.2.0'));
    put(h.io, development, { 'SKILL.md': `---\nname: ${NAME}\n---\nDevelopment source\n` });
    const before = h.io.snapshot(development);
    const result = await syncInstalledSkills({ ...h.options, cwd: '/project/src/nested' });
    expect(result.status).toBe('partial');
    expect(result.updatedPaths).toEqual([projectSkill]);
    expect(result.issues[0]?.reason).toContain('Unrecognized');
    expect(h.io.snapshot(development)).toEqual(before);
  });

  it('does not downgrade a newer external Skill while an older CLI checks the registry', async () => {
    const h = harness();
    put(h.io, TARGET, fixture('3.3.0'));
    const before = h.io.snapshot(TARGET);
    const result = await h.run();
    expect(result.status).toBe('partial');
    expect(result.issues[0]?.reason).toContain('newer');
    expect(h.io.snapshot(TARGET)).toEqual(before);
    expect(h.io.renames).toEqual([]);
  });

  it('refuses invalid bundled content before writing any installed target', async () => {
    const h = harness();
    put(h.io, TARGET, fixture('3.2.0'));
    h.io.add(`${SOURCE}/references/guide.md`, 'Corrupted');
    const result = await h.run();
    expect(result).toMatchObject({ status: 'partial', updatedPaths: [], backups: [] });
    expect(result.issues[0]?.reason).toContain('digest');
    expect(h.io.renames).toEqual([]);
  });

  it('refuses a valid bundled tree carrying a different release version', async () => {
    const h = harness();
    put(h.io, TARGET, fixture('3.2.0'));
    h.io.add(`${ROOT}/package.json`, JSON.stringify({ version: '3.2.2' }));
    const result = await h.run();
    expect(result.status).toBe('partial');
    expect(result.issues[0]?.reason).toContain('version');
    expect(h.io.renames).toEqual([]);
  });

  it('refuses a bundled tree whose ancestor link leads outside the installed package', async () => {
    const h = harness();
    put(h.io, `/external/${NAME}`, fixture('3.2.1'));
    h.io.links.set(`${ROOT}/skills`, '/external');
    const result = await h.run();
    expect(result.issues[0]?.reason).toContain('contained');
    expect(h.io.renames).toEqual([]);
  });

  it('refuses internal symlinks without following or replacing their content', async () => {
    const h = harness();
    put(h.io, TARGET, fixture('3.2.0'));
    h.io.links.set(`${TARGET}/references/outside.md`, '/private/file');
    const result = await h.run();
    expect(result.issues[0]?.reason).toContain('internal link');
    expect(h.io.renames).toEqual([]);
  });

  it('keeps an alias to the validated npm bundle current without copying or locking', async () => {
    const h = harness();
    h.io.add(`${HOME}/.agents/skills`);
    h.io.links.set(TARGET, SOURCE);
    const result = await h.run();
    expect(result.status).toBe('current');
    expect(result.issues).toEqual([]);
    expect(h.io.renames).toEqual([]);
  });

  it('refuses aliases into other directories within the CLI package', async () => {
    const h = harness();
    const internal = `${ROOT}/other/${NAME}`;
    put(h.io, internal, fixture('3.2.0'));
    h.io.add(`${HOME}/.agents/skills`);
    h.io.links.set(TARGET, internal);
    const result = await h.run();
    expect(result.issues[0]?.reason).toContain('overlaps');
    expect(h.io.renames).toEqual([]);
  });

  it('detects a target edit during staging and preserves the concurrent edit', async () => {
    const h = harness();
    put(h.io, TARGET, fixture('3.2.0'));
    h.io.beforeWrite = (path) => {
      if (path.includes('.xgg-skill-stage-'))
        h.io.add(`${TARGET}/references/guide.md`, 'Concurrent edit');
    };
    const result = await h.run();
    expect(result.issues[0]?.reason).toContain('changed during staging');
    expect((await h.io.readFile(`${TARGET}/references/guide.md`)).toString()).toBe(
      'Concurrent edit',
    );
    expect(h.io.renames).toEqual([]);
  });

  it('restores the complete old tree if stage activation fails', async () => {
    const h = harness();
    put(h.io, TARGET, fixture('3.2.0'));
    const before = h.io.snapshot(TARGET);
    h.io.failRename = (from, to) => from.includes('.xgg-skill-stage-') && to === TARGET;
    const result = await h.run();
    expect(result.status).toBe('partial');
    expect(result.updatedPaths).toEqual([]);
    expect(h.io.snapshot(TARGET)).toEqual(before);
    expect([...h.io.files.keys()].some((path) => path.endsWith('.lock'))).toBe(false);
  });

  it('restores old content and retains the failed active tree if readback detects corruption', async () => {
    const h = harness();
    put(h.io, TARGET, fixture('3.2.0'));
    const before = h.io.snapshot(TARGET);
    h.io.afterRename = (from, to) => {
      if (from.includes('.xgg-skill-stage-') && to === TARGET)
        h.io.add(`${TARGET}/references/guide.md`, 'Bad readback');
    };
    const result = await h.run();
    expect(result.status).toBe('partial');
    expect(h.io.snapshot(TARGET)).toEqual(before);
    expect(
      [...h.io.files.keys()].some((path) => path.endsWith('-failed/references/guide.md')),
    ).toBe(true);
  });

  it('recovers a missing registration from an interrupted activation without losing the old backup', async () => {
    const h = harness();
    put(h.io, TARGET, fixture('3.2.0'));
    h.io.add(`${HOME}/.claude/skills`);
    h.io.links.set(`${HOME}/.claude/skills/${NAME}`, TARGET);
    const before = h.io.snapshot(TARGET);
    h.io.failRename = (_from, to) => to === TARGET;
    const failed = await h.run();
    expect(failed.status).toBe('partial');
    expect(failed.issues[0]?.reason).toContain('rollback failed');
    expect(h.io.files.has(TARGET)).toBe(false);
    h.io.failRename = undefined;
    const recovered = await syncInstalledSkills({ ...h.options, pid: 456 });
    expect(recovered.status).toBe('updated');
    expect(h.io.snapshot(TARGET)).toEqual(h.io.snapshot(SOURCE));
    expect(h.io.snapshot(recovered.backups.at(-1)?.backupPath as string)).toEqual(before);
    expect(h.io.links.get(`${HOME}/.claude/skills/${NAME}`)).toBe(TARGET);
  });

  it('recovers an absent external target reached only through a dangling relative alias chain', async () => {
    const h = harness();
    const external = `/custom/shared/${NAME}`;
    put(h.io, external, fixture('3.2.0'));
    h.io.add(dirname(TARGET));
    h.io.links.set(TARGET, '/custom/shortcut');
    h.io.links.set('/custom/shortcut', `shared/${NAME}`);
    const before = h.io.snapshot(external);
    h.io.failRename = (_from, to) => to === external;
    const failed = await h.run();
    expect(failed.issues[0]?.reason).toContain('rollback failed');
    expect(h.io.files.has(external)).toBe(false);
    h.io.failRename = undefined;
    const recovered = await syncInstalledSkills({ ...h.options, pid: 456 });
    expect(recovered.status).toBe('updated');
    expect(recovered.updatedPaths).toEqual([external]);
    expect(h.io.snapshot(external)).toEqual(h.io.snapshot(SOURCE));
    expect(h.io.snapshot(recovered.backups[0]?.backupPath as string)).toEqual(before);
    expect(h.io.links.get('/custom/shortcut')).toBe(`shared/${NAME}`);
  });

  it('reports the recovered active version again when a prior process could not finish cleanup', async () => {
    const h = harness();
    put(h.io, TARGET, fixture('3.2.0'));
    h.io.failRemove = (path) => path.endsWith('.lock');
    const interrupted = await h.run();
    expect(interrupted.status).toBe('partial');
    expect(h.io.snapshot(TARGET)).toEqual(h.io.snapshot(SOURCE));
    h.io.failRemove = undefined;
    const recovered = await syncInstalledSkills({ ...h.options, pid: 456 });
    expect(recovered.status).toBe('updated');
    expect(recovered.updatedPaths).toEqual([TARGET]);
    expect(recovered.backups).toEqual(interrupted.backups);
  });

  it('does not steal a live lock or a malformed owner', async () => {
    const h = harness();
    put(h.io, TARGET, fixture('3.2.0'));
    const key = createHash('sha256').update(TARGET).digest('hex').slice(0, 24);
    const lock = `${dirname(TARGET)}/.xgg-skill-${key}.lock`;
    h.io.add(`${lock}/owner.json`, JSON.stringify({ pid: 789, token: 'active' }));
    const busy = await syncInstalledSkills({ ...h.options, isProcessAlive: () => true });
    expect(busy.issues[0]?.reason).toContain('Another process');
    h.io.add(`${lock}/owner.json`, JSON.stringify({ pid: 789 }));
    expect((await h.run()).status).toBe('partial');
    expect(h.io.files.has(lock)).toBe(true);
    expect(h.io.renames).toEqual([]);
  });

  it('retains an existing stage if a token collision prevents exclusive creation', async () => {
    const h = harness();
    put(h.io, TARGET, fixture('3.2.0'));
    const stage = `${dirname(TARGET)}/.xgg-skill-stage-test-1`;
    h.io.add(`${stage}/keep.txt`, 'Uncertain prior operation');
    const result = await h.run();
    expect(result.status).toBe('partial');
    expect((await h.io.readFile(`${stage}/keep.txt`)).toString()).toBe('Uncertain prior operation');
    expect(h.io.renames).toEqual([]);
  });

  it('refuses a symlinked backup base before creating anything through it', async () => {
    const h = harness();
    put(h.io, TARGET, fixture('3.2.0'));
    h.io.add('/other');
    h.io.links.set(`${HOME}/.agents/.xgg-skill-backups`, '/other');
    const result = await h.run();
    expect(result.issues[0]?.reason).toContain('backup path contains a link');
    expect(await h.io.readdir('/other')).toEqual([]);
    expect(h.io.renames).toEqual([]);
  });

  it('continues updating independent targets when one target has a filesystem failure', async () => {
    const h = harness();
    const other = `${HOME}/.cursor/skills/${NAME}`;
    put(h.io, TARGET, fixture('3.2.0'));
    put(h.io, other, fixture('3.2.0'));
    h.io.failRename = (from) => from === TARGET;
    const result = await h.run();
    expect(result.status).toBe('partial');
    expect(result.updatedPaths).toEqual([other]);
    expect(result.issues).toHaveLength(1);
  });
});
