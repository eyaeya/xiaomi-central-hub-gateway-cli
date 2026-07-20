import assert from 'node:assert/strict';
import test from 'node:test';

import { __resetSpecCache } from '../dist/http-client.js';
import { addNode, enableRule, exportRuleFromView, validateGraph } from '../dist/index.js';

const baseUrl = 'http://gateway.invalid';
const startedAt = '2026-07-21T00:00:00.000Z';
const ruleId = '173';
const did = 'device-output-variable-contract';
const urn = 'urn:miot-spec-v2:device:variable-contract:0000A001:fixture:1';

const spec = {
  type: urn,
  description: 'device output variable contract',
  services: [
    {
      iid: 2,
      type: 'urn:miot-spec-v2:service:fixture:00007801:fixture:1',
      description: 'fixture',
      properties: [
        {
          iid: 1,
          type: 'urn:miot-spec-v2:property:level:00000001:fixture:1',
          description: 'level',
          format: 'uint8',
          access: ['write'],
          'value-range': [0, 100, 1],
        },
        {
          iid: 2,
          type: 'urn:miot-spec-v2:property:on:00000006:fixture:1',
          description: 'on',
          format: 'bool',
          access: ['write'],
        },
        {
          iid: 3,
          type: 'urn:miot-spec-v2:property:mode:00000008:fixture:1',
          description: 'mode',
          format: 'int',
          access: ['write'],
          'value-list': [
            { value: 0, description: 'off' },
            { value: 1, description: 'eco' },
          ],
        },
        {
          iid: 4,
          type: 'urn:miot-spec-v2:property:label:00000001:fixture:1',
          description: 'label',
          format: 'string',
          access: ['write'],
        },
      ],
      actions: [
        {
          iid: 10,
          type: 'urn:miot-spec-v2:action:apply:00002801:fixture:1',
          description: 'apply',
          in: [1, 2, 3, 4],
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
  name: 'fixture',
  model: 'fixture.variable-contract.v1',
  modelName: 'Fixture',
  urn,
  roomId: 'room',
  roomName: 'Room',
  icon: '',
};

function summary(enable = false) {
  return {
    id: ruleId,
    enable,
    uiType: 'rule',
    userData: {
      name: 'device output variable contract',
      transform: { x: 0, y: 0, scale: 1, rotate: 0 },
      lastUpdateTime: 0,
      version: 0,
    },
  };
}

function gateway(initialNodes = []) {
  const state = { nodes: structuredClone(initialNodes), summary: summary(), calls: [] };
  const deps = {
    baseUrl,
    store: {
      read: async () => ({
        host: baseUrl,
        pid: 1,
        socketPath: '/tmp/xgg-device-output-variable-contract-unused.sock',
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
        state.calls.push({ method, params, options });
        if (method === '/api/getDevList') return { devList: { [did]: device } };
        if (method === '/api/getGraphList') return [structuredClone(state.summary)];
        if (method === '/api/getGraph') {
          return { id: ruleId, nodes: structuredClone(state.nodes) };
        }
        if (method === '/api/getVarList') {
          if (params.scope === `R${ruleId}`) return {};
          if (params.scope === 'global') {
            return {
              level: { type: 'number', value: 1, userData: { name: 'level' } },
              label: { type: 'string', value: 'label', userData: { name: 'label' } },
              mode: { type: 'number', value: 1, userData: { name: 'mode' } },
            };
          }
        }
        if (method === '/api/setGraph') {
          state.nodes = structuredClone(params.nodes);
          state.summary = structuredClone(params.cfg);
          return null;
        }
        if (method === '/api/changeGraphConfig') {
          state.summary = { ...state.summary, enable: params.enable };
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

const cfg = () => ({
  urn,
  pos: { x: 0, y: 0, width: 684, height: 204 },
  name: 'deviceOutput',
  version: 1,
});

function propertyRef(id, piid, ref) {
  return {
    id,
    type: 'deviceOutput',
    cfg: cfg(),
    inputs: { trigger: null },
    outputs: { output: [] },
    props: { did, siid: 2, piid, ...ref },
  };
}

function actionRef(id, overrides = {}) {
  const inputs = new Map([
    [1, { piid: 1, value: 50 }],
    [2, { piid: 2, value: true }],
    [3, { piid: 3, value: 1 }],
    [4, { piid: 4, value: 'ok' }],
  ]);
  for (const [piid, input] of Object.entries(overrides)) inputs.set(Number(piid), input);
  return {
    id,
    type: 'deviceOutput',
    cfg: cfg(),
    inputs: { trigger: null },
    outputs: { output: [] },
    props: { did, siid: 2, aiid: 10, ins: [...inputs.values()] },
  };
}

async function addProperty(target, id, property, value) {
  return addNode(
    {
      ruleId,
      shortcut: {
        type: 'deviceOutput',
        id,
        deviceDid: did,
        deviceSiid: 2,
        deviceProperty: property,
        value,
      },
      getDeviceSpec: target.deps.getDeviceSpec,
      validate: false,
      varCheck: false,
    },
    target.deps,
  );
}

async function addAction(target, id, params) {
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
      },
      getDeviceSpec: target.deps.getDeviceSpec,
      validate: false,
      varCheck: false,
    },
    target.deps,
  );
}

test('typed property/action authoring rejects bool and value-list refs with canonical alternatives', async () => {
  const target = gateway();
  const cases = [
    {
      run: () => addProperty(target, 'boolproperty', 'on', '$global.level'),
      message: /boolean.*literal-only.*number 0\/1.*literal false\/true/is,
    },
    {
      run: () => addProperty(target, 'enumproperty', 'mode', '$global.mode'),
      message: /value-list.*literal-only.*literal values/is,
    },
    {
      run: () =>
        addAction(target, 'boolaction', {
          level: 50,
          on: { $var: 'global.level' },
          mode: 1,
          label: 'ok',
        }),
      message: /boolean.*literal-only.*number 0\/1.*literal false\/true/is,
    },
    {
      run: () =>
        addAction(target, 'enumaction', {
          level: 50,
          on: true,
          mode: { $var: 'global.mode' },
          label: 'ok',
        }),
      message: /value-list.*literal-only.*literal values/is,
    },
  ];

  for (const { run, message } of cases) {
    const writesBefore = target.state.calls.filter(
      (call) => call.method === '/api/setGraph',
    ).length;
    await assert.rejects(run(), (error) => error?.code === 'CONFIG' && message.test(error.message));
    assert.equal(
      target.state.calls.filter((call) => call.method === '/api/setGraph').length,
      writesBefore,
    );
  }
});

test('the presence of an empty value-list also keeps property/action refs on the literal-only path', async () => {
  const target = gateway();
  const emptyListSpec = structuredClone(spec);
  emptyListSpec.services[0].properties[0]['value-list'] = [];
  target.deps.getDeviceSpec = async (requestedUrn) => {
    assert.equal(requestedUrn, urn);
    return emptyListSpec;
  };

  const cases = [
    () => addProperty(target, 'emptylistproperty', 'level', '$global.level'),
    () =>
      addAction(target, 'emptylistaction', {
        level: { $var: 'global.level' },
        on: true,
        mode: 1,
        label: 'ok',
      }),
  ];
  for (const run of cases) {
    await assert.rejects(
      run(),
      (error) =>
        error?.code === 'CONFIG' &&
        /value-list.*literal-only.*empty array.*incomplete/is.test(error.message),
    );
  }
  assert.equal(
    target.state.calls.some((call) => call.method === '/api/setGraph'),
    false,
  );

  const persisted = [
    propertyRef('empty-list-property', 1, {
      scope: 'global',
      id: 'level',
      dtype: 'number',
      min: 0,
      max: 100,
      step: 1,
    }),
    actionRef('empty-list-action', {
      1: {
        piid: 1,
        scope: 'global',
        id: 'level',
        dtype: 'number',
        min: 0,
        max: 100,
        step: 1,
      },
    }),
  ];
  const issues = await validateGraph({
    graph: { id: ruleId, nodes: persisted },
    getDeviceSpec: async () => emptyListSpec,
  });
  assert.deepEqual(
    issues.filter((entry) => /empty array/.test(entry.message)).map((entry) => entry.path),
    ['nodes[0].props.dtype', 'nodes[1].props.ins[0].dtype'],
  );
});

test('literal bool/value-list outputs and number/string refs remain supported', async () => {
  const target = gateway();
  await addProperty(target, 'boolliteral', 'on', 'true');
  await addProperty(target, 'enumliteral', 'mode', '1');
  await addProperty(target, 'numberref', 'level', '$global.level');
  await addProperty(target, 'stringref', 'label', '$global.label');
  await addAction(target, 'actionliteralsandrefs', {
    level: { $var: 'global.level' },
    on: false,
    mode: 0,
    label: { $var: 'global.label' },
  });

  assert.deepEqual(target.state.nodes[0].props.value, true);
  assert.deepEqual(target.state.nodes[1].props.value, 1);
  assert.equal(target.state.nodes[2].props.dtype, 'number');
  assert.equal(target.state.nodes[3].props.dtype, 'string');
  assert.deepEqual(
    target.state.nodes[4].props.ins.map((input) => input.dtype ?? typeof input.value),
    ['number', 'boolean', 'number', 'string'],
  );

  const exported = await exportRuleFromView(
    { id: ruleId, cfg: target.state.summary, nodes: target.state.nodes },
    target.deps,
    undefined,
    true,
  );
  assert.equal(exported.warnings.filter((warning) => /deviceOutput/.test(warning)).length, 0);
});

test('spec-aware validation diagnoses persisted bool/value-list refs at exact property/action paths', async () => {
  const nodes = [
    propertyRef('bool-property', 2, { scope: 'global', id: 'level', dtype: 'boolean' }),
    propertyRef('enum-property', 3, {
      scope: 'global',
      id: 'mode',
      dtype: 'number',
      min: 0,
      max: 1,
      step: 1,
    }),
    actionRef('bool-action', {
      2: { piid: 2, scope: 'global', id: 'level', dtype: 'boolean' },
    }),
    actionRef('enum-action', {
      3: {
        piid: 3,
        scope: 'global',
        id: 'mode',
        dtype: 'number',
        min: 0,
        max: 1,
        step: 1,
      },
    }),
  ];
  const issues = await validateGraph({
    graph: { id: ruleId, nodes },
    getDeviceSpec: async () => spec,
  });
  const unsupported = issues.filter((issue) => /literal-only dropdown/.test(issue.message));
  assert.deepEqual(
    unsupported.map((issue) => issue.path),
    [
      'nodes[0].props.dtype',
      'nodes[1].props.dtype',
      'nodes[2].props.ins[1].dtype',
      'nodes[3].props.ins[2].dtype',
    ],
  );
  assert.match(unsupported[0].message, /number 0\/1.*literal false\/true/is);
  assert.match(unsupported[1].message, /literal values from the MIoT value-list/is);
});

test('enable-only spec pass does not broaden validation to unrelated legacy output state', async () => {
  const unrelatedLiteral = propertyRef('legacyliteral', 2, { value: true });
  unrelatedLiteral.cfg.urn = 'urn:miot-spec-v2:device:unrelated-legacy:0000A002:fixture:1';
  const supportedRef = propertyRef('supportedref', 1, {
    scope: 'global',
    id: 'level',
    dtype: 'number',
    min: 0,
    max: 100,
    step: 1,
  });
  const legacyActionLiteral = actionRef('legacyaction', {
    1: {
      piid: 1,
      scope: 'global',
      id: 'level',
      dtype: 'number',
      min: 0,
      max: 100,
      step: 1,
    },
    2: { piid: 2, value: 1 },
  });
  const sinks = [unrelatedLiteral, supportedRef, legacyActionLiteral];
  const source = {
    id: 'load',
    type: 'onLoad',
    cfg: {
      pos: { x: 0, y: 0, width: 200, height: 120 },
      name: 'onLoad',
      version: 1,
    },
    inputs: {},
    outputs: { output: sinks.map((sink) => `${sink.id}.trigger`) },
    props: {},
  };
  const target = gateway([source, ...sinks]);
  __resetSpecCache();
  const originalFetch = globalThis.fetch;
  const fetched = [];
  globalThis.fetch = async (input) => {
    fetched.push(String(input));
    return new Response(JSON.stringify(spec), { status: 200 });
  };
  try {
    await enableRule(ruleId, target.deps);
  } finally {
    globalThis.fetch = originalFetch;
    __resetSpecCache();
  }

  assert.equal(fetched.length, 1);
  assert.equal(new URL(fetched[0]).searchParams.get('type'), urn);
  assert.equal(target.state.summary.enable, true);
});

test('legacy refs remain locally readable while strict export rejects unsupported semantics', async () => {
  const target = gateway();
  const cases = [
    {
      node: propertyRef('bool-property', 2, {
        scope: 'global',
        id: 'level',
        dtype: 'boolean',
      }),
      strictMessage: /literal-only.*branch a number 0\/1.*literal false\/true/,
    },
    {
      node: actionRef('enum-action', {
        3: {
          piid: 3,
          scope: 'global',
          id: 'mode',
          dtype: 'number',
          min: 0,
          max: 1,
          step: 1,
        },
      }),
      strictMessage: /literal-only dropdown/,
    },
  ];
  for (const { node, strictMessage } of cases) {
    const localIssues = await validateGraph({ graph: { id: ruleId, nodes: [node] } });
    assert.deepEqual(localIssues, []);
    await assert.rejects(
      exportRuleFromView(
        { id: ruleId, cfg: target.state.summary, nodes: [node] },
        target.deps,
        undefined,
        true,
      ),
      (error) => error?.code === 'CONFIG' && strictMessage.test(error.message),
    );
  }

  await exportRuleFromView(
    {
      id: ruleId,
      cfg: target.state.summary,
      nodes: [propertyRef('bool-literal', 2, { value: true }), actionRef('action-literal')],
    },
    target.deps,
    undefined,
    true,
  );
});

test('enable fails closed when registry evidence for an output ref is unavailable', async () => {
  const output = propertyRef('numberoutput', 1, {
    scope: 'global',
    id: 'level',
    dtype: 'number',
    min: 0,
    max: 100,
    step: 1,
  });
  const source = {
    id: 'load',
    type: 'onLoad',
    cfg: {
      pos: { x: 0, y: 0, width: 200, height: 120 },
      name: 'onLoad',
      version: 1,
    },
    inputs: {},
    outputs: { output: ['numberoutput.trigger'] },
    props: {},
  };
  const target = gateway([source, output]);
  __resetSpecCache();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('', { status: 404 });

  try {
    await assert.rejects(
      enableRule(ruleId, target.deps),
      (error) =>
        error?.code === 'CONFIG' &&
        /MIoT spec not found \(HTTP 404\).*Refusing to enable/is.test(error.message) &&
        error.details?.issues?.some((entry) => entry.path === 'nodes[1].cfg.urn'),
    );
  } finally {
    globalThis.fetch = originalFetch;
    __resetSpecCache();
  }
  assert.equal(
    target.state.calls.some((call) => call.method === '/api/changeGraphConfig'),
    false,
  );
});

test('enable fails closed on registry network/schema errors before changeGraphConfig', async () => {
  const output = propertyRef('numberoutput', 1, {
    scope: 'global',
    id: 'level',
    dtype: 'number',
    min: 0,
    max: 100,
    step: 1,
  });
  const source = {
    id: 'load',
    type: 'onLoad',
    cfg: {
      pos: { x: 0, y: 0, width: 200, height: 120 },
      name: 'onLoad',
      version: 1,
    },
    inputs: {},
    outputs: { output: ['numberoutput.trigger'] },
    props: {},
  };
  const originalFetch = globalThis.fetch;
  const cases = [
    {
      code: 'NETWORK',
      fetch: async () => {
        throw new TypeError('registry offline');
      },
    },
    {
      code: 'SCHEMA',
      fetch: async () => new Response(JSON.stringify({ unexpected: true }), { status: 200 }),
    },
  ];

  try {
    for (const current of cases) {
      const target = gateway([source, output]);
      __resetSpecCache();
      globalThis.fetch = current.fetch;
      await assert.rejects(
        enableRule(ruleId, target.deps),
        (error) =>
          error?.code === 'CONFIG' &&
          new RegExp(`spec-aware validation failed \\[${current.code}`).test(error.message),
      );
      assert.equal(
        target.state.calls.some((call) => call.method === '/api/changeGraphConfig'),
        false,
        current.code,
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
    __resetSpecCache();
  }
});

test('enable fails closed on a persisted value-list ref before changeGraphConfig', async () => {
  const output = propertyRef('enum-output', 3, {
    scope: 'global',
    id: 'mode',
    dtype: 'number',
    min: 0,
    max: 1,
    step: 1,
  });
  const source = {
    id: 'load',
    type: 'onLoad',
    cfg: {
      pos: { x: 0, y: 0, width: 200, height: 120 },
      name: 'onLoad',
      version: 1,
    },
    inputs: {},
    outputs: { output: ['enum-output.trigger'] },
    props: {},
  };
  const target = gateway([source, output]);
  __resetSpecCache();
  const originalFetch = globalThis.fetch;
  const fetched = [];
  globalThis.fetch = async (input) => {
    fetched.push(String(input));
    return new Response(JSON.stringify(spec), { status: 200 });
  };

  try {
    await assert.rejects(
      enableRule(ruleId, target.deps),
      (error) =>
        error?.code === 'CONFIG' &&
        /value-list.*literal-only dropdown/is.test(error.message) &&
        error.details?.issues?.some(
          (issue) => issue.path === 'nodes[1].props.dtype' && /literal values/.test(issue.message),
        ),
    );
  } finally {
    globalThis.fetch = originalFetch;
    __resetSpecCache();
  }
  assert.equal(fetched.length, 1);
  assert.equal(
    target.state.calls.some((call) => call.method === '/api/changeGraphConfig'),
    false,
  );
});
