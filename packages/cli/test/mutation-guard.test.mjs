import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ConfigError, GatewayError, createIpcServer } from '@eyaeya/xgg-core';
import ts from 'typescript';
import { formatErrorJson } from '../dist/errors.js';
import {
  AGENT_MODE_NO_SNAPSHOT_FORBIDDEN_MESSAGE,
  AGENT_MODE_SNAPSHOTS_DIR_REQUIRED_MESSAGE,
} from '../dist/mutation-guard-messages.js';
import { buildProgram } from '../dist/program.js';

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const baseUrl = 'http://mutation-guard.test';
const agentStartedAt = '2026-07-19T00:00:00.000Z';

const affectedMutations = [
  {
    command: 'backup create',
    args: ['backup', 'create', '--file-name', 'probe'],
    writeMethod: '/api/createBackup',
  },
  {
    command: 'backup download',
    args: ['backup', 'download', '--did', 'did-1', '--ts', 'ts-1', '--file-name', 'one.bak'],
    writeMethod: '/api/downloadBackup',
    target: { did: 'did-1', ts: 'ts-1', fileName: 'one.bak' },
  },
  {
    command: 'backup config set',
    args: ['backup', 'config', 'set', '--auto-backup', 'true'],
    writeMethod: '/api/setBackupConfig',
  },
  {
    command: 'variable set-value',
    args: ['variable', 'set-value', '--scope', 'global', '--id', 'marker', '--value', '1'],
    writeMethod: '/api/setVarValue',
  },
];

const expectedTypedMutationSurfaces = [
  'backup config set',
  'backup create',
  'backup delete',
  'backup download',
  'backup load',
  'rule delete',
  'rule disable',
  'rule edge add',
  'rule edge remove',
  'rule enable',
  'rule layout',
  'rule new',
  'rule node add',
  'rule node remove',
  'rule node update',
  'rule rename',
  'rule set',
  'rule set-tags',
  'variable create',
  'variable delete',
  'variable set-config',
  'variable set-value',
];

const typedMutationCases = [
  {
    command: 'backup config set',
    args: () => ['backup', 'config', 'set', '--auto-backup', 'true'],
  },
  { command: 'backup create', args: () => ['backup', 'create', '--file-name', 'probe'] },
  {
    command: 'backup delete',
    args: () => ['backup', 'delete', '--did', 'did-1', '--ts', 'ts-1', '--file-name', 'one.bak'],
  },
  {
    command: 'backup download',
    args: () => ['backup', 'download', '--did', 'did-1', '--ts', 'ts-1', '--file-name', 'one.bak'],
  },
  {
    command: 'backup load',
    args: () => ['backup', 'load', '--did', 'did-1', '--ts', 'ts-1', '--file-name', 'one.bak'],
  },
  { command: 'rule delete', args: () => ['rule', 'delete', 'rule1'] },
  { command: 'rule disable', args: () => ['rule', 'disable', 'rule1'] },
  {
    command: 'rule edge add',
    args: () => [
      'rule',
      'edge',
      'add',
      '--rule-id',
      'rule1',
      '--from',
      'source:output',
      '--to',
      'target:input',
    ],
  },
  {
    command: 'rule edge remove',
    args: () => [
      'rule',
      'edge',
      'remove',
      '--rule-id',
      'rule1',
      '--from',
      'source:output',
      '--to',
      'target:input',
    ],
  },
  { command: 'rule enable', args: () => ['rule', 'enable', 'rule1'] },
  { command: 'rule layout', args: () => ['rule', 'layout', 'rule1'] },
  { command: 'rule new', args: () => ['rule', 'new', '--name', 'Guard probe'] },
  {
    command: 'rule node add',
    args: () => ['rule', 'node', 'add', '--rule-id', 'rule1', '--type', 'onLoad'],
  },
  {
    command: 'rule node remove',
    args: () => ['rule', 'node', 'remove', '--rule-id', 'rule1', '--node-id', 'node1'],
  },
  {
    command: 'rule node update',
    args: () => [
      'rule',
      'node',
      'update',
      '--rule-id',
      'rule1',
      '--node-id',
      'node1',
      '--patch',
      '{}',
    ],
  },
  { command: 'rule rename', args: () => ['rule', 'rename', 'rule1', '--name', 'Renamed'] },
  {
    command: 'rule set',
    args: (ruleBodyPath) => ['rule', 'set', '--body', ruleBodyPath],
  },
  {
    command: 'rule set-tags',
    args: () => ['rule', 'set-tags', 'rule1', '--tags', 'guard'],
  },
  {
    command: 'variable create',
    args: () => [
      'variable',
      'create',
      '--scope',
      'global',
      '--id',
      'marker',
      '--type',
      'number',
      '--value',
      '0',
      '--name',
      'Marker',
    ],
  },
  {
    command: 'variable delete',
    args: () => ['variable', 'delete', '--scope', 'global', '--id', 'marker'],
  },
  {
    command: 'variable set-config',
    args: () => [
      'variable',
      'set-config',
      '--scope',
      'global',
      '--id',
      'marker',
      '--name',
      'Marker',
    ],
  },
  {
    command: 'variable set-value',
    args: () => ['variable', 'set-value', '--scope', 'global', '--id', 'marker', '--value', '1'],
  },
];

