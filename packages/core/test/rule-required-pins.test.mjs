import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addEdge,
  addNode,
  checkReachability,
  enableRule,
  exportRuleFromView,
  lintGraph,
  nodeSchemaForType,
  setGraph,
  validateGraph,
} from '../dist/index.js';

const fakeBaseUrl = 'http://gateway.invalid';
const fakeAgentStartedAt = '2026-07-19T00:00:00.000Z';
const position = (width = 200, height = 120) => ({ x: 0, y: 0, width, height });

function onLoad(id, targets = []) {
  return {
    id,
    type: 'onLoad',
    cfg: { pos: position(), name: 'onLoad', version: 1 },
    inputs: {},
    outputs: { output: targets },
    props: {},
  };
}

function buttonTrigger(id, targets = []) {
  return {
    id,
    type: 'deviceInput',
    cfg: {
      urn: 'urn:miot-spec-v2:device:remote-control:0000A021:test:1',
      pos: position(584, 206),
      name: 'deviceInput',
      version: 0,
    },
    inputs: {},
    outputs: { output: targets },
    props: { did: 'button-did', siid: 2, eiid: 1, arguments: [] },
  };
}

function timeRange(id, targets = []) {
  return {
    id,
    type: 'timeRange',
    cfg: { pos: position(524, 152), name: 'timeRange', version: 1 },
    inputs: {},
    outputs: { output: targets },
    props: {
      start: { hour: 8, minute: 0, second: 0 },
      end: { hour: 22, minute: 0, second: 0 },
      filter: {},
    },
  };
}

function condition(id, met = [], unmet = []) {
  return {
    id,
    type: 'condition',
    cfg: { pos: position(320, 140), name: 'condition', version: 1 },
    inputs: { trigger: null, condition: null },
    outputs: { met, unmet },
    props: {},
  };
}

function eventSequence(id, targets = []) {
  return {
    id,
    type: 'eventSequence',
    cfg: {
      pos: position(524, 180),
      name: 'eventSequence',
      version: 1,
      unit: 's',
      value: 5,
    },
    inputs: { input1: null, input2: null },
    outputs: { output: targets },
    props: { timeout: 5_000 },
  };
}

function logicGate(type, id, inputKeysOrCount, targets = []) {
  const keys = Array.isArray(inputKeysOrCount)
    ? inputKeysOrCount
    : Array.from({ length: inputKeysOrCount }, (_, index) => `input${index}`);
  return {
    id,
    type,
    cfg: { pos: position(340, 180), name: type, version: 1 },
    inputs: Object.fromEntries(keys.map((key) => [key, null])),
    outputs: { output: targets },
    props: {},
  };
}

function loop(id) {
  return {
    id,
    type: 'loop',
    cfg: { pos: position(510, 160), name: 'loop', version: 1, unit: 's', value: 1 },
    inputs: { start: null, stop: null },
    outputs: { output: [] },
    props: { interval: 1_000 },
  };
}

function counterLike(type, id) {
  return {
    id,
    type,
    cfg: { pos: position(382, 160), name: type, version: 1 },
    inputs: { input: null, zero: null },
    outputs: { output: [] },
    props: { n: 2 },
  };
}

function ruleSummary(id = 'rule-1') {
  return {
    id,
    enable: false,
    uiType: 'rule',
    userData: {
      name: 'required pins test',
      transform: { x: 0, y: 0, scale: 1, rotate: 0 },
      lastUpdateTime: 0,
      version: 0,
    },
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
          calls.push({ method, params, options });
          return respond(method, params);
        },
        close: () => {},
      }),
    },
  };
}

function errorMessages(issues) {
  return issues.filter((issue) => issue.severity === 'error').map((issue) => issue.message);
}

test('strict lint rejects every missing required input with an advisory non-strict strategy', () => {
  const cases = [
    {
      missing: 'gate.trigger',
      nodes: [timeRange('state', ['gate.condition']), condition('gate')],
    },
    {
      missing: 'sequence.input2',
      nodes: [onLoad('first', ['sequence.input1']), eventSequence('sequence')],
    },
    {
      missing: 'all.input2',
      nodes: [
        timeRange('a', ['all.input0']),
        timeRange('b', ['all.input1']),
        logicGate('logicAnd', 'all', 3),
      ],
    },
  ];

  for (const { missing, nodes } of cases) {
    const strict = lintGraph({ graph: { id: 'rule-1', nodes }, strict: true });
    const advisory = lintGraph({ graph: { id: 'rule-1', nodes } });
    const strictIssue = strict.find((issue) => issue.message.includes(missing));
    const advisoryIssue = advisory.find((issue) => issue.message.includes(missing));

    assert.equal(strictIssue?.severity, 'error', missing);
    assert.equal(advisoryIssue?.severity, 'warn', missing);
  }
});

