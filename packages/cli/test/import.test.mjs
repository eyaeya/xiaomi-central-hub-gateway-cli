import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

test('package root import is side-effect free', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      "const api = await import('@eyaeya/xgg-cli'); console.log(typeof api.buildProgram);",
    ],
    { cwd: packageRoot, encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'function\n');
  assert.equal(result.stderr, '');
});

test('JSON import renders complete comparison operands without shrinking arrays or v2', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'xgg-import-comparisons-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const exportPath = join(root, 'export.json');
  const capturePath = join(root, 'calls.jsonl');
  const fakeXgg = join(root, 'fake-xgg.mjs');
  const payload = {
    ok: true,
    ruleId: '101',
    ruleName: 'complete comparisons',
    enable: false,
    externalVariables: [],
    warnings: [],
    commands: [
      { kind: 'shell-prelude', comment: 'comparison import fixture' },
      {
        kind: 'rule-set-body',
        bodyJson: JSON.stringify({
          id: '101',
          nodes: [],
          cfg: {
            id: '101',
            uiType: 'rule',
            enable: false,
            userData: {
              name: 'complete comparisons',
              transform: { x: 0, y: 0, scale: 1, rotate: 0 },
              lastUpdateTime: 0,
            },
          },
        }),
        description: 'empty rule',
      },
      {
        kind: 'node-add',
        nodeId: 'property-include',
        type: 'deviceGet',
        comment: 'property include',
        flags: [
          { name: '--id', value: 'property-include' },
          { name: '--type', value: 'deviceGet' },
          { name: '--device-did', value: 'fake-device' },
          { name: '--device-property', value: 'count' },
          { name: '--property-include', value: '1,2,3' },
        ],
      },
      {
        kind: 'node-add',
        nodeId: 'event-complete',
        type: 'deviceInput',
        comment: 'event include/between',
        flags: [
          { name: '--id', value: 'event-complete' },
          { name: '--type', value: 'deviceInput' },
          { name: '--device-did', value: 'fake-device' },
          { name: '--device-event', value: 'mixed-event' },
          { name: '--event-filter-include', value: '2=1,2' },
          { name: '--event-filter-between', value: '3=1.5,2.5' },
        ],
      },
    ],
  };
  await writeFile(exportPath, JSON.stringify(payload));
  await writeFile(
    fakeXgg,
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.XGG_CAPTURE, JSON.stringify(process.argv.slice(2)) + '\\n');
`,
  );
  await chmod(fakeXgg, 0o700);

  const imported = spawnSync(
    process.execPath,
    [cliPath, 'rule', 'import', '--from-file', exportPath, '--no-next-hint'],
    { encoding: 'utf8' },
  );
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stderr, '');
  assert.equal((imported.stdout.match(/--allow-legacy-id/g) ?? []).length, 2);

  const cloned = spawnSync(
    process.execPath,
    [cliPath, 'rule', 'import', '--from-file', exportPath, '--target-id', '202', '--no-next-hint'],
    { encoding: 'utf8' },
  );
  assert.equal(cloned.status, 0, cloned.stderr);
  assert.equal((cloned.stdout.match(/--allow-legacy-id/g) ?? []).length, 2);

  const replayed = spawnSync('bash', ['-c', imported.stdout], {
    encoding: 'utf8',
    env: { ...process.env, XGG: fakeXgg, XGG_CAPTURE: capturePath },
  });
  assert.equal(replayed.status, 0, replayed.stderr);
  const calls = (await readFile(capturePath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const nodeCalls = calls.filter(
    (argv) => argv[0] === 'rule' && argv[1] === 'node' && argv[2] === 'add',
  );
  assert.equal(nodeCalls.length, 2);
  assert.equal(nodeCalls[0][nodeCalls[0].indexOf('--property-include') + 1], '1,2,3');
  assert.equal(nodeCalls[1][nodeCalls[1].indexOf('--event-filter-include') + 1], '2=1,2');
  assert.equal(nodeCalls[1][nodeCalls[1].indexOf('--event-filter-between') + 1], '3=1.5,2.5');
});

test('pre-167 JSON import upgrades typed ids and colon-bearing edges for replay and clone', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'xgg-import-legacy-ids-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const exportPath = join(root, 'export.json');
  const capturePath = join(root, 'calls.jsonl');
  const fakeXgg = join(root, 'fake-xgg.mjs');
  const body = {
    id: '301',
    nodes: [],
    cfg: {
      id: '301',
      uiType: 'rule',
      enable: false,
      userData: {
        name: 'legacy ids',
        transform: { x: 0, y: 0, scale: 1, rotate: 0 },
        lastUpdateTime: 0,
      },
    },
  };
  await writeFile(
    exportPath,
    JSON.stringify({
      ruleId: '301',
      ruleName: 'legacy ids',
      enable: false,
      warnings: [],
      commands: [
        { kind: 'rule-set-body', bodyJson: JSON.stringify(body), description: 'empty rule' },
        {
          kind: 'node-add',
          nodeId: 'old:source',
          type: 'onLoad',
          flags: [
            { name: '--id', value: 'old:source' },
            { name: '--type', value: 'onLoad' },
          ],
          comment: 'old source',
        },
        {
          kind: 'node-add',
          nodeId: 'old:sink',
          type: 'delay',
          flags: [
            { name: '--id', value: 'old:sink' },
            { name: '--type', value: 'delay' },
            { name: '--duration', value: '1s' },
          ],
          comment: 'old sink',
        },
        { kind: 'edge-add', from: 'old:source:output', to: 'old:sink:input' },
      ],
    }),
  );
  await writeFile(
    fakeXgg,
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.XGG_CAPTURE, JSON.stringify(process.argv.slice(2)) + '\\n');
`,
  );
  await chmod(fakeXgg, 0o700);

  for (const extraArgs of [[], ['--target-id', '302']]) {
    const imported = spawnSync(
      process.execPath,
      [cliPath, 'rule', 'import', '--from-file', exportPath, ...extraArgs, '--no-next-hint'],
      { encoding: 'utf8' },
    );
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal((imported.stdout.match(/--allow-legacy-id/g) ?? []).length, 2);
    assert.match(imported.stdout, /--from-node-id 'old:source' --from-pin 'output'/);
    assert.match(imported.stdout, /--to-node-id 'old:sink' --to-pin 'input'/);

    await rm(capturePath, { force: true });
    const replayed = spawnSync('bash', ['-c', imported.stdout], {
      encoding: 'utf8',
      env: { ...process.env, XGG: fakeXgg, XGG_CAPTURE: capturePath },
    });
    assert.equal(replayed.status, 0, replayed.stderr);
    const calls = (await readFile(capturePath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const edgeCall = calls.find(
      (argv) => argv[0] === 'rule' && argv[1] === 'edge' && argv[2] === 'add',
    );
    assert.ok(edgeCall);
    assert.equal(edgeCall[edgeCall.indexOf('--from-node-id') + 1], 'old:source');
    assert.equal(edgeCall[edgeCall.indexOf('--to-node-id') + 1], 'old:sink');
  }
});
