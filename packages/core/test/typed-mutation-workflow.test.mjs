import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ConfigError,
  NetworkError,
  NotConfirmedError,
  SchemaError,
  addEdge,
  addNode,
  agentCall,
  createBackup,
  createInMemoryMutationLeaseCoordinator,
  createIpcServer,
  createRule,
  createVariable,
  deleteBackup,
  deleteGraph,
  deleteVariable,
  disableRule,
  downloadAndGenerateBackup,
  downloadBackup,
  enableRule,
  harvestBaseline,
  loadBackup,
  relayoutGraph,
  removeEdge,
  removeNode,
  renameRule,
  setBackupConfig,
  setGraph,
  setRuleTags,
  setVariableConfig,
  setVariableValue,
  updateNode,
  upsertGraph,
  withMutationWorkflow,
} from '../dist/index.js';

const baseUrl = 'http://typed-mutation.test';
const startedAt = '2026-07-19T00:00:00.000Z';
const ruleId = 'rule1';

function endpoint(dir, name) {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\xgg-typed-${process.pid}-${name}-${randomUUID()}`
    : join(dir, `${name}.sock`);
}

function realSessionStore(socketPath) {
  return {
    async read() {
      return {
        host: baseUrl,
        pid: process.pid,
        socketPath,
        agentStartedAt: startedAt,
        agentVersion: 'test',
        lastValidatedAt: startedAt,
      };
    },
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function position(width = 200, height = 120) {
  return { x: 0, y: 0, width, height };
}

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

function delayNode(id) {
  return {
    id,
    type: 'delay',
    cfg: { pos: position(320), name: 'delay', version: 1, unit: 's', value: 1 },
    inputs: { input: null },
    outputs: { output: [] },
    props: { timeout: 1_000 },
  };
}

function summary(id = ruleId) {
  return {
    id,
    enable: false,
    uiType: 'rule',
    userData: {
      name: 'typed mutation contract',
      transform: { x: 0, y: 0, scale: 1, rotate: 0 },
      lastUpdateTime: 0,
      version: 0,
    },
  };
}

function graph(nodes = [onLoad('source'), delayNode('target')]) {
  return { id: ruleId, cfg: summary(), nodes };
}

const backup = {
  ts: '2026-07-19T00:00:00.000Z',
  did: 'backup-did',
  fileName: 'probe.bak',
};

const harvestProduct = {
  type: 'onLoad',
  variant: 'minimal',
  progressId: 1,
  did: backup.did,
  ts: backup.ts,
  fileName: backup.fileName,
};

async function startHarvestAgent(t, respond) {
  const dir = await mkdtemp(join(tmpdir(), 'xgg-harvest-agent-'));
  const socketPath = endpoint(dir, 'agent');
  const calls = [];
  const mutationLeases = createInMemoryMutationLeaseCoordinator();
  const server = await createIpcServer({
    path: socketPath,
    mutationLeases,
    handler: async (request, context) => {
      if (request.method === '$ping') return { host: baseUrl, agentStartedAt: startedAt };
      calls.push({ method: request.method, params: request.params, leaseId: context.leaseId });
      return respond(request, context);
    },
  });
  t.after(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    calls,
    mutationLeases,
    outDir: join(dir, 'out'),
    store: realSessionStore(socketPath),
  };
}

function defaultResponse(method) {
  switch (method) {
    case '/api/getGraphList':
      return [summary()];
    case '/api/getGraph':
      return { id: ruleId, nodes: [onLoad('source'), delayNode('target')] };
    case '/api/getVarList':
      return {};
    case '/api/getBackupProgress':
      return { progress: 100 };
    case '/api/loadBackup':
      return { progress_id: 7 };
    case '/api/createBackup':
    case '/api/downloadBackup':
    case '/api/deleteBackup':
    case '/api/setBackupConfig':
      return 0;
    default:
      return null;
  }
}

function workflowFixture(respond = defaultResponse) {
  const trace = [];
  let storeReads = 0;
  const deps = {
    baseUrl,
    timeoutMs: 100,
    store: {
      async read() {
        storeReads += 1;
        return {
          host: baseUrl,
          pid: 1,
          socketPath: '/tmp/xgg-typed-mutation-unused.sock',
          agentStartedAt: startedAt,
          agentVersion: 'test',
          lastValidatedAt: startedAt,
        };
      },
    },
    ipcClient: () => {
      let leaseId;
      return {
        async request(method, params, options) {
          if (method === '$ping') {
            trace.push({ kind: 'control', method });
            return { host: baseUrl, agentStartedAt: startedAt };
          }
          if (method === '$mutation.acquire') {
            leaseId = `lease:${params.operation}`;
            trace.push({ kind: 'acquire', method, params, leaseId });
            return { leaseId };
          }
          if (method === '$mutation.release') {
            assert.equal(params.leaseId, leaseId);
            trace.push({ kind: 'release', method, params, leaseId });
            return { ok: true };
          }
          if (method === '$mutation.fence') {
            assert.equal(params.leaseId, leaseId);
            trace.push({ kind: 'fence', method, params, leaseId });
            return { ok: true };
          }
          assert.equal(options?.leaseId, leaseId, `${method} did not inherit the workflow lease`);
          trace.push({ kind: 'gateway', method, params, leaseId });
          return respond(method, params);
        },
        close() {
          trace.push({ kind: 'control', method: '$close' });
        },
      };
    },
  };
  return {
    deps,
    trace,
    get storeReads() {
      return storeReads;
    },
  };
}

const typedMutators = [
  {
    name: 'enableRule',
    operation: 'rule.enable',
    invoke: (deps) => enableRule(ruleId, deps, { validate: false }),
  },
  { name: 'disableRule', operation: 'rule.disable', invoke: (deps) => disableRule(ruleId, deps) },
  {
    name: 'renameRule',
    operation: 'rule.rename',
    invoke: (deps) => renameRule(ruleId, 'renamed', deps),
  },
  {
    name: 'setRuleTags',
    operation: 'rule.set-tags',
    invoke: (deps) => setRuleTags(ruleId, ['tag'], deps),
  },
  {
    name: 'setGraph',
    operation: 'rule.set-graph',
    invoke: (deps) => setGraph(graph(), deps, { validate: false }),
  },
  {
    name: 'upsertGraph',
    operation: 'rule.upsert',
    invoke: (deps) => upsertGraph(graph(), deps, { validate: false }),
  },
  {
    name: 'createRule',
    operation: 'rule.create',
    invoke: (deps) => createRule(graph([]), deps),
  },
  { name: 'deleteGraph', operation: 'rule.delete', invoke: (deps) => deleteGraph(ruleId, deps) },
  {
    name: 'addNode',
    operation: 'rule.node.add',
    invoke: (deps) =>
      addNode({ ruleId, node: onLoad('added'), validate: false, varCheck: false }, deps),
  },
  {
    name: 'updateNode',
    operation: 'rule.node.update',
    invoke: (deps) =>
      updateNode(
        { ruleId, nodeId: 'target', patch: { cfg: { name: 'updated' } }, varCheck: false },
        deps,
      ),
  },
  {
    name: 'removeNode',
    operation: 'rule.node.remove',
    invoke: (deps) => removeNode({ ruleId, nodeId: 'target' }, deps),
  },
  {
    name: 'addEdge',
    operation: 'rule.edge.add',
    invoke: (deps) =>
      addEdge(
        {
          ruleId,
          from: { nodeId: 'source', pin: 'output' },
          to: { nodeId: 'target', pin: 'input' },
          varCheck: false,
        },
        deps,
      ),
  },
  {
    name: 'removeEdge',
    operation: 'rule.edge.remove',
    respond: (method) => {
      if (method === '/api/getGraph') {
        return { id: ruleId, nodes: [onLoad('source', ['target.input']), delayNode('target')] };
      }
      return defaultResponse(method);
    },
    invoke: (deps) =>
      removeEdge(
        {
          ruleId,
          from: { nodeId: 'source', pin: 'output' },
          to: { nodeId: 'target', pin: 'input' },
          varCheck: false,
        },
        deps,
      ),
  },
  {
    name: 'relayoutGraph',
    operation: 'rule.layout',
    invoke: (deps) => relayoutGraph(ruleId, deps, { validate: false, varCheck: false }),
  },
  {
    name: 'createVariable',
    operation: 'variable.create',
    invoke: (deps) =>
      createVariable(
        { scope: 'global', id: 'probe', type: 'number', value: 1, userData: { name: 'probe' } },
        deps,
      ),
  },
  {
    name: 'deleteVariable',
    operation: 'variable.delete',
    invoke: (deps) => deleteVariable({ scope: 'global', id: 'probe' }, deps),
  },
  {
    name: 'setVariableConfig',
    operation: 'variable.set-config',
    invoke: (deps) =>
      setVariableConfig({ scope: 'global', id: 'probe', userData: { name: 'renamed' } }, deps),
  },
  {
    name: 'setVariableValue',
    operation: 'variable.set-value',
    invoke: (deps) => setVariableValue({ scope: 'global', id: 'probe', value: 2 }, deps),
  },
  {
    name: 'createBackup',
    operation: 'backup.create',
    invoke: (deps) => createBackup({ from: 'fds', fileName: backup.fileName }, deps),
  },
  {
    name: 'downloadBackup',
    operation: 'backup.download',
    invoke: (deps) => downloadBackup({ from: 'fds', backup }, deps),
  },
  {
    name: 'downloadAndGenerateBackup',
    operation: 'backup.cloud-export',
    respond: (method) => {
      if (method === '/api/generateBackup') {
        return { version: 2, rules: [], variables: {} };
      }
      return defaultResponse(method);
    },
    invoke: (deps) =>
      downloadAndGenerateBackup({ from: 'fds', backup }, deps, {
        pollIntervalMs: 1,
        pollTimeoutMs: 100,
      }),
  },
  {
    name: 'loadBackup',
    operation: 'backup.load',
    invoke: (deps) =>
      loadBackup({ from: 'fds', backup }, deps, { pollIntervalMs: 1, pollTimeoutMs: 100 }),
  },
  {
    name: 'deleteBackup',
    operation: 'backup.delete',
    invoke: (deps) => deleteBackup({ from: 'fds', backup }, deps),
  },
  {
    name: 'setBackupConfig',
    operation: 'backup.config.set',
    invoke: (deps) => setBackupConfig({ from: 'fds', autoBackup: true }, deps),
  },
];

test('all 24 public typed resource mutators are explicitly inventoried', async () => {
  const files = ['rules.ts', 'variables.ts', 'backup.ts'];
  const source = (
    await Promise.all(
      files.map((file) => readFile(new URL(`../src/resources/${file}`, import.meta.url), 'utf8')),
    )
  ).join('\n');
  const mutationName =
    /^(?:add|create|delete|disable|download|enable|load|relayout|remove|rename|set|update|upsert)/;
  const discovered = [
    ...new Set(
      [...source.matchAll(/export (?:async )?function (\w+)\s*\(/g)]
        .map((match) => match[1])
        .filter((name) => mutationName.test(name)),
    ),
  ].sort();
  const expected = typedMutators.map((entry) => entry.name).sort();
  assert.deepEqual(discovered, expected);
  assert.equal(expected.length, 24);
  for (const entry of typedMutators) {
    assert.match(
      source,
      new RegExp(
        `withResourceMutationWorkflow\\(deps, ['"]${entry.operation.replaceAll('.', '\\.')}`,
      ),
      `${entry.name} is missing its named resource workflow`,
    );
  }
});

