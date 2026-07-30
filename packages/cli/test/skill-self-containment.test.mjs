import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
  'references/habit-learning.md',
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
  ['local user home path', /\/Users\/[^/\s]+(?:\/|$)/],
  ['private development artifact path', /\.codex-review\//],
  [
    'literal six-digit login credential',
    /(?:登录码|验证码|六位码|6\s*位(?:登录)?码)[^`\n]{0,40}\b\d{6}\b/u,
  ],
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

test('root and npm READMEs require one complete CLI plus Skill installation flow', async () => {
  const readmes = [
    ['README.md', path.join(repositoryRoot, 'README.md')],
    ['packages/cli/README.md', path.join(repositoryRoot, 'packages', 'cli', 'README.md')],
  ];
  const requiredFragments = [
    'npm install -g @eyaeya/xgg-cli@latest',
    'eyaeya/xiaomi-central-hub-gateway-cli@v${XGG_VERSION}',
    '--global --all',
    'npx --yes skills list --global --json',
    'skills.find((item) => item.name === "xgg-rule-authoring")',
    'const expectedAgent = process.env.XGG_AGENT_NAME',
    'expectedAgent === "AGENT_NAME"',
    '!skill.agents.includes(expectedAgent)',
    'process.exit(1)',
    'verifiedFor: expectedAgent',
    'agents: skill.agents',
  ];

  for (const [displayPath, absolutePath] of readmes) {
    const content = await readFile(absolutePath, 'utf8');
    const nextHeading = displayPath === 'README.md' ? '快速开始' : '快速使用';
    const installSection = content.match(
      new RegExp(`^## 安装[^\\n]*\\n([\\s\\S]*?)(?=^## ${nextHeading}$)`, 'm'),
    )?.[1];
    assert.ok(installSection, `${displayPath} must have one complete installation section`);
    for (const fragment of requiredFragments) {
      assert.ok(
        installSection.includes(fragment),
        `${displayPath} install must include ${fragment}`,
      );
    }
  }

  const rootReadme = await readFile(path.join(repositoryRoot, 'README.md'), 'utf8');
  assert.doesNotMatch(rootReadme, /^## (?:人类安装|AI Agent 安装)$/m);
  assert.equal(
    rootReadme.split('const expectedAgent = process.env.XGG_AGENT_NAME').length - 1,
    2,
    'npm and source installation paths must both verify the intended Agent',
  );
  assert.equal(
    rootReadme.split('export XGG_AGENT_NAME="AGENT_NAME"').length - 1,
    2,
    'npm and source installation paths must both require an explicit verification target',
  );
  assert.ok(rootReadme.includes('test -f "$CLI_SKILL/SKILL.md"'));
  assert.ok(rootReadme.includes('Refusing to overlay existing Skill directory'));
  assert.ok(rootReadme.includes('diff -qr "$CLI_SKILL" "$AGENT_SKILL_DIR"'));
});

test('root and npm READMEs route Agents through one-graph household habit learning', async () => {
  const rootReadme = await readFile(path.join(repositoryRoot, 'README.md'), 'utf8');
  const npmReadme = await readFile(
    path.join(repositoryRoot, 'packages', 'cli', 'README.md'),
    'utf8',
  );
  const habitReference = await readFile(
    path.join(skillRoot, 'references', 'habit-learning.md'),
    'utf8',
  );
  const habitHeading = '### 新家庭先学习习惯，再设计第一条自动化（推荐）';
  const directHeading = '### 用 LLM Agent 设计并创建自动化（主用法）';
  assert.ok(rootReadme.indexOf(habitHeading) >= 0, 'README must expose habit learning');
  assert.ok(
    rootReadme.indexOf(habitHeading) < rootReadme.indexOf(directHeading),
    'habit learning must be offered before direct automation',
  );
  for (const fragment of [
    'skills/xgg-rule-authoring/references/habit-learning.md',
    '一张统一观察图',
    'xgg learn plan --include-context --pretty',
    'start（disabled）→ start --enable --plan-id <reviewed-plan-id> → capture → status → finish →（如需澄清：clarify → 再次 finish）→ profile',
    'xgg learn capture --study-dir <private-study-dir> --follow',
    'xgg learn status --study-dir <private-study-dir> --local-only',
    'xgg learn finish --study-dir <private-study-dir>',
    'xgg learn clarify --help',
    'xgg learn profile --study-dir <private-study-dir>',
    'durable phase',
    '--exclude-room <room-id...>',
    '--exclude-device <did...>',
    '不能按来源数量、房间、优先级、A/B 区或 16 路估算预先拆成多张规则',
    '单图只说明采集源位于同一规则，不等于“全屋完整”',
    '设备覆盖、房间覆盖和信号覆盖',
    '所有具备 notify 的整体及分区照度',
    'people-num',
    'enable 边界和预期 preload 来源',
    'source transaction',
    '不得跨越日志 gap',
    'semanticDigest',
    'layoutDigest',
    '.xgg-private/habit-learning/<session-id>/',
    '最终拉取并落盘 → 停用并 readback',
    'fail-safe 停用并 readback',
    'current',
    'expired',
    'invalidated',
    'insufficient',
  ]) {
    assert.ok(rootReadme.includes(fragment), `README habit workflow must include ${fragment}`);
  }
  for (const fragment of [
    '## 新家庭先学习习惯',
    '一张无物理输出的观察图',
    'plan → start（disabled）→ start --enable --plan-id <reviewed-plan-id> → capture → status → finish →（如需澄清：clarify → 再次 finish）→ profile',
    'xgg learn plan --include-context --pretty',
    'xgg learn start --study-dir .xgg-private/habit-learning/home --include-context',
    '--enable --plan-id <reviewed-plan-id>',
    'xgg learn capture --study-dir .xgg-private/habit-learning/home --follow',
    'xgg learn status --study-dir <private-study-dir>',
    'xgg learn finish --study-dir <private-study-dir>',
    'xgg learn clarify --help',
    'xgg learn profile --study-dir <private-study-dir>',
    'skills/xgg-rule-authoring/references/habit-learning.md',
    'people-num',
    '0700',
    '0600',
    'fail-safe 停用并 readback',
  ]) {
    assert.ok(npmReadme.includes(fragment), `npm README habit workflow must include ${fragment}`);
  }
  const callerFacing = `${rootReadme}\n${habitReference}`;
  for (const subcommand of ['plan', 'start', 'capture', 'status', 'clarify', 'finish', 'profile']) {
    assert.match(
      callerFacing,
      new RegExp(`\\bxgg learn ${subcommand}\\b`),
      `caller-facing habit workflow must advertise learn ${subcommand}`,
    );
  }
});

