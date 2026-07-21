import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const skillRoot = path.join(repositoryRoot, 'skills', 'xgg-rule-authoring');
const canonicalSkillFiles = [
  'SKILL.md',
  'references/device-semantics.md',
  'references/graph-model.md',
  'references/node-catalog.md',
  'references/operations.md',
  'references/recipes.md',
].sort();

async function listMarkdownFiles(root, relative = '') {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await listMarkdownFiles(root, child)));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(child);
  }
  return files.sort();
}

const forbiddenReferences = [
  ['external GUIDE filename', /\bGUIDE\.md\b/i],
  ['external oh-my-sage repository', /\boh-my-sage\b/i],
  ['external allocnode owner', /\ballocnode\b/i],
  ['external ai-config JavaScript filename', /\bai-config[\w.-]*\.js\b/i],
  [
    'pinned external source revision',
    /(?:\b(?:tree|blob|commit)\/[0-9a-f]{7,40}\b|\b[0-9a-f]{40}\b)/i,
  ],
  ['external development Bundle provenance', /\bbundles?\b/i],
];

test('caller-facing Skill and README files are self-contained', async () => {
  const skillRelativePaths = await listMarkdownFiles(skillRoot);
  assert.deepEqual(
    skillRelativePaths,
    canonicalSkillFiles,
    'canonical Skill tree must contain only the audited Markdown files',
  );
  const skillFiles = skillRelativePaths.map((relativePath) => ({
    absolutePath: path.join(skillRoot, ...relativePath.split('/')),
    displayPath: `skills/xgg-rule-authoring/${relativePath}`,
  }));
  const files = [
    ...skillFiles,
    { absolutePath: path.join(repositoryRoot, 'README.md'), displayPath: 'README.md' },
    {
      absolutePath: path.join(repositoryRoot, 'packages', 'cli', 'README.md'),
      displayPath: 'packages/cli/README.md',
    },
    {
      absolutePath: path.join(repositoryRoot, 'packages', 'core', 'README.md'),
      displayPath: 'packages/core/README.md',
    },
  ];

  const violations = [];
  for (const { absolutePath, displayPath } of files) {
    const content = await readFile(absolutePath, 'utf8');
    for (const [index, rawLine] of content.split('\n').entries()) {
      const line = rawLine.replaceAll('bundle-semantic-drift', 'allowed-machine-reason-code');
      for (const [label, pattern] of forbiddenReferences) {
        if (pattern.test(line)) violations.push(`${displayPath}:${index + 1}: ${label}`);
      }
    }
  }
  assert.deepEqual(violations, [], violations.join('\n'));
});

test('every relative Markdown link in the canonical Skill stays inside its tree and resolves', async () => {
  const files = await listMarkdownFiles(skillRoot);
  const violations = [];
  for (const relativePath of files) {
    const absolutePath = path.join(skillRoot, ...relativePath.split('/'));
    const content = await readFile(absolutePath, 'utf8');
    for (const match of content.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g)) {
      const target = match[1];
      if (target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const pathname = decodeURIComponent(target.split('#', 1)[0]);
      const resolved = path.resolve(path.dirname(absolutePath), pathname);
      const relativeToRoot = path.relative(skillRoot, resolved);
      if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
        violations.push(`${relativePath}: link escapes Skill tree: ${target}`);
        continue;
      }
      try {
        await stat(resolved);
      } catch {
        violations.push(`${relativePath}: missing link target: ${target}`);
      }
    }
  }
  assert.deepEqual(violations, [], violations.join('\n'));
});