test('all 24 public typed mutators acquire once and lease every live read/write', async () => {
  for (const entry of typedMutators) {
    const fixture = workflowFixture(entry.respond);
    await entry.invoke(fixture.deps);
    const acquire = fixture.trace.filter((event) => event.kind === 'acquire');
    const release = fixture.trace.filter((event) => event.kind === 'release');
    const gateway = fixture.trace.filter((event) => event.kind === 'gateway');
    assert.deepEqual(
      acquire.map((event) => event.params.operation),
      [entry.operation],
      entry.name,
    );
    assert.equal(release.length, 1, entry.name);
    assert.ok(gateway.length > 0, entry.name);
    assert.equal(fixture.storeReads, 1, entry.name);
    assert.ok(
      gateway.every((event) => event.leaseId === acquire[0].leaseId),
      entry.name,
    );
  }
});

test('deterministic invalid typed input still fails before session access', async () => {
  let reads = 0;
  const deps = {
    baseUrl,
    store: {
      async read() {
        reads += 1;
        throw new Error('session access must not happen');
      },
    },
  };

  await assert.rejects(
    createVariable(
      { scope: 'global', id: 'bad-id', type: 'number', value: 1, userData: { name: 'bad' } },
      deps,
    ),
    SchemaError,
  );
  await assert.rejects(setGraph({ ...graph(), nodes: 'not-an-array' }, deps), SchemaError);
  await assert.rejects(addNode({ ruleId }, deps), ConfigError);
  const invalidDeviceShortcuts = [
    { type: 'deviceInput', deviceDid: 'd' },
    { type: 'deviceOutput', deviceDid: 'd', deviceProperty: 'on' },
    { type: 'deviceOutput', deviceDid: 'd' },
    { type: 'deviceGet', deviceDid: 'd' },
    { type: 'deviceGetSetVar', deviceDid: 'd', deviceEvent: 'changed' },
    { type: 'deviceGetSetVar', deviceDid: 'd', varScope: 'global', varId: 'v' },
    { type: 'deviceGetSetVar', deviceDid: 'd', deviceProperty: 'value' },
    {
      type: 'deviceInputSetVar',
      deviceDid: 'd',
      deviceEvent: 'changed',
      deviceProperty: 'value',
    },
    {
      type: 'deviceInputSetVar',
      deviceDid: 'd',
      deviceEvent: 'changed',
      deviceEventArgVars: ['1=global.a'],
      varScope: 'global',
      varId: 'a',
    },
    { type: 'deviceInputSetVar', deviceDid: 'd', varScope: 'global', varId: 'v' },
    { type: 'deviceInputSetVar', deviceDid: 'd', deviceProperty: 'value' },
    { type: 'futureDeviceShortcut', deviceDid: 'd' },
  ];
  for (const shortcut of invalidDeviceShortcuts) {
    await assert.rejects(addNode({ ruleId, shortcut }, deps), ConfigError);
  }
  await assert.rejects(loadBackup({ from: 'fds' }, deps), SchemaError);
  for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
    await assert.rejects(
      loadBackup({ from: 'fds', backup }, deps, { pollIntervalMs: value }),
      ConfigError,
    );
    await assert.rejects(
      harvestBaseline(harvestProduct, {
        baseUrl,
        outDir: '/tmp/xgg-invalid-timing-must-not-write',
        from: 'fds',
        pollTimeoutMs: value,
        store: deps.store,
      }),
      ConfigError,
    );
  }
  assert.equal(reads, 0);
});