test('habit-learning reference preserves long-window evidence boundaries', async () => {
  const reference = await readFile(path.join(skillRoot, 'references', 'habit-learning.md'), 'utf8');
  for (const fragment of [
    'CLI 生命周期与恢复',
    'preparing → ready-disabled → observing / observing-degraded → finishing → awaiting-clarification → complete',
    '每个新 Agent session、进程异常或用户回来时都先运行它',
    '先 append+fsync journal/gaps，再原子更新 checkpoint',
    '`finish` 可恢复且顺序固定',
    '最终 capture、fsync journal/gaps、原子提交 checkpoint，然后 disable',
    '`reusableForRuleAuthoring=true`',
    '`expired`、`invalidated` 或 `insufficient`',
    '设备覆盖：',
    '房间覆盖：',
    '信号覆盖：',
    '不能固定为 5 秒',
    'quiet period',
    'hard cap',
    '`missing`',
    '`ambiguous`',
    '先折叠 source transaction，再计行为',
    'supportRefs',
    'counter 和其他下游执行行',
    '状态区间必须 gap-aware',
    '任何频次、持续时间、路径或作息结论都不得跨 gap 拼接',
    '`asOf`',
    'append-only correction',
    '从分区语义形成候选拓扑',
    '传感器抖动与视野重叠',
    '长期证据的主路径固定为',
    '`rule trace` 是基于当前图和有界日志的诊断投影',
    '不得把多个房间的 occupancy overlap',
    '`semanticDigest`',
    '`layoutDigest`',
  ]) {
    assert.ok(
      reference.includes(fragment),
      `habit-learning evidence contract must include ${fragment}`,
    );
  }

  const lifecycleCommands = [
    'xgg learn plan',
    'xgg learn start',
    'xgg learn capture',
    'xgg learn status',
    'xgg learn finish',
    'xgg learn clarify',
    'xgg learn profile',
  ];
  let previousIndex = -1;
  for (const command of lifecycleCommands) {
    const index = reference.indexOf(command);
    assert.ok(index > previousIndex, `${command} must appear in lifecycle order`);
    previousIndex = index;
  }
});

test('habit-learning reference reason codes exactly match the Core planning schema', async () => {
  const schema = await readFile(
    path.join(repositoryRoot, 'packages', 'core', 'src', 'schemas', 'habit-learning.ts'),
    'utf8',
  );
  const reference = await readFile(path.join(skillRoot, 'references', 'habit-learning.md'), 'utf8');
  const schemaBlock = schema.match(
    /export const HABIT_LEARNING_REASON_CODES = \[([\s\S]*?)\] as const;/,
  )?.[1];
  const referenceBlock = reference.match(
    /机器计划只使用当前 schema 的以下精确 reason code：\n\n```text\n([\s\S]*?)\n```/,
  )?.[1];
  assert.ok(schemaBlock, 'Core habit-learning reason-code schema must be readable');
  assert.ok(referenceBlock, 'habit-learning reference must list exact reason codes');
  const schemaCodes = [...schemaBlock.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  const referenceCodes = referenceBlock.split('\n').filter(Boolean);
  assert.deepEqual(referenceCodes, schemaCodes);
});

test('README verification snippets fail closed for placeholders and the wrong Agent', async () => {
  const readmePaths = [
    path.join(repositoryRoot, 'README.md'),
    path.join(repositoryRoot, 'packages', 'cli', 'README.md'),
  ];
  const inventory = JSON.stringify([
    { name: 'xgg-rule-authoring', agents: ['Codex', 'Claude Code'] },
  ]);

  for (const readmePath of readmePaths) {
    const content = await readFile(readmePath, 'utf8');
    const scripts = [
      ...content.matchAll(/npx --yes skills list --global --json \| node -e '\n([\s\S]*?)\n'/g),
    ].map((match) => match[1]);
    assert.ok(scripts.length > 0, `${readmePath} must contain an executable verifier`);

    for (const script of scripts) {
      for (const expectedAgent of ['Codex', '*']) {
        const result = spawnSync(process.execPath, ['-e', script], {
          encoding: 'utf8',
          env: { ...process.env, XGG_AGENT_NAME: expectedAgent },
          input: inventory,
        });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(JSON.parse(result.stdout).verifiedFor, expectedAgent);
      }

      for (const expectedAgent of ['AGENT_NAME', 'OpenClaw']) {
        const result = spawnSync(process.execPath, ['-e', script], {
          encoding: 'utf8',
          env: { ...process.env, XGG_AGENT_NAME: expectedAgent },
          input: inventory,
        });
        assert.notEqual(result.status, 0, `${expectedAgent} must not pass ${readmePath}`);
      }
    }
  }
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
