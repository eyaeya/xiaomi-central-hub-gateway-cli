import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ConfigError,
  addEdge,
  addNode,
  applyRename,
  exportRuleFromView,
  renderExportedAsShell,
} from '../dist/index.js';

const baseUrl = 'http://gateway.invalid';
const agentStartedAt = '2026-07-19T00:00:00.000Z';

function summary() {
  return {
    id: 'rule1',
    enable: false,
    uiType: 'test',
    userData: {
      name: 'future node round-trip',
      transform: { x: 0, y: 0, scale: 1, rotate: 0 },
      lastUpdateTime: 0,
      version: 0,
    },
  };
}

const sourceNode = {
  id: 'source',
  type: 'onLoad',
  cfg: { pos: { x: 0, y: 0, width: 160, height: 80 }, name: 'onLoad', version: 1 },
  inputs: {},
  outputs: { output: ['future.input'] },
  props: {},
};

const futureNode = {
  id: 'future',
  type: 'firmwareCardV99',
  cfg: {
    pos: { x: 200, y: 0, width: 180, height: 100 },
    name: 'firmwareCardV99',
    version: 99,
  },
  inputs: { input: null },
  outputs: { output: ['sink.input'], alternate: [] },
  props: {
    opaqueMode: 'native',
    nested: { preserve: true, values: [1, false, 'three'] },
  },
  firmwareExtension: { token: 'opaque-but-not-secret', enabled: true },
};

const sinkNode = {
  id: 'sink',
  type: 'delay',
  cfg: {
    pos: { x: 420, y: 0, width: 160, height: 80 },
    name: 'delay',
    version: 1,
    unit: 's',
    value: 1,
  },
  inputs: { input: null },
  outputs: { output: [] },
  props: { timeout: 1000 },
};

function view() {
  return { id: 'rule1', cfg: summary(), nodes: [sourceNode, futureNode, sinkNode] };
}

function statefulGateway() {
  const state = {
    summary: structuredClone(summary()),
    nodes: [{ ...structuredClone(sourceNode), outputs: { output: [] } }, structuredClone(sinkNode)],
  };
  const deps = {
    baseUrl,
    store: {
      read: async () => ({
        host: baseUrl,
        pid: 1,
        socketPath: '/tmp/xgg-export-unknown-unused.sock',
        agentStartedAt,
        agentVersion: '0.1.4',
        lastValidatedAt: agentStartedAt,
      }),
    },
    ipcClient: () => ({
      request: async (method, params) => {
        if (method === '$ping') return { host: baseUrl, agentStartedAt };
        if (method === '$mutation.acquire') return { leaseId: 'test-lease' };
        if (method === '$mutation.release' || method === '$mutation.fence') return { ok: true };
        if (method === '/api/getGraphList') return [structuredClone(state.summary)];
        if (method === '/api/getGraph') {
          return { id: 'rule1', nodes: structuredClone(state.nodes) };
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
  return { state, deps };
}

test('strict export preserves an unknown node, opaque props, and both adjacent edges', async () => {
  const exported = await exportRuleFromView(view(), { baseUrl, store: {} }, undefined, true);
  const raw = exported.commands.find(
    (command) => command.kind === 'node-add' && command.nodeId === 'future',
  );
  assert.ok(raw);
  assert.equal(raw.opaqueRaw, true);
  assert.equal(raw.type, futureNode.type);

  const cfgFlag = raw.flags.find((flag) => flag.name === '--cfg');
  assert.ok(cfgFlag?.value);
  const tuple = JSON.parse(cfgFlag.value);
  assert.deepEqual(tuple.cfg, futureNode.cfg);
  assert.deepEqual(tuple.inputs, futureNode.inputs);
  assert.deepEqual(tuple.outputs, { output: [], alternate: [] });
  assert.deepEqual(tuple.props, futureNode.props);
  assert.deepEqual(tuple.firmwareExtension, futureNode.firmwareExtension);
  assert.equal(Object.hasOwn(tuple, 'id'), false);
  assert.equal(Object.hasOwn(tuple, 'type'), false);

  assert.deepEqual(
    exported.commands
      .filter((command) => command.kind === 'edge-add')
      .map(({ from, to }) => ({ from, to })),
    [
      { from: 'source:output', to: 'future:input' },
      { from: 'future:output', to: 'sink:input' },
    ],
  );
  assert.match(exported.warnings.join('\n'), /preserved through the opaque raw --cfg fallback/);

  const shell = renderExportedAsShell(exported);
  assert.match(shell, /--type' 'firmwareCardV99'/);
  assert.match(shell, /--cfg'/);
});

test('raw fallback plus emitted edges reconstructs the original future-node graph', async () => {
  const exported = await exportRuleFromView(view(), { baseUrl, store: {} }, undefined, true);
  const raw = exported.commands.find(
    (command) => command.kind === 'node-add' && command.nodeId === 'future',
  );
  assert.ok(raw);
  const tuple = JSON.parse(raw.flags.find((flag) => flag.name === '--cfg').value);
  const { state, deps } = statefulGateway();

  await addNode(
    {
      ruleId: 'rule1',
      node: { ...tuple, id: raw.nodeId, type: raw.type },
      validate: true,
      varCheck: false,
    },
    deps,
  );
  for (const edge of exported.commands.filter((command) => command.kind === 'edge-add')) {
    const [fromNodeId, fromPin] = edge.from.split(':');
    const [toNodeId, toPin] = edge.to.split(':');
    await addEdge(
      {
        ruleId: 'rule1',
        from: { nodeId: fromNodeId, pin: fromPin },
        to: { nodeId: toNodeId, pin: toPin },
        varCheck: false,
      },
      deps,
    );
  }

  assert.deepEqual(
    state.nodes.find((node) => node.id === 'future'),
    futureNode,
  );
  assert.deepEqual(state.nodes.find((node) => node.id === 'source').outputs, sourceNode.outputs);
});

test('opaque same-id/name replay remains available while target-id clone fails closed', async () => {
  const exported = await exportRuleFromView(view(), { baseUrl, store: {} }, undefined, true);
  const renamed = applyRename(exported, { targetName: 'renamed in place' });
  assert.equal(renamed.ruleId, 'rule1');
  assert.equal(renamed.ruleName, 'renamed in place');
  assert.ok(
    renamed.commands.some((command) => command.kind === 'node-add' && command.opaqueRaw === true),
  );

  assert.throws(
    () => applyRename(exported, { targetId: 'rule2' }),
    (error) => error instanceof ConfigError && /opaque raw node/.test(error.message),
  );
});
