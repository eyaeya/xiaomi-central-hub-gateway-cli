import assert from 'node:assert/strict';
import test from 'node:test';

import { addNode, exportRuleFromView, validateGraph } from '../dist/index.js';

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

function createGateway(deviceSpec = spec) {
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
      return deviceSpec;
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

function actionNode(ins, { id = 'action', aiid = 10 } = {}) {
  return {
    id,
    type: 'deviceOutput',
    cfg: {
      urn,
      pos: { x: 0, y: 0, width: 684, height: 204 },
      name: 'deviceOutput',
      version: 1,
    },
    inputs: { trigger: null },
    outputs: { output: [] },
    props: { did, siid: 2, aiid, ins },
  };
}

function propertyWriteNode() {
  return {
    id: 'property-write',
    type: 'deviceOutput',
    cfg: {
      urn,
      pos: { x: 0, y: 0, width: 684, height: 204 },
      name: 'deviceOutput',
      version: 1,
    },
    inputs: { trigger: null },
    outputs: { output: [] },
    props: { did, siid: 2, piid: 2, value: true },
  };
}

function validIns(overrides = {}) {
  const byPiid = new Map([
    [1, { piid: 1, value: 4 }],
    [2, { piid: 2, value: true }],
    [3, { piid: 3, value: 'hello' }],
    [4, { piid: 4, value: 2 }],
    [5, { piid: 5, value: 0.5 }],
  ]);
  for (const [piid, value] of Object.entries(overrides)) {
    byPiid.set(Number(piid), value);
  }
  return [...byPiid.values()];
}

async function validateNodes(nodes, deviceSpec = spec) {
  return validateGraph({
    graph: { id: ruleId, nodes },
    getDeviceSpec: async (requestedUrn) => {
      assert.equal(requestedUrn, urn);
      return deviceSpec;
    },
  });
}

async function exportNodes(nodes, strictRoundtrip = true, deviceSpec = spec) {
  const gateway = createGateway(deviceSpec);
  return exportRuleFromView(
    { id: ruleId, cfg: gateway.state.summary, nodes },
    gateway.deps,
    undefined,
    strictRoundtrip,
  );
}

async function addAction(gateway, params, id = 'action') {
  return addNamedAction(gateway, 'apply', params, id);
}

async function addNamedAction(gateway, deviceAction, params, id = 'action') {
  return addNode(
    {
      ruleId,
      shortcut: {
        type: 'deviceOutput',
        id,
        deviceDid: did,
        deviceSiid: 2,
        deviceAction,
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

function specWithActionInputs({ properties, actions }) {
  const result = structuredClone(spec);
  result.services[0].properties.push(...properties);
  result.services[0].actions.push(...actions);
  return result;
}

function inputProperty(iid, name, format, valueRange) {
  return {
    iid,
    type: `urn:miot-spec-v2:property:${name}:0000${String(iid).padStart(4, '0')}:fixture:1`,
    description: name,
    format,
    access: ['read', 'write'],
    ...(valueRange === undefined ? {} : { 'value-range': valueRange }),
  };
}

function inputAction(iid, name, inputs) {
  return {
    iid,
    type: `urn:miot-spec-v2:action:${name}:0000${String(iid).padStart(4, '0')}:fixture:1`,
    description: name,
    in: inputs,
    out: [],
  };
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

test('action synthesis follows action.in order instead of JSON object key order', async () => {
  const gateway = createGateway();
  const params = JSON.parse('{"ratio":0.5,"mode":2,"label":"hello","enabled":true,"level":4}');
  await addAction(gateway, params);
  assert.deepEqual(gateway.state.nodes[0].props.ins, validIns());
});

test('bool and string action inputs keep format-native types despite numeric value-lists', async () => {
  const nativeSpec = specWithActionInputs({
    properties: [
      {
        ...inputProperty(50, 'flag-enum', 'bool'),
        'value-list': [
          { value: 7, description: 'vendor false' },
          { value: 8, description: 'vendor true' },
        ],
      },
      {
        ...inputProperty(51, 'text-enum', 'string'),
        'value-list': [
          { value: 7, description: 'vendor seven' },
          { value: 8, description: 'vendor eight' },
        ],
      },
    ],
    actions: [inputAction(50, 'set-format-native', [50, 51])],
  });
  const gateway = createGateway(nativeSpec);
  await addNamedAction(gateway, 'set-format-native', {
    'flag-enum': false,
    'text-enum': 'not-a-numeric-enum-value',
  });
  assert.deepEqual(gateway.state.nodes[0].props.ins, [
    { piid: 50, value: false },
    { piid: 51, value: 'not-a-numeric-enum-value' },
  ]);
  assert.deepEqual(await validateNodes(gateway.state.nodes, nativeSpec), []);
  await exportRuleFromView(
    { id: ruleId, cfg: gateway.state.summary, nodes: gateway.state.nodes },
    gateway.deps,
    undefined,
    true,
  );

  await assert.rejects(
    addNamedAction(createGateway(nativeSpec), 'set-format-native', {
      'flag-enum': false,
      'text-enum': 8,
    }),
    (error) =>
      error?.code === 'CONFIG' && /text-enum.*requires a string value/i.test(error.message),
  );

  const malformed = actionNode(
    [
      { piid: 50, value: 7 },
      { piid: 51, value: 8 },
    ],
    { aiid: 50 },
  );
  const issues = await validateNodes([malformed], nativeSpec);
  assert.equal(
    issues.some((entry) => /piid=50 requires a boolean/i.test(entry.message)),
    true,
    JSON.stringify(issues),
  );
  assert.equal(
    issues.some((entry) => /piid=51 requires a string/i.test(entry.message)),
    true,
    JSON.stringify(issues),
  );
  await assert.rejects(
    exportNodes([malformed], true, nativeSpec),
    (error) => error?.code === 'CONFIG' && /piid=50 requires a boolean/i.test(error.message),
  );
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
    undefined,
    true,
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
  assert.deepEqual(await validateNodes(source.state.nodes), []);
});

test('valid number, boolean, and string action variable refs survive strict export/replay', async () => {
  const source = createGateway();
  await addAction(
    source,
    completeParams({
      level: { $var: 'global.targetLevel' },
      enabled: { $var: 'global.targetEnabled' },
      label: { $var: 'global.targetLabel' },
    }),
  );

  const exported = await exportRuleFromView(
    { id: ruleId, cfg: source.state.summary, nodes: source.state.nodes },
    source.deps,
    undefined,
    true,
  );
  const params = JSON.parse(flagValue(nodeCommand(exported), '--params'));
  assert.deepEqual(params, {
    level: { $var: 'global.targetLevel' },
    enabled: { $var: 'global.targetEnabled' },
    label: { $var: 'global.targetLabel' },
    mode: 2,
    ratio: 0.5,
  });

  const replay = createGateway();
  await addAction(replay, params);
  assert.deepEqual(replay.state.nodes, source.state.nodes);
  assert.deepEqual(await validateNodes(source.state.nodes), []);
});

test('spec-aware validation enforces a one-to-one action.in to props.ins mapping', async () => {
  const cases = [
    {
      name: 'missing',
      ins: validIns({ 1: undefined }).filter(Boolean),
      message: /missing required action input piid=1/i,
    },
    {
      name: 'extra',
      ins: [...validIns(), { piid: 99, value: 1 }],
      message: /unexpected action input piid=99/i,
    },
    {
      name: 'duplicate',
      ins: [...validIns(), { piid: 1, value: 4 }],
      message: /duplicate action input piid=1/i,
    },
  ];

  for (const { name, ins, message } of cases) {
    const issues = await validateNodes([actionNode(ins)]);
    assert.equal(
      issues.some((entry) => message.test(entry.message)),
      true,
      `${name}: ${JSON.stringify(issues)}`,
    );
  }
});

test('spec-aware validation rejects non-native action literals and out-of-domain numbers', async () => {
  const cases = [
    { name: 'number type', input: { piid: 1, value: '4' }, message: /requires a number/i },
    { name: 'boolean type', input: { piid: 2, value: 1 }, message: /requires a boolean/i },
    { name: 'string type', input: { piid: 3, value: 3 }, message: /requires a string/i },
    { name: 'integer', input: { piid: 1, value: 1.5 }, message: /exact safe integer/i },
    { name: 'step', input: { piid: 1, value: 3 }, message: /not aligned.*step 2/i },
    { name: 'value-list', input: { piid: 4, value: 3 }, message: /not in MIoT value-list/i },
    { name: 'range', input: { piid: 5, value: 1.1 }, message: /outside MIoT value-range/i },
  ];

  for (const { name, input, message } of cases) {
    const issues = await validateNodes([actionNode(validIns({ [input.piid]: input }))]);
    assert.equal(
      issues.some((entry) => message.test(entry.message)),
      true,
      `${name}: ${JSON.stringify(issues)}`,
    );
  }
});

test('spec-aware validation checks action variable dtype and exact numeric range metadata', async () => {
  const cases = [
    {
      name: 'dtype',
      input: { piid: 2, scope: 'global', id: 'enabled', dtype: 'number', min: 0, max: 1, step: 1 },
      message: /expects variable dtype "boolean"/i,
    },
    {
      name: 'range',
      input: { piid: 1, scope: 'global', id: 'level', dtype: 'number', min: 0, max: 9, step: 2 },
      message: /range metadata.*\[0, 10, 2\]/i,
    },
    {
      name: 'identifier',
      input: {
        piid: 1,
        scope: 'global',
        id: 'bad-id',
        dtype: 'number',
        min: 0,
        max: 10,
        step: 2,
      },
      message: /variable id must be non-empty ASCII alphanumeric/i,
    },
  ];

  for (const { name, input, message } of cases) {
    const issues = await validateNodes([actionNode(validIns({ [input.piid]: input }))]);
    assert.equal(
      issues.some((entry) => message.test(entry.message)),
      true,
      `${name}: ${JSON.stringify(issues)}`,
    );
  }
});

test('spec-aware action validation leaves property-write deviceOutput nodes unchanged', async () => {
  assert.deepEqual(await validateNodes([propertyWriteNode()]), []);
});

test('strict export rejects persisted action mapping, literal, and variable contract failures', async () => {
  const cases = [
    {
      name: 'missing',
      ins: validIns({ 1: undefined }).filter(Boolean),
      message: /missing required action input piid=1/i,
    },
    {
      name: 'extra',
      ins: [...validIns(), { piid: 99, value: 1 }],
      message: /unexpected action input piid=99/i,
    },
    {
      name: 'duplicate',
      ins: [...validIns(), { piid: 1, value: 4 }],
      message: /duplicate action input piid=1/i,
    },
    {
      name: 'literal type',
      ins: validIns({ 2: { piid: 2, value: 1 } }),
      message: /requires a boolean/i,
    },
    {
      name: 'literal domain',
      ins: validIns({ 1: { piid: 1, value: 3 } }),
      message: /not aligned.*step 2/i,
    },
    {
      name: 'literal integer',
      ins: validIns({ 1: { piid: 1, value: 1.5 } }),
      message: /exact safe integer/i,
    },
    {
      name: 'variable dtype',
      ins: validIns({
        3: { piid: 3, scope: 'global', id: 'label', dtype: 'boolean' },
      }),
      message: /expects variable dtype "string"/i,
    },
    {
      name: 'variable range',
      ins: validIns({
        1: { piid: 1, scope: 'global', id: 'level', dtype: 'number', min: 0, max: 9, step: 2 },
      }),
      message: /range metadata.*\[0, 10, 2\]/i,
    },
    {
      name: 'variable identifier',
      ins: validIns({
        1: {
          piid: 1,
          scope: 'global',
          id: 'bad-id',
          dtype: 'number',
          min: 0,
          max: 10,
          step: 2,
        },
      }),
      message: /variable id must be non-empty ASCII alphanumeric/i,
    },
  ];

  for (const { name, ins, message } of cases) {
    await assert.rejects(
      exportNodes([actionNode(ins)]),
      (error) => error?.code === 'CONFIG' && message.test(error.message),
      name,
    );
  }
});

test('permissive export warns before emitting an incomplete action replay', async () => {
  const exported = await exportNodes(
    [actionNode(validIns({ 1: undefined }).filter(Boolean))],
    false,
  );
  assert.equal(
    exported.warnings.some((warning) => /missing required action input piid=1/i.test(warning)),
    true,
  );
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
    (error) => error?.code === 'CONFIG' && /not in MIoT value-list \[0, 1, 2\]/.test(error.message),
  );
  await assert.rejects(
    addAction(createGateway(), completeParams({ level: 12 })),
    (error) => error?.code === 'CONFIG' && /outside MIoT value-range \[0, 10\]/.test(error.message),
  );
  await assert.rejects(
    addAction(createGateway(), completeParams({ level: 3 })),
    (error) => error?.code === 'CONFIG' && /not aligned.*value-range step 2/.test(error.message),
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
        `unsafe${index}`,
      ),
      (error) =>
        error?.code === 'CONFIG' &&
        /requires an exact safe integer for format int64/.test(error.message) &&
        error.details?.value === value,
      String(value),
    );
  }
});

test('action input arrays are index-bound and permissive export cannot silently reorder them', async () => {
  const reordered = validIns();
  [reordered[0], reordered[1]] = [reordered[1], reordered[0]];

  const issues = await validateNodes([actionNode(reordered)]);
  assert.equal(
    issues.some((entry) => /index 0.*requires piid=1.*got piid=2/i.test(entry.message)),
    true,
    JSON.stringify(issues),
  );
  await assert.rejects(
    exportNodes([actionNode(reordered)]),
    (error) =>
      error?.code === 'CONFIG' && /index 0.*requires piid=1.*got piid=2/i.test(error.message),
  );

  const permissive = await exportNodes([actionNode(reordered)], false);
  assert.equal(
    permissive.warnings.some((warning) => /index 0.*requires piid=1.*got piid=2/i.test(warning)),
    true,
  );
  const params = JSON.parse(flagValue(nodeCommand(permissive), '--params'));
  assert.deepEqual(params, {
    level: true,
    enabled: 4,
    label: 'hello',
    mode: 2,
    ratio: 0.5,
  });
  await assert.rejects(addAction(createGateway(), params), (error) => error?.code === 'CONFIG');
});

test('malformed persisted action inputs warn without crashing permissive export', async () => {
  const malformed = actionNode([null, ...validIns().slice(1)]);
  const issues = await validateNodes([malformed]);
  assert.equal(
    issues.some((entry) => /index 0.*requires piid=1.*got piid=undefined/i.test(entry.message)),
    true,
  );
  const permissive = await exportNodes([malformed], false);
  assert.equal(
    permissive.warnings.some((warning) =>
      /index 0.*requires piid=1.*got piid=undefined/i.test(warning),
    ),
    true,
  );
  assert.equal(JSON.parse(flagValue(nodeCommand(permissive), '--params')).level, null);
});

test('duplicate action.in entries are rejected by authoring, validation, and strict export', async () => {
  const duplicateSpec = specWithActionInputs({
    properties: [],
    actions: [inputAction(20, 'duplicate-input', [1, 1])],
  });
  await assert.rejects(
    addNamedAction(createGateway(duplicateSpec), 'duplicate-input', { level: 4 }),
    (error) => error?.code === 'CONFIG' && /declares duplicate input piid=1/i.test(error.message),
  );

  const node = actionNode(
    [
      { piid: 1, value: 4 },
      { piid: 1, value: 4 },
    ],
    { aiid: 20 },
  );
  const issues = await validateNodes([node], duplicateSpec);
  assert.equal(
    issues.some((entry) => /declares duplicate input piid=1/i.test(entry.message)),
    true,
  );
  await assert.rejects(
    exportNodes([node], true, duplicateSpec),
    (error) => error?.code === 'CONFIG' && /declares duplicate input piid=1/i.test(error.message),
  );
  const permissive = await exportNodes([node], false, duplicateSpec);
  assert.equal(
    permissive.warnings.some((warning) => /declares duplicate input piid=1/i.test(warning)),
    true,
  );
  assert.equal(flagValue(nodeCommand(permissive), '--params'), '{"level":4,"piid-1-index-1":4}');
});

test('duplicate property short-names never disappear silently across action projection modes', async () => {
  const duplicateNameSpec = specWithActionInputs({
    properties: [
      inputProperty(21, 'same', 'uint8', [0, 10, 1]),
      inputProperty(22, 'same', 'uint8', [0, 10, 1]),
    ],
    actions: [inputAction(21, 'duplicate-name', [21, 22])],
  });
  await assert.rejects(
    addNamedAction(createGateway(duplicateNameSpec), 'duplicate-name', { same: 1 }),
    (error) =>
      error?.code === 'CONFIG' &&
      /duplicate parameter short-name "same".*piid=21.*piid=22/i.test(error.message),
  );

  const node = actionNode(
    [
      { piid: 21, value: 1 },
      { piid: 22, value: 2 },
    ],
    { aiid: 21 },
  );
  const issues = await validateNodes([node], duplicateNameSpec);
  assert.equal(
    issues.some((entry) =>
      /duplicate parameter short-name "same".*piid=21.*piid=22/i.test(entry.message),
    ),
    true,
  );
  await assert.rejects(
    exportNodes([node], true, duplicateNameSpec),
    (error) =>
      error?.code === 'CONFIG' &&
      /duplicate parameter short-name "same".*piid=21.*piid=22/i.test(error.message),
  );
  const permissive = await exportNodes([node], false, duplicateNameSpec);
  assert.equal(
    permissive.warnings.some((warning) =>
      /duplicate parameter short-name "same".*piid=21.*piid=22/i.test(warning),
    ),
    true,
  );
  assert.equal(flagValue(nodeCommand(permissive), '--params'), '{"same":1,"piid-22-index-1":2}');
});

test('__proto__ action parameter is exported as an own JSON key and replays losslessly', async () => {
  const protoSpec = specWithActionInputs({
    properties: [inputProperty(23, '__proto__', 'uint8', [0, 10, 1])],
    actions: [inputAction(23, 'proto-key', [23])],
  });
  const params = JSON.parse('{"__proto__":7}');
  const source = createGateway(protoSpec);
  await addNamedAction(source, 'proto-key', params);
  assert.deepEqual(source.state.nodes[0].props.ins, [{ piid: 23, value: 7 }]);

  const exported = await exportRuleFromView(
    { id: ruleId, cfg: source.state.summary, nodes: source.state.nodes },
    source.deps,
    undefined,
    true,
  );
  const rendered = JSON.parse(flagValue(nodeCommand(exported), '--params'));
  assert.equal(Object.hasOwn(rendered, '__proto__'), true);
  assert.equal(rendered.__proto__, 7);
  const replay = createGateway(protoSpec);
  await addNamedAction(replay, 'proto-key', rendered);
  assert.deepEqual(replay.state.nodes, source.state.nodes);
});

test('invalid numeric value-ranges are rejected consistently by authoring and persisted validation', async () => {
  const ranges = [
    { name: 'zero-step', range: [0, 10, 0] },
    { name: 'reversed', range: [10, 0, 1] },
    { name: 'non-finite', range: [0, Number.POSITIVE_INFINITY, 1] },
  ];

  for (const [offset, { name, range }] of ranges.entries()) {
    const piid = 30 + offset;
    const aiid = 30 + offset;
    const deviceSpec = specWithActionInputs({
      properties: [inputProperty(piid, name, 'float', range)],
      actions: [inputAction(aiid, `set-${name}`, [piid])],
    });
    await assert.rejects(
      addNamedAction(createGateway(deviceSpec), `set-${name}`, { [name]: 5 }),
      (error) => error?.code === 'CONFIG' && /invalid MIoT value-range/i.test(error.message),
      name,
    );
    await assert.rejects(
      addNamedAction(createGateway(deviceSpec), `set-${name}`, {
        [name]: { $var: 'global.target' },
      }),
      (error) => error?.code === 'CONFIG' && /invalid MIoT value-range/i.test(error.message),
      `${name} variable`,
    );
    const node = actionNode([{ piid, value: 5 }], { aiid });
    const issues = await validateNodes([node], deviceSpec);
    assert.equal(
      issues.some((entry) => /invalid MIoT value-range/i.test(entry.message)),
      true,
      `${name}: ${JSON.stringify(issues)}`,
    );
    await assert.rejects(
      exportNodes([node], true, deviceSpec),
      (error) => error?.code === 'CONFIG' && /invalid MIoT value-range/i.test(error.message),
      name,
    );
    const variableIssues = await validateNodes(
      [
        actionNode(
          [
            {
              piid,
              scope: 'global',
              id: 'target',
              dtype: 'number',
              min: range[0],
              max: range[1],
              step: range[2],
            },
          ],
          { aiid },
        ),
      ],
      deviceSpec,
    );
    assert.equal(
      variableIssues.some((entry) => /invalid MIoT value-range/i.test(entry.message)),
      true,
      `${name} variable: ${JSON.stringify(variableIssues)}`,
    );
  }
});

test('large integer and float step quotients have identical authoring and validation decisions', async () => {
  const largeSpec = specWithActionInputs({
    properties: [
      inputProperty(40, 'large-int', 'uint64', [0, Number.MAX_SAFE_INTEGER, 3]),
      inputProperty(41, 'large-float', 'float', [0, 2e12, 1]),
    ],
    actions: [inputAction(40, 'set-large-int', [40]), inputAction(41, 'set-large-float', [41])],
  });
  const cases = [
    {
      name: 'integer',
      action: 'set-large-int',
      aiid: 40,
      piid: 40,
      key: 'large-int',
      aligned: Number.MAX_SAFE_INTEGER - 1,
      offStep: Number.MAX_SAFE_INTEGER,
    },
    {
      name: 'float',
      action: 'set-large-float',
      aiid: 41,
      piid: 41,
      key: 'large-float',
      aligned: 1e12,
      offStep: 1e12 + 0.001,
    },
  ];

  for (const entry of cases) {
    const accepted = createGateway(largeSpec);
    await addNamedAction(accepted, entry.action, { [entry.key]: entry.aligned });
    assert.deepEqual(await validateNodes(accepted.state.nodes, largeSpec), [], entry.name);
    await exportRuleFromView(
      { id: ruleId, cfg: accepted.state.summary, nodes: accepted.state.nodes },
      accepted.deps,
      undefined,
      true,
    );

    await assert.rejects(
      addNamedAction(createGateway(largeSpec), entry.action, { [entry.key]: entry.offStep }),
      (error) => error?.code === 'CONFIG' && /not aligned.*step/i.test(error.message),
      entry.name,
    );
    const issues = await validateNodes(
      [actionNode([{ piid: entry.piid, value: entry.offStep }], { aiid: entry.aiid })],
      largeSpec,
    );
    assert.equal(
      issues.some((issue) => /not aligned.*step/i.test(issue.message)),
      true,
      `${entry.name}: ${JSON.stringify(issues)}`,
    );
  }
});

test('number variables without ranges and non-number variables with ranges are rejected', async () => {
  await assert.rejects(
    addCounterAction(createGateway(), {
      'signed-counter': { $var: 'global.counter' },
      'unsigned-counter': 0,
    }),
    (error) => error?.code === 'CONFIG' && /declares no value-range/i.test(error.message),
  );

  const numberWithoutRange = actionNode(
    [
      { piid: 6, scope: 'global', id: 'counter', dtype: 'number' },
      { piid: 7, value: 0 },
    ],
    { aiid: 11 },
  );
  const boolWithRange = actionNode(
    validIns({
      2: {
        piid: 2,
        scope: 'global',
        id: 'enabled',
        dtype: 'boolean',
        min: 0,
        max: 1,
        step: 1,
      },
    }),
  );
  for (const [node, pattern, strictPattern] of [
    [
      numberWithoutRange,
      /cannot use a number variable.*declares no value-range/i,
      /number-dtype variable requires numeric min\/max\/step|declares no value-range/i,
    ],
    [
      boolWithRange,
      /must not carry numeric range metadata/i,
      /must not carry numeric range metadata/i,
    ],
  ]) {
    const issues = await validateNodes([node]);
    assert.equal(
      issues.some((entry) => pattern.test(entry.message)),
      true,
      JSON.stringify(issues),
    );
    await assert.rejects(
      exportNodes([node]),
      (error) => error?.code === 'CONFIG' && strictPattern.test(error.message),
    );
    const permissive = await exportNodes([node], false);
    assert.equal(
      permissive.warnings.some((warning) => pattern.test(warning)),
      true,
    );
    assert.ok(flagValue(nodeCommand(permissive), '--params'));
  }
});
