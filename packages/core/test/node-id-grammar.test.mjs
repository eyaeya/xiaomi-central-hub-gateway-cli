import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ConfigError,
  addEdge,
  addNode,
  assertEditorCompatibleNodeId,
  editorNodeIdCompatibilityIssues,
  exportRuleFromView,
  isEditorCompatibleNodeId,
  lintGraph,
  nodeSchemaForType,
  renderExportedAsShell,
  validateGraph,
} from '../dist/index.js';

const baseUrl = 'http://gateway.invalid';
const agentStartedAt = '2026-07-20T00:00:00.000Z';
const ruleId = '167';
const did = 'fixture.node-id';
const urn = 'urn:miot-spec-v2:device:light:0000A001:node-id:1';

function summary() {
  return {
    id: ruleId,
    enable: false,
    uiType: 'rule',
    userData: {
      name: 'node id grammar',
      transform: { x: 0, y: 0, scale: 1, rotate: 0 },
      lastUpdateTime: 0,
      version: 0,
    },
  };
}

function onLoad(id, outputs = []) {
  return {
    id,
    type: 'onLoad',
    cfg: {
      pos: { x: 0, y: 0, width: 320, height: 80 },
      name: 'onLoad',
      version: 1,
    },
    inputs: {},
    outputs: { output: outputs },
    props: {},
  };
}

function delay(id) {
  return {
    id,
    type: 'delay',
    cfg: {
      pos: { x: 400, y: 0, width: 320, height: 80 },
      name: 'delay',
      version: 1,
      unit: 's',
      value: 1,
    },
    inputs: { input: null },
    outputs: { output: [] },
    props: { timeout: 1000 },
  };
}

const device = {
  specV2Access: true,
  specV3Access: false,
  online: true,
  pushAvailable: true,
  name: 'Node id light',
  model: 'fixture.node-id.v1',
  modelName: 'Node Id Light',
  urn,
  roomId: 'room1',
  roomName: 'Room',
  icon: '',
};

const spec = {
  type: urn,
  description: 'Node id light',
  services: [
    {
      iid: 2,
      type: 'urn:miot-spec-v2:service:light:00007802:node-id:1',
      description: 'Light',
      properties: [
        {
          iid: 1,
          type: 'urn:miot-spec-v2:property:on:00000006:node-id:1',
          description: 'On',
          format: 'bool',
          access: ['read', 'write', 'notify'],
        },
      ],
    },
  ],
};

function statefulGateway() {
  const calls = [];
  const state = { summary: summary(), nodes: [] };
  const deps = {
    baseUrl,
    store: {
      read: async () => ({
        host: baseUrl,
        pid: 1,
        socketPath: '/tmp/xgg-node-id-unused.sock',
        agentStartedAt,
        agentVersion: '0.1.4',
        lastValidatedAt: agentStartedAt,
      }),
    },
    ipcClient: () => ({
      request: async (method, params) => {
        if (method === '$ping') return { host: baseUrl, agentStartedAt };
        if (method === '$mutation.acquire') return { leaseId: 'node-id-lease' };
        if (method === '$mutation.release' || method === '$mutation.fence') return { ok: true };
        calls.push({ method, params: structuredClone(params) });
        if (method === '/api/getDevList') return { devList: { [did]: device } };
        if (method === '/api/getGraphList') return [structuredClone(state.summary)];
        if (method === '/api/getGraph') {
          return { id: ruleId, nodes: structuredClone(state.nodes) };
        }
        if (method === '/api/setGraph') {
          state.summary = structuredClone(params.cfg);
          state.nodes = structuredClone(params.nodes);
          return null;
        }
        throw new Error(`unexpected RPC: ${method}`);
      },
      close: () => {},
    }),
  };
  return { calls, deps, state };
}

test('typed defaults mint editor-compatible ids and edge endpoints use them unchanged', async () => {
  const gateway = statefulGateway();
  const source = await addNode(
    { ruleId, shortcut: { type: 'onLoad' }, varCheck: false },
    gateway.deps,
  );
  const sink = await addNode(
    {
      ruleId,
      shortcut: {
        type: 'deviceOutput',
        deviceDid: did,
        deviceProperty: 'on',
        value: 'true',
      },
      getDeviceSpec: async (requestedUrn) => {
        assert.equal(requestedUrn, urn);
        return spec;
      },
      varCheck: false,
    },
    gateway.deps,
  );

  assert.match(source.nodeId, /^n[0-9a-f]{32}$/);
  assert.match(sink.nodeId, /^n[0-9a-f]{32}$/);
  assert.notEqual(source.nodeId, sink.nodeId);
  assert.equal(isEditorCompatibleNodeId(source.nodeId), true);
  assert.equal(isEditorCompatibleNodeId(sink.nodeId), true);

  await addEdge(
    {
      ruleId,
      from: { nodeId: source.nodeId, pin: 'output' },
      to: { nodeId: sink.nodeId, pin: 'trigger' },
      varCheck: false,
    },
    gateway.deps,
  );
  assert.deepEqual(gateway.state.nodes.find((node) => node.id === source.nodeId)?.outputs.output, [
    `${sink.nodeId}.trigger`,
  ]);
});

