import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { GatewayError, dumpBeforeWrite } from '../dist/index.js';
import { GraphSetRequest } from '../dist/schemas/rule.js';
import { VariableCreateRequest } from '../dist/schemas/variable.js';

const baseUrl = 'http://gateway.invalid';
const agentStartedAt = '2026-07-19T00:00:00.000Z';

function ruleSummary(id = 'rule-1') {
  return {
    id,
    enable: true,
    uiType: 'rule',
    userData: {
      name: 'snapshot integrity test',
      transform: { x: 0, y: 0, scale: 1, rotate: 0 },
      lastUpdateTime: 123,
      version: 0,
    },
  };
}

function ruleNodes() {
  return [
    {
      id: 'start',
      type: 'onLoad',
      cfg: {
        pos: { x: 0, y: 0, width: 200, height: 120 },
        name: 'onLoad',
        version: 1,
      },
      inputs: {},
      outputs: { output: ['wait.input'] },
      props: {},
    },
    {
      id: 'wait',
      type: 'delay',
      cfg: {
        pos: { x: 240, y: 0, width: 320, height: 120 },
        name: 'delay',
        version: 1,
        unit: 's',
        value: 1,
      },
      inputs: { input: null },
      outputs: { output: [] },
      props: { timeout: 1_000 },
    },
  ];
}

function fakeGateway(respond) {
  const calls = [];
  return {
    calls,
    store: {
      read: async () => ({
        host: baseUrl,
        pid: process.pid,
        socketPath: '/tmp/xgg-snapshot-test-unused.sock',
        agentStartedAt,
        agentVersion: 'test',
        lastValidatedAt: agentStartedAt,
      }),
    },
    ipcClient: () => ({
      request: async (method, params) => {
        if (method === '$ping') return { host: baseUrl, agentStartedAt };
        calls.push({ method, params });
        return respond(method, params);
      },
      close: () => {},
    }),
  };
}

test('pre-write artifact contains replayable rules, variables, and backup context', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'xgg-snapshot-integrity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshotsDir = join(root, 'snapshots');
  const cfg = ruleSummary();
  const nodes = ruleNodes();
  const variable = {
    type: 'number',
    value: 41,
    userData: { name: 'Marker', source: 'fixture' },
  };
  const target = {
    did: 'backup-did',
    ts: '2026-07-19T00:00:00Z',
    fileName: 'before-change.bak',
    deviceName: 'Offline fixture',
  };
  const gateway = fakeGateway(async (method, params) => {
    switch (method) {
      case '/api/getDevList':
        return { devList: {} };
      case '/api/getGraphList':
        return [cfg];
      case '/api/getGraph':
        assert.deepEqual(params, { id: cfg.id });
        return { id: cfg.id, nodes };
      case '/api/getVarScopeList':
        return { scopes: ['global'] };
      case '/api/getVarList':
        assert.deepEqual(params, { scope: 'global' });
        return { marker: variable };
      case '/api/getBackupList':
        assert.deepEqual(params, { from: 'fds' });
        return { list: [target] };
      case '/api/getBackupConfig':
        assert.deepEqual(params, { from: 'fds' });
        return { autoBackup: true, autoBackupLimit: 7 };
      default:
        throw new Error(`unexpected method: ${method}`);
    }
  });

  const path = await dumpBeforeWrite({
    baseUrl,
    store: gateway.store,
    ipcClient: gateway.ipcClient,
    snapshotsDir,
    backup: { from: 'fds', target },
  });
  const snapshot = JSON.parse(await readFile(path, 'utf8'));

  assert.equal(snapshot.kind, 'xgg-pre-write-rollback');
  assert.equal(snapshot.schemaVersion, 1);
  assert.deepEqual(snapshot.devices, {});
  assert.deepEqual(snapshot.rules, [{ id: cfg.id, cfg, nodes }]);
  assert.deepEqual(snapshot.variables, { global: { marker: variable } });
  assert.deepEqual(snapshot.backup, {
    from: 'fds',
    target,
    list: [target],
    config: { autoBackup: true, autoBackupLimit: 7 },
  });
  assert.match(snapshot.capturedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal('errors' in snapshot, false);
  assert.equal('variableScopes' in snapshot, false);

  // A rule can be fed back to the graph-set shape, and a variable entry has
  // every create payload field needed to reconstruct its config and value.
  assert.deepEqual(GraphSetRequest.parse(snapshot.rules[0]), { id: cfg.id, cfg, nodes });
  const variableCreate = {
    scope: 'global',
    id: 'marker',
    type: snapshot.variables.global.marker.type,
    value: snapshot.variables.global.marker.value,
    userData: snapshot.variables.global.marker.userData,
  };
  assert.deepEqual(VariableCreateRequest.parse(variableCreate), {
    scope: 'global',
    id: 'marker',
    ...variable,
  });

  assert.deepEqual(
    gateway.calls.map((call) => call.method),
    [
      '/api/getDevList',
      '/api/getGraphList',
      '/api/getGraph',
      '/api/getVarScopeList',
      '/api/getVarList',
      '/api/getBackupList',
      '/api/getBackupConfig',
    ],
  );
  assert.deepEqual(await readdir(dirname(path)), ['dump.json']);
  if (process.platform !== 'win32') {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
});

test('pre-write collection fails closed and creates no artifact on a required read failure', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'xgg-snapshot-fail-closed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshotsDir = join(root, 'snapshots');
  const cfg = ruleSummary();
  const gateway = fakeGateway(async (method) => {
    if (method === '/api/getDevList') return { devList: {} };
    if (method === '/api/getGraphList') return [cfg];
    if (method === '/api/getGraph') {
      throw new GatewayError('rule body unavailable', { gatewayCode: -1 });
    }
    throw new Error(`unexpected method: ${method}`);
  });

  await assert.rejects(
    dumpBeforeWrite({
      baseUrl,
      store: gateway.store,
      ipcClient: gateway.ipcClient,
      snapshotsDir,
    }),
    (error) => error instanceof GatewayError && /unavailable/.test(error.message),
  );
  await assert.rejects(stat(snapshotsDir), (error) => error?.code === 'ENOENT');
  assert.deepEqual(
    gateway.calls.map((call) => call.method),
    ['/api/getDevList', '/api/getGraphList', '/api/getGraph'],
  );
});
