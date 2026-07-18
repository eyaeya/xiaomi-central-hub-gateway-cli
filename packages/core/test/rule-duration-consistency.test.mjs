import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addNode,
  enableRule,
  exportRuleFromView,
  lintGraph,
  nodeSchemaForType,
  setGraph,
  validateGraph,
} from '../dist/index.js';

const fakeBaseUrl = 'http://gateway.invalid';
const fakeAgentStartedAt = '2026-07-19T00:00:00.000Z';

const geometry = {
  delay: { width: 320, height: 120 },
  statusLast: { width: 340, height: 140 },
  loop: { width: 510, height: 160 },
  eventSequence: { width: 524, height: 180 },
};

function durationNode(type, id, unit, value, milliseconds) {
  const inputs =
    type === 'loop'
      ? { start: null, stop: null }
      : type === 'eventSequence'
        ? { input1: null, input2: null }
        : { input: null };
  const runtimeField = type === 'loop' ? 'interval' : 'timeout';
  return {
    id,
    type,
    cfg: {
      pos: { x: 0, y: 0, ...geometry[type] },
      name: type,
      version: 1,
      unit,
      value,
    },
    inputs,
    outputs: { output: [] },
    props: { [runtimeField]: milliseconds },
  };
}

function onLoad(id, targets = []) {
  return {
    id,
    type: 'onLoad',
    cfg: {
      pos: { x: 0, y: 0, width: 200, height: 120 },
      name: 'onLoad',
      version: 1,
    },
    inputs: {},
    outputs: { output: targets },
    props: {},
  };
}

