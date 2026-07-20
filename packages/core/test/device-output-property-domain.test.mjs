import assert from 'node:assert/strict';
import test from 'node:test';

import { addNode, exportRuleFromView, validateGraph } from '../dist/index.js';

const baseUrl = 'http://gateway.invalid';
const startedAt = '2026-07-21T00:00:00.000Z';
const ruleId = '172';
const did = 'property-domain-device';
const urn = 'urn:miot-spec-v2:device:property-domain:0000A001:fixture:1';

const properties = [
  property(1, 'level', 'uint8', { 'value-range': [0, 10, 2] }),
  property(2, 'mode', 'uint8', {
    'value-list': [
      { value: 0, description: 'off' },
      { value: 2, description: 'boost' },
    ],
  }),
  property(3, 'ratio', 'float', { 'value-range': [0, 2, 0.25] }),
  property(4, 'precise', 'double', { 'value-range': [-2, 2, 0.25] }),
  property(5, 'counter', 'int64'),
  property(6, 'enabled', 'bool', {
    'value-list': [
      { value: 7, description: 'vendor false' },
      { value: 8, description: 'vendor true' },
    ],
  }),
  property(7, 'label', 'string', {
    'value-list': [{ value: 7, description: 'vendor text metadata' }],
  }),
  property(8, 'readonly-level', 'uint8', { access: ['read'], 'value-range': [0, 10, 1] }),
  property(9, 'free-label', 'string'),
];

const spec = specWith(properties);

function property(iid, name, format, extra = {}) {
  return {
    iid,
    type: `urn:miot-spec-v2:property:${name}:0000${String(iid).padStart(4, '0')}:fixture:1`,
    description: name,
    format,
    access: extra.access ?? ['read', 'write'],
    ...extra,
  };
}

function specWith(serviceProperties) {
  return {
    type: urn,
    description: 'property domain fixture',
    services: [
      {
        iid: 2,
        type: 'urn:miot-spec-v2:service:property-domain:00007801:fixture:1',
        description: 'property domain service',
        properties: serviceProperties,
      },
    ],
  };
}

