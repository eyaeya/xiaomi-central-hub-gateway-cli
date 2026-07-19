import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('published and repository xgg-rule-authoring Skill mirrors are byte-identical', async () => {
  const [published, repository] = await Promise.all([
    readFile(new URL('../skills/xgg-rule-authoring/SKILL.md', import.meta.url)),
    readFile(new URL('../../../skills/xgg-rule-authoring/SKILL.md', import.meta.url)),
  ]);
  assert.deepEqual(published, repository);
});
