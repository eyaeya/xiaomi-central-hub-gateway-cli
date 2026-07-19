import assert from 'node:assert/strict';
import test from 'node:test';

import {
  INDEPENDENT_EVENT_SOURCE_TYPES,
  checkReachability,
  enableRule,
  lintGraph,
} from '../dist/index.js';

const fakeBaseUrl = 'http://gateway.invalid';
const fakeAgentStartedAt = '2026-07-19T00:00:00.000Z';
const position = (width = 240, height = 140) => ({ x: 0, y: 0, width, height });

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

function independentSource(type, id, targets = []) {
  if (type === 'onLoad') return onLoad(id, targets);
  if (type === 'alarmClock') {
    return {
      id,
      type,
      cfg: {
        pos: position(),
        name: type,
        version: 1,
        happenType: 'periodicAlarm',
        tempOffset: 0,
      },
      inputs: {},
      outputs: { output: targets },
      props: {
        type: 'periodicAlarm',
        isSunset: false,
        hour: 8,
        minute: 0,
        second: 0,
        filter: {},
      },
    };
  }
  if (type === 'deviceInput') {
    return {
      id,
      type,
      cfg: {
        urn: 'urn:miot-spec-v2:device:remote-control:0000A021:test:1',
        pos: position(),
        name: type,
        version: 1,
      },
      inputs: {},
      outputs: { output: targets },
      props: { did: 'button-did', siid: 2, eiid: 1, arguments: [] },
    };
  }
  if (type === 'deviceInputSetVar') {
    return {
      id,
      type,
      cfg: {
        urn: 'urn:miot-spec-v2:device:sensor:0000A0FF:test:1',
        pos: position(),
        name: type,
        version: 1,
      },
      inputs: {},
      outputs: { output: targets },
      props: {
        did: 'sensor-did',
        siid: 2,
        piid: 1,
        dtype: 'number',
        scope: 'global',
        id: 'captured',
      },
    };
  }
  if (type === 'varChange') {
    return {
      id,
      type,
      cfg: { pos: position(), name: type, version: 1 },
      inputs: {},
      outputs: { output: targets },
      props: {
        scope: 'global',
        id: 'observed',
        varType: 'number',
        preload: false,
        operator: '=',
        v1: 1,
      },
    };
  }
  throw new Error(`missing source fixture for ${type}`);
}

function deviceOutput(id, targets = []) {
  return {
    id,
    type: 'deviceOutput',
    cfg: {
      urn: 'urn:miot-spec-v2:device:light:0000A001:test:1',
      pos: position(),
      name: 'deviceOutput',
      version: 1,
    },
    inputs: { trigger: null },
    outputs: { output: targets },
    props: { did: 'light-did', siid: 2, piid: 1, value: true },
  };
}

function loop(id, targets = []) {
  return {
    id,
    type: 'loop',
    cfg: { pos: position(), name: 'loop', version: 1, unit: 's', value: 1 },
    inputs: { start: null, stop: null },
    outputs: { output: targets },
    props: { interval: 1_000 },
  };
}

function register(id, targets = []) {
  return {
    id,
    type: 'register',
    cfg: { pos: position(), name: 'register', version: 1 },
    inputs: { setTrue: null, setFalse: null },
    outputs: { output: targets },
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
      start: { hour: 8, minute: 0, second: 0 },
      end: { hour: 22, minute: 0, second: 0 },
      filter: {},
    },
  };
}

function condition(id, metTargets = [], unmetTargets = []) {
  return {
    id,
    type: 'condition',
    cfg: { pos: position(), name: 'condition', version: 1 },
    inputs: { trigger: null, condition: null },
    outputs: { met: metTargets, unmet: unmetTargets },
    props: {},
  };
}