test('between shortcuts require both explicit bounds before session, spec, lease, or graph access', async () => {
  const effects = { session: 0, spec: 0, ipcClient: 0 };
  const deps = {
    baseUrl,
    store: {
      async read() {
        effects.session += 1;
        throw new Error('session access must not happen');
      },
    },
    ipcClient: () => {
      effects.ipcClient += 1;
      throw new Error('lease or graph access must not happen');
    },
  };
  const getDeviceSpec = async () => {
    effects.spec += 1;
    throw new Error('spec access must not happen');
  };
  const families = [
    {
      type: 'deviceInput',
      deviceDid: 'device1',
      deviceProperty: 'temperature',
    },
    {
      type: 'deviceGet',
      deviceDid: 'device1',
      deviceProperty: 'temperature',
    },
    {
      type: 'varChange',
      varScope: 'global',
      varId: 'temperature',
      varType: 'number',
    },
    {
      type: 'varGet',
      varScope: 'global',
      varId: 'temperature',
      varType: 'number',
    },
  ];

  for (const family of families) {
    for (const supplied of [{ threshold2: 1 }, { threshold: 0 }]) {
      await assert.rejects(
        addNode(
          {
            ruleId,
            shortcut: { ...family, op: 'between', ...supplied },
            getDeviceSpec,
            varCheck: false,
          },
          deps,
        ),
        (error) =>
          error instanceof ConfigError &&
          /--op between requires explicit --threshold \(v1\) and --threshold2 \(v2\)/.test(
            error.message,
          ),
        `${family.type}: ${JSON.stringify(supplied)}`,
      );
    }
  }

  assert.deepEqual(effects, { session: 0, spec: 0, ipcClient: 0 });
});