test('enableRule rejects a missing required input before any write RPC', async () => {
  const id = 'rule-1';
  const nodes = [timeRange('state', ['gate.condition']), condition('gate')];
  const { deps, calls } = fakeDeps((method) => {
    if (method === '/api/getGraph') return { id, nodes };
    throw new Error(`unexpected RPC: ${method}`);
  });

  await assert.rejects(
    enableRule(id, deps),
    (error) => error?.code === 'CONFIG' && error.message.includes('gate.trigger'),
  );
  assert.deepEqual(
    calls.map((call) => call.method),
    ['/api/getGraph'],
  );
  assert.equal(
    calls.some((call) => call.options?.kind === 'write'),
    false,
  );
});

test('valid button, condition, eventSequence, and three-input logicAnd templates pass', () => {
  const nodes = [
    buttonTrigger('condition-trigger', ['gate.trigger']),
    timeRange('condition-state', ['gate.condition']),
    condition('gate'),
    onLoad('event-one', ['sequence.input1']),
    onLoad('event-two', ['sequence.input2']),
    eventSequence('sequence'),
    timeRange('state-zero', ['all.input0']),
    timeRange('state-one', ['all.input1']),
    timeRange('state-two', ['all.input2']),
    logicGate('logicAnd', 'all', 3),
  ];

  assert.deepEqual(errorMessages(lintGraph({ graph: { id: 'rule-1', nodes }, strict: true })), []);
});

test('optional reset and stop control pins remain optional', () => {
  const nodes = [
    onLoad('loop-start', ['repeat.start']),
    loop('repeat'),
    onLoad('counter-input', ['count.input']),
    counterLike('counter', 'count'),
    onLoad('limit-input', ['limit.input']),
    counterLike('onlyNTimes', 'limit'),
  ];

  assert.deepEqual(errorMessages(lintGraph({ graph: { id: 'rule-1', nodes }, strict: true })), []);
});

test('duplicate node IDs are reported consistently before graph indexing', async () => {
  const nodes = [onLoad('duplicate'), onLoad('duplicate'), onLoad('duplicate')];
  const lintIssues = lintGraph({ graph: { id: 'rule-1', nodes }, strict: true });
  const validateIssues = await validateGraph({ graph: { id: 'rule-1', nodes } });
  const reachabilityIssues = checkReachability(nodes);

  for (const issues of [lintIssues, validateIssues, reachabilityIssues]) {
    const duplicate = issues.find((issue) => issue.message.includes('duplicate node id'));
    assert.ok(duplicate);
    assert.match(duplicate.message, /nodes\[0\].*nodes\[1\].*nodes\[2\]/);
    assert.equal(duplicate.path, 'nodes[1].id');
  }
});

test('setGraph rejects duplicate IDs before any RPC', async () => {
  const { deps, calls } = fakeDeps(() => {
    throw new Error('unexpected RPC');
  });
  const id = 'rule-1';

  await assert.rejects(
    setGraph(
      {
        id,
        cfg: ruleSummary(id),
        nodes: [onLoad('duplicate'), onLoad('duplicate')],
      },
      deps,
    ),
    (error) => error?.code === 'CONFIG' && error.message.includes('duplicate node id'),
  );
  assert.equal(calls.length, 0);
});

test('enableRule rejects duplicate IDs before any write RPC', async () => {
  const id = 'rule-1';
  const nodes = [onLoad('duplicate'), onLoad('duplicate')];
  const { deps, calls } = fakeDeps((method) => {
    if (method === '/api/getGraph') return { id, nodes };
    throw new Error(`unexpected RPC: ${method}`);
  });

  await assert.rejects(
    enableRule(id, deps),
    (error) => error?.code === 'CONFIG' && error.message.includes('duplicate node id'),
  );
  assert.deepEqual(
    calls.map((call) => call.method),
    ['/api/getGraph'],
  );
  assert.equal(
    calls.some((call) => call.options?.kind === 'write'),
    false,
  );
});