function delay(id, targets = []) {
  return {
    id,
    type: 'delay',
    cfg: { pos: position(), name: 'delay', version: 1, unit: 's', value: 1 },
    inputs: { input: null },
    outputs: { output: targets },
    props: { timeout: 1_000 },
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

function multiInput(type, id, targets = []) {
  return {
    id,
    type,
    cfg: { pos: position(340, 180), name: type, version: 1 },
    inputs: { input0: null, input1: null },
    outputs: { output: targets },
    props: {},
  };
}

function stateUnary(type, id, targets = []) {
  return {
    id,
    type,
    cfg: { pos: position(240, 120), name: type, version: 1 },
    inputs: { input: null },
    outputs: { output: targets },
    props: {},
  };
}

function statusLast(id, targets = []) {
  return {
    id,
    type: 'statusLast',
    cfg: { pos: position(340, 140), name: 'statusLast', version: 1, unit: 's', value: 1 },
    inputs: { input: null },
    outputs: { output: targets },
    props: { timeout: 1_000 },
  };
}

function counterLike(type, id, targets = []) {
  return {
    id,
    type,
    cfg: { pos: position(382, 160), name: type, version: 1 },
    inputs: { input: null, zero: null },
    outputs: { output: targets },
    props: { n: 2 },
  };
}

function futureNode(id, targets = []) {
  return {
    id,
    type: 'futureNode',
    cfg: {},
    inputs: { input: null },
    outputs: { output: targets },
    props: {},
  };
}

function futureNodeWithoutInputs(id, targets = []) {
  return {
    id,
    type: 'futureNode',
    cfg: {},
    outputs: { output: targets },
    props: {},
  };
}

function falseStateNodes(prefix, target) {
  return [
    onLoad(`${prefix}-source`, [`${prefix}-latch.setFalse`]),
    register(`${prefix}-latch`, [target]),
  ];
}

function trueStateNodes(prefix, target) {
  return [
    onLoad(`${prefix}-source`, [`${prefix}-latch.setFalse`]),
    register(`${prefix}-latch`, [`${prefix}-not.input`]),
    stateUnary('logicNot', `${prefix}-not`, [target]),
  ];
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

function unreachableSinkIds(nodes) {
  return checkReachability(nodes)
    .map((issue) => /sink "([^"]+)"/.exec(issue.message)?.[1])
    .filter(Boolean);
}

test('independent source fact table has the evidence-backed source set and each reaches a sink', () => {
  assert.deepEqual(
    new Set(INDEPENDENT_EVENT_SOURCE_TYPES),
    new Set(['onLoad', 'alarmClock', 'deviceInput', 'deviceInputSetVar', 'varChange']),
  );

  for (const type of INDEPENDENT_EVENT_SOURCE_TYPES) {
    const nodes = [independentSource(type, 'source', ['sink.trigger']), deviceOutput('sink')];
    assert.deepEqual(checkReachability(nodes), [], type);
  }
});

test('reachability follows edge direction and controlled/state cards are not bootstrap sources', () => {
  const reverse = [deviceOutput('sink', ['repeat.start']), loop('repeat')];
  assert.deepEqual(unreachableSinkIds(reverse), ['sink']);

  assert.deepEqual(unreachableSinkIds([loop('repeat', ['sink.trigger']), deviceOutput('sink')]), [
    'sink',
  ]);
  assert.deepEqual(
    unreachableSinkIds([
      onLoad('source', ['repeat.stop']),
      loop('repeat', ['sink.trigger']),
      deviceOutput('sink'),
    ]),
    ['sink'],
  );
  assert.deepEqual(
    checkReachability([
      onLoad('source', ['repeat.start']),
      loop('repeat', ['sink.trigger']),
      deviceOutput('sink'),
    ]),
    [],
  );

  assert.deepEqual(
    unreachableSinkIds([register('latch', ['sink.trigger']), deviceOutput('sink')]),
    ['sink'],
  );
  assert.deepEqual(
    checkReachability([
      onLoad('source', ['latch.setTrue']),
      register('latch', ['sink.trigger']),
      deviceOutput('sink'),
    ]),
    [],
  );

  assert.deepEqual(
    unreachableSinkIds([timeRange('window', ['sink.trigger']), deviceOutput('sink')]),
    ['sink'],
  );
});

test('timeRange supports condition state but cannot replace the condition event path', () => {
  const stateOnly = [
    timeRange('window', ['gate.condition']),
    condition('gate', ['sink.trigger']),
    deviceOutput('sink'),
  ];
  assert.deepEqual(unreachableSinkIds(stateOnly), ['sink']);

  const eventAndState = [
    onLoad('source', ['gate.trigger']),
    timeRange('window', ['gate.condition']),
    condition('gate', ['sink.trigger']),
    deviceOutput('sink'),
  ];
  assert.deepEqual(checkReachability(eventAndState), []);
});

test('condition trigger can reach unmet without a live true-state path, while met stays guarded', () => {
  const unmet = [
    onLoad('source', ['gate.trigger']),
    register('initially-false', ['gate.condition']),
    condition('gate', [], ['sink.trigger']),
    deviceOutput('sink'),
  ];
  assert.deepEqual(checkReachability(unmet), []);

  const met = [
    onLoad('source', ['gate.trigger']),
    register('initially-false', ['gate.condition']),
    condition('gate', ['sink.trigger']),
    deviceOutput('sink'),
  ];
  assert.deepEqual(unreachableSinkIds(met), ['sink']);
});

test('statusLast converts supporting state into an event but rejects an unreachable state card', () => {
  assert.deepEqual(
    checkReachability([
      timeRange('window', ['held.input']),
      statusLast('held', ['sink.trigger']),
      deviceOutput('sink'),
    ]),
    [],
  );

  assert.deepEqual(
    checkReachability([
      timeRange('first-state', ['all.input0']),
      timeRange('second-state', ['all.input1']),
      multiInput('logicAnd', 'all', ['held.input']),
      statusLast('held', ['sink.trigger']),
      deviceOutput('sink'),
    ]),
    [],
  );

  assert.deepEqual(
    unreachableSinkIds([
      register('dead-state', ['held.input']),
      statusLast('held', ['sink.trigger']),
      deviceOutput('sink'),
    ]),
    ['sink'],
  );
});

test('eventSequence requires an event-driving path at every required input endpoint', () => {
  const oneLiveInput = [
    onLoad('first', ['sequence.input1']),
    delay('dead', ['sequence.input2']),
    eventSequence('sequence', ['sink.trigger']),
    deviceOutput('sink'),
  ];
  assert.deepEqual(unreachableSinkIds(oneLiveInput), ['sink']);

  const otherLiveInput = [
    delay('dead', ['sequence.input1']),
    onLoad('second', ['sequence.input2']),
    eventSequence('sequence', ['sink.trigger']),
    deviceOutput('sink'),
  ];
  assert.deepEqual(unreachableSinkIds(otherLiveInput), ['sink']);

  const bothLiveInputs = [
    onLoad('source', ['sequence.input1', 'sequence.input2']),
    eventSequence('sequence', ['sink.trigger']),
    deviceOutput('sink'),
  ];
  assert.deepEqual(checkReachability(bothLiveInputs), []);
});

test('logicAnd requires all state values and at least one event-driving update path', () => {
  const staticStateOnly = [
    timeRange('first-state', ['all.input0']),
    timeRange('second-state', ['all.input1']),
    multiInput('logicAnd', 'all', ['sink.trigger']),
    deviceOutput('sink'),
  ];
  assert.deepEqual(unreachableSinkIds(staticStateOnly), ['sink']);

  const missingState = [
    independentSource('varChange', 'updating-state', ['all.input0']),
    register('dead-state', ['all.input1']),
    multiInput('logicAnd', 'all', ['stable.input']),
    statusLast('stable', ['sink.trigger']),
    deviceOutput('sink'),
  ];
  assert.deepEqual(unreachableSinkIds(missingState), ['sink']);

  const complete = [
    independentSource('varChange', 'updating-state', ['all.input0']),
    timeRange('supporting-state', ['all.input1']),
    multiInput('logicAnd', 'all', ['stable.input']),
    statusLast('stable', ['sink.trigger']),
    deviceOutput('sink'),
  ];
  assert.deepEqual(checkReachability(complete), []);
});

test('ANY-input cards activate from one live endpoint while reset-only onlyNTimes does not', () => {
  for (const type of ['signalOr', 'logicOr']) {
    const source =
      type === 'logicOr'
        ? independentSource('varChange', 'source', ['any.input0'])
        : onLoad('source', ['any.input0']);
    const nodes = [source, multiInput(type, 'any', ['sink.trigger']), deviceOutput('sink')];
    assert.deepEqual(checkReachability(nodes), [], type);
  }

  assert.deepEqual(
    unreachableSinkIds([
      onLoad('reset', ['limited.zero']),
      counterLike('onlyNTimes', 'limited', ['sink.trigger']),
      deviceOutput('sink'),
    ]),
    ['sink'],
  );
  assert.deepEqual(
    checkReachability([
      onLoad('input', ['limited.input']),
      counterLike('onlyNTimes', 'limited', ['sink.trigger']),
      deviceOutput('sink'),
    ]),
    [],
  );

  // Counter zero behavior is not sufficiently evidenced to tighten in #64;
  // retain the prior optimistic reachability behavior.
  assert.deepEqual(
    checkReachability([
      onLoad('reset', ['count.zero']),
      counterLike('counter', 'count', ['sink.trigger']),
      deviceOutput('sink'),
    ]),
    [],
  );
});

test('state-card updates require a dual/state source endpoint, not an event-only cross-color wire', () => {
  const eventOnlyWithOtherState = [
    onLoad('event-only', ['any.input0']),
    timeRange('supporting-state', ['any.input1']),
    multiInput('logicOr', 'any', ['sink.trigger']),
    deviceOutput('sink'),
  ];
  assert.deepEqual(unreachableSinkIds(eventOnlyWithOtherState), ['sink']);

  assert.deepEqual(
    unreachableSinkIds([
      onLoad('event-only', ['not.input']),
      stateUnary('logicNot', 'not', ['sink.trigger']),
      deviceOutput('sink'),
    ]),
    ['sink'],
  );
  assert.deepEqual(
    checkReachability([
      independentSource('varChange', 'dual-source', ['not.input']),
      stateUnary('logicNot', 'not', ['sink.trigger']),
      deviceOutput('sink'),
    ]),
    [],
  );
});

test('register activates from either setter endpoint', () => {
  for (const pin of ['setTrue', 'setFalse']) {
    const nodes = [
      onLoad('source', [`latch.${pin}`]),
      register('latch', ['sink.trigger']),
      deviceOutput('sink'),
    ];
    assert.deepEqual(checkReachability(nodes), [], pin);
  }
});

test('register truth facts distinguish condition branches and true-only statusLast', () => {
  const setFalseMet = [
    onLoad('source', ['latch.setFalse', 'gate.trigger']),
    register('latch', ['gate.condition']),
    condition('gate', ['sink.trigger']),
    deviceOutput('sink'),
  ];
  assert.deepEqual(unreachableSinkIds(setFalseMet), ['sink']);

  const setFalseUnmet = [
    onLoad('source', ['latch.setFalse', 'gate.trigger']),
    register('latch', ['gate.condition']),
    condition('gate', [], ['sink.trigger']),
    deviceOutput('sink'),
  ];
  assert.deepEqual(checkReachability(setFalseUnmet), []);

  const setTrueBranches = [
    onLoad('source', ['latch.setTrue', 'gate.trigger']),
    register('latch', ['gate.condition']),
    condition('gate', ['met.trigger'], ['unmet.trigger']),
    deviceOutput('met'),
    deviceOutput('unmet'),
  ];
  assert.deepEqual(checkReachability(setTrueBranches), []);

  assert.deepEqual(
    unreachableSinkIds([
      onLoad('source', ['latch.setFalse']),
      register('latch', ['held.input']),
      statusLast('held', ['sink.trigger']),
      deviceOutput('sink'),
    ]),
    ['sink'],
  );
  assert.deepEqual(
    checkReachability([
      onLoad('source', ['latch.setTrue']),
      register('latch', ['held.input']),
      statusLast('held', ['sink.trigger']),
      deviceOutput('sink'),
    ]),
    [],
  );
});

test('false state remains usable through logicNot instead of being discarded', () => {
  assert.deepEqual(
    checkReachability([
      register('initially-false', ['not.input']),
      stateUnary('logicNot', 'not', ['held.input']),
      statusLast('held', ['sink.trigger']),
      deviceOutput('sink'),
    ]),
    [],
  );

  assert.deepEqual(
    checkReachability([
      onLoad('source', ['latch.setFalse']),
      register('latch', ['not.input']),
      stateUnary('logicNot', 'not', ['held.input']),
      statusLast('held', ['sink.trigger']),
      deviceOutput('sink'),
    ]),
    [],
  );
});

test('logicAnd, logicOr, and logicNot propagate may-true and may-false separately', () => {
  const andFalseTrue = [
    ...falseStateNodes('f', 'gate.input0'),
    ...trueStateNodes('t', 'gate.input1'),
    multiInput('logicAnd', 'gate', ['held.input']),
    statusLast('held', ['sink.trigger']),
    deviceOutput('sink'),
  ];
  assert.deepEqual(unreachableSinkIds(andFalseTrue), ['sink']);

  const andTrueTrue = [
    ...trueStateNodes('a', 'gate.input0'),
    ...trueStateNodes('b', 'gate.input1'),
    multiInput('logicAnd', 'gate', ['held.input']),
    statusLast('held', ['sink.trigger']),
    deviceOutput('sink'),
  ];
  assert.deepEqual(checkReachability(andTrueTrue), []);

  const andTrueTrueNot = [
    ...trueStateNodes('a', 'gate.input0'),
    ...trueStateNodes('b', 'gate.input1'),
    multiInput('logicAnd', 'gate', ['not.input']),
    stateUnary('logicNot', 'not', ['held.input']),
    statusLast('held', ['sink.trigger']),
    deviceOutput('sink'),
  ];
  assert.deepEqual(unreachableSinkIds(andTrueTrueNot), ['sink']);

  const orFalseFalseNot = [
    ...falseStateNodes('a', 'gate.input0'),
    ...falseStateNodes('b', 'gate.input1'),
    multiInput('logicOr', 'gate', ['not.input']),
    stateUnary('logicNot', 'not', ['held.input']),
    statusLast('held', ['sink.trigger']),
    deviceOutput('sink'),
  ];
  assert.deepEqual(checkReachability(orFalseFalseNot), []);

  const orFalseTrueNot = [
    ...falseStateNodes('f', 'gate.input0'),
    ...trueStateNodes('t', 'gate.input1'),
    multiInput('logicOr', 'gate', ['not.input']),
    stateUnary('logicNot', 'not', ['held.input']),
    statusLast('held', ['sink.trigger']),
    deviceOutput('sink'),
  ];
  assert.deepEqual(unreachableSinkIds(orFalseTrueNot), ['sink']);
});

test('counter zero and unknown future cards retain optimistic truth compatibility', () => {
  assert.deepEqual(
    checkReachability([
      onLoad('reset', ['count.zero']),
      counterLike('counter', 'count', ['held.input']),
      statusLast('held', ['sink.trigger']),
      deviceOutput('sink'),
    ]),
    [],
  );

  const future = futureNodeWithoutInputs('future', ['held.input']);
  assert.deepEqual(
    checkReachability([
      ...falseStateNodes('f', 'future.input'),
      future,
      statusLast('held', ['sink.trigger']),
      deviceOutput('sink'),
    ]),
    [],
  );
});

test('invalid target pins and malformed endpoints cannot manufacture reachability', () => {
  assert.deepEqual(unreachableSinkIds([onLoad('source', ['sink.typo']), deviceOutput('sink')]), [
    'sink',
  ]);
  assert.deepEqual(
    unreachableSinkIds([onLoad('source', ['sink.trigger.extra']), deviceOutput('sink')]),
    ['sink'],
  );
});

test('branches, multiple sinks, cycles, and future intermediate nodes terminate deterministically', () => {
  const nodes = [
    onLoad('source', ['known.input', 'future.input', 'live-direct.trigger']),
    delay('known', ['live-known.trigger']),
    futureNode('future', ['future-cycle.input']),
    futureNode('future-cycle', ['future.input', 'live-future.trigger']),
    deviceOutput('live-direct'),
    deviceOutput('live-known'),
    deviceOutput('live-future'),
    delay('dead-a', ['dead-b.input']),
    delay('dead-b', ['dead-a.input', 'dead.trigger']),
    deviceOutput('dead'),
  ];

  assert.deepEqual(unreachableSinkIds(nodes), ['dead']);
});

test('future nodes with missing or empty inputs preserve observed event and state paths', () => {
  const eventFuture = {
    ...futureNodeWithoutInputs('future-event', ['event-sink.trigger']),
    inputs: {},
  };
  assert.deepEqual(
    checkReachability([
      onLoad('source', ['future-event.input']),
      eventFuture,
      deviceOutput('event-sink'),
    ]),
    [],
  );

  const stateFuture = futureNodeWithoutInputs('future-state', ['held.input']);
  assert.deepEqual(
    checkReachability([
      timeRange('window', ['future-state.input']),
      stateFuture,
      statusLast('held', ['state-sink.trigger']),
      deviceOutput('state-sink'),
    ]),
    [],
  );
});

test('strict lint and enable expose the same directed diagnosis before follow-up RPCs', async () => {
  const id = 'rule-1';
  const nodes = [deviceOutput('sink', ['repeat.start']), loop('repeat')];
  const reachIssues = checkReachability(nodes);
  assert.equal(reachIssues.length, 1);

  const strictIssues = lintGraph({ graph: { id, nodes }, strict: true });
  assert.equal(
    strictIssues.some((issue) => issue.severity === 'error'),
    false,
  );
  strictIssues.push(...checkReachability(nodes));
  assert.deepEqual(
    strictIssues.filter((issue) => issue.message.includes('卡片不可达')),
    reachIssues,
  );

  const { deps, calls } = fakeDeps((method) => {
    if (method === '/api/getGraph') return { id, nodes };
    throw new Error(`unexpected RPC: ${method}`);
  });

  await assert.rejects(
    enableRule(id, deps),
    (error) =>
      error?.code === 'CONFIG' &&
      error.message.includes(reachIssues[0].message) &&
      error.details?.issues?.[0]?.message === reachIssues[0].message,
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

test('enable rejects a partially live multi-input path after getGraph and performs zero writes', async () => {
  const id = 'rule-1';
  const nodes = [
    onLoad('first', ['sequence.input1']),
    delay('dead', ['sequence.input2']),
    eventSequence('sequence', ['sink.trigger']),
    deviceOutput('sink'),
  ];
  const { deps, calls } = fakeDeps((method) => {
    if (method === '/api/getGraph') return { id, nodes };
    throw new Error(`unexpected RPC: ${method}`);
  });

  await assert.rejects(
    enableRule(id, deps),
    (error) => error?.code === 'CONFIG' && error.message.includes('卡片不可达'),
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

test('enable rejects known-false true-only paths after getGraph and performs zero writes', async () => {
  const id = 'rule-1';
  const cases = [
    [
      onLoad('source', ['latch.setFalse', 'gate.trigger']),
      register('latch', ['gate.condition']),
      condition('gate', ['sink.trigger']),
      deviceOutput('sink'),
    ],
    [
      onLoad('source', ['latch.setFalse']),
      register('latch', ['held.input']),
      statusLast('held', ['sink.trigger']),
      deviceOutput('sink'),
    ],
  ];

  for (const nodes of cases) {
    const { deps, calls } = fakeDeps((method) => {
      if (method === '/api/getGraph') return { id, nodes };
      throw new Error(`unexpected RPC: ${method}`);
    });

    await assert.rejects(
      enableRule(id, deps),
      (error) => error?.code === 'CONFIG' && error.message.includes('卡片不可达'),
    );
    assert.deepEqual(
      calls.map((call) => call.method),
      ['/api/getGraph'],
    );
    assert.equal(
      calls.some((call) => call.options?.kind === 'write'),
      false,
    );
  }
});
