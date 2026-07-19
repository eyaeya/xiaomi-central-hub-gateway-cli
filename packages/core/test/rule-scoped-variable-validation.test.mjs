import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AuthExpiredError,
  AuthRequiredError,
  GatewayError,
  NetworkError,
  SchemaError,
  addEdge,
  createRule,
  enableRule,
  listAvailVarsForRule,
  updateNode,
  upsertGraph,
  validateGraph,
} from '../dist/index.js';

const fakeBaseUrl = 'http://gateway.invalid';
const fakeAgentStartedAt = '2026-07-19T00:00:00.000Z';
const ruleId = '1';
const localScope = `R${ruleId}`;
const urn = 'urn:miot-spec-v2:device:test-device:0000A000:test:1';

const position = (width = 200, height = 120) => ({ x: 0, y: 0, width, height });
const variableEntry = {
  type: 'number',
  value: 1,
  userData: { name: 'same' },
};

const deviceSpec = {
  type: urn,
  description: 'test device',
  services: [
    {
      iid: 2,
      type: 'urn:miot-spec-v2:service:test-service:00007801:test:1',
      description: 'test service',
      properties: [
        {
          iid: 1,
          type: 'urn:miot-spec-v2:property:test-value:00000001:test:1',
          description: 'test value',
          format: 'int',
          access: ['read', 'notify'],
        },
      ],
      events: [
        {
          iid: 2,
          type: 'urn:miot-spec-v2:event:test-event:00005001:test:1',
          description: 'test event',
          arguments: [1],
        },
      ],
    },
  ],
};

function ruleSummary(id = ruleId) {
  return {
    id,
    enable: false,
    uiType: 'rule',
    userData: {
      name: 'scoped variable validation test',
      transform: { x: 0, y: 0, scale: 1, rotate: 0 },
      lastUpdateTime: 0,
      version: 0,
    },
  };
}

function varChange(scope, id = 'same', nodeId = 'var-change') {
  return {
    id: nodeId,
    type: 'varChange',
    cfg: { pos: position(532, 160), name: 'varChange', version: 1 },
    inputs: {},
    outputs: { output: [] },
    props: { scope, id, varType: 'number', preload: true, operator: '=', v1: 1 },
  };
}

function varGet(scope, id = 'same') {
  return {
    id: 'var-get',
    type: 'varGet',
    cfg: { pos: position(532, 200), name: 'varGet', version: 1 },
    inputs: { input: null },
    outputs: { output: [], output2: [] },
    props: { scope, id, varType: 'number', operator: '=', v1: 1 },
  };
}

function varSet(type, targetScope, targetId, elements) {
  return {
    id: `${type}-node`,
    type,
    cfg: {
      pos: position(type === 'varSetNumber' ? 740 : 712, 220),
      name: type,
      version: 1,
    },
    inputs: { input: null },
    outputs: { output: [] },
    props: { scope: targetScope, id: targetId, elements },
  };
}

function deviceCfg(type, width, height) {
  return { urn, pos: position(width, height), name: type, version: 1 };
}

function deviceInputSetVarProperty(scope, id = 'same') {
  return {
    id: 'input-set-property',
    type: 'deviceInputSetVar',
    cfg: deviceCfg('deviceInputSetVar', 554, 206),
    inputs: {},
    outputs: { output: [] },
    props: { did: 'did-1', siid: 2, piid: 1, dtype: 'number', scope, id },
  };
}

function deviceInputSetVarEvent(scope, id = 'same') {
  return {
    id: 'input-set-event',
    type: 'deviceInputSetVar',
    cfg: deviceCfg('deviceInputSetVar', 554, 206),
    inputs: {},
    outputs: { output: [] },
    props: {
      did: 'did-1',
      siid: 2,
      eiid: 2,
      arguments: [{ piid: 1, dtype: 'number', scope, id }],
    },
  };
}

function deviceGetSetVar(scope, id = 'same') {
  return {
    id: 'get-set-var',
    type: 'deviceGetSetVar',
    cfg: deviceCfg('deviceGetSetVar', 566, 200),
    inputs: { input: null },
    outputs: { output: [] },
    props: { did: 'did-1', siid: 2, piid: 1, dtype: 'number', scope, id },
  };
}

function deviceOutputProperty(scope, id = 'same') {
  return {
    id: 'output-property',
    type: 'deviceOutput',
    cfg: deviceCfg('deviceOutput', 684, 204),
    inputs: { trigger: null },
    outputs: { output: [] },
    props: {
      did: 'did-1',
      siid: 2,
      piid: 1,
      scope,
      id,
      dtype: 'number',
      min: 0,
      max: 100,
      step: 1,
    },
  };
}

