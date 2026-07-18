import assert from 'node:assert/strict';
import test from 'node:test';

import { addEdge, checkReachability, enableRule, lintGraph, setGraph } from '../dist/index.js';

const position = (width = 200, height = 120) => ({ x: 0, y: 0, width, height });
const fakeBaseUrl = 'http://gateway.invalid';
const fakeAgentStartedAt = '2026-07-19T00:00:00.000Z';

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

function delay(id, targets = []) {
  return {
    id,
    type: 'delay',
    cfg: { pos: position(320), name: 'delay', version: 1, unit: 's', value: 1 },
    inputs: { input: null },
    outputs: { output: targets },
    props: { timeout: 1_000 },
  };
}

function condition(id, met = [], unmet = []) {
  return {
    id,
    type: 'condition',
    cfg: { pos: position(320), name: 'condition', version: 1 },
    inputs: { trigger: null, condition: null },
    outputs: { met, unmet },
    props: {},
  };
}

function signalOr(id, inputs = 2) {
  return {
    id,
    type: 'signalOr',
    cfg: { pos: position(320), name: 'signalOr', version: 1 },
    inputs: Object.fromEntries(
      Array.from({ length: inputs }, (_, index) => [`input${index}`, null]),
    ),
    outputs: { output: [] },
    props: {},
  };
}

function timeRange(id, targets = []) {
  return {
    id,
    type: 'timeRange',
    cfg: { pos: position(), name: 'timeRange', version: 1 },
    inputs: {},
    outputs: { output: targets },
    props: {
      start: { hour: 0, minute: 0, second: 0 },
      end: { hour: 23, minute: 59, second: 59 },
      filter: {},
    },
  };
}

function varSetNumber(id) {
  return {
    id,
    type: 'varSetNumber',
    cfg: { pos: position(740, 220), name: 'varSetNumber', version: 1 },
    inputs: { input: null },
    outputs: { output: [] },
    props: {
      scope: 'global',
      id: 'marker',
      elements: [{ type: 'const', value: '1' }],
    },
  };
}