test('deviceInput mode conflicts fail before session, spec, lease, or graph access', async () => {
  const effects = { session: 0, spec: 0, ipcClient: 0 };
  const deps = {
    baseUrl,
    store: {
      async read() {
        effects.session += 1;
        throw new Error('session access must not happen');
      },
    },
    ipcClient: () => {
      effects.ipcClient += 1;
      throw new Error('lease or graph access must not happen');
    },
  };
  const getDeviceSpec = async () => {
    effects.spec += 1;
    throw new Error('spec access must not happen');
  };
  const invalid = [
    {
      shortcut: {
        type: 'deviceInput',
        deviceDid: 'd',
        deviceEvent: 'changed',
        deviceProperty: 'value',
      },
      message: /cannot mix --device-event with --device-property/,
    },
    {
      shortcut: {
        type: 'deviceInput',
        deviceDid: 'd',
        deviceEvent: 'changed',
        op: 'between',
        threshold: 1,
        thresholdLiteral: '1',
        threshold2: 2,
        threshold2Literal: '2',
      },
      message:
        /event mode cannot use property-only comparison field\(s\): op, threshold, thresholdLiteral, threshold2, threshold2Literal/,
    },
    {
      shortcut: {
        type: 'deviceInput',
        deviceDid: 'd',
        deviceEvent: 'changed',
        propertyValue: 'open',
      },
      message: /event mode cannot use property-only comparison field\(s\): propertyValue/,
    },
    {
      shortcut: {
        type: 'deviceInput',
        deviceDid: 'd',
        deviceEvent: 'changed',
        propertyInclude: [1, 2],
      },
      message: /event mode cannot use property-only comparison field\(s\): propertyInclude/,
    },
    {
      shortcut: {
        type: 'deviceInput',
        deviceDid: 'd',
        deviceEvent: 'changed',
        forceOutOfRange: true,
      },
      message: /event mode cannot use property-only comparison field\(s\): forceOutOfRange/,
    },
  ];

  for (const { shortcut, message } of invalid) {
    await assert.rejects(
      addNode({ ruleId, shortcut, getDeviceSpec, varCheck: false }, deps),
      (error) => error instanceof ConfigError && message.test(error.message),
    );
  }
  assert.deepEqual(effects, { session: 0, spec: 0, ipcClient: 0 });
});

