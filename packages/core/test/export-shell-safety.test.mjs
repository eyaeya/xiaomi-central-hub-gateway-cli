import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { renderExportedAsShell } from '../dist/index.js';

test('shell export treats every metadata field as data and cleans its temporary body', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'xgg-shell-export-'));
  t.after(() => rm(root, { force: true, recursive: true }));

  const marker = join(root, 'unexpected-marker');
  const capture = join(root, 'calls.jsonl');
  const binDir = join(root, 'bin with spaces');
  const fakeXgg = join(binDir, 'fake xgg.mjs');
  await mkdir(binDir);
  await writeFile(
    fakeXgg,
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.XGG_CAPTURE, JSON.stringify(process.argv.slice(2)) + '\\n');
`,
  );
  await chmod(fakeXgg, 0o700);

  const command = `printf unsafe > ${marker}`;
  const ruleId = `rule'; ${command}; #\n${command}`;
  const ruleName = `ordinary\r\n${command}\n# \\`;
  const baseUrl = `http://example.invalid/'; ${command}; #'`;
  const snapshotsDir = `${root}/snapshots'; ${command}; #'`;
  const flagName = `--flag\n${command}`;
  const flagValue = `space ' " \` $(${command}) ; & | < > * ? [ ]`;
  const from = `node:out'; ${command}; #'`;
  const to = `target:in\n${command}`;
  const bodyJson = `{"safe":true}\nXGG_SHELL_EOF\n${command}\n#`;

  const script = renderExportedAsShell(
    {
      ruleId,
      ruleName,
      enable: true,
      commands: [
        { kind: 'shell-prelude', comment: `prelude\n${command}\n# \\` },
        { kind: 'rule-set-body', bodyJson, description: `body\r\n${command}` },
        {
          kind: 'node-add',
          nodeId: `node\n${command}`,
          type: 'test',
          flags: [{ name: flagName, value: flagValue, needsQuoting: false }],
          comment: `node\n${command}`,
        },
        { kind: 'edge-add', from, to },
        { kind: 'warning', message: `warning\n${command}` },
        { kind: 'rule-enable' },
      ],
      warnings: [],
    },
    { baseUrl, snapshotsDir },
  );

  const result = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      TMPDIR: root,
      XGG: fakeXgg,
      XGG_CAPTURE: capture,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  await assert.rejects(access(marker), { code: 'ENOENT' });

  const calls = (await readFile(capture, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(calls.length, 4);

  assert.deepEqual(calls[0].slice(0, 3), ['rule', 'set', '--body']);
  assert.equal(calls[0][4], '--snapshots-dir');
  assert.equal(calls[0][5], snapshotsDir);
  assert.equal(calls[0][6], '--base-url');
  assert.equal(calls[0][7], baseUrl);
  await assert.rejects(access(calls[0][3]), { code: 'ENOENT' });

  assert.deepEqual(calls[1], [
    'rule',
    'node',
    'add',
    '--rule-id',
    ruleId,
    flagName,
    flagValue,
    '--snapshots-dir',
    snapshotsDir,
    '--base-url',
    baseUrl,
  ]);
  assert.deepEqual(calls[2], [
    'rule',
    'edge',
    'add',
    '--rule-id',
    ruleId,
    '--from',
    from,
    '--to',
    to,
    '--snapshots-dir',
    snapshotsDir,
    '--base-url',
    baseUrl,
  ]);
  assert.deepEqual(calls[3], [
    'rule',
    'enable',
    ruleId,
    '--snapshots-dir',
    snapshotsDir,
    '--base-url',
    baseUrl,
  ]);
});