function ruleSummary(id = 'rule-1') {
  return {
    id,
    enable: false,
    uiType: 'rule',
    userData: {
      name: 'duration consistency test',
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

function errorIssues(issues) {
  return issues.filter((issue) => issue.severity === 'error');
}

test('all duration nodes accept exact ms, s, and m representations', async () => {
  const nodes = [
    durationNode('delay', 'delay-ms', 'ms', 500, 500),
    durationNode('statusLast', 'status-s', 's', 5, 5_000),
    durationNode('loop', 'loop-m', 'm', 2, 120_000),
    onLoad('event-one', ['sequence.input1']),
    onLoad('event-two', ['sequence.input2']),
    durationNode('eventSequence', 'sequence', 's', 5, 5_000),
  ];

  for (const node of nodes.filter((candidate) => candidate.type !== 'onLoad')) {
    const schema = nodeSchemaForType(node.type);
    assert.ok(schema);
    assert.equal(schema.safeParse(node).success, true, node.type);
  }

  assert.deepEqual(errorIssues(lintGraph({ graph: { id: 'rule-1', nodes }, strict: true })), []);
  assert.deepEqual(errorIssues(await validateGraph({ graph: { id: 'rule-1', nodes } })), []);
});

test('all duration nodes reject display/runtime mismatches with both values named', async () => {
  const cases = [
    durationNode('delay', 'delay', 'm', 5, 1_000),
    durationNode('statusLast', 'status', 's', 5, 1_000),
    durationNode('loop', 'loop', 'm', 2, 1_000),
    durationNode('eventSequence', 'sequence', 's', 5, 1_000),
  ];

  for (const node of cases) {
    const schema = nodeSchemaForType(node.type);
    assert.ok(schema);
    const parsed = schema.safeParse(node);
    assert.equal(parsed.success, false, node.type);
    assert.match(parsed.error.issues[0].path.join('.'), /^props\.(timeout|interval)$/);
    assert.match(parsed.error.issues[0].message, /cfg\.value\/unit/);
    assert.match(parsed.error.issues[0].message, /props\.(timeout|interval)/);
    assert.match(parsed.error.issues[0].message, new RegExp(`${node.cfg.value}${node.cfg.unit}`));
    assert.match(parsed.error.issues[0].message, new RegExp(`${Object.values(node.props)[0]}ms`));

    const lintIssues = lintGraph({ graph: { id: 'rule-1', nodes: [node] }, strict: true });
    const validationIssues = await validateGraph({ graph: { id: 'rule-1', nodes: [node] } });
    assert.equal(
      lintIssues.some((issue) => issue.message.includes('cfg.value/unit')),
      true,
      node.type,
    );
    assert.equal(
      validationIssues.some((issue) => issue.message.includes('cfg.value/unit')),
      true,
      node.type,
    );
  }
});

test('duration display fields reject unsupported units and invalid numeric values', () => {
  const cases = [
    { field: 'unit', value: 'h', expected: /ms.*s.*m/ },
    { field: 'value', value: Number.POSITIVE_INFINITY, expected: /finite/i },
    { field: 'value', value: 1.5, expected: /integer/i },
  ];

  for (const type of Object.keys(geometry)) {
    const schema = nodeSchemaForType(type);
    assert.ok(schema);
    for (const { field, value, expected } of cases) {
      const node = durationNode(type, `${type}-invalid-${field}`, 's', 1, 1_000);
      node.cfg[field] = value;
      const parsed = schema.safeParse(node);
      assert.equal(parsed.success, false, `${type}.${field}=${String(value)}`);
      assert.equal(parsed.error.issues[0].path.join('.'), `cfg.${field}`);
      assert.match(parsed.error.issues[0].message, expected);
    }
  }
});

test('zero remains compatible only for delay and loop', () => {
  for (const type of ['delay', 'loop']) {
    const node = durationNode(type, `${type}-zero`, 'ms', 0, 0);
    assert.equal(nodeSchemaForType(type).safeParse(node).success, true, type);
  }

  for (const type of ['statusLast', 'eventSequence']) {
    const node = durationNode(type, `${type}-zero`, 'ms', 0, 0);
    assert.equal(nodeSchemaForType(type).safeParse(node).success, false, type);
  }
});

test('setGraph and enableRule reject a mismatch before any write RPC', async () => {
  const id = 'rule-1';
  const mismatch = durationNode('delay', 'wait', 'm', 5, 1_000);
  const setFake = fakeDeps(() => {
    throw new Error('unexpected RPC');
  });

  await assert.rejects(
    setGraph({ id, cfg: ruleSummary(id), nodes: [mismatch] }, setFake.deps),
    (error) => error?.code === 'CONFIG' && error.message.includes('cfg.value/unit'),
  );
  assert.equal(setFake.calls.length, 0);

  const enableFake = fakeDeps((method) => {
    if (method === '/api/getGraph') return { id, nodes: [mismatch] };
    throw new Error(`unexpected RPC: ${method}`);
  });
  await assert.rejects(
    enableRule(id, enableFake.deps),
    (error) => error?.code === 'CONFIG' && error.message.includes('cfg.value/unit'),
  );
  assert.deepEqual(
    enableFake.calls.map((call) => call.method),
    ['/api/getGraph'],
  );
  assert.equal(
    enableFake.calls.some((call) => call.options?.kind === 'write'),
    false,
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
  const duration = flagValue(command, '--duration');
  if (duration !== undefined) shortcut.duration = duration;
  const interval = flagValue(command, '--interval');
  if (interval !== undefined) shortcut.interval = interval;
  return shortcut;
}

function durationState(nodes) {
  return nodes.map((node) => ({
    id: node.id,
    type: node.type,
    cfg: { unit: node.cfg.unit, value: node.cfg.value },
    props: node.props,
  }));
}

test('export replay preserves display and runtime values for all duration nodes', async () => {
  const id = 'rule-1';
  const sourceNodes = [
    durationNode('delay', 'delay-ms', 'ms', 500, 500),
    durationNode('statusLast', 'status-s', 's', 5, 5_000),
    durationNode('loop', 'loop-m', 'm', 2, 120_000),
    durationNode('eventSequence', 'sequence-s', 's', 5, 5_000),
    durationNode('delay', 'delay-zero', 's', 0, 0),
    durationNode('loop', 'loop-zero', 'm', 0, 0),
    durationNode('delay', 'delay-negative', 's', -2, -2_000),
    durationNode('loop', 'loop-negative', 'ms', -3, -3),
    durationNode('delay', 'delay-exponent', 'ms', 1e21, 1e21),
  ];
  const gateway = createStatefulGateway(id);
  const exported = await exportRuleFromView(
    { id, cfg: ruleSummary(id), nodes: sourceNodes },
    gateway.deps,
  );

  for (const command of exported.commands) {
    if (command.kind !== 'node-add') continue;
    await addNode(
      {
        ruleId: id,
        shortcut: shortcutFromExport(command),
        varCheck: false,
      },
      gateway.deps,
    );
  }

  assert.deepEqual(durationState(gateway.state.nodes), durationState(sourceNodes));
});
