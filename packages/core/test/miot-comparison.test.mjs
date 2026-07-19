import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MIOT_COMPARISON_CONTRACT,
  addNode,
  exportRuleFromView,
  nodeSchemaForType,
  parseFiniteDecimalLiteral,
  projectMiotComparisonDtype,
  validateGraph,
} from '../dist/index.js';

const fakeBaseUrl = 'http://gateway.invalid';
const fakeAgentStartedAt = '2026-07-19T00:00:00.000Z';
const did = 'fake-device';
const urn = 'urn:miot-spec-v2:device:test-device:0000A001:fake:1';

const fakeSpec = {
  type: urn,
  description: 'offline comparison fixture',
  services: [
    {
      iid: 2,
      type: 'urn:miot-spec-v2:service:test-service:00007801:fake:1',
      description: 'offline service',
      properties: [
        {
          iid: 1,
          type: 'urn:miot-spec-v2:property:mode:00000008:fake:1',
          description: 'string mode',
          format: 'string',
          access: ['read', 'notify'],
        },
        {
          iid: 2,
          type: 'urn:miot-spec-v2:property:enum-level:0000000D:fake:1',
          description: 'float-backed enum',
          format: 'float',
          access: ['read', 'notify'],
          'value-list': [
            { value: 1, description: 'one' },
            { value: 2, description: 'two' },
          ],
        },
        {
          iid: 3,
          type: 'urn:miot-spec-v2:property:temperature:00000020:fake:1',
          description: 'continuous float',
          format: 'float',
          access: ['read', 'notify'],
        },
        {
          iid: 4,
          type: 'urn:miot-spec-v2:property:on:00000006:fake:1',
          description: 'boolean state',
          format: 'bool',
          access: ['read', 'notify'],
        },
        {
          iid: 5,
          type: 'urn:miot-spec-v2:property:count:0000001C:fake:1',
          description: 'integer count',
          format: 'uint16',
          access: ['read', 'notify'],
        },
      ],
      events: [
        {
          iid: 10,
          type: 'urn:miot-spec-v2:event:enum-event:00005001:fake:1',
          description: 'enum event',
          arguments: [2],
        },
        {
          iid: 11,
          type: 'urn:miot-spec-v2:event:continuous-event:00005002:fake:1',
          description: 'continuous event',
          arguments: [3],
        },
        {
          iid: 12,
          type: 'urn:miot-spec-v2:event:mixed-event:00005003:fake:1',
          description: 'mixed event',
          arguments: [1, 4, 5],
        },
      ],
    },
  ],
};

const fakeDevice = {
  specV2Access: true,
  specV3Access: false,
  online: true,
  pushAvailable: true,
  name: 'fake device',
  model: 'fake.model.v1',
  modelName: 'Fake Device',
  urn,
  roomId: 'room-1',
  roomName: 'Test Room',
  icon: '',
};

function ruleSummary(id = 'rule-1') {
  return {
    id,
    enable: false,
    uiType: 'rule',
    userData: {
      name: 'MIoT comparison test',
      transform: { x: 0, y: 0, scale: 1, rotate: 0 },
      lastUpdateTime: 0,
      version: 0,
    },
  };
}

