import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ConfigError,
  addNode,
  applyRename,
  checkReachability,
  exportRuleFromView,
  lintGraph,
  modeledNodePinNames,
  nodeSchemaForType,
  renderExportedAsShell,
  validateGraph,
} from '../dist/index.js';

const baseUrl = 'http://gateway.invalid';
const agentStartedAt = '2026-07-19T00:00:00.000Z';

const formattedDelta = [
  { insert: '标题' },
  { insert: '\n', attributes: { header: 1, align: 'center' } },
  { insert: '重点', attributes: { bold: true } },
  { insert: '\n', attributes: { list: 'bullet' } },
];

function summary(id = 'rule1') {
  return {
    id,
    enable: false,
    uiType: 'test',
    userData: {
      name: 'note round-trip',
      transform: { x: 0, y: 0, scale: 1, rotate: 0 },
      lastUpdateTime: 0,
      version: 0,
    },
  };
}

function nopNode(overrides = {}) {
  return {
    id: 'note1',
    type: 'nop',
    cfg: {
      pos: { x: 12, y: 34, width: 456, height: 98 },
      name: 'nop',
      version: 1,
      contents: structuredClone(formattedDelta),
      background: '#FFD966',
    },
    inputs: {},
    outputs: { output: [] },
    props: {},
    ...overrides,
  };
}

function statefulGateway(id = 'rule1') {
  const calls = [];
  const state = { summary: summary(id), nodes: [] };
  return {
    calls,
    state,
    deps: {
      baseUrl,
      store: {
        read: async () => ({
          host: baseUrl,
          pid: 1,
          socketPath: '/tmp/xgg-nop-note-unused.sock',
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
          calls.push({ method, params });
          if (method === '/api/getGraphList') return [structuredClone(state.summary)];
          if (method === '/api/getGraph') return { id, nodes: structuredClone(state.nodes) };
          if (method === '/api/setGraph') {
            state.summary = structuredClone(params.cfg);
            state.nodes = structuredClone(params.nodes);
            return null;
          }
          throw new Error(`unexpected RPC: ${method}`);
        },
        close: () => {},
      }),
    },
  };
}

function flagValue(command, name) {
  return command.flags.find((flag) => flag.name === name)?.value;
}

function shortcutFromExport(command) {
  const [x, y, width, height] = flagValue(command, '--pos').split(',').map(Number);
  return {
    type: 'nop',
    id: flagValue(command, '--id'),
    pos: { x, y, width, height },
    noteDelta: JSON.parse(flagValue(command, '--delta')),
    noteBackground: flagValue(command, '--background'),
  };
}

test('strict nop schema accepts formatted Quill Delta and has no graph semantics', async () => {
  const node = nopNode();
  const schema = nodeSchemaForType('nop');
  assert.ok(schema);
  assert.deepEqual(schema.parse(node), node);
  assert.deepEqual(modeledNodePinNames('nop', 'input'), []);
  assert.deepEqual(modeledNodePinNames('nop', 'output'), []);
  assert.deepEqual(await validateGraph({ graph: { id: 'rule1', nodes: [node] } }), []);
  assert.deepEqual(lintGraph({ graph: { id: 'rule1', nodes: [node] }, strict: true }), []);
  assert.deepEqual(checkReachability([node]), []);
});

test('nop validation rejects non-document Delta ops and executable edges', async () => {
  const schema = nodeSchemaForType('nop');
  assert.ok(schema);

  const retainNode = nopNode({
    cfg: { ...nopNode().cfg, contents: [{ retain: 1 }] },
  });
  assert.equal(schema.safeParse(retainNode).success, false);
  assert.match(
    (await validateGraph({ graph: { id: 'rule1', nodes: [retainNode] } }))[0].message,
    /nop node failed its strict schema/,
  );

  const wiredNode = nopNode({ outputs: { output: ['action.trigger'] } });
  assert.equal(schema.safeParse(wiredNode).success, false);
  assert.match(
    (await validateGraph({ graph: { id: 'rule1', nodes: [wiredNode] } }))[0].message,
    /nop node failed its strict schema/,
  );

  const compactNode = nopNode({ cfg: { ...nopNode().cfg, simplified: true } });
  assert.equal(schema.safeParse(compactNode).success, false);
  await assert.rejects(
    exportRuleFromView(
      { id: 'rule1', cfg: summary(), nodes: [compactNode] },
      { baseUrl, store: {} },
      undefined,
      true,
    ),
    (error) => error instanceof ConfigError && /exporter drops.*simplified/.test(error.message),
  );

  // Adding a modeled nop must not consume the UnknownNode escape hatch used
  // for genuinely future firmware cards.
  assert.equal(nodeSchemaForType('futureCanvasCard'), undefined);
  assert.deepEqual(
    await validateGraph({
      graph: { id: 'rule1', nodes: [{ id: 'future1', type: 'futureCanvasCard', opaque: true }] },
    }),
    [],
  );
});