test('standalone raw writes auto-lease, while an outer workflow remains the sole owner', async () => {
  for (const method of ['/api/setVarValue', '/custom/write']) {
    const fixture = workflowFixture();
    await agentCall({
      ...fixture.deps,
      method,
      params: { value: 1 },
      kind: 'write',
    });
    assert.deepEqual(
      fixture.trace
        .filter((event) => event.kind === 'acquire')
        .map((event) => event.params.operation),
      [`agent-call:${method}`],
    );
    assert.equal(fixture.trace.filter((event) => event.kind === 'release').length, 1);
  }

  const nested = workflowFixture();
  await withMutationWorkflow({ ...nested.deps, operation: 'outer-rmw' }, async () => {
    await agentCall({
      ...nested.deps,
      method: '/api/setVarValue',
      params: { value: 2 },
      kind: 'write',
    });
  });
  assert.deepEqual(
    nested.trace.filter((event) => event.kind === 'acquire').map((event) => event.params.operation),
    ['outer-rmw'],
  );
});

test('typed and raw backup load keep the lease through terminal progress', async () => {
  for (const mode of ['typed-nested', 'raw-standalone']) {
    const fixture = workflowFixture();
    if (mode === 'typed-nested') {
      await withMutationWorkflow({ ...fixture.deps, operation: mode }, () =>
        loadBackup({ from: 'fds', backup }, fixture.deps, {
          pollIntervalMs: 1,
          pollTimeoutMs: 100,
        }),
      );
    } else {
      await agentCall({
        ...fixture.deps,
        method: '/api/loadBackup',
        params: { from: 'fds', params: backup },
        kind: 'write',
      });
    }
    const ordered = fixture.trace
      .filter((event) => event.kind === 'gateway' || event.kind === 'release')
      .map((event) => event.method);
    assert.deepEqual(ordered, ['/api/loadBackup', '/api/getBackupProgress', '$mutation.release']);
  }

  const ambiguous = workflowFixture((method) => {
    if (method === '/api/loadBackup') return true;
    return defaultResponse(method);
  });
  await assert.rejects(
    loadBackup({ from: 'fds', backup }, ambiguous.deps, {
      pollIntervalMs: 1,
      pollTimeoutMs: 100,
    }),
    NotConfirmedError,
  );
  assert.equal(ambiguous.trace.filter((event) => event.kind === 'fence').length, 1);

  const injected = workflowFixture();
  let injectedPolls = 0;
  await loadBackup({ from: 'fds', backup }, injected.deps, {
    pollIntervalMs: 1,
    pollTimeoutMs: 100,
    // JavaScript callers can supply extra keys despite the public type. The
    // high-level restore API must ignore this low-level test seam.
    _getBackupProgress: async () => {
      injectedPolls += 1;
      return { progress: 100 };
    },
  });
  assert.equal(injectedPolls, 0);
  assert.equal(
    injected.trace.filter(
      (event) => event.kind === 'gateway' && event.method === '/api/getBackupProgress',
    ).length,
    1,
  );
});