const position = (width = 200, height = 120) => ({ x: 0, y: 0, width, height });

function onLoad(id, targets = []) {
  return {
    id,
    type: 'onLoad',
    cfg: { pos: position(), name: 'onLoad', version: 1 },
    inputs: {},
    outputs: { output: targets },
    props: {},
  };
}

function delay(id, targets = []) {
  return {
    id,
    type: 'delay',
    cfg: { pos: position(320), name: 'delay', version: 1, unit: 's', value: 1 },
    inputs: { input: null },
    outputs: { output: targets },
    props: { timeout: 1_000 },
  };
}

function condition(id) {
  return {
    id,
    type: 'condition',
    cfg: { pos: position(320), name: 'condition', version: 1 },
    inputs: { trigger: null, condition: null },
    outputs: { met: [], unmet: [] },
    props: {},
  };
}

function ruleSummary(id = 'rule1') {
  return {
    id,
    enable: false,
    uiType: 'rule',
    userData: {
      name: 'guard test',
      transform: { x: 0, y: 0, scale: 1, rotate: 0 },
      lastUpdateTime: 0,
      version: 0,
    },
  };
}

function endpointPath(root) {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\xgg-mutation-${process.pid}-${randomUUID()}`;
  }
  return join(root, 'agent.sock');
}

async function startFakeAgent(t) {
  const root = await mkdtemp(join(tmpdir(), 'xgg-mutation-guard-'));
  const socketPath = endpointPath(root);
  const sessionFile = join(root, 'session.json');
  const frames = [];
  const gatewayCalls = [];
  const writes = [];
  const control = {
    failSnapshot: false,
    rule: undefined,
    snapshotsDir: undefined,
  };

  const server = await createIpcServer({
    path: socketPath,
    handler: async (request) => {
      frames.push(request);
      if (request.method === '$ping') return { host: baseUrl, agentStartedAt };
      gatewayCalls.push(request);
      if (control.failSnapshot && request.method === '/api/getGraphList') {
        throw new GatewayError('rules unavailable during checkpoint', { gatewayCode: -1 });
      }
      switch (request.method) {
        case '/api/getVarConfig':
          return { type: 'number', userData: { name: 'Marker' } };
        case '/api/getDevList':
          return { devList: {} };
        case '/api/getGraphList':
          return control.rule === undefined ? [] : [control.rule.cfg];
        case '/api/getGraph':
          if (control.rule !== undefined && request.params?.id === control.rule.cfg.id) {
            return { id: control.rule.cfg.id, nodes: control.rule.nodes };
          }
          throw new Error(`unexpected graph request: ${JSON.stringify(request.params)}`);
        case '/api/getVarScopeList':
          return { scopes: [] };
        case '/api/getBackupList':
          return { list: [] };
        case '/api/getBackupConfig':
          return { autoBackup: false };
        case '/api/createBackup':
        case '/api/downloadBackup':
        case '/api/setBackupConfig':
        case '/api/setVarValue': {
          const artifact = await readPublishedArtifact(control.snapshotsDir);
          writes.push({ request, artifact });
          return request.method === '/api/setVarValue' ? {} : { progress_id: 0 };
        }
        default:
          throw new Error(`unexpected method: ${request.method}`);
      }
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
    await rm(root, { recursive: true, force: true });
  });
  return { control, frames, gatewayCalls, root, sessionFile, writes };
}

function runCli(args, agent, env = {}) {
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
      stdio: ['ignore', 'pipe', 'pipe'],
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
    child.once('error', reject);
    child.once('close', (status, signal) => resolvePromise({ status, signal, stdout, stderr }));
  });
}

function assertSingleJsonFailure(result, code, status) {
  assert.equal(result.status, status, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, '');
  const lines = result.stderr.trimEnd().split('\n');
  assert.equal(lines.length, 1, `expected one stderr line, got ${result.stderr}`);
  const payload = JSON.parse(lines[0]);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, code);
  return payload;
}

async function readPublishedArtifact(snapshotsDir) {
  if (snapshotsDir === undefined) return { error: 'no snapshots dir selected' };
  try {
    const entries = await readdir(snapshotsDir);
    if (entries.length !== 1) return { error: `expected one artifact directory, got ${entries}` };
    const path = join(snapshotsDir, entries[0], 'dump.json');
    const snapshot = JSON.parse(await readFile(path, 'utf8'));
    const files = await readdir(dirname(path));
    return { files, path, snapshot };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function assertMissing(path) {
  await assert.rejects(access(path), (error) => error?.code === 'ENOENT');
}

test('affected mutations reject a missing Agent snapshots dir before any IPC or warning', async (t) => {
  const agent = await startFakeAgent(t);

  for (const mutation of affectedMutations) {
    agent.frames.length = 0;
    const args =
      mutation.command === 'variable set-value'
        ? ['variable', 'set-value', '--scope', 'ghostscope', '--id', 'marker', '--value', '1']
        : mutation.args;
    const result = await runCli(args, agent);
    const payload = assertSingleJsonFailure(result, 'CONFIG', 5);
    assert.match(payload.error.message, /requires --snapshots-dir/);
    assert.deepEqual(agent.frames, [], `${mutation.command} reached IPC`);
  }
});

test('affected mutations reject Agent --no-snapshot before any IPC', async (t) => {
  const agent = await startFakeAgent(t);

  for (const mutation of affectedMutations) {
    agent.frames.length = 0;
    const snapshotsDir = join(agent.root, `disabled-${mutation.command.replaceAll(' ', '-')}`);
    const result = await runCli(
      [...mutation.args, '--snapshots-dir', snapshotsDir, '--no-snapshot'],
      agent,
    );
    const payload = assertSingleJsonFailure(result, 'CONFIG', 5);
    assert.match(payload.error.message, /forbids --no-snapshot/);
    assert.deepEqual(agent.frames, [], `${mutation.command} reached IPC`);
    await assertMissing(snapshotsDir);
  }
});

test('every typed mutation command label receives the exact missing-snapshot guard hint', async (t) => {
  const agent = await startFakeAgent(t);
  const ruleBodyPath = join(agent.root, 'guard-rule.json');
  await writeFile(ruleBodyPath, JSON.stringify({ id: 'rule1' }));
  assert.deepEqual(
    typedMutationCases.map(({ command }) => command).sort(),
    expectedTypedMutationSurfaces,
  );

  for (const mutation of typedMutationCases) {
    agent.frames.length = 0;
    const result = await runCli(mutation.args(ruleBodyPath), agent);
    const payload = assertSingleJsonFailure(result, 'CONFIG', 5);
    assert.equal(
      payload.error.message,
      AGENT_MODE_SNAPSHOTS_DIR_REQUIRED_MESSAGE,
      mutation.command,
    );
    assert.match(payload.error.hint, /pass --snapshots-dir <dir>/, mutation.command);
    assert.deepEqual(agent.frames, [], `${mutation.command} reached IPC`);
  }
});

test('every typed mutation command label receives the exact no-snapshot guard hint', async (t) => {
  const agent = await startFakeAgent(t);
  const ruleBodyPath = join(agent.root, 'guard-rule.json');
  await writeFile(ruleBodyPath, JSON.stringify({ id: 'rule1' }));

  for (const mutation of typedMutationCases) {
    agent.frames.length = 0;
    const snapshotsDir = join(agent.root, `forbidden-${mutation.command.replaceAll(' ', '-')}`);
    const result = await runCli(
      [...mutation.args(ruleBodyPath), '--snapshots-dir', snapshotsDir, '--no-snapshot'],
      agent,
    );
    const payload = assertSingleJsonFailure(result, 'CONFIG', 5);
    assert.equal(payload.error.message, AGENT_MODE_NO_SNAPSHOT_FORBIDDEN_MESSAGE, mutation.command);
    assert.match(payload.error.hint, /Remove --no-snapshot/, mutation.command);
    assert.deepEqual(agent.frames, [], `${mutation.command} reached IPC`);
    await assertMissing(snapshotsDir);
  }
});

test('snapshot hints require an exact guard message for every typed mutation label', () => {
  const nearMisses = [
    `${AGENT_MODE_SNAPSHOTS_DIR_REQUIRED_MESSAGE} (extra context)`,
    `${AGENT_MODE_NO_SNAPSHOT_FORBIDDEN_MESSAGE} (extra context)`,
  ];

  for (const command of expectedTypedMutationSurfaces) {
    for (const message of nearMisses) {
      const error = new ConfigError(message);
      error.__xggCmd = command.replaceAll(' ', '.');
      const payload = formatErrorJson(error);
      assert.doesNotMatch(payload.error.hint, /snapshots-dir|no-snapshot|checkpointed/i, command);
    }
  }
});

test('shared CONFIG failures do not inherit graph or node-authoring causes', async (t) => {
  const agent = await startFakeAgent(t);
  const mutations = typedMutationCases.filter(({ command }) =>
    [
      'rule edge add',
      'rule edge remove',
      'rule node add',
      'rule node remove',
      'rule node update',
    ].includes(command),
  );
  const cases = [
    {
      name: 'missing base URL',
      args: [],
      env: { XGG_AGENT_MODE: '0', XGG_BASE_URL: '' },
      message: 'missing --base-url or XGG_BASE_URL',
      hint: 'Pass --base-url <url> or set XGG_BASE_URL.',
    },
    {
      name: 'invalid timeout',
      args: ['--timeout', 'not-a-timeout'],
      env: { XGG_AGENT_MODE: '0' },
      message: '--timeout must be a positive decimal integer no greater than 2147483647',
      hint: 'Pass --timeout <ms> as a positive decimal integer within the limit shown in error.message.',
    },
  ];

  assert.equal(mutations.length, 5);
  for (const mutation of mutations) {
    for (const scenario of cases) {
      agent.frames.length = 0;
      const result = await runCli([...mutation.args(), ...scenario.args], agent, scenario.env);
      const payload = assertSingleJsonFailure(result, 'CONFIG', 5);
      assert.equal(
        payload.error.message,
        scenario.message,
        `${mutation.command}: ${scenario.name}`,
      );
      assert.equal(payload.error.hint, scenario.hint, `${mutation.command}: ${scenario.name}`);
      assert.doesNotMatch(
        payload.error.hint,
        /graph invariant|wiring|endpoint|node id|dependent edge|node shortcut|JSON field/i,
        `${mutation.command}: ${scenario.name}`,
      );
      assert.deepEqual(agent.frames, [], `${mutation.command}: ${scenario.name} reached IPC`);
    }
  }
});

test('valid snapshots keep graph guard hints actionable and prevent setGraph', async (t) => {
  const agent = await startFakeAgent(t);
  const cases = [
    {
      name: 'self-loop',
      nodes: [delay('wait')],
      from: 'wait:output',
      to: 'wait:input',
      message: /self-loop:/,
      hint: /cannot connect to itself/i,
    },
    {
      name: 'invalid-target-pin',
      nodes: [onLoad('start'), delay('wait')],
      from: 'start:output',
      to: 'wait:imput',
      message: /target pin "imput"/,
      hint: /availablePins/,
    },
    {
      name: 'cross-color',
      nodes: [onLoad('start'), condition('gate')],
      from: 'start:output',
      to: 'gate:condition',
      message: /cross-color edge:/,
      hint: /compatible pin colors/i,
    },
    {
      name: 'fan-in',
      nodes: [onLoad('first', ['wait.input']), onLoad('second'), delay('wait')],
      from: 'second:output',
      to: 'wait:input',
      message: /fan-in cap:/,
      hint: /signalOr.*logicOr.*logicAnd/,
    },
  ];

  for (const scenario of cases) {
    const snapshotsDir = join(agent.root, `graph-${scenario.name}`);
    agent.control.rule = { cfg: ruleSummary(), nodes: scenario.nodes };
    agent.frames.length = 0;
    agent.gatewayCalls.length = 0;
    const result = await runCli(
      [
        'rule',
        'edge',
        'add',
        '--rule-id',
        'rule1',
        '--from',
        scenario.from,
        '--to',
        scenario.to,
        '--snapshots-dir',
        snapshotsDir,
        '--no-var-check',
      ],
      agent,
    );
    const payload = assertSingleJsonFailure(result, 'CONFIG', 5);
    assert.match(payload.error.message, scenario.message, scenario.name);
    assert.match(payload.error.hint, scenario.hint, scenario.name);
    assert.doesNotMatch(payload.error.hint, /snapshot|XGG_AGENT_MODE/i, scenario.name);
    assert.equal(
      agent.gatewayCalls.some(({ method, kind }) => method === '/api/setGraph' || kind === 'write'),
      false,
      `${scenario.name} sent a write RPC`,
    );
    const artifact = await readPublishedArtifact(snapshotsDir);
    assert.equal(artifact.error, undefined, scenario.name);
    assert.equal(artifact.snapshot.rules.length, 1, scenario.name);
    assert.deepEqual(artifact.files, ['dump.json'], scenario.name);
  }
});

test('valid snapshots no longer turn a node validation error into snapshot advice', async (t) => {
  const agent = await startFakeAgent(t);
  const snapshotsDir = join(agent.root, 'node-invariant');
  agent.control.rule = { cfg: ruleSummary(), nodes: [onLoad('start')] };
  agent.gatewayCalls.length = 0;

  const result = await runCli(
    [
      'rule',
      'node',
      'add',
      '--rule-id',
      'rule1',
      '--type',
      'counter',
      '--threshold',
      '0',
      '--snapshots-dir',
      snapshotsDir,
    ],
    agent,
  );
  const payload = assertSingleJsonFailure(result, 'CONFIG', 5);
  assert.match(
    payload.error.message,
    /counter shortcut requires --threshold <N> as an integer >= 1/,
  );
  assert.match(payload.error.hint, /node shortcut flag or JSON field/);
  assert.doesNotMatch(payload.error.hint, /snapshot|XGG_AGENT_MODE/i);
  assert.equal(
    agent.gatewayCalls.some(({ method, kind }) => method === '/api/setGraph' || kind === 'write'),
    false,
  );
  const artifact = await readPublishedArtifact(snapshotsDir);
  assert.equal(artifact.error, undefined);
});

test('snapshot collection failures prevent every affected write RPC and artifact', async (t) => {
  const agent = await startFakeAgent(t);
  agent.control.failSnapshot = true;

  for (const mutation of affectedMutations) {
    agent.frames.length = 0;
    agent.gatewayCalls.length = 0;
    const snapshotsDir = join(agent.root, `failed-${mutation.command.replaceAll(' ', '-')}`);
    agent.control.snapshotsDir = snapshotsDir;
    const result = await runCli(
      [
        ...mutation.args,
        '--snapshots-dir',
        snapshotsDir,
        ...(mutation.command === 'variable set-value' ? ['--type', 'number'] : []),
      ],
      agent,
    );
    assertSingleJsonFailure(result, 'GATEWAY', 1);
    assert.equal(
      agent.gatewayCalls.some(({ method }) => method === mutation.writeMethod),
      false,
      `${mutation.command} wrote after checkpoint failure`,
    );
    assert.deepEqual(
      agent.gatewayCalls.map(({ method }) => method),
      mutation.command === 'variable set-value'
        ? ['/api/getVarConfig', '/api/getDevList', '/api/getGraphList']
        : ['/api/getDevList', '/api/getGraphList'],
    );
    await assertMissing(snapshotsDir);
  }
});

test('affected writes observe a complete rollback artifact before their write frame', async (t) => {
  const agent = await startFakeAgent(t);
  agent.control.failSnapshot = false;

  for (const mutation of affectedMutations) {
    agent.gatewayCalls.length = 0;
    agent.writes.length = 0;
    const snapshotsDir = join(agent.root, `valid-${mutation.command.replaceAll(' ', '-')}`);
    agent.control.snapshotsDir = snapshotsDir;
    const result = await runCli(
      [
        ...mutation.args,
        '--snapshots-dir',
        snapshotsDir,
        ...(mutation.command === 'variable set-value' ? ['--type', 'number'] : []),
      ],
      agent,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(agent.writes.length, 1);
    const observed = agent.writes[0];
    assert.equal(observed.request.method, mutation.writeMethod);
    assert.equal(observed.request.kind, 'write');
    assert.equal(observed.artifact.error, undefined);
    assert.deepEqual(observed.artifact.files, ['dump.json']);
    assert.equal(observed.artifact.snapshot.kind, 'xgg-pre-write-rollback');
    assert.equal(observed.artifact.snapshot.schemaVersion, 1);
    assert.deepEqual(observed.artifact.snapshot.devices, {});
    assert.deepEqual(observed.artifact.snapshot.rules, []);
    assert.deepEqual(observed.artifact.snapshot.variables, {});
    if (mutation.command.startsWith('backup ')) {
      assert.deepEqual(observed.artifact.snapshot.backup, {
        from: 'fds',
        ...(mutation.target !== undefined && { target: mutation.target }),
        list: [],
        config: { autoBackup: false },
      });
    } else {
      assert.equal('backup' in observed.artifact.snapshot, false);
    }
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.snapshot, observed.artifact.path);
    assert.equal((await stat(observed.artifact.path)).isFile(), true);
    assert.equal(agent.gatewayCalls.at(-1)?.method, mutation.writeMethod);
  }
});

test('source-derived typed mutation inventory declares and invokes the mutation funnel', async () => {
  const inventory = await deriveTypedMutationInventory();
  assert.deepEqual([...inventory.keys()].sort(), expectedTypedMutationSurfaces);

  const program = buildProgram();
  for (const [path, calls] of inventory) {
    assert.equal(
      calls.has('assertAgentModeOrSnapshotsDir'),
      true,
      `${path} reaches a typed write without the Agent mutation guard`,
    );
    const command = findCommand(program, path.split(' '));
    const longFlags = new Set(command.options.map((option) => option.long));
    assert.equal(longFlags.has('--snapshots-dir'), true, `${path} lacks --snapshots-dir`);
    assert.equal(longFlags.has('--no-snapshot'), true, `${path} lacks --no-snapshot`);
  }
});

async function deriveTypedMutationInventory() {
  const coreFiles = [
    join(repositoryRoot, 'packages/core/src/resources/backup.ts'),
    join(repositoryRoot, 'packages/core/src/resources/rules.ts'),
    join(repositoryRoot, 'packages/core/src/resources/variables.ts'),
    join(repositoryRoot, 'packages/core/src/usecases/probe-node.ts'),
  ];
  const writeExports = new Set();
  for (const file of coreFiles) {
    const source = parseSource(file, await readFile(file, 'utf8'));
    const functions = topLevelFunctions(source);
    let changed = true;
    while (changed) {
      changed = false;
      for (const info of functions.values()) {
        if (info.writes || [...info.calls].some((name) => functions.get(name)?.writes === true)) {
          if (!info.writes) changed = true;
          info.writes = true;
        }
      }
    }
    for (const [name, info] of functions) {
      if (info.exported && info.writes) writeExports.add(name);
    }
  }

  const inventory = new Map();
  const cliFiles = await sourceFiles(join(repositoryRoot, 'packages/cli/src/commands'));
  for (const file of cliFiles) {
    const source = parseSource(file, await readFile(file, 'utf8'));
    const importedWrites = importedIdentifiers(source, '@eyaeya/xgg-core', writeExports);
    visit(source, (node) => {
      if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return;
      if (node.expression.text !== 'wrap' || node.arguments.length < 2) return;
      const label = node.arguments[0];
      const callback = node.arguments[1];
      if (
        !ts.isStringLiteral(label) ||
        (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))
      ) {
        return;
      }
      const calls = calledIdentifiers(callback.body);
      if (![...calls].some((name) => importedWrites.has(name))) return;
      inventory.set(label.text.replaceAll('.', ' '), calls);
    });
  }
  return inventory;
}

function parseSource(file, contents) {
  return ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function topLevelFunctions(source) {
  const functions = new Map();
  for (const statement of source.statements) {
    if (
      !ts.isFunctionDeclaration(statement) ||
      statement.name === undefined ||
      statement.body === undefined
    ) {
      continue;
    }
    const calls = calledIdentifiers(statement.body);
    const directWrite = directWriteCall(statement.body);
    const exported =
      statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ===
      true;
    functions.set(statement.name.text, { calls, exported, writes: directWrite });
  }
  return functions;
}

function directWriteCall(node) {
  let writes = false;
  visit(node, (candidate) => {
    if (writes || !ts.isCallExpression(candidate) || !ts.isIdentifier(candidate.expression)) return;
    if (candidate.expression.text === 'callBackup') {
      writes = candidate.arguments.some(
        (argument) => ts.isStringLiteral(argument) && argument.text === 'write',
      );
      return;
    }
    if (candidate.expression.text !== 'agentCall') return;
    const options = candidate.arguments[0];
    if (!ts.isObjectLiteralExpression(options)) return;
    writes = options.properties.some(
      (property) =>
        ts.isPropertyAssignment(property) &&
        property.name.getText() === 'kind' &&
        ts.isStringLiteral(property.initializer) &&
        property.initializer.text === 'write',
    );
  });
  return writes;
}

function calledIdentifiers(node) {
  const calls = new Set();
  visit(node, (candidate) => {
    if (ts.isCallExpression(candidate) && ts.isIdentifier(candidate.expression)) {
      calls.add(candidate.expression.text);
    }
  });
  return calls;
}

function importedIdentifiers(source, moduleName, allowed) {
  const imported = new Set();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.text !== moduleName)
      continue;
    for (const element of statement.importClause?.namedBindings?.elements ?? []) {
      const importedName = element.propertyName?.text ?? element.name.text;
      if (allowed.has(importedName)) imported.add(element.name.text);
    }
  }
  return imported;
}

function visit(node, visitor) {
  visitor(node);
  ts.forEachChild(node, (child) => visit(child, visitor));
}

async function sourceFiles(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path);
  }
  return files;
}

function findCommand(program, path) {
  let current = program;
  for (const name of path) {
    const next = current.commands.find((command) => command.name() === name);
    assert.ok(next, `missing command ${path.join(' ')}`);
    current = next;
  }
  return current;
}

assert.equal(relative(repositoryRoot, cliPath), 'packages/cli/dist/cli.js');
