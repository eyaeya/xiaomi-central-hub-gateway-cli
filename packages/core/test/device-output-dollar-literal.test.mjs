import assert from 'node:assert/strict';
import test from 'node:test';

import { addNode, applyRename, exportRuleFromView, renderExportedAsShell } from '../dist/index.js';

const baseUrl = 'http://gateway.invalid';
const startedAt = '2026-07-19T00:00:00.000Z';
const did = 'fake-device';
const urn = 'urn:miot-spec-v2:device:dollar-literal:0000A001:fixture:1';

const spec = {
  type: urn,
  description: 'offline dollar-literal fixture',
  services: [
    {
      iid: 2,
      type: 'urn:miot-spec-v2:service:test-service:00007801:fixture:1',
      description: 'fixture service',
      properties: [
        {
          iid: 1,
          type: 'urn:miot-spec-v2:property:text:00000001:fixture:1',
          description: 'text',
          format: 'string',
          access: ['read', 'write'],
        },
        {
          iid: 2,
          type: 'urn:miot-spec-v2:property:count:00000002:fixture:1',
          description: 'count',
          format: 'uint8',
          access: ['read', 'write'],
          'value-range': [0, 100, 1],
        },
        {
          iid: 3,
          type: 'urn:miot-spec-v2:property:on:00000003:fixture:1',
          description: 'on',
          format: 'bool',
          access: ['read', 'write'],
        },
      ],
    },
  ],
};

const device = {
  specV2Access: true,
  specV3Access: false,
  online: true,
  pushAvailable: true,
  name: 'fixture device',
  model: 'fixture.device.v1',
  modelName: 'Fixture',
  urn,
  roomId: 'room-1',
  roomName: 'Room',
  icon: '',
};

function summary(id = '123') {
  return {
    id,
    enable: false,
    uiType: 'rule',
    userData: {
      name: 'dollar literal fixture',
      transform: { x: 0, y: 0, scale: 1, rotate: 0 },
      lastUpdateTime: 0,
      version: 0,
    },
  };
}

