import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { NODE_ADD_AUTHORING_FLAG_NAMES } from '../dist/commands/rule/node-add-authoring-flags.js';

const publishedDir = fileURLToPath(new URL('../skills/xgg-rule-authoring/', import.meta.url));
const repositoryDir = fileURLToPath(
  new URL('../../../skills/xgg-rule-authoring/', import.meta.url),
);

const modeledNodeTypes = [
  'deviceInput',
  'deviceGet',
  'deviceOutput',
  'alarmClock',
  'timeRange',
  'delay',
  'statusLast',
  'condition',
  'loop',
  'onlyNTimes',
  'counter',
  'signalOr',
  'logicOr',
  'logicAnd',
  'logicNot',
  'onLoad',
  'eventSequence',
  'register',
  'modeSwitch',
  'deviceInputSetVar',
  'deviceGetSetVar',
  'varChange',
  'varGet',
  'varSetNumber',
  'varSetString',
  'nop',
].sort();

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

test('Skill entrypoint has a content-bound build marker and minimal frontmatter', async () => {
  const skill = await readFile(path.join(repositoryDir, 'SKILL.md'), 'utf8');
  const markerLines = skill
    .split('\n')
    .filter((line) => line.startsWith('<!-- xgg-skill-content-build:'));
  assert.equal(markerLines.length, 1, 'SKILL.md must contain exactly one build marker');
  const markerLine = markerLines[0];
  const marker = /^<!-- xgg-skill-content-build: sha256-([0-9a-f]{64}) -->$/.exec(markerLine);
  assert.ok(marker, 'Skill build marker must contain a lowercase SHA-256');
  const markerWithLf = `${markerLine}\n`;
  const markerOffset = skill.indexOf(markerWithLf);
  assert.notEqual(markerOffset, -1, 'Skill build marker must end with LF');
  const contentWithoutMarker =
    skill.slice(0, markerOffset) + skill.slice(markerOffset + markerWithLf.length);
  const contentDigest = createHash('sha256').update(contentWithoutMarker).digest('hex');
  assert.equal(marker[1], contentDigest, 'Skill build marker is stale for the current body');

  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skill);
  assert.ok(frontmatter, 'SKILL.md must start with YAML frontmatter');
  const keys = frontmatter[1]
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => line.slice(0, line.indexOf(':')));
  assert.deepEqual(keys, ['name', 'description']);
  assert.ok(skill.trimEnd().split('\n').length < 500, 'SKILL.md should stay under 500 lines');
  assert.match(skill, /\[references\/graph-model\.md\]\(references\/graph-model\.md\)/);
  assert.match(skill, /\[references\/node-catalog\.md\]\(references\/node-catalog\.md\)/);
  assert.match(skill, /\[references\/device-semantics\.md\]\(references\/device-semantics\.md\)/);
  assert.match(skill, /\[references\/recipes\.md\]\(references\/recipes\.md\)/);
  assert.match(skill, /\[references\/operations\.md\]\(references\/operations\.md\)/);
});

test('Skill node catalog keeps parameter coverage for all 25 executable cards plus nop', async () => {
  const catalog = await readFile(path.join(repositoryDir, 'references', 'node-catalog.md'), 'utf8');
  const section = /## 25\+nop 参数总表\n([\s\S]*?)(?=\n## )/.exec(catalog);
  assert.ok(section, 'node catalog must contain the bounded 25+nop parameter table');

  const documented = new Set();
  for (const line of section[1].split('\n')) {
    if (!line.startsWith('| `')) continue;
    const firstCell = line.slice(0, line.indexOf('|', 1));
    for (const match of firstCell.matchAll(/`([^`]+)`/g)) documented.add(match[1]);
  }

  assert.deepEqual(
    [...documented].sort(),
    modeledNodeTypes,
    'node catalog parameter table must cover every modeled node type exactly',
  );

  const rows = section[1].split('\n').filter((line) => line.startsWith('| `'));
  const row = (firstCell) => {
    const found = rows.find((line) => line.startsWith(`| ${firstCell} |`));
    assert.ok(found, `missing parameter row ${firstCell}`);
    return found;
  };

  const inputProperty = row('`deviceInput` property');
  const inputEvent = row('`deviceInput` event');
  const captureProperty = row('`deviceInputSetVar` property');
  const captureEvent = row('`deviceInputSetVar` event');
  for (const sourceRow of [inputProperty, inputEvent, captureProperty, captureEvent]) {
    assert.match(sourceRow, /--allow-no-push/, 'every push-source mode must document its waiver');
  }
  for (const preloadRow of [
    inputProperty,
    captureProperty,
    row('`varChange` number'),
    row('`varChange` string'),
  ]) {
    assert.match(preloadRow, /preload/, 'every preload-capable mode must document preload');
  }
  assert.doesNotMatch(inputEvent, /preload/);
  assert.doesNotMatch(captureEvent, /preload/);
  assert.match(inputEvent, /--event-filter/);
  assert.doesNotMatch(captureEvent, /--event-filter/);
  assert.match(captureEvent, /--event-arg-var/);
  assert.doesNotMatch(row('`deviceGet`'), /--allow-no-push|preload/);
  assert.match(row('`deviceOutput` action'), /--params/);

  const delay = row('`delay`');
  assert.match(delay, /ms\|s\|min\|hour/);
  assert.match(delay, /`m\|h`/);
  assert.match(row('`statusLast`'), /≥1/);
  assert.match(row('`eventSequence`'), /≥1|同 statusLast/);
  assert.match(row('`loop`'), /0\/负数/);
});

test('Skill documents every registered node-add authoring flag and lossless legacy edge form', async () => {
  const files = await listFiles(repositoryDir);
  const documentation = (
    await Promise.all(files.map((relative) => readFile(path.join(repositoryDir, relative), 'utf8')))
  ).join('\n');

  for (const flag of NODE_ADD_AUTHORING_FLAG_NAMES) {
    assert.ok(
      documentation.includes(flag),
      `Skill must document registered authoring flag ${flag}`,
    );
  }

  for (const flag of ['--from-node-id', '--from-pin', '--to-node-id', '--to-pin']) {
    assert.ok(documentation.includes(flag), `Skill must document lossless edge flag ${flag}`);
  }
});