test('nop shortcut authors canonical plain text and preserves lossless Delta input', async () => {
  const gateway = statefulGateway();
  await addNode(
    {
      ruleId: 'rule1',
      shortcut: { type: 'nop', id: 'plain', noteText: '第一行\n第二行' },
      varCheck: false,
    },
    gateway.deps,
  );
  assert.deepEqual(gateway.state.nodes[0], {
    id: 'plain',
    type: 'nop',
    cfg: {
      pos: { x: 40, y: 40, width: 320, height: 60 },
      name: 'nop',
      version: 1,
      contents: [{ insert: '第一行\n第二行\n' }],
      background: '#80CAFF',
    },
    inputs: {},
    outputs: { output: [] },
    props: {},
  });

  await addNode(
    {
      ruleId: 'rule1',
      shortcut: {
        type: 'nop',
        id: 'rich',
        pos: { x: 500, y: 50, width: 600, height: 140 },
        noteDelta: structuredClone(formattedDelta),
        noteBackground: '#85E0A3',
      },
      varCheck: false,
    },
    gateway.deps,
  );
  assert.deepEqual(gateway.state.nodes[1], {
    id: 'rich',
    type: 'nop',
    cfg: {
      pos: { x: 500, y: 50, width: 600, height: 140 },
      name: 'nop',
      version: 1,
      contents: formattedDelta,
      background: '#85E0A3',
    },
    inputs: {},
    outputs: { output: [] },
    props: {},
  });
});

test('nop shortcut rejects malformed Delta before session or gateway access', async () => {
  const gateway = statefulGateway();
  await assert.rejects(
    addNode(
      {
        ruleId: 'rule1',
        shortcut: { type: 'nop', noteDelta: [{ retain: 1 }] },
      },
      gateway.deps,
    ),
    (error) =>
      error instanceof ConfigError &&
      error.code === 'CONFIG' &&
      /--delta is not a Quill document/.test(error.message),
  );
  await assert.rejects(
    addNode(
      {
        ruleId: 'rule1',
        shortcut: { type: 'nop', simplified: true },
      },
      gateway.deps,
    ),
    (error) => error instanceof ConfigError && /executable cards, not nop/.test(error.message),
  );
  assert.deepEqual(gateway.calls, []);
});

test('strict export and JSON import rendering preserve nop Delta, color, and size', async () => {
  const source = nopNode();
  const exported = await exportRuleFromView(
    { id: 'rule1', cfg: summary(), nodes: [source] },
    { baseUrl, store: {} },
    undefined,
    true,
  );
  assert.deepEqual(exported.warnings, []);
  assert.equal(
    exported.commands.some((command) => command.kind === 'edge-add'),
    false,
  );
  const command = exported.commands.find(
    (candidate) => candidate.kind === 'node-add' && candidate.nodeId === 'note1',
  );
  assert.ok(command);
  assert.equal(flagValue(command, '--pos'), '12,34,456,98');
  assert.deepEqual(JSON.parse(flagValue(command, '--delta')), formattedDelta);
  assert.equal(flagValue(command, '--background'), '#FFD966');

  const importedPayload = JSON.parse(JSON.stringify(exported));
  const cloned = applyRename(importedPayload, { targetId: 'rule2' });
  const clonedCommand = cloned.commands.find(
    (candidate) => candidate.kind === 'node-add' && candidate.nodeId === 'note1',
  );
  assert.ok(clonedCommand);
  assert.deepEqual(shortcutFromExport(clonedCommand), shortcutFromExport(command));
  const shell = renderExportedAsShell(cloned);
  assert.equal(shell.includes("'--type' 'nop'"), true);
  assert.equal(shell.includes("'--delta'"), true);
  assert.equal(shell.includes("'--background' '#FFD966'"), true);

  const replay = statefulGateway('rule2');
  await addNode(
    {
      ruleId: 'rule2',
      shortcut: shortcutFromExport(clonedCommand),
      varCheck: false,
    },
    replay.deps,
  );
  assert.deepEqual(replay.state.nodes, [source]);
});
