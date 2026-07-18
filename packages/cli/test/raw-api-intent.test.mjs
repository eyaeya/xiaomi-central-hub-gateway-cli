import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { GatewayError, NotConfirmedError, createIpcServer } from '@eyaeya/xgg-core';

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const baseUrl = 'http://raw-api-intent.test';
const agentStartedAt = '2026-07-19T00:00:00.000Z';

function endpointPath(root) {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\xgg-raw-api-${process.pid}-${randomUUID()}`;
  }
  return join(root, 'agent.sock');
}

async function startFakeAgent(t) {
  const root = await mkdtemp(join(tmpdir(), 'xgg-raw-api-intent-'));
  const socketPath = endpointPath(root);
  const sessionFile = join(root, 'session.json');
  const frames = [];
  const gatewayCalls = [];
  const attempts = [];
  const control = {
    behavior: 'success',
    failSnapshot: false,
    snapshotsDir: undefined,
  };

  const server = await createIpcServer({
    path: socketPath,
    handler: async (request) => {
      frames.push(request);
      if (request.method === '$ping') return { host: baseUrl, agentStartedAt };
      gatewayCalls.push(request);
      if (control.failSnapshot && request.method === '/api/getGraphList') {
        throw new GatewayError('rules unavailable during raw checkpoint', { gatewayCode: -1 });
      }
      switch (request.method) {
        case '/api/getDevList':
          return { devList: {} };
        case '/api/getGraphList':
          return [];
        case '/api/getVarScopeList':
          return { scopes: [] };
        case '/api/getBackupList':
          return { list: [] };
        case '/api/getBackupConfig':
          return { autoBackup: false };
        default:
          break;
      }

      const artifact =
        request.kind === 'write'
          ? await readPublishedArtifact(control.snapshotsDir)
          : { error: undefined };
      attempts.push({ request, artifact });
      if (control.behavior === 'daemon-timeout') {
        throw new NotConfirmedError(
          `gateway call ${request.method} was not confirmed by the fake daemon`,
          { method: request.method },
        );
      }
      if (control.behavior === 'local-timeout') {
        return await new Promise(() => {});
      }
      return { accepted: true };
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
  return { attempts, control, frames, gatewayCalls, root, sessionFile };
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

test('known writes require --kind write and conflict with declared read before IPC', async (t) => {
  const agent = await startFakeAgent(t);
  for (const intent of [[], ['--kind', 'read']]) {
    agent.frames.length = 0;
    const result = await runCli(
      ['api', '/api/setVarValue', '--params', '{"scope":"global","id":"x","value":1}', ...intent],
      agent,
    );
    const payload = assertSingleJsonFailure(result, 'CONFIG', 5);
    assert.match(payload.error.message, /requires explicit write intent/);
    assert.deepEqual(agent.frames, []);
  }
});

test('Agent mode rejects missing or disabled raw-write snapshots before IPC', async (t) => {
  const agent = await startFakeAgent(t);
  const disabledDir = join(agent.root, 'disabled');
  const cases = [
    { args: [], message: /requires --snapshots-dir/ },
    {
      args: ['--snapshots-dir', disabledDir, '--no-snapshot'],
      message: /forbids --no-snapshot/,
    },
  ];
  for (const scenario of cases) {
    agent.frames.length = 0;
    const result = await runCli(
      ['api', '/api/futureMutation', '--kind', 'write', ...scenario.args],
      agent,
    );
    const payload = assertSingleJsonFailure(result, 'CONFIG', 5);
    assert.match(payload.error.message, scenario.message);
    assert.deepEqual(agent.frames, []);
  }
  await assertMissing(disabledDir);
});

test('known and future raw writes publish a complete artifact before a write frame', async (t) => {
  const agent = await startFakeAgent(t);
  const mutations = [
    {
      method: '/api/setVarValue',
      params: '{"scope":"global","id":"x","value":1}',
    },
    {
      backup: {
        from: 'fds',
        target: {
          did: 'did-1',
          ts: 'ts-1',
          fileName: 'one.bak',
          deviceName: 'Gateway',
          self: true,
          futureMeta: { generation: 2 },
        },
        list: [],
        config: { autoBackup: false },
      },
      method: '/api/loadBackup',
      params:
        '{"from":"fds","params":{"did":"did-1","ts":"ts-1","fileName":"one.bak","deviceName":"Gateway","self":true,"futureMeta":{"generation":2}}}',
    },
    { method: '/api/futureMutation', params: '{"future":true}' },
  ];

  for (const mutation of mutations) {
    agent.attempts.length = 0;
    agent.gatewayCalls.length = 0;
    const snapshotsDir = join(
      agent.root,
      `valid-${mutation.method.replaceAll('/', '-').replaceAll(':', '-')}`,
    );
    agent.control.snapshotsDir = snapshotsDir;
    agent.control.behavior = 'success';
    const result = await runCli(
      [
        'api',
        mutation.method,
        '--kind',
        'write',
        '--params',
        mutation.params,
        '--snapshots-dir',
        snapshotsDir,
      ],
      agent,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(agent.attempts.length, 1);
    const observed = agent.attempts[0];
    assert.equal(observed.request.method, mutation.method);
    assert.equal(observed.request.kind, 'write');
    assert.equal(observed.artifact.error, undefined);
    assert.deepEqual(observed.artifact.files, ['dump.json']);
    assert.equal(observed.artifact.snapshot.kind, 'xgg-pre-write-rollback');
    assert.equal(observed.artifact.snapshot.schemaVersion, 1);
    assert.deepEqual(observed.artifact.snapshot.devices, {});
    assert.deepEqual(observed.artifact.snapshot.rules, []);
    assert.deepEqual(observed.artifact.snapshot.variables, {});
    if (mutation.backup !== undefined) {
      assert.deepEqual(observed.artifact.snapshot.backup, mutation.backup);
    } else {
      assert.equal('backup' in observed.artifact.snapshot, false);
    }
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.method, mutation.method);
    assert.equal(payload.kind, 'write');
    assert.equal(payload.snapshot, observed.artifact.path);
    assert.equal((await stat(observed.artifact.path)).isFile(), true);
    assert.equal(agent.gatewayCalls.at(-1)?.method, mutation.method);
  }
});

test('non-Agent --no-snapshot preserves future raw backup request shapes', async (t) => {
  const agent = await startFakeAgent(t);
  const params = { futureShape: { generation: 2 } };
  const result = await runCli(
    [
      'api',
      '/api/loadBackup',
      '--kind',
      'write',
      '--no-snapshot',
      '--params',
      JSON.stringify(params),
    ],
    agent,
    { XGG_AGENT_MODE: '0' },
  );
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.kind, 'write');
  assert.equal(payload.snapshot, null);
  assert.deepEqual(
    agent.gatewayCalls.map(({ method }) => method),
    ['/api/loadBackup'],
  );
  assert.equal(agent.attempts.length, 1);
  assert.deepEqual(agent.attempts[0].request.params, params);
  assert.equal(agent.attempts[0].request.kind, 'write');
});

test('snapshot collection failure prevents the raw write and leaves no artifact', async (t) => {
  const agent = await startFakeAgent(t);
  const snapshotsDir = join(agent.root, 'failed-snapshot');
  agent.control.failSnapshot = true;
  agent.control.snapshotsDir = snapshotsDir;
  const result = await runCli(
    ['api', '/api/futureMutation', '--kind', 'write', '--snapshots-dir', snapshotsDir],
    agent,
  );
  assertSingleJsonFailure(result, 'GATEWAY', 1);
  assert.deepEqual(
    agent.gatewayCalls.map(({ method }) => method),
    ['/api/getDevList', '/api/getGraphList'],
  );
  assert.deepEqual(agent.attempts, []);
  await assertMissing(snapshotsDir);
});

test('unknown raw methods support default or explicit read without the mutation funnel', async (t) => {
  const agent = await startFakeAgent(t);
  const snapshotsDir = join(agent.root, 'must-not-exist');
  agent.control.behavior = 'success';
  for (const intent of [[], ['--kind', 'read']]) {
    agent.attempts.length = 0;
    const result = await runCli(
      ['api', '/api/futureRead', '--params', '{"probe":true}', ...intent],
      agent,
    );
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.kind, 'read');
    assert.equal('snapshot' in payload, false);
    assert.equal(agent.attempts.length, 1);
    assert.equal(agent.attempts[0].request.kind, 'read');
  }
  await assertMissing(snapshotsDir);
});

test('raw timeout classification follows the declared intent across IPC', async (t) => {
  const agent = await startFakeAgent(t);
  const cases = [
    {
      behavior: 'local-timeout',
      code: 'NOT_CONFIRMED',
      kind: 'write',
      method: '/api/futureLocalWriteTimeout',
      status: 2,
    },
    {
      behavior: 'daemon-timeout',
      code: 'NOT_CONFIRMED',
      kind: 'write',
      method: '/api/futureDaemonWriteTimeout',
      status: 2,
    },
    {
      behavior: 'local-timeout',
      code: 'NETWORK',
      kind: 'read',
      method: '/api/futureReadTimeout',
      status: 1,
    },
  ];

  for (const scenario of cases) {
    agent.attempts.length = 0;
    agent.control.behavior = scenario.behavior;
    const snapshotsDir = join(agent.root, `timeout-${scenario.kind}-${scenario.behavior}`);
    agent.control.snapshotsDir = snapshotsDir;
    const result = await runCli(
      [
        'api',
        scenario.method,
        '--kind',
        scenario.kind,
        '--timeout',
        '500',
        ...(scenario.kind === 'write' ? ['--snapshots-dir', snapshotsDir] : []),
      ],
      agent,
    );
    assertSingleJsonFailure(result, scenario.code, scenario.status);
    assert.equal(agent.attempts.length, 1);
    assert.equal(agent.attempts[0].request.kind, scenario.kind);
    if (scenario.kind === 'write') {
      assert.equal(agent.attempts[0].artifact.error, undefined);
      assert.equal(agent.attempts[0].artifact.snapshot.kind, 'xgg-pre-write-rollback');
    } else {
      await assertMissing(snapshotsDir);
    }
  }
});

test('api help documents intent, snapshots, and known-write behavior', async (t) => {
  const agent = await startFakeAgent(t);
  const result = await runCli(['api', '--help'], agent);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--kind <read\|write>/);
  assert.match(result.stdout, /--snapshots-dir <path>/);
  assert.match(result.stdout, /--no-snapshot/);
  assert.match(result.stdout, /known mutations which require --kind write/);
  assert.deepEqual(agent.frames, []);
});