test('backup load converts every post-ack confirmation failure to NOT_CONFIRMED', async () => {
  const malformedAck = workflowFixture((method) => {
    if (method === '/api/loadBackup') return { progress_id: 'invalid' };
    return defaultResponse(method);
  });
  await assert.rejects(
    loadBackup({ from: 'fds', backup }, malformedAck.deps, {
      pollIntervalMs: 1,
      pollTimeoutMs: 100,
    }),
    (error) =>
      error instanceof NotConfirmedError &&
      error.details?.phase === 'ack-parse' &&
      error.details?.causeCode === 'SCHEMA',
  );
  assert.equal(malformedAck.trace.filter((event) => event.kind === 'fence').length, 1);

  const malformedProgress = workflowFixture((method) => {
    if (method === '/api/getBackupProgress') return { progress: 'invalid' };
    return defaultResponse(method);
  });
  await assert.rejects(
    loadBackup({ from: 'fds', backup }, malformedProgress.deps, {
      pollIntervalMs: 1,
      pollTimeoutMs: 100,
    }),
    (error) =>
      error instanceof NotConfirmedError &&
      error.details?.phase === 'progress-confirmation' &&
      error.details?.causeCode === 'SCHEMA',
  );
  assert.equal(malformedProgress.trace.filter((event) => event.kind === 'fence').length, 1);

  for (const mode of ['typed', 'raw']) {
    const disconnected = workflowFixture((method) => {
      if (method === '/api/getBackupProgress') {
        throw new NetworkError('progress channel disconnected', { probe: mode });
      }
      return defaultResponse(method);
    });
    const operation =
      mode === 'typed'
        ? loadBackup({ from: 'fds', backup }, disconnected.deps, {
            pollIntervalMs: 1,
            pollTimeoutMs: 100,
          })
        : agentCall({
            ...disconnected.deps,
            method: '/api/loadBackup',
            params: { from: 'fds', params: backup },
            kind: 'write',
          });
    await assert.rejects(
      operation,
      (error) =>
        error instanceof NotConfirmedError &&
        error.details?.phase === 'progress-confirmation' &&
        error.details?.causeCode === 'NETWORK' &&
        error.details?.causeMessage === 'progress channel disconnected' &&
        error.details?.causeDetails?.probe === mode,
      mode,
    );
    assert.equal(disconnected.trace.filter((event) => event.kind === 'fence').length, 1, mode);
  }
});

test('real IPC daemon guard accepts direct typed and standalone raw SDK writes', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'xgg-typed-sdk-'));
  const socketPath = endpoint(dir, 'agent');
  const writes = [];
  const server = await createIpcServer({
    path: socketPath,
    handler: async (request, context) => {
      if (request.method === '$ping') return { host: baseUrl, agentStartedAt: startedAt };
      writes.push({ method: request.method, leaseId: context.leaseId });
      return null;
    },
  });
  t.after(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });
  const deps = { baseUrl, store: realSessionStore(socketPath), timeoutMs: 1_000 };

  await createVariable(
    { scope: 'global', id: 'probe', type: 'number', value: 1, userData: { name: 'probe' } },
    deps,
  );
  await agentCall({
    ...deps,
    method: '/future/write',
    params: { value: 2 },
    kind: 'write',
  });

  assert.deepEqual(
    writes.map((entry) => entry.method),
    ['/api/createVar', '/future/write'],
  );
  assert.ok(writes.every((entry) => typeof entry.leaseId === 'string' && entry.leaseId.length > 0));
  assert.notEqual(writes[0].leaseId, writes[1].leaseId);
});

