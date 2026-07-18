import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createIpcServer } from '@eyaeya/xgg-core';

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
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
  ];

  for (const args of scenarios) {
    agent.frames.length = 0;
    assertSingleConfig(await runCli(args, agent));
    assert.deepEqual(agent.frames, []);
  }
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
