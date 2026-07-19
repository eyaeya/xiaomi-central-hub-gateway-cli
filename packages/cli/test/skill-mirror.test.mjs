import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const publishedDir = fileURLToPath(new URL('../skills/xgg-rule-authoring/', import.meta.url));
const repositoryDir = fileURLToPath(
  new URL('../../../skills/xgg-rule-authoring/', import.meta.url),
);

async function listFiles(root, relative = '') {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(root, child)));
    else if (entry.isFile()) files.push(child);
  }
  return files.sort();
}

test('published and repository xgg-rule-authoring Skill directories are byte-identical', async () => {
  const [publishedFiles, repositoryFiles] = await Promise.all([
    listFiles(publishedDir),
    listFiles(repositoryDir),
  ]);
  assert.deepEqual(publishedFiles, repositoryFiles);

  for (const relative of repositoryFiles) {
    const [published, repository] = await Promise.all([
      readFile(path.join(publishedDir, relative)),
      readFile(path.join(repositoryDir, relative)),
    ]);
    assert.deepEqual(published, repository, `${relative} differs between Skill mirrors`);
  }
});

test('Skill entrypoint has a content build marker and minimal frontmatter', async () => {
  const skill = await readFile(path.join(repositoryDir, 'SKILL.md'), 'utf8');
  assert.match(skill, /^<!-- xgg-skill-content-build: [a-zA-Z0-9._-]+ -->$/m);

  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skill);
  assert.ok(frontmatter, 'SKILL.md must start with YAML frontmatter');
  const keys = frontmatter[1]
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => line.slice(0, line.indexOf(':')));
  assert.deepEqual(keys, ['name', 'description']);
  assert.ok(skill.trimEnd().split('\n').length < 500, 'SKILL.md should stay under 500 lines');
  assert.match(skill, /\[references\/node-catalog\.md\]\(references\/node-catalog\.md\)/);
  assert.match(skill, /\[references\/recipes\.md\]\(references\/recipes\.md\)/);
});