function deviceOutputAction(scope, id = 'same') {
  return {
    id: 'output-action',
    type: 'deviceOutput',
    cfg: deviceCfg('deviceOutput', 684, 204),
    inputs: { trigger: null },
    outputs: { output: [] },
    props: {
      did: 'did-1',
      siid: 2,
      aiid: 3,
      ins: [{ piid: 1, scope, id, dtype: 'number', min: 0, max: 100, step: 1 }],
    },
  };
}

function delay() {
  return {
    id: 'wait',
    type: 'delay',
    cfg: {
      pos: position(320, 120),
      name: 'delay',
      version: 1,
      unit: 's',
      value: 1,
    },
    inputs: { input: null },
    outputs: { output: [] },
    props: { timeout: 1_000 },
  };
}

function fakeDeps(respond) {
  const calls = [];
  return {
    calls,
    deps: {
      baseUrl: fakeBaseUrl,
      store: {
        read: async () => ({
          host: fakeBaseUrl,
          pid: 123,
          socketPath: '/tmp/xgg-test-unused.sock',
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
          return respond(method, params);
        },
        close: () => {},
      }),
    },
  };
}

function variableErrors(issues) {
  return issues.filter((issue) => issue.message.includes('卡片变量'));
}

async function validate(nodes, available, id = ruleId) {
  return validateGraph({
    graph: { id, nodes },
    listAvailVars: async () => available,
    getDeviceSpec: async () => deviceSpec,
  });
}

test('variable existence is keyed by exact scope and id', async () => {
  const globalOnly = [{ scope: 'global', id: 'same' }];
  const localOnly = [{ scope: localScope, id: 'same' }];
  const both = [...localOnly, ...globalOnly];

  assert.match(
    variableErrors(await validate([varChange(localScope)], globalOnly))[0].message,
    /R1\.same/,
  );
  assert.match(
    variableErrors(await validate([varChange('global')], localOnly))[0].message,
    /global\.same/,
  );
  assert.deepEqual(
    variableErrors(await validate([varChange(localScope), varGet('global')], both)),
    [],
  );
  assert.match(
    variableErrors(await validate([varChange(localScope, 'other')], localOnly))[0].message,
    /R1\.other/,
  );

  const thirdParty = variableErrors(
    await validate([varChange('thirdParty')], [{ scope: 'thirdParty', id: 'same' }]),
  );
  assert.match(thirdParty[0].message, /卡片变量有误/);
  assert.match(thirdParty[0].message, /global.*R1/);

  const changedRule = variableErrors(
    await validate([varChange(localScope)], [{ scope: localScope, id: 'same' }], '2'),
  );
  assert.match(changedRule[0].message, /卡片变量有误/);
  assert.match(changedRule[0].message, /R2/);
});

test('every modeled variable-reference location uses the scoped lookup', async () => {
  const crossScopeOnly = [
    { scope: 'global', id: 'same' },
    { scope: 'global', id: 'target' },
  ];
  const exact = [...crossScopeOnly, { scope: localScope, id: 'same' }];
  const cases = [
    { name: 'varChange props', node: varChange(localScope), path: 'nodes[0].props' },
    { name: 'varGet props', node: varGet(localScope), path: 'nodes[0].props' },
    {
      name: 'varSetNumber target',
      node: varSet('varSetNumber', localScope, 'same', [{ type: 'const', value: '1' }]),
      path: 'nodes[0].props',
    },
    {
      name: 'varSetNumber element',
      node: varSet('varSetNumber', 'global', 'target', [
        { type: 'var', scope: localScope, id: 'same' },
        { type: 'const', value: ' + 1' },
      ]),
      path: 'nodes[0].props.elements[0]',
    },
    {
      name: 'varSetString target',
      node: varSet('varSetString', localScope, 'same', [{ type: 'const', value: 'ok' }]),
      path: 'nodes[0].props',
    },
    {
      name: 'varSetString element',
      node: varSet('varSetString', 'global', 'target', [
        { type: 'var', scope: localScope, id: 'same' },
      ]),
      path: 'nodes[0].props.elements[0]',
    },
    {
      name: 'deviceInputSetVar property props',
      node: deviceInputSetVarProperty(localScope),
      path: 'nodes[0].props',
    },
    {
      name: 'deviceInputSetVar event argument',
      node: deviceInputSetVarEvent(localScope),
      path: 'nodes[0].props.arguments[0]',
    },
    {
      name: 'deviceGetSetVar props',
      node: deviceGetSetVar(localScope),
      path: 'nodes[0].props',
    },
    {
      name: 'deviceOutput property variable',
      node: deviceOutputProperty(localScope),
      path: 'nodes[0].props',
    },
    {
      name: 'deviceOutput action variable',
      node: deviceOutputAction(localScope),
      path: 'nodes[0].props.ins[0]',
    },
  ];

  for (const { name, node, path } of cases) {
    const missing = variableErrors(await validate([node], crossScopeOnly));
    assert.equal(missing.length, 1, name);
    assert.equal(missing[0].path, path, name);
    assert.match(missing[0].message, /卡片变量丢失: R1\.same/, name);
    assert.deepEqual(variableErrors(await validate([node], exact)), [], name);
  }
});