test('the typed authoring guard accepts only the canonical editor grammar', () => {
  for (const id of ['Node1', '1node', 'n0123456789abcdef']) {
    assert.doesNotThrow(() => assertEditorCompatibleNodeId(id, '--id'));
  }
  for (const id of ['n-invalid', 'n_invalid', 'n.invalid', '节点']) {
    assert.throws(
      () => assertEditorCompatibleNodeId(id, '--id'),
      (error) =>
        error instanceof ConfigError && /ASCII alphanumeric \[A-Za-z0-9\]\+/.test(error.message),
    );
  }
});

test('Core typed authoring rejects legacy ids before session access and permits only explicit replay', async () => {
  let sessionReads = 0;
  const unreachableDeps = {
    baseUrl,
    store: {
      read: async () => {
        sessionReads += 1;
        throw new Error('SESSION_TOUCHED');
      },
    },
  };

  await assert.rejects(
    addNode(
      { ruleId, shortcut: { type: 'onLoad', id: 'legacy-node' }, varCheck: false },
      unreachableDeps,
    ),
    (error) => error instanceof ConfigError && /shortcut\.id/.test(error.message),
  );
  assert.equal(sessionReads, 0);

  await assert.rejects(
    addNode(
      {
        ruleId,
        shortcut: { type: 'onLoad', id: 'validNode' },
        legacyNodeIdReplay: true,
        varCheck: false,
      },
      unreachableDeps,
    ),
    (error) => error instanceof ConfigError && /unnecessary/.test(error.message),
  );
  await assert.rejects(
    addNode(
      {
        ruleId,
        node: onLoad('legacy-node'),
        legacyNodeIdReplay: true,
        varCheck: false,
      },
      unreachableDeps,
    ),
    (error) => error instanceof ConfigError && /typed shortcut replay/.test(error.message),
  );
  assert.equal(sessionReads, 0);

  const gateway = statefulGateway();
  await addNode(
    {
      ruleId,
      shortcut: { type: 'onLoad', id: 'legacy-node' },
      legacyNodeIdReplay: true,
      varCheck: false,
    },
    gateway.deps,
  );
  assert.equal(gateway.state.nodes[0].id, 'legacy-node');
});

test('legacy modeled ids stay parsed and writable, with targeted non-blocking diagnostics', async () => {
  const legacy = onLoad('legacy-node');
  const schema = nodeSchemaForType('onLoad');
  assert.ok(schema);
  assert.equal(schema.safeParse(legacy).success, true, 'known node must not fall into UnknownNode');

  assert.deepEqual(await validateGraph({ graph: { id: ruleId, nodes: [legacy] } }), []);
  const validationWarnings = editorNodeIdCompatibilityIssues([legacy]);
  assert.equal(validationWarnings.length, 1);
  assert.equal(validationWarnings[0].severity, 'warn');
  assert.equal(validationWarnings[0].path, 'nodes[0].id');
  assert.match(validationWarnings[0].message, /not editor-compatible/);
  assert.match(validationWarnings[0].message, /preserved/);

  const lint = lintGraph({ graph: { id: ruleId, nodes: [legacy] }, strict: true });
  assert.deepEqual(
    lint.map(({ severity, path }) => ({ severity, path })),
    [{ severity: 'warn', path: 'nodes[0].id' }],
  );

  const gateway = statefulGateway();
  await addNode({ ruleId, node: legacy, validate: true, varCheck: false }, gateway.deps);
  assert.deepEqual(gateway.state.nodes, [legacy]);
});

test('legacy-id diagnostics enumerate every affected stored edge reference', () => {
  const source = onLoad('legacy-source', ['legacy-sink.input']);
  const sink = delay('legacy-sink');
  const issues = editorNodeIdCompatibilityIssues([source, sink]);

  assert.deepEqual(
    issues.map(({ severity, path }) => ({ severity, path })),
    [
      { severity: 'warn', path: 'nodes[0].id' },
      { severity: 'warn', path: 'nodes[1].id' },
      { severity: 'warn', path: 'nodes[0].outputs.output[0]' },
    ],
  );
  assert.match(issues[2].message, /legacy-source\.output -> legacy-sink\.input/);
  assert.match(issues[2].message, /"legacy-source"/);
  assert.match(issues[2].message, /"legacy-sink"/);
  assert.match(issues[2].message, /whole graph atomically/);
});