function createStatefulGateway(id = 'rule-1') {
  const state = { summary: ruleSummary(id), nodes: [] };
  const calls = [];
  const deps = {
    baseUrl: fakeBaseUrl,
    store: {
      read: async () => ({
        host: fakeBaseUrl,
        pid: 123,
        socketPath: '/tmp/xgg-miot-test-unused.sock',
        agentStartedAt: fakeAgentStartedAt,
        agentVersion: '0.1.4',
        lastValidatedAt: fakeAgentStartedAt,
      }),
    },
    ipcClient: () => ({
      request: async (method, params, options) => {
        if (method === '$ping') {
          return { host: fakeBaseUrl, agentStartedAt: fakeAgentStartedAt };
        }
        if (method === '$mutation.acquire') return { leaseId: 'test-lease' };
        if (method === '$mutation.release' || method === '$mutation.fence') return { ok: true };
        calls.push({ method, params, options });
        if (method === '/api/getDevList') return { devList: { [did]: fakeDevice } };
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
      return fakeSpec;
    },
  };
  return { calls, deps, state };
}

function flagValues(command, name) {
  return command.flags.filter((flag) => flag.name === name).map((flag) => flag.value);
}

function shortcutFromExport(command) {
  const one = (name) => flagValues(command, name)[0];
  const rawPos = one('--pos');
  const posParts = rawPos?.split(',').map(Number);
  const shortcut = {
    type: command.type,
    id: one('--id'),
    deviceDid: one('--device-did'),
  };
  if (posParts?.length === 4) {
    shortcut.pos = {
      x: posParts[0],
      y: posParts[1],
      width: posParts[2],
      height: posParts[3],
    };
  }
  const property = one('--device-property');
  if (property !== undefined) shortcut.deviceProperty = property;
  const deviceSiid = one('--device-siid');
  if (deviceSiid !== undefined) shortcut.deviceSiid = Number(deviceSiid);
  const event = one('--device-event');
  if (event !== undefined) shortcut.deviceEvent = event;
  const op = one('--op');
  if (op !== undefined) shortcut.op = op;
  const propertyValue = one('--property-value');
  if (propertyValue !== undefined) shortcut.propertyValue = propertyValue;
  const threshold = one('--threshold');
  if (threshold !== undefined) shortcut.threshold = Number(threshold);
  const threshold2 = one('--threshold2');
  if (threshold2 !== undefined) shortcut.threshold2 = Number(threshold2);
  const eventFilters = flagValues(command, '--event-filter').filter((value) => value !== undefined);
  if (eventFilters.length > 0) shortcut.deviceEventArgs = eventFilters;
  return shortcut;
}

async function addShortcut(gateway, shortcut) {
  return addNode(
    {
      ruleId: gateway.state.summary.id,
      shortcut,
      getDeviceSpec: gateway.deps.getDeviceSpec,
      varCheck: false,
    },
    gateway.deps,
  );
}

function comparisonProps(nodes) {
  return Object.fromEntries(nodes.map((node) => [node.id, node.props]));
}

test('shared MIoT projector and contract distinguish enum floats from continuous floats', () => {
  const properties = fakeSpec.services[0].properties;
  assert.deepEqual(
    properties.map((property) => projectMiotComparisonDtype(property)),
    ['string', 'int', 'float', 'boolean', 'int'],
  );
  assert.deepEqual(MIOT_COMPARISON_CONTRACT.string.shortcutOperators, ['eq']);
  assert.equal(MIOT_COMPARISON_CONTRACT.string.equalityWireOperator, '=');
  assert.deepEqual(MIOT_COMPARISON_CONTRACT.float.shortcutOperators, ['gt', 'lt', 'between']);
  assert.equal(parseFiniteDecimalLiteral(' 1.5e2 '), 150);
  assert.equal(parseFiniteDecimalLiteral(''), null);
  assert.equal(parseFiniteDecimalLiteral('0x10'), null);
  assert.equal(parseFiniteDecimalLiteral('1oops'), null);
});

test('string property shortcut creates, validates, exports, and replays without coercion', async () => {
  const source = createStatefulGateway();
  await addShortcut(source, {
    type: 'deviceInput',
    id: 'string-input',
    deviceDid: did,
    deviceProperty: 'mode',
    op: 'eq',
    propertyValue: '00123',
  });
  await addShortcut(source, {
    type: 'deviceGet',
    id: 'string-get',
    deviceDid: did,
    deviceProperty: 'mode',
    op: 'eq',
    propertyValue: '待机 模式',
  });

  const props = comparisonProps(source.state.nodes);
  assert.deepEqual(props['string-input'], {
    did,
    siid: 2,
    piid: 1,
    dtype: 'string',
    operator: '=',
    v1: '00123',
    preload: true,
  });
  assert.deepEqual(props['string-get'], {
    did,
    siid: 2,
    piid: 1,
    dtype: 'string',
    operator: '=',
    v1: '待机 模式',
    preload: true,
  });
  assert.equal(nodeSchemaForType('deviceInput').safeParse(source.state.nodes[0]).success, true);
  assert.equal(nodeSchemaForType('deviceGet').safeParse(source.state.nodes[1]).success, true);
  assert.deepEqual(
    await validateGraph({
      graph: { id: 'rule-1', nodes: source.state.nodes },
      getDeviceSpec: source.deps.getDeviceSpec,
    }),
    [],
  );

  const exported = await exportRuleFromView(
    { id: 'rule-1', cfg: source.state.summary, nodes: source.state.nodes },
    source.deps,
  );
  assert.deepEqual(exported.warnings, []);
  const nodeCommands = exported.commands.filter((command) => command.kind === 'node-add');
  assert.deepEqual(
    nodeCommands.map((command) => flagValues(command, '--property-value')),
    [['00123'], ['待机 模式']],
  );
  assert.deepEqual(
    nodeCommands.map((command) => flagValues(command, '--threshold')),
    [[], []],
  );
  assert.deepEqual(
    nodeCommands.map((command) => flagValues(command, '--device-siid')),
    [['2'], ['2']],
  );

  const replay = createStatefulGateway();
  const replaySpec = structuredClone(fakeSpec);
  replaySpec.services.push({
    iid: 3,
    type: 'urn:miot-spec-v2:service:alternate:00007802:fake:1',
    description: 'duplicate property-name service',
    properties: [
      {
        iid: 9,
        type: 'urn:miot-spec-v2:property:mode:00000008:fake:2',
        description: 'another string mode',
        format: 'string',
        access: ['read', 'notify'],
      },
    ],
  });
  replay.deps.getDeviceSpec = async (requestedUrn) => {
    assert.equal(requestedUrn, urn);
    return replaySpec;
  };
  for (const command of nodeCommands) {
    await addShortcut(replay, shortcutFromExport(command));
  }
  assert.deepEqual(comparisonProps(replay.state.nodes), comparisonProps(source.state.nodes));
});

test('string property shortcut rejects missing, empty, and mixed comparison literals', async () => {
  const cases = [
    [{}, /requires a non-empty --property-value/],
    [{ propertyValue: '' }, /requires a non-empty --property-value/],
    [{ propertyValue: 'open', threshold: 1 }, /cannot use numeric --threshold/],
    [{ propertyValue: 'open', op: 'ne' }, /only supports --op eq/],
  ];

  for (const [extra, expected] of cases) {
    const gateway = createStatefulGateway();
    await assert.rejects(
      addShortcut(gateway, {
        type: 'deviceInput',
        deviceDid: did,
        deviceProperty: 'mode',
        ...extra,
      }),
      expected,
    );
    assert.equal(
      gateway.calls.some((call) => call.method === '/api/setGraph'),
      false,
    );
  }

  const wrongMode = createStatefulGateway();
  await assert.rejects(
    addShortcut(wrongMode, {
      type: 'deviceInput',
      deviceDid: did,
      deviceEvent: 'mixed-event',
      propertyValue: 'open',
    }),
    /only applies to deviceInput\/deviceGet property-mode shortcuts/,
  );
  assert.equal(wrongMode.calls.length, 0);

  const emptyWire = createStatefulGateway();
  await addShortcut(emptyWire, {
    type: 'deviceInput',
    deviceDid: did,
    deviceProperty: 'mode',
    propertyValue: 'open',
  });
  emptyWire.state.nodes[0].props.v1 = '';
  assert.equal(nodeSchemaForType('deviceInput').safeParse(emptyWire.state.nodes[0]).success, false);
  const emptyIssues = await validateGraph({
    graph: { id: 'rule-1', nodes: emptyWire.state.nodes },
    getDeviceSpec: emptyWire.deps.getDeviceSpec,
  });
  assert.equal(
    emptyIssues.some((issue) => issue.path === 'nodes[0].props.v1'),
    true,
  );
});

test('continuous float property shortcut keeps its numeric comparison contract', async () => {
  const gateway = createStatefulGateway();
  await addShortcut(gateway, {
    type: 'deviceGet',
    id: 'continuous-property',
    deviceDid: did,
    deviceProperty: 'temperature',
    op: 'between',
    threshold: 19.5,
    threshold2: 24.75,
  });
  assert.deepEqual(gateway.state.nodes[0].props, {
    did,
    siid: 2,
    piid: 3,
    dtype: 'float',
    operator: 'between',
    v1: 19.5,
    v2: 24.75,
    preload: true,
  });

  const invalid = createStatefulGateway();
  await assert.rejects(
    addShortcut(invalid, {
      type: 'deviceGet',
      deviceDid: did,
      deviceProperty: 'temperature',
      op: 'eq',
      threshold: 20,
    }),
    /float property "temperature" only supports --op gt\|lt\|between/,
  );
  assert.equal(
    invalid.calls.some((call) => call.method === '/api/setGraph'),
    false,
  );
});

test('float value-list event args validate as int while continuous floats remain float', async () => {
  const gateway = createStatefulGateway();
  await addShortcut(gateway, {
    type: 'deviceInput',
    id: 'enum-event',
    deviceDid: did,
    deviceEvent: 'enum-event',
    deviceEventArgs: ['2=1'],
  });
  await addShortcut(gateway, {
    type: 'deviceInput',
    id: 'continuous-event',
    deviceDid: did,
    deviceEvent: 'continuous-event',
    deviceEventArgs: ['3>1.5'],
  });

  const [enumNode, continuousNode] = gateway.state.nodes;
  assert.deepEqual(enumNode.props.arguments, [{ piid: 2, dtype: 'int', operator: '=', v1: 1 }]);
  assert.deepEqual(continuousNode.props.arguments, [
    { piid: 3, dtype: 'float', operator: '>', v1: 1.5 },
  ]);
  assert.deepEqual(
    await validateGraph({
      graph: { id: 'rule-1', nodes: gateway.state.nodes },
      getDeviceSpec: gateway.deps.getDeviceSpec,
    }),
    [],
  );

  const wrongEnum = structuredClone(enumNode);
  wrongEnum.props.arguments[0].dtype = 'float';
  const enumIssues = await validateGraph({
    graph: { id: 'rule-1', nodes: [wrongEnum] },
    getDeviceSpec: gateway.deps.getDeviceSpec,
  });
  assert.equal(
    enumIssues.some(
      (issue) =>
        issue.path === 'nodes[0].props.arguments[0]' &&
        issue.message.includes('format float with a non-empty value-list') &&
        issue.message.includes('expects dtype "int"'),
    ),
    true,
  );

  const wrongContinuous = structuredClone(continuousNode);
  wrongContinuous.props.arguments[0].dtype = 'int';
  const issues = await validateGraph({
    graph: { id: 'rule-1', nodes: [wrongContinuous] },
    getDeviceSpec: gateway.deps.getDeviceSpec,
  });
  assert.equal(
    issues.some(
      (issue) =>
        issue.path === 'nodes[0].props.arguments[0]' &&
        issue.message.includes('expects dtype "float"'),
    ),
    true,
  );
});

test('event-filter parser preserves bool, string, and integer contracts and rejects numeric coercion', async () => {
  const gateway = createStatefulGateway();
  await addShortcut(gateway, {
    type: 'deviceInput',
    id: 'mixed-event',
    deviceDid: did,
    deviceEvent: 'mixed-event',
    deviceEventArgs: ['1=open', '4=1', '5>=2'],
  });
  assert.deepEqual(gateway.state.nodes[0].props.arguments, [
    { piid: 1, dtype: 'string', operator: '=', v1: 'open' },
    { piid: 4, dtype: 'boolean', operator: '=', v1: true },
    { piid: 5, dtype: 'int', operator: '>=', v1: 2 },
  ]);

  for (const [raw, message] of [
    ['2=', /must be <piid><op><v1>/],
    ['2=0x10', /int v1 must be an integer/],
    ['2=1oops', /int v1 must be an integer/],
  ]) {
    const invalid = createStatefulGateway();
    await assert.rejects(
      addShortcut(invalid, {
        type: 'deviceInput',
        deviceDid: did,
        deviceEvent: 'enum-event',
        deviceEventArgs: [raw],
      }),
      message,
    );
    assert.equal(
      invalid.calls.some((call) => call.method === '/api/setGraph'),
      false,
    );
  }
});