test('available-variable listing preserves scope for same-named variables', async () => {
  const { deps, calls } = fakeDeps((method, params) => {
    if (method !== '/api/getVarList') throw new Error(`unexpected RPC: ${method}`);
    if (params.scope === localScope) return { same: variableEntry };
    if (params.scope === 'global') {
      return { same: variableEntry, other: { ...variableEntry, userData: { name: 'other' } } };
    }
    throw new Error(`unexpected scope: ${params.scope}`);
  });

  assert.deepEqual(await listAvailVarsForRule(ruleId, deps), [
    { scope: localScope, id: 'same' },
    { scope: 'global', id: 'same' },
    { scope: 'global', id: 'other' },
  ]);
  assert.deepEqual(
    calls.map((call) => call.params.scope),
    [localScope, 'global'],
  );
});

test('only the two known missing-scope messages are treated as an empty scope', async () => {
  for (const message of ['Invalid scope', `Scope ${localScope} does not exist`]) {
    const { deps } = fakeDeps((method, params) => {
      if (method !== '/api/getVarList') throw new Error(`unexpected RPC: ${method}`);
      if (params.scope === localScope) throw new GatewayError(message, {});
      return { same: variableEntry };
    });
    assert.deepEqual(await listAvailVarsForRule(ruleId, deps), [{ scope: 'global', id: 'same' }]);
  }

  const errors = [
    new AuthRequiredError('login required'),
    new AuthExpiredError('agent expired'),
    new NetworkError('transport failed'),
    new NetworkError('agent IPC call timed out after 10ms'),
    new SchemaError('VarListResponse parse failed', {}),
    new GatewayError('Permission does not exist', {}),
    new GatewayError(`Scope ${localScope} does not exist because access was denied`, {}),
    new GatewayError('Invalid scope: permission denied', {}),
    new GatewayError('Invalid variable id', {}),
  ];

  for (const expected of errors) {
    const { deps } = fakeDeps((method) => {
      if (method === '/api/getVarList') throw expected;
      throw new Error(`unexpected RPC: ${method}`);
    });
    await assert.rejects(listAvailVarsForRule(ruleId, deps), (error) => error === expected);
  }
});

test('rule scope bootstrap shares the two known missing-scope classifications', async () => {
  const { deps, calls } = fakeDeps((method, params) => {
    if (method === '/api/setGraph') return null;
    if (method === '/api/getVarList') {
      if (params.scope === localScope) throw new GatewayError('Invalid scope', {});
      throw new GatewayError('Scope global does not exist', {});
    }
    if (method === '/api/createVar') return null;
    throw new Error(`unexpected RPC: ${method}`);
  });

  await createRule({ id: ruleId, nodes: [], cfg: ruleSummary() }, deps);
  assert.deepEqual(
    calls.filter((call) => call.method === '/api/createVar').map((call) => call.params.scope),
    [localScope, 'global'],
  );
});

function writeGateDeps(nodes) {
  return fakeDeps((method, params) => {
    if (method === '/api/getGraphList') return [ruleSummary()];
    if (method === '/api/getGraph') return { id: ruleId, nodes: structuredClone(nodes) };
    if (method === '/api/getVarList') {
      return params.scope === 'global' ? { same: variableEntry } : {};
    }
    if (method === '/api/setGraph' || method === '/api/changeGraphConfig') return null;
    throw new Error(`unexpected RPC: ${method}`);
  });
}

test('set, node update, edge add, and enable reject the exact missing scope before writes', async () => {
  const ref = varChange(localScope);
  const cases = [
    {
      name: 'set',
      nodes: [ref],
      run: (deps) => upsertGraph({ id: ruleId, nodes: [ref], cfg: ruleSummary() }, deps),
    },
    {
      name: 'node update',
      nodes: [ref],
      run: (deps) =>
        updateNode({ ruleId, nodeId: ref.id, patch: { cfg: { name: 'patched' } } }, deps),
    },
    {
      name: 'edge add',
      nodes: [ref, delay()],
      run: (deps) =>
        addEdge(
          {
            ruleId,
            from: { nodeId: ref.id, pin: 'output' },
            to: { nodeId: 'wait', pin: 'input' },
          },
          deps,
        ),
    },
    {
      name: 'enable',
      nodes: [ref],
      run: (deps) => enableRule(ruleId, deps),
    },
  ];

  for (const { name, nodes, run } of cases) {
    const { deps, calls } = writeGateDeps(nodes);
    await assert.rejects(
      run(deps),
      (error) => error?.code === 'CONFIG' && error.message.includes('卡片变量丢失: R1.same'),
      name,
    );
    assert.equal(
      calls.some((call) => call.options?.kind === 'write'),
      false,
      name,
    );
  }
});