test('opaque future node ids and their edges receive the same non-blocking diagnostics', () => {
  const opaque = {
    id: 'future-node',
    type: 'futureCard',
    cfg: { version: 7 },
    inputs: {},
    outputs: { output: ['legacy-sink.input'] },
    props: { future: true },
  };
  const sink = delay('legacy-sink');
  const issues = editorNodeIdCompatibilityIssues([opaque, sink]);

  assert.deepEqual(
    issues.map(({ severity, path }) => ({ severity, path })),
    [
      { severity: 'warn', path: 'nodes[0].id' },
      { severity: 'warn', path: 'nodes[1].id' },
      { severity: 'warn', path: 'nodes[0].outputs.output[0]' },
    ],
  );
  assert.match(issues[0].message, /raw tuple/);
  assert.match(issues[2].message, /"future-node"/);
  assert.match(issues[2].message, /"legacy-sink"/);
});

test('export preserves a legacy id and every adjacent endpoint through explicit typed replay', async () => {
  const source = onLoad('legacy-node', ['sink.input']);
  const sink = delay('sink');
  const exported = await exportRuleFromView(
    { id: ruleId, cfg: summary(), nodes: [source, sink] },
    { baseUrl, store: {} },
    undefined,
    true,
  );

  const sourceCommand = exported.commands.find(
    (command) => command.kind === 'node-add' && command.nodeId === source.id,
  );
  assert.ok(sourceCommand);
  assert.notEqual(sourceCommand.opaqueRaw, true);
  assert.equal(sourceCommand.flags.find((flag) => flag.name === '--id')?.value, source.id);
  assert.ok(sourceCommand.flags.some((flag) => flag.name === '--allow-legacy-id'));
  assert.deepEqual(
    exported.commands
      .filter((command) => command.kind === 'edge-add')
      .map(({ from, to }) => ({ from, to })),
    [{ from: 'legacy-node:output', to: 'sink:input' }],
  );
  assert.deepEqual(exported.warnings, []);
});

test('export replays colon-bearing legacy ids through lossless split edge flags', async () => {
  const source = onLoad('legacy:source', ['legacy:sink.input']);
  const sink = delay('legacy:sink');
  const exported = await exportRuleFromView(
    { id: ruleId, cfg: summary(), nodes: [source, sink] },
    { baseUrl, store: {} },
    undefined,
    true,
  );

  const edge = exported.commands.find((command) => command.kind === 'edge-add');
  assert.deepEqual(edge?.fromRef, { nodeId: 'legacy:source', pin: 'output' });
  assert.deepEqual(edge?.toRef, { nodeId: 'legacy:sink', pin: 'input' });
  const shell = renderExportedAsShell(exported);
  assert.match(shell, /--from-node-id 'legacy:source' --from-pin 'output'/);
  assert.match(shell, /--to-node-id 'legacy:sink' --to-pin 'input'/);
  assert.doesNotMatch(shell, /--from 'legacy:source:output'/);
});

test('shell rendering upgrades old modeled exports but never raw or unknown commands', () => {
  const base = {
    ruleId,
    ruleName: 'old export',
    enable: false,
    warnings: [],
    externalVariables: [],
  };
  const shell = renderExportedAsShell({
    ...base,
    commands: [
      {
        kind: 'node-add',
        nodeId: 'old-node',
        type: 'onLoad',
        flags: [
          { name: '--id', value: 'old-node' },
          { name: '--type', value: 'onLoad' },
        ],
        comment: 'pre-167 modeled export',
      },
      {
        kind: 'node-add',
        nodeId: 'raw-node',
        type: 'onLoad',
        flags: [
          { name: '--id', value: 'raw-node' },
          { name: '--type', value: 'onLoad' },
          { name: '--cfg', value: '{}', needsQuoting: true },
        ],
        comment: 'raw tuple',
      },
      {
        kind: 'node-add',
        nodeId: 'future-node',
        type: 'futureCard',
        flags: [
          { name: '--id', value: 'future-node' },
          { name: '--type', value: 'futureCard' },
        ],
        comment: 'unknown type',
      },
      {
        kind: 'edge-add',
        from: 'old:source:output',
        to: 'old:sink:input',
      },
    ],
  });

  assert.equal((shell.match(/--allow-legacy-id/g) ?? []).length, 1);
  assert.match(shell, /'--id' 'old-node'.*'--allow-legacy-id'/);
  assert.match(shell, /--from-node-id 'old:source' --from-pin 'output'/);
  assert.match(shell, /--to-node-id 'old:sink' --to-pin 'input'/);
});