test('backup load progress at 50 blocks a contender until terminal 100', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'xgg-typed-load-'));
  const socketPath = endpoint(dir, 'agent');
  const trace = [];
  let progressReads = 0;
  let firstProgressSeen;
  const firstProgress = new Promise((resolve) => {
    firstProgressSeen = resolve;
  });
  let allowTerminal;
  const terminalGate = new Promise((resolve) => {
    allowTerminal = resolve;
  });
  const server = await createIpcServer({
    path: socketPath,
    handler: async (request) => {
      if (request.method === '$ping') return { host: baseUrl, agentStartedAt: startedAt };
      if (request.method === '/api/loadBackup') {
        trace.push('load');
        return { progress_id: 7 };
      }
      if (request.method === '/api/getBackupProgress') {
        progressReads += 1;
        if (progressReads === 1) {
          trace.push('progress:50');
          firstProgressSeen();
          return { progress: 50 };
        }
        await terminalGate;
        trace.push('progress:100');
        return { progress: 100 };
      }
      if (request.method === '/api/setVarValue') {
        trace.push('contender-write');
        return null;
      }
      throw new Error(`unexpected method ${request.method}`);
    },
  });
  t.after(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });
  const deps = { baseUrl, store: realSessionStore(socketPath), timeoutMs: 1_000 };

  const restore = loadBackup({ from: 'fds', backup }, deps, {
    pollIntervalMs: 1,
    pollTimeoutMs: 1_000,
  });
  await firstProgress;
  let contenderDone = false;
  const contender = setVariableValue({ scope: 'global', id: 'probe', value: 2 }, deps).then(() => {
    contenderDone = true;
  });
  await delay(20);
  assert.equal(contenderDone, false);
  assert.equal(trace.includes('contender-write'), false);

  allowTerminal();
  await Promise.all([restore, contender]);
  assert.deepEqual(trace, ['load', 'progress:50', 'progress:100', 'contender-write']);
});

test('harvestBaseline waits for download cache completion before generate', async (t) => {
  const trace = [];
  let downloadProgressReads = 0;
  const asyncAgent = await startHarvestAgent(t, async (request) => {
    if (request.method === '/api/getBackupProgress') {
      const progressId = request.params.params.progress_id;
      if (progressId === 1) {
        trace.push('prior:100');
        return { progress: 100 };
      }
      downloadProgressReads += 1;
      const progress = downloadProgressReads === 1 ? 25 : 100;
      trace.push(`download:${progress}`);
      return { progress };
    }
    if (request.method === '/api/downloadBackup') {
      trace.push('download');
      return { progress_id: 2 };
    }
    if (request.method === '/api/generateBackup') {
      trace.push('generate');
      return { version: 2, rules: [], variables: {} };
    }
    throw new Error(`unexpected method ${request.method}`);
  });
  await harvestBaseline(harvestProduct, {
    baseUrl,
    outDir: asyncAgent.outDir,
    from: 'fds',
    pollIntervalMs: 1,
    pollTimeoutMs: 100,
    store: asyncAgent.store,
  });
  assert.deepEqual(trace, ['prior:100', 'download', 'download:25', 'download:100', 'generate']);
  const [prior, download, download25, download100, generate] = asyncAgent.calls;
  assert.equal(prior.leaseId, undefined);
  assert.ok(typeof download.leaseId === 'string' && download.leaseId.length > 0);
  assert.equal(download25.leaseId, download.leaseId);
  assert.equal(download100.leaseId, download.leaseId);
  assert.equal(generate.leaseId, download.leaseId);

  const syncTrace = [];
  const syncAgent = await startHarvestAgent(t, async (request) => {
    if (request.method === '/api/getBackupProgress') {
      syncTrace.push('prior:100');
      return { progress: 100 };
    }
    if (request.method === '/api/downloadBackup') {
      syncTrace.push('download:sync');
      return {};
    }
    if (request.method === '/api/generateBackup') {
      syncTrace.push('generate');
      return { version: 2, rules: [], variables: {} };
    }
    throw new Error(`unexpected method ${request.method}`);
  });
  await harvestBaseline(harvestProduct, {
    baseUrl,
    outDir: syncAgent.outDir,
    from: 'fds',
    pollIntervalMs: 1,
    pollTimeoutMs: 100,
    store: syncAgent.store,
  });
  assert.deepEqual(syncTrace, ['prior:100', 'download:sync', 'generate']);
  assert.equal(syncAgent.calls[1].leaseId, syncAgent.calls[2].leaseId);
});

