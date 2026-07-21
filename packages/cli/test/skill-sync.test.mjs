import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  checkSkillSync,
  computeSkillTreeDigest,
  writeSkillSync,
} from '../../../scripts/sync-xgg-skill.mjs';

const EMPTY_MARKER = `<!-- xgg-skill-content-build: sha256-${'0'.repeat(64)} -->`;

async function createFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'xgg-skill-sync-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const sourceDir = path.join(root, 'canonical', 'xgg-rule-authoring');
  const packageTargetDir = path.join(root, 'package', 'xgg-rule-authoring');
  const installedTargetDir = path.join(root, 'installed', 'xgg-rule-authoring');
  await mkdir(path.join(sourceDir, 'references'), { recursive: true });
  await writeFile(
    path.join(sourceDir, 'SKILL.md'),
    `---\nname: xgg-rule-authoring\ndescription: fixture\n---\n\n${EMPTY_MARKER}\n\n# Fixture\n`,
  );
  await writeFile(path.join(sourceDir, 'references', 'catalog.md'), '# Catalog\n\nInitial.\n');
  return { installedTargetDir, packageTargetDir, sourceDir };
}

test('reference edits invalidate the full-tree digest and --write repairs every explicit mirror', async (t) => {
  const fixture = await createFixture(t);
  const initialDigest = await writeSkillSync(fixture);
  await checkSkillSync(fixture);

  const referencePath = path.join(fixture.sourceDir, 'references', 'catalog.md');
  await writeFile(referencePath, '# Catalog\n\nChanged reference content.\n');
  const changedDigest = await computeSkillTreeDigest(fixture.sourceDir);
  assert.notEqual(changedDigest, initialDigest, 'a reference edit must change the tree digest');
  await assert.rejects(checkSkillSync(fixture), /Skill build marker is stale/);

  const repairedDigest = await writeSkillSync(fixture);
  assert.equal(repairedDigest, changedDigest);
  await checkSkillSync(fixture);
  const skill = await readFile(path.join(fixture.sourceDir, 'SKILL.md'), 'utf8');
  assert.match(
    skill,
    new RegExp(`^<!-- xgg-skill-content-build: sha256-${changedDigest} -->$`, 'm'),
  );
  for (const targetDir of [fixture.packageTargetDir, fixture.installedTargetDir]) {
    assert.equal(
      await readFile(path.join(targetDir, 'references', 'catalog.md'), 'utf8'),
      '# Catalog\n\nChanged reference content.\n',
    );
  }
});

test('check rejects a tampered package mirror', async (t) => {
  const fixture = await createFixture(t);
  await writeSkillSync(fixture);
  await writeFile(
    path.join(fixture.packageTargetDir, 'references', 'catalog.md'),
    '# Catalog\n\nTampered.\n',
  );
  await assert.rejects(
    checkSkillSync(fixture),
    /Packaged Skill mirror differs from the canonical Skill at references\/catalog\.md/,
  );
});

test('write rejects a broad installed target before touching its files', async (t) => {
  const fixture = await createFixture(t);
  const broadTarget = path.dirname(fixture.installedTargetDir);
  const sentinel = path.join(broadTarget, 'another-skill', 'SKILL.md');
  await mkdir(path.dirname(sentinel), { recursive: true });
  await writeFile(sentinel, '# Must survive\n');

  await assert.rejects(
    writeSkillSync({ ...fixture, installedTargetDir: broadTarget }),
    /Explicit installed Skill target must end in an exact xgg-rule-authoring directory/,
  );
  assert.equal(await readFile(sentinel, 'utf8'), '# Must survive\n');
});

test('write rejects overlapping Skill roots before changing the canonical marker', async (t) => {
  const fixture = await createFixture(t);
  const before = await readFile(path.join(fixture.sourceDir, 'SKILL.md'), 'utf8');

  await assert.rejects(
    writeSkillSync({ ...fixture, installedTargetDir: fixture.packageTargetDir }),
    /packageTargetDir and installedTargetDir must not overlap/,
  );
  assert.equal(await readFile(path.join(fixture.sourceDir, 'SKILL.md'), 'utf8'), before);
});
