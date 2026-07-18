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

function condition(id, targets = []) {
  return {
    id,
    type: 'condition',
    cfg: { pos: position(), name: 'condition', version: 1 },
    inputs: { trigger: null, condition: null },
    outputs: { met: targets, unmet: [] },
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