function createGateway(id = '123') {
  const state = { summary: summary(id), nodes: [] };
  const calls = [];
  const deps = {
    baseUrl,
    store: {
      read: async () => ({
        host: baseUrl,
        pid: 1,
        socketPath: '/tmp/xgg-dollar-literal-unused.sock',
        agentStartedAt: startedAt,
        agentVersion: '0.1.4',
        lastValidatedAt: startedAt,
      }),
    },
    ipcClient: () => ({
      request: async (method, params, options) => {
        if (method === '$ping') return { host: baseUrl, agentStartedAt: startedAt };
        if (method === '$mutation.acquire') return { leaseId: 'test-lease' };
        if (method === '$mutation.release' || method === '$mutation.fence') return { ok: true };
        calls.push({ method, params, options });
        if (method === '/api/getDevList') return { devList: { [did]: device } };
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
    getDeviceSpec: async (requestedUrn) => {
      assert.equal(requestedUrn, urn);
      return spec;
    },
  };
  return { calls, deps, state };
}

async function addValue(gateway, id, value, property = 'text') {
  return addNode(
    {
      ruleId: gateway.state.summary.id,
      shortcut: {
        type: 'deviceOutput',
        id,
        deviceDid: did,
        deviceProperty: property,
        value,
      },
      getDeviceSpec: gateway.deps.getDeviceSpec,
      validate: false,
      varCheck: false,
    },
    gateway.deps,
  );
}

function propsById(nodes) {
  return Object.fromEntries(nodes.map((node) => [node.id, node.props]));
}

function flagValue(command, name) {
  return command.flags.find((flag) => flag.name === name)?.value;
}

function nodeCommand(exported, nodeId) {
  return exported.commands.find(
    (command) => command.kind === 'node-add' && command.nodeId === nodeId,
  );
}

function shortcutFromExport(command) {
  const rawPos = flagValue(command, '--pos');
  const pos = rawPos?.split(',').map(Number);
  return {
    type: command.type,
    id: flagValue(command, '--id'),
    deviceDid: flagValue(command, '--device-did'),
    deviceProperty: flagValue(command, '--device-property'),
    value: flagValue(command, '--value'),
    ...(pos?.length === 4 ? { pos: { x: pos[0], y: pos[1], width: pos[2], height: pos[3] } } : {}),
  };
}

function literalNode(id, piid, value, x) {
  return {
    id,
    type: 'deviceOutput',
    cfg: {
      urn,
      name: 'deviceOutput',
      version: 1,
      pos: { x, y: 0, width: 684, height: 204 },
    },
    inputs: { trigger: null },
    outputs: { output: [] },
    props: { did, siid: 2, piid, value },
  };
}

test('deviceOutput decodes one doubled dollar while preserving variable-reference behavior', async () => {
  const gateway = createGateway();
  await addValue(gateway, 'plain', 'hello');
  await addValue(gateway, 'variable', '$global.foo');
  await addValue(gateway, 'literal-unqualified', '$$hello');
  await addValue(gateway, 'literal-qualified', '$$global.foo');
  await addValue(gateway, 'literal-double', '$$$foo');
  await addValue(gateway, 'literal-dollar', '$$');
  await addValue(gateway, 'number', '7', 'count');
  await addValue(gateway, 'boolean', 'true', 'on');

  const props = propsById(gateway.state.nodes);
  assert.equal(props.plain.value, 'hello');
  assert.deepEqual(props.variable, {
    did,
    siid: 2,
    piid: 1,
    scope: 'global',
    id: 'foo',
    dtype: 'string',
  });
  assert.equal(props['literal-unqualified'].value, '$hello');
  assert.equal(props['literal-qualified'].value, '$global.foo');
  assert.equal(props['literal-double'].value, '$$foo');
  assert.equal(props['literal-dollar'].value, '$');
  assert.equal(props.number.value, 7);
  assert.equal(props.boolean.value, true);
});

test('unescaped malformed dollars and escaped non-string values still fail closed', async () => {
  const gateway = createGateway();
  await assert.rejects(
    addValue(gateway, 'bad-string', '$hello'),
    (error) => error?.code === 'CONFIG' && /variable reference must be/.test(error.message),
  );
  await assert.rejects(
    addValue(gateway, 'bad-number', '$$1', 'count'),
    (error) => error?.code === 'CONFIG' && /requires numeric value/.test(error.message),
  );
  assert.deepEqual(gateway.state.nodes, []);
});

test('export, clone, shell rendering, and shortcut replay preserve dollar-prefixed literals', async () => {
  const sourceNodes = [
    literalNode('literal-unqualified', 1, '$hello', 0),
    literalNode('literal-qualified', 1, '$global.literal', 700),
    literalNode('literal-double', 1, '$$foo', 1400),
    literalNode('literal-dollar', 1, '$', 2100),
    literalNode('plain', 1, 'plain', 2800),
    literalNode('number', 2, 7, 3500),
    literalNode('boolean', 3, true, 4200),
    {
      ...literalNode('variable', 1, '', 4900),
      props: { did, siid: 2, piid: 1, scope: 'global', id: 'realVar', dtype: 'string' },
    },
  ];
  const source = createGateway();
  const exported = await exportRuleFromView(
    { id: '123', cfg: summary(), nodes: sourceNodes },
    source.deps,
  );

  assert.equal(flagValue(nodeCommand(exported, 'literal-unqualified'), '--value'), '$$hello');
  assert.equal(
    flagValue(nodeCommand(exported, 'literal-qualified'), '--value'),
    '$$global.literal',
  );
  assert.equal(flagValue(nodeCommand(exported, 'literal-double'), '--value'), '$$$foo');
  assert.equal(flagValue(nodeCommand(exported, 'literal-dollar'), '--value'), '$$');
  assert.equal(flagValue(nodeCommand(exported, 'plain'), '--value'), 'plain');
  assert.equal(flagValue(nodeCommand(exported, 'number'), '--value'), '7');
  assert.equal(flagValue(nodeCommand(exported, 'boolean'), '--value'), 'true');
  assert.equal(flagValue(nodeCommand(exported, 'variable'), '--value'), '$global.realVar');
  assert.deepEqual(exported.externalVariables, [{ scope: 'global', id: 'realVar' }]);

  const cloned = applyRename(exported, { targetId: '456' });
  assert.equal(flagValue(nodeCommand(cloned, 'literal-qualified'), '--value'), '$$global.literal');
  assert.deepEqual(cloned.externalVariables, [{ scope: 'global', id: 'realVar' }]);
  assert.equal(
    cloned.commands.some((command) => command.kind === 'variable-create'),
    false,
  );

  const shell = renderExportedAsShell(exported);
  assert.equal(shell.includes("'--value' '$$hello'"), true);
  assert.equal(shell.includes("'--value' '$$global.literal'"), true);
  assert.equal(shell.includes("'--value' '$$$foo'"), true);

  const replay = createGateway();
  for (const command of exported.commands) {
    if (command.kind !== 'node-add') continue;
    await addNode(
      {
        ruleId: '123',
        shortcut: shortcutFromExport(command),
        getDeviceSpec: replay.deps.getDeviceSpec,
        validate: false,
        varCheck: false,
      },
      replay.deps,
    );
  }
  assert.deepEqual(replay.state.nodes, sourceNodes);
});
