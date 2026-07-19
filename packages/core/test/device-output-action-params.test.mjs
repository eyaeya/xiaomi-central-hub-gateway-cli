import assert from 'node:assert/strict';
import test from 'node:test';

import { addNode, exportRuleFromView } from '../dist/index.js';

const baseUrl = 'http://gateway.invalid';
const startedAt = '2026-07-19T00:00:00.000Z';
const ruleId = '99';
const did = 'typed-action-device';
const urn = 'urn:miot-spec-v2:device:typed-action:0000A001:fixture:1';

const spec = {
  type: urn,
  description: 'typed action fixture',
  services: [
    {
      iid: 2,
      type: 'urn:miot-spec-v2:service:typed-action:00007801:fixture:1',
      description: 'typed action service',
      properties: [
        {
          iid: 1,
          type: 'urn:miot-spec-v2:property:level:00000001:fixture:1',
          description: 'level',
          format: 'uint8',
          access: ['read', 'write'],
          'value-range': [0, 10, 2],
        },
        {
          iid: 2,
          type: 'urn:miot-spec-v2:property:enabled:00000002:fixture:1',
          description: 'enabled',
          format: 'bool',
          access: ['read', 'write'],
        },
        {
          iid: 3,
          type: 'urn:miot-spec-v2:property:label:00000003:fixture:1',
          description: 'label',
          format: 'string',
          access: ['read', 'write'],
        },
        {
          iid: 4,
          type: 'urn:miot-spec-v2:property:mode:00000004:fixture:1',
          description: 'mode',
          format: 'float',
          access: ['read', 'write'],
          'value-list': [
            { value: 0, description: 'off' },
            { value: 1, description: 'eco' },
            { value: 2, description: 'boost' },
          ],
        },
        {
          iid: 5,
          type: 'urn:miot-spec-v2:property:ratio:00000005:fixture:1',
          description: 'ratio',
          format: 'float',
          access: ['read', 'write'],
          'value-range': [0, 1, 0.1],
        },
        {
          iid: 6,
          type: 'urn:miot-spec-v2:property:signed-counter:00000006:fixture:1',
          description: 'signed counter',
          format: 'int64',
          access: ['read', 'write'],
        },
        {
          iid: 7,
          type: 'urn:miot-spec-v2:property:unsigned-counter:00000007:fixture:1',
          description: 'unsigned counter',
          format: 'uint64',
          access: ['read', 'write'],
        },
      ],
      actions: [
        {
          iid: 10,
          type: 'urn:miot-spec-v2:action:apply:00002801:fixture:1',
          description: 'apply typed values',
          in: [1, 2, 3, 4, 5],
          out: [],
        },
        {
          iid: 11,
          type: 'urn:miot-spec-v2:action:set-counters:00002802:fixture:1',
          description: 'set 64-bit counters',
          in: [6, 7],
          out: [],
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
  name: 'typed action fixture',
  model: 'fixture.typed-action.v1',
  modelName: 'Typed Action Fixture',
  urn,
  roomId: 'room-1',
  roomName: 'Room',
  icon: '',
};

function summary() {
  return {
    id: ruleId,
    enable: false,
    uiType: 'rule',
    userData: {
      name: 'typed action fixture',
      transform: { x: 0, y: 0, scale: 1, rotate: 0 },
      lastUpdateTime: 0,
      version: 0,
    },
  };
}

function createGateway() {
  const state = { summary: summary(), nodes: [] };
  const deps = {
    baseUrl,
    store: {
      read: async () => ({
        host: baseUrl,
        pid: 1,
        socketPath: '/tmp/xgg-action-params-unused.sock',
        agentStartedAt: startedAt,
        agentVersion: '0.1.4',
        lastValidatedAt: startedAt,
      }),
    },
    ipcClient: () => ({
      request: async (method, params) => {
        if (method === '$ping') return { host: baseUrl, agentStartedAt: startedAt };
        if (method === '$mutation.acquire') return { leaseId: 'test-lease' };
        if (method === '$mutation.release' || method === '$mutation.fence') return { ok: true };
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
    getDeviceSpec: async (requestedUrn) => {
      assert.equal(requestedUrn, urn);
      return spec;
    },
  };
  return { deps, state };
}

function completeParams(overrides = {}) {
  return {
    level: 4,
    enabled: true,
    label: 'hello',
    mode: 2,
    ratio: 0.5,
    ...overrides,
  };
}

async function addAction(gateway, params, id = 'action') {
  return addNode(
    {
      ruleId,
      shortcut: {
        type: 'deviceOutput',
        id,
        deviceDid: did,
        deviceSiid: 2,
        deviceAction: 'apply',
        params,
        pos: { x: 0, y: 0, width: 684, height: 204 },
      },
      getDeviceSpec: gateway.deps.getDeviceSpec,
      validate: false,
      varCheck: false,
    },
    gateway.deps,
  );
}

async function addCounterAction(gateway, params, id = 'counters') {
  return addNode(
    {
      ruleId,
      shortcut: {
        type: 'deviceOutput',
        id,
        deviceDid: did,
        deviceSiid: 2,
        deviceAction: 'set-counters',
        params,
        pos: { x: 0, y: 0, width: 684, height: 204 },
      },
      getDeviceSpec: gateway.deps.getDeviceSpec,
      validate: false,
      varCheck: false,
    },
    gateway.deps,
  );
}

function nodeCommand(exported) {
  return exported.commands.find(
    (command) => command.kind === 'node-add' && command.nodeId === 'action',
  );
}

function flagValue(command, name) {
  return command.flags.find((flag) => flag.name === name)?.value;
}

test('action synthesis retains native literals and coerces JSON-compatible scalar forms', async () => {
  const gateway = createGateway();
  await addAction(
    gateway,
    completeParams({ level: '4', enabled: 'false', mode: '2', ratio: '0.5' }),
  );

  assert.deepEqual(gateway.state.nodes[0].props.ins, [
    { piid: 1, value: 4 },
    { piid: 2, value: false },
    { piid: 3, value: 'hello' },
    { piid: 4, value: 2 },
    { piid: 5, value: 0.5 },
  ]);
});

test('action variables retain their wire shape and native literals round-trip through export', async () => {
  const source = createGateway();
  await addAction(
    source,
    completeParams({ level: { $var: 'global.targetLevel' }, enabled: false }),
  );

  assert.deepEqual(source.state.nodes[0].props.ins[0], {
    piid: 1,
    scope: 'global',
    id: 'targetLevel',
    dtype: 'number',
    min: 0,
    max: 10,
    step: 2,
  });

  const exported = await exportRuleFromView(
    { id: ruleId, cfg: source.state.summary, nodes: source.state.nodes },
    source.deps,
  );
  const command = nodeCommand(exported);
  const params = JSON.parse(flagValue(command, '--params'));
  assert.deepEqual(
    params,
    completeParams({ level: { $var: 'global.targetLevel' }, enabled: false }),
  );
  assert.equal(typeof params.enabled, 'boolean');
  assert.equal(typeof params.mode, 'number');
  assert.equal(typeof params.ratio, 'number');

  const replay = createGateway();
  await addAction(replay, params);
  assert.deepEqual(replay.state.nodes, source.state.nodes);
});

test('action synthesis rejects missing required and unknown parameters clearly', async () => {
  const missing = { level: 4, enabled: true, mode: 2, ratio: 0.5 };
  await assert.rejects(
    addAction(createGateway(), missing),
    (error) =>
      error?.code === 'CONFIG' &&
      /missing required parameter\(s\): label/.test(error.message) &&
      error.details?.missing?.includes('label'),
  );

  await assert.rejects(
    addAction(createGateway(), completeParams({ surprise: 1 })),
    (error) =>
      error?.code === 'CONFIG' &&
      /unknown parameter\(s\): surprise/.test(error.message) &&
      error.details?.unknown?.includes('surprise'),
  );
});

test('action synthesis enforces value-list membership and numeric range/step', async () => {
  await assert.rejects(
    addAction(createGateway(), completeParams({ mode: 3 })),
    (error) => error?.code === 'CONFIG' && /not in value-list \[0, 1, 2\]/.test(error.message),
  );
  await assert.rejects(
    addAction(createGateway(), completeParams({ level: 12 })),
    (error) => error?.code === 'CONFIG' && /outside value-range \[0, 10\]/.test(error.message),
  );
  await assert.rejects(
    addAction(createGateway(), completeParams({ level: 3 })),
    (error) =>
      error?.code === 'CONFIG' && /does not align with value-range step 2/.test(error.message),
  );
});

test('int64 and uint64 action inputs preserve exact safe-integer boundaries', async () => {
  const gateway = createGateway();
  await addCounterAction(gateway, {
    'signed-counter': String(Number.MIN_SAFE_INTEGER),
    'unsigned-counter': String(Number.MAX_SAFE_INTEGER),
  });

  assert.deepEqual(gateway.state.nodes[0].props.ins, [
    { piid: 6, value: Number.MIN_SAFE_INTEGER },
    { piid: 7, value: Number.MAX_SAFE_INTEGER },
  ]);
});

test('integer action inputs reject unsafe numbers and lossy decimal strings', async () => {
  const invalidValues = [
    Number.MAX_SAFE_INTEGER + 1,
    Number.MIN_SAFE_INTEGER - 1,
    '9007199254740992',
    '-9007199254740992',
    '9007199254740993',
    '9007199254740990.9',
  ];

  for (const [index, value] of invalidValues.entries()) {
    await assert.rejects(
      addCounterAction(
        createGateway(),
        { 'signed-counter': value, 'unsigned-counter': 0 },
        `unsafe-${index}`,
      ),
      (error) =>
        error?.code === 'CONFIG' &&
        /requires an exact safe integer for format int64/.test(error.message) &&
        error.details?.value === value,
      String(value),
    );
  }
});