const device = {
  specV2Access: true,
  specV3Access: false,
  online: true,
  pushAvailable: true,
  name: 'property domain fixture',
  model: 'fixture.property-domain.v1',
  modelName: 'Property Domain Fixture',
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
      name: 'property domain fixture',
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
        socketPath: '/tmp/xgg-property-domain-unused.sock',
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

async function addProperty(
  gateway,
  deviceProperty,
  value,
  id = deviceProperty.replaceAll('-', ''),
) {
  return addNode(
    {
      ruleId,
      shortcut: {
        type: 'deviceOutput',
        id,
        deviceDid: did,
        deviceSiid: 2,
        deviceProperty,
        value,
        pos: { x: 0, y: 0, width: 684, height: 204 },
      },
      getDeviceSpec: gateway.deps.getDeviceSpec,
      validate: false,
      varCheck: false,
    },
    gateway.deps,
  );
}

function propertyWriteNode(props = {}) {
  const mergedProps = Object.hasOwn(props, 'scope')
    ? { did, siid: 2, piid: 1, ...props }
    : { did, siid: 2, piid: 1, value: 4, ...props };
  return {
    id: 'propertywrite',
    type: 'deviceOutput',
    cfg: {
      urn,
      pos: { x: 0, y: 0, width: 684, height: 204 },
      name: 'deviceOutput',
      version: 1,
    },
    inputs: { trigger: null },
    outputs: { output: [] },
    props: mergedProps,
  };
}

async function validateNode(node, deviceSpec = spec) {
  return validateGraph({
    graph: { id: ruleId, nodes: [node] },
    getDeviceSpec: async (requestedUrn) => {
      assert.equal(requestedUrn, urn);
      return deviceSpec;
    },
  });
}

async function exportNode(node, strictRoundtrip = true, deviceSpec = spec) {
  const gateway = createGateway(deviceSpec);
  return exportRuleFromView(
    { id: ruleId, cfg: gateway.state.summary, nodes: [node] },
    gateway.deps,
    undefined,
    strictRoundtrip,
  );
}

test('property authoring preserves strict decimal, scientific, double, bool, string, and dollar forms', async () => {
  const gateway = createGateway();
  await addProperty(gateway, 'level', '1e1');
  await addProperty(gateway, 'counter', '1e2');
  await addProperty(gateway, 'ratio', '5e-1');
  await addProperty(gateway, 'precise', '1.75');
  await addProperty(gateway, 'enabled', '0');
  await addProperty(gateway, 'label', '$$global.literal');

  assert.deepEqual(
    gateway.state.nodes.map((node) => node.props.value),
    [10, 100, 0.5, 1.75, false, '$global.literal'],
  );
  for (const node of gateway.state.nodes) {
    assert.deepEqual(await validateNode(node), []);
  }
});

test('property authoring rejects partial, fractional, unsafe, non-finite, and out-of-domain numbers', async () => {
  const cases = [
    { property: 'level', value: '7junk', message: /exact safe integer/i },
    { property: 'level', value: '1.5', message: /exact safe integer/i },
    { property: 'counter', value: '9007199254740992', message: /exact safe integer/i },
    { property: 'counter', value: '1e309', message: /exact safe integer/i },
    { property: 'ratio', value: '0.5junk', message: /finite numeric value/i },
    { property: 'ratio', value: 'Infinity', message: /finite numeric value/i },
    { property: 'precise', value: '1e309', message: /finite numeric value/i },
    { property: 'mode', value: '1', message: /not in MIoT value-list/i },
    { property: 'level', value: '12', message: /outside MIoT value-range/i },
    { property: 'level', value: '3', message: /not aligned.*step 2/i },
  ];

  for (const { property: name, value, message } of cases) {
    await assert.rejects(
      addProperty(createGateway(), name, value),
      (error) => error?.code === 'CONFIG' && message.test(error.message),
      `${name}=${value}`,
    );
  }
});

test('property authoring rejects malformed numeric ranges for literals and variables', async () => {
  const ranges = [
    [0, 10, 0],
    [10, 0, 1],
    [0, Number.POSITIVE_INFINITY, 1],
  ];

  for (const [index, range] of ranges.entries()) {
    const malformed = specWith([
      property(20 + index, `malformed-${index}`, 'double', { 'value-range': range }),
    ]);
    await assert.rejects(
      addProperty(createGateway(malformed), `malformed-${index}`, '5'),
      (error) => error?.code === 'CONFIG' && /invalid MIoT value-range/i.test(error.message),
      `literal ${range}`,
    );
    await assert.rejects(
      addProperty(createGateway(malformed), `malformed-${index}`, '$global.target'),
      (error) => error?.code === 'CONFIG' && /invalid MIoT value-range/i.test(error.message),
      `variable ${range}`,
    );
  }
});

test('number property variables retain exact native dtype/range and literal-only targets reject refs', async () => {
  const gateway = createGateway();
  await addProperty(gateway, 'ratio', '$global.targetRatio');

  assert.deepEqual(
    gateway.state.nodes.map((node) => node.props),
    [
      {
        did,
        siid: 2,
        piid: 3,
        scope: 'global',
        id: 'targetRatio',
        dtype: 'number',
        min: 0,
        max: 2,
        step: 0.25,
      },
    ],
  );
  for (const node of gateway.state.nodes) {
    assert.deepEqual(await validateNode(node), []);
  }
  for (const [name, ref, message] of [
    ['enabled', '$global.targetEnabled', /boolean.*literal-only/i],
    ['label', '$global.targetLabel', /value-list.*literal-only/i],
    ['mode', '$global.targetMode', /value-list.*literal-only/i],
  ]) {
    await assert.rejects(
      addProperty(createGateway(), name, ref),
      (error) => error?.code === 'CONFIG' && message.test(error.message),
      name,
    );
  }
});

test('spec-aware persisted property writes enforce property capability, native type, and domain', async () => {
  const cases = [
    { name: 'missing', props: { piid: 99 }, message: /property siid=2 piid=99 not found/i },
    { name: 'read-only', props: { piid: 8 }, message: /requires MIoT access "write"/i },
    { name: 'number type', props: { value: '4' }, message: /native JSON number/i },
    { name: 'boolean type', props: { piid: 6, value: 7 }, message: /native JSON boolean/i },
    { name: 'string type', props: { piid: 7, value: 7 }, message: /native JSON string/i },
    {
      name: 'unsafe integer',
      props: { piid: 5, value: Number.MAX_SAFE_INTEGER + 1 },
      message: /exact safe integer/i,
    },
    { name: 'enum', props: { piid: 2, value: 1 }, message: /not in MIoT value-list/i },
    { name: 'range', props: { piid: 3, value: 2.25 }, message: /outside MIoT value-range/i },
    { name: 'step', props: { piid: 4, value: 0.1 }, message: /not aligned.*step 0.25/i },
  ];

  for (const { name, props, message } of cases) {
    const issues = await validateNode(propertyWriteNode(props));
    assert.equal(
      issues.some((entry) => message.test(entry.message)),
      true,
      `${name}: ${JSON.stringify(issues)}`,
    );
  }

  assert.deepEqual(await validateNode(propertyWriteNode({ piid: 6, value: true })), []);
  assert.deepEqual(await validateNode(propertyWriteNode({ piid: 6, value: false })), []);
  assert.deepEqual(await validateNode(propertyWriteNode({ piid: 6, value: 1 })), []);
  assert.deepEqual(await validateNode(propertyWriteNode({ piid: 6, value: 0 })), []);
});

test('spec-aware persisted property variables enforce dtype, identifiers, and exact range metadata', async () => {
  const base = {
    piid: 3,
    scope: 'global',
    id: 'target',
    dtype: 'number',
    min: 0,
    max: 2,
    step: 0.25,
  };
  const cases = [
    {
      name: 'dtype',
      props: { ...base, dtype: 'string' },
      message: /expects variable dtype "number"/i,
    },
    { name: 'id', props: { ...base, id: 'bad-id' }, message: /variable id must be/i },
    { name: 'range', props: { ...base, max: 1 }, message: /range metadata.*\[0, 2, 0.25\]/i },
    {
      name: 'nonnumeric metadata',
      props: { ...base, piid: 9, dtype: 'string' },
      message: /must not carry numeric range metadata/i,
    },
    {
      name: 'missing source range',
      props: { ...base, piid: 5, min: 0, max: 10, step: 1 },
      message: /declares no value-range/i,
    },
  ];

  assert.deepEqual(await validateNode(propertyWriteNode(base)), []);
  for (const { name, props, message } of cases) {
    const issues = await validateNode(propertyWriteNode(props));
    assert.equal(
      issues.some((entry) => message.test(entry.message)),
      true,
      `${name}: ${JSON.stringify(issues)}`,
    );
  }
});

test('malformed property ranges fail persisted spec-aware validation and strict export', async () => {
  const malformed = specWith([property(1, 'level', 'double', { 'value-range': [0, 10, 0] })]);
  const node = propertyWriteNode({ value: 4 });
  const issues = await validateNode(node, malformed);
  assert.equal(
    issues.some((entry) => /invalid MIoT value-range/i.test(entry.message)),
    true,
    JSON.stringify(issues),
  );
  await assert.rejects(
    exportNode(node, true, malformed),
    (error) => error?.code === 'CONFIG' && /invalid MIoT value-range/i.test(error.message),
  );
  const permissive = await exportNode(node, false, malformed);
  assert.equal(
    permissive.warnings.some((warning) => /invalid MIoT value-range/i.test(warning)),
    true,
  );
});

test('strict export rejects an ordinary persisted property domain violation', async () => {
  const node = propertyWriteNode({ value: 3 });
  await assert.rejects(
    exportNode(node),
    (error) => error?.code === 'CONFIG' && /not aligned.*step 2/i.test(error.message),
  );
  const permissive = await exportNode(node, false);
  assert.equal(
    permissive.warnings.some((warning) => /not aligned.*step 2/i.test(warning)),
    true,
  );
});

test('empty property strings fail spec-aware validation and strict/permissive export contracts', async () => {
  const node = propertyWriteNode({ piid: 7, value: '' });
  const issues = await validateNode(node);
  assert.equal(
    issues.some((entry) => /requires a non-empty string/i.test(entry.message)),
    true,
    JSON.stringify(issues),
  );
  await assert.rejects(
    exportNode(node),
    (error) => error?.code === 'CONFIG' && /requires a non-empty string/i.test(error.message),
  );
  const permissive = await exportNode(node, false);
  assert.equal(
    permissive.warnings.some((warning) => /requires a non-empty string/i.test(warning)),
    true,
  );
});