test('dynamic input schemas require at least two pins numbered contiguously from zero', () => {
  for (const type of ['logicAnd', 'logicOr', 'signalOr']) {
    const schema = nodeSchemaForType(type);
    assert.ok(schema);

    for (const keys of [['input0', 'input1', 'input99'], ['input0', 'input2'], ['input0']]) {
      const result = schema.safeParse(logicGate(type, 'gate', keys));
      assert.equal(result.success, false, `${type}: ${keys.join(',')}`);
    }

    for (const count of [2, 3, 10]) {
      const result = schema.safeParse(logicGate(type, 'gate', count));
      assert.equal(result.success, true, `${type}: ${count}`);
    }
  }
});

test('strict lint surfaces sparse dynamic input numbering as an error', () => {
  const issues = lintGraph({
    graph: {
      id: 'rule-1',
      nodes: [logicGate('logicAnd', 'gate', ['input0', 'input1', 'input99'])],
    },
    strict: true,
  });

  assert.equal(
    issues.some(
      (issue) => issue.severity === 'error' && issue.message.includes('contiguous range'),
    ),
    true,
  );
});

function createStatefulGateway(id) {
  const state = { summary: ruleSummary(id), nodes: [] };
  const fake = fakeDeps((method, params) => {
    if (method === '/api/getGraphList') return [structuredClone(state.summary)];
    if (method === '/api/getGraph') return { id, nodes: structuredClone(state.nodes) };
    if (method === '/api/setGraph') {
      state.summary = structuredClone(params.cfg);
      state.nodes = structuredClone(params.nodes);
      return null;
    }
    throw new Error(`unexpected RPC: ${method}`);
  });
  return { ...fake, state };
}

function flagValue(command, name) {
  return command.flags.find((flag) => flag.name === name)?.value;
}

function shortcutFromExport(command) {
  const rawPos = flagValue(command, '--pos');
  const posParts = rawPos?.split(',').map(Number);
  const shortcut = {
    type: command.type,
    id: flagValue(command, '--id'),
  };
  if (posParts?.length === 4) {
    shortcut.pos = {
      x: posParts[0],
      y: posParts[1],
      width: posParts[2],
      height: posParts[3],
    };
  }
  const inputs = flagValue(command, '--inputs');
  if (inputs !== undefined) shortcut.inputs = Number(inputs);
  return shortcut;
}

function parseColonEndpoint(endpoint) {
  const separator = endpoint.indexOf(':');
  return { nodeId: endpoint.slice(0, separator), pin: endpoint.slice(separator + 1) };
}

function graphEndpoints(nodes) {
  const endpoints = [];
  for (const node of nodes) {
    for (const [pin, targets] of Object.entries(node.outputs ?? {})) {
      if (!Array.isArray(targets)) continue;
      for (const target of targets) endpoints.push(`${node.id}.${pin}->${target}`);
    }
  }
  return endpoints.sort();
}

test('export replay preserves IDs, dynamic input pins, and edge endpoints', async () => {
  const id = 'rule-1';
  const sourceNodes = [
    onLoad('first', ['any.input0']),
    onLoad('second', ['any.input1']),
    onLoad('third', ['any.input2']),
    logicGate('signalOr', 'any', 3),
  ];
  const gateway = createStatefulGateway(id);
  const exported = await exportRuleFromView(
    { id, cfg: ruleSummary(id), nodes: sourceNodes },
    gateway.deps,
  );

  for (const command of exported.commands) {
    if (command.kind === 'node-add') {
      await addNode(
        {
          ruleId: id,
          shortcut: shortcutFromExport(command),
          varCheck: false,
        },
        gateway.deps,
      );
    }
  }
  for (const command of exported.commands) {
    if (command.kind === 'edge-add') {
      await addEdge(
        {
          ruleId: id,
          from: parseColonEndpoint(command.from),
          to: parseColonEndpoint(command.to),
          varCheck: false,
        },
        gateway.deps,
      );
    }
  }

  assert.deepEqual(
    gateway.state.nodes.map((node) => node.id),
    sourceNodes.map((node) => node.id),
  );
  assert.deepEqual(Object.keys(gateway.state.nodes.find((node) => node.id === 'any').inputs), [
    'input0',
    'input1',
    'input2',
  ]);
  assert.deepEqual(graphEndpoints(gateway.state.nodes), graphEndpoints(sourceNodes));
});
