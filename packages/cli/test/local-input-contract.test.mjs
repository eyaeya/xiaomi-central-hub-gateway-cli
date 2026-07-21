import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createIpcServer } from '@eyaeya/xgg-core';

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const packageMetadata = JSON.parse(
  await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
);
const baseUrl = 'http://local-input-contract.test';
const agentStartedAt = '2026-07-19T02:30:00.000Z';

function endpointPath(root) {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\xgg-local-input-${process.pid}-${randomUUID()}`;
  }
  return join(root, 'agent.sock');
}

async function startFakeAgent(t) {
  const root = await mkdtemp(join(tmpdir(), 'xgg-local-input-'));
  const socketPath = endpointPath(root);
  const sessionFile = join(root, 'session.json');
  const frames = [];
  const server = await createIpcServer({
    path: socketPath,
    handler: async (request) => {
      frames.push(request);
      if (request.method === '$ping') return { host: baseUrl, agentStartedAt };
      return {};
    },
  });
  await writeFile(
    sessionFile,
    JSON.stringify({
      version: 2,
      sessions: {
        [baseUrl]: {
          host: baseUrl,
          pid: process.pid,
          socketPath,
          agentStartedAt,
          agentVersion: 'test',
          lastValidatedAt: agentStartedAt,
        },
      },
    }),
    { mode: 0o600 },
  );
  t.after(async () => {
    await server.close();
    await rm(root, { force: true, recursive: true });
  });
  return { frames, root, sessionFile };
}

function runCli(args, agent, env = {}, input = undefined) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: {
        ...process.env,
        XGG_AGENT_MODE: '1',
        XGG_BASE_URL: baseUrl,
        XGG_NO_NEXT_HINT: '1',
        XGG_NO_REFRESH_HINT: '1',
        XGG_SESSION_FILE: agent.sessionFile,
        XGG_SNAPSHOTS_DIR: '',
        ...env,
      },
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    if (input !== undefined) child.stdin.end(input);
    child.once('error', reject);
    child.once('close', (status, signal) => resolvePromise({ status, signal, stdout, stderr }));
  });
}

function assertSingleConfig(result, forbiddenText) {
  assert.equal(result.status, 5, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, '');
  const physicalLines = result.stderr.trimEnd().split('\n');
  assert.equal(physicalLines.length, 1, result.stderr);
  const payload = JSON.parse(physicalLines[0]);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'CONFIG');
  if (forbiddenText !== undefined) assert.doesNotMatch(result.stderr, forbiddenText);
  return payload;
}

test('Commander failures use one CONFIG JSON line while help and version stay successful', async (t) => {
  const agent = await startFakeAgent(t);
  const failures = [
    ['not-a-command'],
    ['dump', '--unknown-input-flag'],
    ['api'],
    ['variable', 'create'],
  ];

  for (const args of failures) {
    agent.frames.length = 0;
    assertSingleConfig(await runCli(args, agent));
    assert.deepEqual(agent.frames, []);
  }

  for (const args of [['--help'], ['--version'], ['rule', 'node', 'add', '--help']]) {
    const result = await runCli(args, agent);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.notEqual(result.stdout, '');
  }

  const version = await runCli(['--version'], agent);
  assert.equal(version.stdout, `${packageMetadata.version}\n`);
});

test('typed node ids fail before Agent access while explicit legacy and raw replay stay available', async (t) => {
  const agent = await startFakeAgent(t);
  const invalidSnapshotsDir = join(agent.root, 'invalid-node-id-must-not-snapshot');
  const typed = await runCli(
    ['rule', 'node', 'add', '--rule-id', 'r', '--type', 'onLoad', '--id', 'legacy-node'],
    agent,
    { XGG_SNAPSHOTS_DIR: invalidSnapshotsDir },
  );
  const payload = assertSingleConfig(typed);
  assert.match(payload.error.message, /ASCII alphanumeric \[A-Za-z0-9\]\+/);
  assert.deepEqual(agent.frames, []);
  await assert.rejects(access(invalidSnapshotsDir), (error) => error?.code === 'ENOENT');

  const replay = await runCli(
    [
      'rule',
      'node',
      'add',
      '--rule-id',
      'r',
      '--type',
      'onLoad',
      '--id',
      'legacy-node',
      '--allow-legacy-id',
      '--snapshots-dir',
      agent.root,
      '--no-validate',
    ],
    agent,
  );
  assert.doesNotMatch(replay.stderr, /ASCII alphanumeric \[A-Za-z0-9\]\+/);
  assert.ok(agent.frames.length > 0, 'legacy replay opt-in was rejected before Agent access');
  agent.frames.length = 0;

  const rawTuple = {
    cfg: {
      pos: { x: 0, y: 0, width: 320, height: 80 },
      name: 'onLoad',
      version: 1,
    },
    inputs: {},
    outputs: { output: [] },
    props: {},
  };
  const raw = await runCli(
    [
      'rule',
      'node',
      'add',
      '--rule-id',
      'r',
      '--type',
      'onLoad',
      '--id',
      'legacy-node',
      '--cfg',
      JSON.stringify(rawTuple),
      '--snapshots-dir',
      agent.root,
      '--no-validate',
    ],
    agent,
  );
  assert.doesNotMatch(raw.stderr, /ASCII alphanumeric \[A-Za-z0-9\]\+/);
  assert.ok(agent.frames.length > 0, `raw path was rejected before Agent access: ${raw.stderr}`);
});

test('legacy-id opt-in rejects every non-replay use before snapshots or IPC', async (t) => {
  const agent = await startFakeAgent(t);
  const snapshotsDir = join(agent.root, 'legacy-id-opt-in-must-not-snapshot');
  const rawTuple = JSON.stringify({
    cfg: {
      pos: { x: 0, y: 0, width: 320, height: 80 },
      name: 'onLoad',
      version: 1,
    },
    inputs: {},
    outputs: { output: [] },
    props: {},
  });
  const scenarios = [
    {
      args: ['--type', 'onLoad', '--allow-legacy-id'],
      message: /requires an explicit --id on a modeled typed shortcut/,
    },
    {
      args: ['--type', 'onLoad', '--id', 'validNode1', '--allow-legacy-id'],
      message: /unnecessary for an editor-compatible --id/,
    },
    {
      args: ['--type', 'futureNode', '--id', 'legacy-node', '--allow-legacy-id'],
      message: /requires an explicit --id on a modeled typed shortcut/,
    },
    {
      args: ['--type', 'onLoad', '--id', 'legacy-node', '--cfg', rawTuple, '--allow-legacy-id'],
      message: /applies only to typed shortcut replay, not raw --cfg/,
    },
  ];

  for (const { args, message } of scenarios) {
    agent.frames.length = 0;
    const payload = assertSingleConfig(
      await runCli(['rule', 'node', 'add', '--rule-id', 'r', ...args], agent, {
        XGG_SNAPSHOTS_DIR: snapshotsDir,
      }),
    );
    assert.match(payload.error.message, message);
    assert.deepEqual(agent.frames, []);
    await assert.rejects(access(snapshotsDir), (error) => error?.code === 'ENOENT');
  }
});

test('property comparison flag misuse fails before Agent guards, snapshots, or IPC', async (t) => {
  const agent = await startFakeAgent(t);
  const scenarios = [
    [
      'rule',
      'node',
      'add',
      '--rule-id',
      'r',
      '--type',
      'counter',
      '--threshold',
      '1',
      '--property-value',
      'open',
    ],
    [
      'rule',
      'node',
      'add',
      '--rule-id',
      'r',
      '--type',
      'deviceInput',
      '--device-did',
      'd',
      '--device-event',
      'click',
      '--property-value',
      'open',
    ],
    [
      'rule',
      'node',
      'add',
      '--rule-id',
      'r',
      '--type',
      'deviceGet',
      '--device-did',
      'd',
      '--device-property',
      'mode',
      '--property-value',
      '',
    ],
    [
      'rule',
      'node',
      'add',
      '--rule-id',
      'r',
      '--type',
      'deviceGet',
      '--device-did',
      'd',
      '--device-property',
      'mode',
      '--property-value',
      'open',
      '--threshold',
      '1',
    ],
    [
      'rule',
      'node',
      'add',
      '--rule-id',
      'r',
      '--type',
      'deviceGet',
      '--device-did',
      'd',
      '--device-property',
      'mode',
      '--property-value',
      'open',
      '--cfg',
      '{}',
    ],
    ['rule', 'node', 'add', '--rule-id', 'r', '--type', 'counter', '--property-include', '1,2'],
    [
      'rule',
      'node',
      'add',
      '--rule-id',
      'r',
      '--type',
      'deviceGet',
      '--device-did',
      'd',
      '--device-property',
      'mode',
      '--property-include',
      '1,2',
      '--threshold',
      '1',
    ],
    [
      'rule',
      'node',
      'add',
      '--rule-id',
      'r',
      '--type',
      'deviceInput',
      '--device-did',
      'd',
      '--device-property',
      'mode',
      '--event-filter-include',
      '2=1,2',
    ],
    [
      'rule',
      'node',
      'add',
      '--rule-id',
      'r',
      '--type',
      'deviceInput',
      '--device-did',
      'd',
      '--device-event',
      'click',
      '--event-filter-between',
      '2=1,2',
      '--cfg',
      '{}',
    ],
  ];

  for (const args of scenarios) {
    agent.frames.length = 0;
    assertSingleConfig(await runCli(args, agent));
    assert.deepEqual(agent.frames, []);
  }
});

test('between shortcuts reject either omitted bound before snapshots or IPC', async (t) => {
  const agent = await startFakeAgent(t);
  const snapshotsDir = join(agent.root, 'between-must-not-snapshot');
  const families = [
    ['--type', 'deviceInput', '--device-did', 'd', '--device-property', 'temperature'],
    ['--type', 'deviceGet', '--device-did', 'd', '--device-property', 'temperature'],
    [
      '--type',
      'varChange',
      '--var-scope',
      'global',
      '--var-id',
      'temperature',
      '--var-type',
      'number',
    ],
    [
      '--type',
      'varGet',
      '--var-scope',
      'global',
      '--var-id',
      'temperature',
      '--var-type',
      'number',
    ],
  ];

  for (const family of families) {
    for (const supplied of [
      ['--threshold2', '1'],
      ['--threshold', '0'],
    ]) {
      agent.frames.length = 0;
      const result = await runCli(
        ['rule', 'node', 'add', '--rule-id', 'r', ...family, '--op', 'between', ...supplied],
        agent,
        { XGG_SNAPSHOTS_DIR: snapshotsDir },
      );
      const payload = assertSingleConfig(result);
      assert.match(
        payload.error.message,
        /--op between requires explicit --threshold \(v1\) and --threshold2 \(v2\)/,
      );
      assert.deepEqual(agent.frames, []);
      await assert.rejects(access(snapshotsDir), (error) => error?.code === 'ENOENT');
    }
  }
});

test('scalar device threshold2 and contradictory preload flags fail before snapshots or IPC', async (t) => {
  const agent = await startFakeAgent(t);
  const snapshotsDir = join(agent.root, 'node-authoring-must-not-snapshot');
  const scenarios = [
    {
      args: [
        '--type',
        'deviceInput',
        '--device-did',
        'd',
        '--device-property',
        'temperature',
        '--op',
        'eq',
        '--threshold',
        '1',
        '--threshold2',
        '2',
      ],
      message: /--threshold2 only applies to --op between/,
    },
    {
      args: [
        '--type',
        'deviceGet',
        '--device-did',
        'd',
        '--device-property',
        'temperature',
        '--threshold',
        '1',
        '--threshold2',
        '2',
      ],
      message: /--threshold2 only applies to --op between/,
    },
    {
      args: [
        '--type',
        'varChange',
        '--var-scope',
        'global',
        '--var-id',
        'mode',
        '--var-type',
        'number',
        '--op',
        'eq',
        '--threshold',
        '1',
        '--preload',
        '--no-preload',
      ],
      message: /--preload and --no-preload are mutually exclusive/,
    },
    {
      args: [
        '--type',
        'varChange',
        '--var-scope',
        'global',
        '--var-id',
        'mode',
        '--var-type',
        'number',
        '--op',
        'eq',
        '--threshold',
        '1',
        '--no-preload',
        '--preload',
      ],
      message: /--preload and --no-preload are mutually exclusive/,
    },
  ];

  for (const { args, message } of scenarios) {
    agent.frames.length = 0;
    const payload = assertSingleConfig(
      await runCli(['rule', 'node', 'add', '--rule-id', 'r', ...args], agent, {
        XGG_SNAPSHOTS_DIR: snapshotsDir,
      }),
    );
    assert.match(payload.error.message, message);
    assert.deepEqual(agent.frames, []);
    await assert.rejects(access(snapshotsDir), (error) => error?.code === 'ENOENT');
  }
});

test('preload flag misuse fails before Agent guards, snapshots, or IPC', async (t) => {
  const agent = await startFakeAgent(t);
  const scenarios = [
    [
      'rule',
      'node',
      'add',
      '--rule-id',
      'r',
      '--type',
      'deviceInput',
      '--device-did',
      'd',
      '--device-event',
      'changed',
      '--preload',
    ],
    [
      'rule',
      'node',
      'add',
      '--rule-id',
      'r',
      '--type',
      'deviceInputSetVar',
      '--device-did',
      'd',
      '--device-event',
      'changed',
      '--event-arg-var',
      '1=global.captured',
      '--no-preload',
    ],
    [
      'rule',
      'node',
      'add',
      '--rule-id',
      'r',
      '--type',
      'deviceGet',
      '--device-did',
      'd',
      '--device-property',
      'level',
      '--preload',
    ],
    ['rule', 'node', 'add', '--rule-id', 'r', '--type', 'varGet', '--no-preload'],
    ['rule', 'node', 'add', '--rule-id', 'r', '--type', 'onLoad', '--preload'],
    ['rule', 'node', 'add', '--rule-id', 'r', '--type', 'varChange', '--cfg', '{}', '--no-preload'],
  ];

  for (const args of scenarios) {
    agent.frames.length = 0;
    const payload = assertSingleConfig(await runCli(args, agent));
    assert.match(payload.error.message, /preload/);
    assert.deepEqual(agent.frames, []);
  }
});

test('--cfg rejects every shortcut authoring flag before JSON parsing, Agent guards, or IPC', async (t) => {
  const agent = await startFakeAgent(t);
  const shortcutCases = [
    ['--device-did', 'd'],
    ['--device-siid', '2'],
    ['--device-property', 'on'],
    ['--device-action', 'toggle'],
    ['--device-event', 'changed'],
    ['--event-filter', '1=1'],
    ['--event-filter-include', '1=1,2'],
    ['--event-filter-between', '1=1,2'],
    ['--event-arg-var', '1=global.marker'],
    ['--threshold', '1'],
    ['--property-value', 'open'],
    ['--property-include', '1,2'],
    ['--op', 'eq'],
    ['--params', '{'],
    ['--value', 'true'],
    ['--force-out-of-range'],
    ['--allow-no-push'],
    ['--preload'],
    ['--no-preload'],
    ['--pos', '0,0,200,120'],
    ['--simplified', 'true'],
    ['--text', 'note'],
    ['--delta', '[]'],
    ['--background', '#fff'],
    ['--inputs', '2'],
    ['--duration', '5s'],
    ['--interval', '5s'],
    ['--start', '08:00'],
    ['--end', '09:00'],
    ['--ming-text-show', 'true'],
    ['--weekday-only'],
    ['--holiday-only'],
    ['--days', '1,2'],
    ['--var-scope', 'global'],
    ['--var-id', 'marker'],
    ['--var-type', 'number'],
    ['--var-value', 'open'],
    ['--threshold2', '2'],
    ['--allow-unknown-scope'],
    ['--at', '07:30'],
    ['--sunrise'],
    ['--sunset'],
    ['--offset-min', '-15'],
    ['--latitude', '30.46'],
    ['--longitude', '114.41'],
    ['--expr', '$global.marker + 1'],
    ['--default-expr-scope', 'global'],
    ['--outputs', '2'],
  ];

  for (const shortcutArgs of shortcutCases) {
    agent.frames.length = 0;
    const payload = assertSingleConfig(
      await runCli(
        [
          'rule',
          'node',
          'add',
          '--rule-id',
          'r',
          '--type',
          'onLoad',
          '--cfg',
          '{',
          ...shortcutArgs,
        ],
        agent,
      ),
    );
    assert.match(payload.error.message, /--type onLoad raw does not accept authoring option\(s\)/);
    assert.equal(payload.error.message.includes(shortcutArgs[0]), true, shortcutArgs[0]);
    assert.deepEqual(agent.frames, [], shortcutArgs[0]);
  }
});

test('nop rejects executable-card flags before Agent guards, snapshots, or IPC', async (t) => {
  const agent = await startFakeAgent(t);
  const args = [
    'rule',
    'node',
    'add',
    '--rule-id',
    'r',
    '--type',
    'nop',
    '--text',
    'canvas note',
    '--duration',
    '5s',
    '--interval',
    '1s',
    '--inputs',
    '3',
  ];

  const payload = assertSingleConfig(await runCli(args, agent));
  assert.match(payload.error.message, /--type nop shortcut does not accept authoring option\(s\)/);
  assert.match(payload.error.message, /--duration/);
  assert.match(payload.error.message, /--interval/);
  assert.match(payload.error.message, /--inputs/);
  assert.deepEqual(agent.frames, []);
});

test('node-add rejects flags not consumed by the selected modeled type or mode before IPC', async (t) => {
  const agent = await startFakeAgent(t);
  const snapshotsDir = join(agent.root, 'unused-authoring-flag-must-not-snapshot');
  const scenarios = [
    {
      args: ['--type', 'onLoad', '--duration', '5s'],
      message: /--type onLoad shortcut does not accept authoring option\(s\): --duration/,
    },
    {
      args: ['--type', 'delay', '--duration', '5s', '--interval', '1s'],
      message: /--type delay shortcut does not accept authoring option\(s\): --interval/,
    },
    {
      args: ['--type', 'logicNot', '--inputs', '2'],
      message: /--type logicNot shortcut does not accept authoring option\(s\): --inputs/,
    },
    {
      args: [
        '--type',
        'deviceOutput',
        '--device-did',
        'did',
        '--device-action',
        'toggle',
        '--params',
        '{}',
        '--device-property',
        'on',
        '--value',
        'true',
      ],
      message: /action mode.*property mode.*mutually exclusive/,
    },
    {
      args: [
        '--type',
        'deviceInput',
        '--device-did',
        'did',
        '--device-property',
        'temperature',
        '--event-filter',
        '1=1',
      ],
      message: /event comparison filters require --device-event/,
    },
    {
      args: [
        '--type',
        'deviceInputSetVar',
        '--device-did',
        'did',
        '--device-property',
        'temperature',
        '--device-event',
        'changed',
      ],
      message: /cannot mix --device-property with --device-event/,
    },
    {
      args: [
        '--type',
        'deviceInputSetVar',
        '--device-did',
        'did',
        '--device-property',
        'temperature',
        '--event-arg-var',
        '1=global.value',
      ],
      message: /property mode does not accept authoring option\(s\): --event-arg-var/,
    },
    {
      args: [
        '--type',
        'deviceInputSetVar',
        '--device-did',
        'did',
        '--device-event',
        'changed',
        '--event-arg-var',
        '1=global.value',
        '--var-scope',
        'global',
        '--var-id',
        'value',
      ],
      message: /cannot mix --event-arg-var with --var-scope\/--var-id/,
    },
  ];

  for (const { args, message } of scenarios) {
    agent.frames.length = 0;
    const result = await runCli(['rule', 'node', 'add', '--rule-id', 'r', ...args], agent, {
      XGG_SNAPSHOTS_DIR: snapshotsDir,
    });
    const payload = assertSingleConfig(result);
    assert.match(payload.error.message, message, args.join(' '));
    assert.deepEqual(agent.frames, [], args.join(' '));
    await assert.rejects(access(snapshotsDir), (error) => error?.code === 'ENOENT');
  }
});

test('node-add operational and shared UI flags pass the authoring allowlist', async (t) => {
  const agent = await startFakeAgent(t);
  const snapshotsDir = join(agent.root, 'operational-flags-must-not-be-authoring-flags');
  const result = await runCli(
    [
      'rule',
      'node',
      'add',
      '--rule-id',
      'r',
      '--type',
      'onLoad',
      '--id',
      'load',
      '--pos',
      '1,2,200,120',
      '--simplified',
      'false',
      '--no-snapshot',
      '--no-validate',
      '--no-var-check',
      '--snapshots-dir',
      snapshotsDir,
      '--base-url',
      baseUrl,
      '--session-file',
      agent.sessionFile,
      '--timeout',
      'NaN',
      '--pretty',
      '--no-refresh-hint',
      '--no-next-hint',
    ],
    agent,
    { XGG_AGENT_MODE: '0' },
  );
  const payload = assertSingleConfig(result);

  assert.equal(payload.error.details.flag, '--timeout');
  assert.doesNotMatch(payload.error.message, /authoring option/);
  assert.deepEqual(agent.frames, []);
  await assert.rejects(access(snapshotsDir), (error) => error?.code === 'ENOENT');
});

test('node-add fallback modes retain downstream selector and variable-type diagnostics', async (t) => {
  const agent = await startFakeAgent(t);
  const scenarios = [
    {
      args: ['--type', 'deviceOutput', '--device-did', 'did'],
      message: /deviceOutput shortcut requires either --device-action or --device-property/,
    },
    {
      args: ['--type', 'varChange', '--var-type', 'boolean', '--threshold', '1'],
      message: /--var-type "boolean" is not a valid gateway variable type/,
    },
    {
      args: ['--type', 'varGet', '--var-type', 'boolean', '--var-value', 'open'],
      message: /--var-type "boolean" is not a valid gateway variable type/,
    },
  ];

  for (const { args, message } of scenarios) {
    agent.frames.length = 0;
    const payload = assertSingleConfig(
      await runCli(['rule', 'node', 'add', '--rule-id', 'r', ...args, '--no-snapshot'], agent, {
        XGG_AGENT_MODE: '0',
      }),
    );
    assert.match(payload.error.message, message);
    assert.doesNotMatch(payload.error.message, /authoring option/);
    assert.equal(
      agent.frames.some(({ method }) => method !== '$ping'),
      false,
    );
  }
});

test('exprHeight position rejects unsupported card types before Agent guards or IPC', async (t) => {
  const agent = await startFakeAgent(t);
  const result = await runCli(
    ['rule', 'node', 'add', '--rule-id', 'r', '--type', 'onLoad', '--pos', '1,2,200,120,30'],
    agent,
  );
  const payload = assertSingleConfig(result);

  assert.match(payload.error.message, /exprHeight is only valid for varSetNumber\/varSetString/);
  assert.deepEqual(agent.frames, []);
});

test('every user JSON surface reports CONFIG without echoing malformed payloads or using IPC', async (t) => {
  const agent = await startFakeAgent(t);
  const secret = 'issue31-sensitive-payload';
  const malformed = `{"secret":"${secret}"`;
  const paramsFile = join(agent.root, 'params.json');
  const graphFile = join(agent.root, 'graph.json');
  await writeFile(paramsFile, malformed);
  await writeFile(graphFile, malformed);

  const cases = [
    ['api', '/api/getDevList', '--params', malformed],
    ['api', '/api/getDevList', '--params-file', paramsFile],
    ['rule', 'import', '--from-file', graphFile],
    ['rule', 'set', '--body', graphFile],
    ['rule', 'validate', '--body', graphFile],
    ['rule', 'node', 'update', '--rule-id', 'r', '--node-id', 'n', '--patch', malformed],
    [
      'rule',
      'node',
      'add',
      '--rule-id',
      'r',
      '--type',
      'deviceOutput',
      '--device-did',
      'd',
      '--device-action',
      'a',
      '--params',
      malformed,
    ],
    ['rule', 'node', 'add', '--rule-id', 'r', '--type', 'custom', '--cfg', malformed],
  ];

  for (const args of cases) {
    agent.frames.length = 0;
    assertSingleConfig(await runCli(args, agent), new RegExp(secret));
    assert.deepEqual(agent.frames, [], args.join(' '));
  }
});

test('api rejects competing params sources before reading the session or sending IPC', async (t) => {
  const agent = await startFakeAgent(t);
  const paramsFile = join(agent.root, 'valid-params.json');
  await writeFile(paramsFile, '{"source":"file"}');

  const result = await runCli(
    ['api', '/api/getDevList', '--params', '{"source":"inline"}', '--params-file', paramsFile],
    agent,
  );
  const payload = assertSingleConfig(result);
  assert.match(payload.error.message, /mutually exclusive/);
  assert.deepEqual(agent.frames, []);
});

test('JSON file read failures are CONFIG errors with safe path metadata and no IPC', async (t) => {
  const agent = await startFakeAgent(t);
  const missingPath = join(agent.root, 'missing-graph.json');
  const result = await runCli(['rule', 'validate', '--body', missingPath], agent);
  const payload = assertSingleConfig(result);

  assert.equal(payload.error.details.flag, '--body');
  assert.equal(payload.error.details.path, missingPath);
  assert.equal(payload.error.details.fsCode, 'ENOENT');
  assert.deepEqual(agent.frames, []);
});

test('offline validate modes still reject invalid timeout input deterministically', async (t) => {
  const agent = await startFakeAgent(t);
  const graphJson = '{"id":"offline-local-input","nodes":[]}';
  const graphFile = join(agent.root, 'valid-graph.json');
  await writeFile(graphFile, graphJson);
  const cases = [
    { args: ['rule', 'validate', '--body', graphFile, '--timeout', 'NaN'] },
    {
      args: ['rule', 'validate', '--stdin', '--timeout', 'NaN'],
      input: graphJson,
    },
  ];

  for (const scenario of cases) {
    agent.frames.length = 0;
    const result = await runCli(scenario.args, agent, {}, scenario.input);
    const payload = assertSingleConfig(result);
    assert.equal(payload.error.details.flag, '--timeout');
    assert.deepEqual(agent.frames, [], scenario.args.join(' '));
  }
});

test('all shared timeout surfaces reject non-canonical or unsafe values before IPC', async (t) => {
  const agent = await startFakeAgent(t);
  const surfaces = [
    ['api', '/api/getDevList'],
    ['backup', 'list'],
    ['device', 'list'],
    ['dump'],
    ['rule', 'list'],
    ['variable', 'list'],
  ];
  const invalidValues = ['NaN', 'Infinity', '-1', '0', '1.5', '1e3', '0x10', '2147483648'];

  for (const prefix of surfaces) {
    for (const raw of invalidValues) {
      agent.frames.length = 0;
      const result = await runCli([...prefix, '--timeout', raw], agent);
      const payload = assertSingleConfig(result);
      assert.match(payload.error.message, /positive decimal integer/);
      assert.equal(payload.error.details.flag, '--timeout');
      assert.deepEqual(agent.frames, [], `${prefix.join(' ')} --timeout ${raw}`);
    }
  }
});

test('variable mutation warnings never precede a local timeout error', async (t) => {
  const agent = await startFakeAgent(t);
  const cases = [
    [
      'variable',
      'create',
      '--scope',
      'my',
      '--id',
      'v',
      '--type',
      'number',
      '--value',
      '1',
      '--name',
      'V',
    ],
    ['variable', 'delete', '--scope', 'my', '--id', 'v'],
    ['variable', 'set-value', '--scope', 'my', '--id', 'v', '--value', '1'],
    ['variable', 'set-config', '--scope', 'my', '--id', 'v', '--name', 'V'],
  ];

  for (const prefix of cases) {
    agent.frames.length = 0;
    const result = await runCli([...prefix, '--timeout', 'NaN'], agent, {
      XGG_AGENT_MODE: '0',
    });
    const payload = assertSingleConfig(result);
    assert.equal(payload.error.details.flag, '--timeout');
    assert.doesNotMatch(result.stderr, /warning:/i);
    assert.deepEqual(agent.frames, [], prefix.join(' '));
  }
});

test('poll and daemon timers use the same strict local-input contract', async (t) => {
  const agent = await startFakeAgent(t);
  const pollSurfaces = [
    ['backup', 'create', '--file-name', 'local-input-test', '--wait', '--poll-interval-ms'],
    ['backup', 'create', '--file-name', 'local-input-test', '--wait', '--poll-timeout-ms'],
    ['rule', 'logs', 'rule-id', '--follow', '--interval-ms'],
    ['variable', 'watch', '--follow', '--interval-ms'],
  ];
  const invalidValues = ['0', '1.5', '1e3', '2147483648'];

  for (const prefix of pollSurfaces) {
    for (const raw of invalidValues) {
      agent.frames.length = 0;
      const flag = prefix.at(-1);
      const result = await runCli([...prefix, raw], agent);
      const payload = assertSingleConfig(result);
      assert.match(payload.error.message, /positive decimal integer/);
      assert.equal(payload.error.details.flag, flag);
      assert.deepEqual(agent.frames, [], `${prefix.join(' ')} ${raw}`);
    }
  }

  for (const raw of invalidValues) {
    const result = await runCli(['agent', 'serve', '--host', baseUrl, '--idle-ms', raw], agent);
    const payload = assertSingleConfig(result);
    assert.equal(payload.error.details.flag, '--idle-ms');
    assert.deepEqual(agent.frames, []);
  }
});