function ruleSummary(id = 'rule-1') {
  return {
    id,
    enable: false,
    uiType: 'rule',
    userData: {
      name: 'edge integrity test',
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
          // Newer agent-call implementations probe daemon identity before each
          // gateway method. Keep these tests compatible with both baselines and
          // count only gateway RPCs in the write-gate assertions below.
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

function messages(issues) {
  return issues.map((issue) => issue.message);
}

test('strict lint rejects a second source endpoint into one input while allowing fan-out', () => {
  const fanInIssues = lintGraph({
    graph: {
      id: 'rule-1',
      nodes: [onLoad('first', ['wait.input']), onLoad('second', ['wait.input']), delay('wait')],
    },
    strict: true,
  });

  const fanIn = fanInIssues.find((issue) => issue.message.includes('fan-in cap'));
  assert.ok(fanIn);
  assert.equal(fanIn.severity, 'error');
  assert.equal(fanIn.path, 'nodes[1].outputs.output[0]');

  const fanOutIssues = lintGraph({
    graph: {
      id: 'rule-1',
      nodes: [onLoad('start', ['first.input', 'second.input']), delay('first'), delay('second')],
    },
    strict: true,
  });
  assert.equal(
    messages(fanOutIssues).some((message) => message.includes('fan-in cap')),
    false,
  );
});

test('legal event and state connections remain accepted', () => {
  const issues = lintGraph({
    graph: {
      id: 'rule-1',
      nodes: [
        onLoad('event-source', ['gate.trigger']),
        timeRange('state-source', ['gate.condition']),
        condition('gate'),
      ],
    },
    strict: true,
  });

  assert.deepEqual(
    issues.filter((issue) => issue.severity === 'error'),
    [],
  );
});

test('lint validates modeled target pins, including dynamic pin bounds', () => {
  const cases = [
    { target: delay('target'), edge: 'target.typo' },
    { target: delay('target'), edge: 'target.output' },
    { target: signalOr('target', 3), edge: 'target.input3' },
  ];

  for (const { target, edge } of cases) {
    const issues = lintGraph({
      graph: { id: 'rule-1', nodes: [onLoad('start', [edge]), target] },
      strict: true,
    });
    assert.equal(
      messages(issues).some((message) => message.includes('target input pin')),
      true,
      edge,
    );
  }

  const validDynamic = lintGraph({
    graph: {
      id: 'rule-1',
      nodes: [onLoad('start', ['target.input2']), signalOr('target', 3)],
    },
    strict: true,
  });
  assert.equal(
    messages(validDynamic).some((message) => message.includes('target input pin')),
    false,
  );
});

test('unknown target node types remain forward-compatible', () => {
  const issues = lintGraph({
    graph: {
      id: 'rule-1',
      nodes: [
        onLoad('start', ['future.mysteryInput']),
        { id: 'future', type: 'futureFirmwareNode', inputs: {}, outputs: {} },
      ],
    },
    strict: true,
  });

  assert.equal(
    messages(issues).some((message) => message.includes('target input pin')),
    false,
  );
  assert.equal(
    issues.some((issue) => issue.severity === 'error'),
    false,
  );
  assert.equal(
    issues.some((issue) => issue.message.includes('UnknownNode fallback')),
    true,
  );
});

test('fan-in remains a generic invariant for an unknown target type', () => {
  const issues = lintGraph({
    graph: {
      id: 'rule-1',
      nodes: [
        onLoad('first', ['future.mysteryInput']),
        onLoad('second', ['future.mysteryInput']),
        {
          id: 'future',
          type: 'futureFirmwareNode',
          inputs: { mysteryInput: null },
          outputs: {},
        },
      ],
    },
    strict: true,
  });

  assert.equal(
    messages(issues).some((message) => message.includes('fan-in cap')),
    true,
  );
});

test('self-loops are errors in strict mode and warnings in advisory mode', () => {
  const node = delay('loop', ['loop.input']);
  const strictIssue = lintGraph({
    graph: { id: 'rule-1', nodes: [node] },
    strict: true,
  }).find((issue) => issue.message.includes('self-loop'));
  const advisoryIssue = lintGraph({
    graph: { id: 'rule-1', nodes: [node] },
  }).find((issue) => issue.message.includes('self-loop'));

  assert.equal(strictIssue?.severity, 'error');
  assert.equal(advisoryIssue?.severity, 'warn');
});

test('reachability ignores an edge whose modeled target pin does not exist', () => {
  const invalid = checkReachability([onLoad('start', ['sink.typo']), varSetNumber('sink')]);
  assert.equal(
    invalid.some((issue) => issue.message.includes('卡片不可达')),
    true,
  );

  const valid = checkReachability([onLoad('start', ['sink.input']), varSetNumber('sink')]);
  assert.equal(valid.length, 0);
});

test('setGraph rejects invalid edge integrity before any RPC', async () => {
  const { deps, calls } = fakeDeps(() => {
    throw new Error('unexpected RPC');
  });
  const id = 'rule-1';

  await assert.rejects(
    setGraph(
      {
        id,
        cfg: ruleSummary(id),
        nodes: [onLoad('first', ['wait.input']), onLoad('second', ['wait.input']), delay('wait')],
      },
      deps,
    ),
    (error) => error?.code === 'CONFIG' && error.message.includes('fan-in cap'),
  );
  assert.equal(calls.length, 0);
});

test('enableRule rejects invalid edge integrity before any write RPC', async () => {
  const id = 'rule-1';
  const nodes = [delay('loop', ['loop.input'])];
  const { deps, calls } = fakeDeps((method) => {
    if (method === '/api/getGraph') return { id, nodes };
    throw new Error(`unexpected RPC: ${method}`);
  });

  await assert.rejects(
    enableRule(id, deps),
    (error) => error?.code === 'CONFIG' && error.message.includes('self-loop'),
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

test('addEdge rejects same-node different-output fan-in without writing', async () => {
  const id = 'rule-1';
  const nodes = [condition('gate', ['wait.input']), delay('wait')];
  const { deps, calls } = fakeDeps((method) => {
    if (method === '/api/getGraphList') return [ruleSummary(id)];
    if (method === '/api/getGraph') return { id, nodes };
    throw new Error(`unexpected RPC: ${method}`);
  });

  await assert.rejects(
    addEdge(
      {
        ruleId: id,
        from: { nodeId: 'gate', pin: 'unmet' },
        to: { nodeId: 'wait', pin: 'input' },
        varCheck: false,
      },
      deps,
    ),
    (error) => error?.code === 'CONFIG' && error.message.includes('fan-in cap'),
  );
  assert.deepEqual(
    calls.map((call) => call.method),
    ['/api/getGraphList', '/api/getGraph'],
  );
  assert.equal(
    calls.some((call) => call.options?.kind === 'write'),
    false,
  );
});

test('addEdge preserves exact-duplicate error classification', async () => {
  const id = 'rule-1';
  const nodes = [condition('gate', ['wait.input']), delay('wait')];
  const { deps } = fakeDeps((method) => {
    if (method === '/api/getGraphList') return [ruleSummary(id)];
    if (method === '/api/getGraph') return { id, nodes };
    throw new Error(`unexpected RPC: ${method}`);
  });

  await assert.rejects(
    addEdge(
      {
        ruleId: id,
        from: { nodeId: 'gate', pin: 'met' },
        to: { nodeId: 'wait', pin: 'input' },
        varCheck: false,
      },
      deps,
    ),
    (error) => error?.code === 'CONFIG' && error.message.includes('edge already exists'),
  );
});

test('addEdge still requires an advertised input pin on unknown node types', async () => {
  const id = 'rule-1';
  const nodes = [
    onLoad('start'),
    { id: 'future', type: 'futureFirmwareNode', inputs: { known: null }, outputs: {} },
  ];
  const { deps, calls } = fakeDeps((method) => {
    if (method === '/api/getGraphList') return [ruleSummary(id)];
    if (method === '/api/getGraph') return { id, nodes };
    throw new Error(`unexpected RPC: ${method}`);
  });

  await assert.rejects(
    addEdge(
      {
        ruleId: id,
        from: { nodeId: 'start', pin: 'output' },
        to: { nodeId: 'future', pin: 'missing' },
        varCheck: false,
      },
      deps,
    ),
    (error) => error?.code === 'CONFIG' && error.message.includes('target pin'),
  );
  assert.equal(
    calls.some((call) => call.options?.kind === 'write'),
    false,
  );
});

test('addEdge preserves unknown target node forward compatibility', async () => {
  const id = 'rule-1';
  const nodes = [
    onLoad('start'),
    {
      id: 'future',
      type: 'futureFirmwareNode',
      inputs: { firmwareDefinedInput: null },
      outputs: {},
    },
  ];
  const { deps, calls } = fakeDeps((method) => {
    if (method === '/api/getGraphList') return [ruleSummary(id)];
    if (method === '/api/getGraph') return { id, nodes };
    if (method === '/api/setGraph') return null;
    throw new Error(`unexpected RPC: ${method}`);
  });

  const result = await addEdge(
    {
      ruleId: id,
      from: { nodeId: 'start', pin: 'output' },
      to: { nodeId: 'future', pin: 'firmwareDefinedInput' },
      varCheck: false,
    },
    deps,
  );

  assert.equal(result.edgeString, 'future.firmwareDefinedInput');
  assert.deepEqual(
    calls.map((call) => call.method),
    ['/api/getGraphList', '/api/getGraph', '/api/setGraph'],
  );
});