test('harvestBaseline download timeout never calls generate', async (t) => {
  const agent = await startHarvestAgent(t, async (request) => {
    if (request.method === '/api/getBackupProgress') {
      const progressId = request.params.params.progress_id;
      return { progress: progressId === 1 ? 100 : 25 };
    }
    if (request.method === '/api/downloadBackup') return { progress_id: 2 };
    if (request.method === '/api/generateBackup') {
      throw new Error('generate must not run after an unconfirmed download');
    }
    throw new Error(`unexpected method ${request.method}`);
  });
  await assert.rejects(
    harvestBaseline(harvestProduct, {
      baseUrl,
      outDir: agent.outDir,
      from: 'fds',
      pollIntervalMs: 1,
      pollTimeoutMs: 2,
      store: agent.store,
    }),
    NotConfirmedError,
  );
  assert.equal(
    agent.calls.some(({ method }) => method === '/api/generateBackup'),
    false,
  );
  assert.equal(agent.mutationLeases.status().fenced, true);
});

test('harvestBaseline converts post-ack progress read failures to NOT_CONFIRMED', async (t) => {
  const agent = await startHarvestAgent(t, async (request) => {
    if (request.method === '/api/getBackupProgress') {
      const progressId = request.params.params.progress_id;
      if (progressId === 1) return { progress: 100 };
      throw new NetworkError('download progress disconnected', { progressId });
    }
    if (request.method === '/api/downloadBackup') return { progress_id: 2 };
    if (request.method === '/api/generateBackup') {
      throw new Error('generate must not run after progress confirmation fails');
    }
    throw new Error(`unexpected method ${request.method}`);
  });
  await assert.rejects(
    harvestBaseline(harvestProduct, {
      baseUrl,
      outDir: agent.outDir,
      from: 'fds',
      pollIntervalMs: 1,
      pollTimeoutMs: 20,
      store: agent.store,
    }),
    (error) =>
      error instanceof NotConfirmedError &&
      error.details?.phase === 'progress-confirmation' &&
      error.details?.causeCode === 'NETWORK' &&
      error.details?.causeMessage === 'download progress disconnected',
  );
  assert.equal(
    agent.calls.some(({ method }) => method === '/api/generateBackup'),
    false,
  );
  assert.equal(agent.mutationLeases.status().fenced, true);
});

test('harvestBaseline fails closed on ambiguous or invalid download acknowledgements', async (t) => {
  for (const response of [true, false, 'ok', null, -1, 1.5, { progress_id: -1 }]) {
    const agent = await startHarvestAgent(t, async (request) => {
      if (request.method === '/api/getBackupProgress') return { progress: 100 };
      if (request.method === '/api/downloadBackup') return response;
      if (request.method === '/api/generateBackup') {
        throw new Error('generate must not run after an ambiguous download acknowledgement');
      }
      throw new Error(`unexpected method ${request.method}`);
    });
    await assert.rejects(
      harvestBaseline(harvestProduct, {
        baseUrl,
        outDir: agent.outDir,
        from: 'fds',
        pollIntervalMs: 1,
        pollTimeoutMs: 20,
        store: agent.store,
      }),
      NotConfirmedError,
    );
    assert.equal(
      agent.calls.some(({ method }) => method === '/api/generateBackup'),
      false,
      `generate ran for ${JSON.stringify(response)}`,
    );
    assert.equal(agent.mutationLeases.status().fenced, true);
  }
});
