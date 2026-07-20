import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DeviceSpecSemanticCache,
  buildRuleTraceWatchpoints,
  calculateRuleTrace,
  fetchRuleLogs,
  findNextRuleTraceWatchpoint,
  parseLogLine,
  resolveRuleTraceDeviceGetLabels,
} from '../dist/index.js';

function nodes() {
  return [
    {
      id: 'source',
      type: 'onLoad',
      cfg: { pos: { x: 0, y: 0, width: 1, height: 1 }, name: 'source', version: 1 },
      inputs: {},
      outputs: { output: ['sink.trigger'] },
      props: {},
    },
    {
      id: 'sink',
      type: 'onLoad',
      cfg: { pos: { x: 1, y: 0, width: 1, height: 1 }, name: 'sink', version: 1 },
      inputs: {},
      outputs: { output: [] },
      props: {},
    },
  ];
}

function logs(lines) {
  return lines.map((line) => {
    const parsed = parseLogLine(line);
    assert.ok(parsed, line);
    return parsed;
  });
}

test('trace calculator accumulates current-graph node/link state and resets on enable', () => {
  const entries = logs([
    '3|1000|r|rule-1|{"enable":true}',
    '3|1001|l|rule-1|source.output|sink.trigger|null',
    '3|1001|i|rule-1|sink|[true]',
    '3|1002|i|rule-1|removed|success',
    '3|1003|r|rule-1|{"enable":false}',
    '3|1004|r|rule-1|{"enable":true}',
    '3|1005|e|rule-1|sink|-9999|timeout',
  ]);

  const result = calculateRuleTrace({ ruleId: 'rule-1', nodes: nodes(), entries });

  assert.deepEqual(
    buildRuleTraceWatchpoints(nodes()).map((entry) => entry.id),
    ['node:source', 'link:source.output->sink.trigger', 'node:sink'],
  );
  assert.equal(result.frames.length, 5);
  assert.deepEqual(
    result.frames.map((frame) => frame.changed),
    [null, 'link:source.output->sink.trigger', 'node:sink', null, 'node:sink'],
  );
  assert.equal(result.frames[2].status['link:source.output->sink.trigger'].order, 0);
  assert.equal(result.frames[2].status['link:source.output->sink.trigger'].info, '事件');
  assert.equal(result.frames[2].status['node:sink'].order, 1);
  assert.deepEqual(result.frames[3].status, {});
  assert.equal(result.frames[4].status['node:sink'].order, 2);
  assert.equal(result.frames[4].status['node:sink'].type, 'error');
  assert.deepEqual(result.topologyDrift, {
    entryCount: 1,
    missingWatchpointEntryCount: 1,
    incompatibleLinkEntryCount: 0,
    watchpoints: ['node:removed'],
  });
});

test('watchpoint filtering preserves reset frames, absolute ordering, and navigation', () => {
  const result = calculateRuleTrace({
    ruleId: 'rule-1',
    nodes: nodes(),
    filter: ['node:sink'],
    entries: logs([
      '3|1000|r|rule-1|{"enable":true}',
      '3|1001|l|rule-1|source.output|sink.trigger|true',
      '3|1002|i|rule-1|sink|first',
      '3|1003|i|rule-1|sink|second',
    ]),
  });

  assert.deepEqual(
    result.frames.map((frame) => frame.changed),
    [null, 'node:sink', 'node:sink'],
  );
  assert.equal(result.frames[2].status['node:sink'].order, 1);
  assert.equal(findNextRuleTraceWatchpoint(result.frames, 0, ['node:sink'])?.step, 1);
  assert.equal(findNextRuleTraceWatchpoint(result.frames, 2, ['node:sink'])?.step, 2);
  assert.equal(findNextRuleTraceWatchpoint(result.frames, 3, ['node:sink']), undefined);
});

test('trace input parser rejects field-count drift instead of hiding it from completeness', () => {
  assert.equal(parseLogLine('3|1000|i|rule-1|sink|success|unexpected'), null);
  assert.equal(parseLogLine('3|1000|e|rule-1|sink|-1|message|unexpected'), null);
  assert.equal(parseLogLine('3|1000|l|rule-1|source.output|sink.trigger|null|unexpected'), null);
  assert.equal(parseLogLine('3|1000|r|rule-1|{"enable":true}|unexpected'), null);
  assert.equal(parseLogLine('3|1000|l|rule-1|source|sink.trigger|null'), null);
  assert.equal(parseLogLine('3|1000|e|rule-1|sink|not-a-number|message'), null);
});

test('log pagination preserves duplicates and orders old blocks before new blocks at one millisecond', async () => {
  const repeated = '3|1000|i|rule-1|sink|same';
  const newest = [repeated, '3|1000|i|rule-1|sink|new'].join('\n');
  const oldest = [repeated, repeated, '3|1000|i|rule-1|sink|old'].join('\n');
  const baseUrl = 'http://trace-pagination.test';
  const agentStartedAt = '2026-07-20T00:00:00.000Z';
  const result = await fetchRuleLogs({
    baseUrl,
    maxBlocks: 4,
    store: {
      read: async () => ({
        host: baseUrl,
        pid: 1,
        socketPath: '/unused/trace-pagination.sock',
        agentStartedAt,
        agentVersion: 'test',
        lastValidatedAt: agentStartedAt,
      }),
    },
    ipcClient: () => ({
      request: async (method, params) => {
        if (method === '$ping') return { host: baseUrl, agentStartedAt };
        if (method !== '/api/getLog') throw new Error(`unexpected method ${method}`);
        if (params.num === 0) return newest;
        if (params.num === 1) return oldest;
        return oldest;
      },
      close: () => {},
    }),
  });

  assert.equal(result.stopReason, 'duplicate-block');
  assert.equal(result.blocksRead, 3);
  assert.deepEqual(
    result.entries.map((entry) => entry.info),
    ['same', 'same', 'old', 'same', 'new'],
  );
  assert.equal(
    result.entries.every((entry) => entry.timestamp === 1000),
    true,
  );
});

function traceNode(id, type, props = {}, inputs = {}, outputs = {}) {
  return {
    id,
    type,
    cfg: { urn: `urn:miot-spec-v2:device:test:0000A000:${id}:1`, pos: {}, name: id, version: 1 },
    props,
    inputs,
    outputs,
  };
}

test('Bundle node getInfo translations drop failures and count semantic drift', () => {
  const typedNodes = [
    traceNode('action', 'deviceOutput'),
    traceNode('get', 'deviceGet', { siid: 2, piid: 1 }),
    traceNode('only', 'onlyNTimes'),
    traceNode('counter', 'counter'),
    traceNode('set-property', 'deviceInputSetVar', { piid: 1 }),
    traceNode('set-event', 'deviceInputSetVar', { eiid: 1 }),
    traceNode('get-set', 'deviceGetSetVar'),
    traceNode('var-get', 'varGet'),
    traceNode('set-number', 'varSetNumber'),
    traceNode('set-string', 'varSetString'),
    traceNode('default', 'onLoad'),
  ];
  const entries = logs([
    '3|1|i|rule-1|action|success',
    '3|2|i|rule-1|action|[1,"x",null]',
    '3|3|i|rule-1|action|{}',
    '3|4|i|rule-1|get|1',
    '3|5|i|rule-1|get|2',
    '3|6|i|rule-1|only|{"n":3}',
    '3|7|i|rule-1|only|{"max":true}',
    '3|8|i|rule-1|only|{}',
    '3|9|i|rule-1|only|bad-json',
    '3|10|i|rule-1|counter|{"n":4}',
    '3|11|i|rule-1|counter|{}',
    '3|12|i|rule-1|counter|bad-json',
    '3|13|i|rule-1|set-property|raw',
    '3|14|i|rule-1|set-event|["x",1,{"a":true}]',
    '3|15|i|rule-1|set-event|bad-json',
    '3|16|i|rule-1|get-set|5',
    '3|17|i|rule-1|var-get|6',
    '3|18|i|rule-1|set-number|7',
    '3|19|i|rule-1|set-string|text',
    '3|20|i|rule-1|default|anything',
  ]);
  const result = calculateRuleTrace({
    ruleId: 'rule-1',
    nodes: typedNodes,
    entries,
    deviceGetLabels: { get: { 1: '开启' } },
  });
  const info = result.frames.map((frame) => frame.status[frame.changed].info);

  assert.deepEqual(info, [
    '执行成功',
    '命令发送，参数为：1,x,',
    '查询成功, 值为开启',
    '查询成功, 值为2',
    '当前计数为3',
    '已达到上限',
    '未知信息',
    '当前计数为4',
    '未知信息',
    '变量被设置为：raw',
    '变量被设置为："x",1,{"a":true}',
    '变量被设置为：5',
    '查询到的变量值为：6',
    '变量被设置为：7',
    '变量被设置为：text',
    '未知信息',
  ]);
  assert.deepEqual(result.semanticDrift, {
    entryCount: 4,
    nodeInfoParseFailureCount: 4,
    incompatibleLinkEntryCount: 0,
    watchpoints: ['node:action', 'node:only', 'node:counter', 'node:set-event'],
  });
});

test('known Bundle pin values are filtered while deviceInput output keeps all three values', () => {
  const graph = [
    traceNode(
      'sensor',
      'deviceInput',
      {},
      {},
      {
        output: ['condition.condition', 'condition.trigger'],
      },
    ),
    traceNode(
      'condition',
      'condition',
      {},
      { trigger: null, condition: null },
      { met: [], unmet: [] },
    ),
  ];
  const result = calculateRuleTrace({
    ruleId: 'rule-1',
    nodes: graph,
    entries: logs([
      '3|1|l|rule-1|sensor.output|condition.condition|true',
      '3|2|l|rule-1|sensor.output|condition.condition|null',
      '3|3|l|rule-1|sensor.output|condition.trigger|null',
      '3|4|l|rule-1|sensor.output|condition.trigger|false',
      '3|5|l|rule-1|sensor.output|condition.condition|unexpected',
    ]),
  });

  assert.deepEqual(
    result.frames.map((frame) => [frame.changed, frame.status[frame.changed].info]),
    [
      ['link:sensor.output->condition.condition', '真'],
      ['link:sensor.output->condition.trigger', '事件'],
    ],
  );
  assert.equal(result.topologyDrift.incompatibleLinkEntryCount, 3);
  assert.equal(result.topologyDrift.entryCount, 3);
  assert.equal(result.semanticDrift.incompatibleLinkEntryCount, 3);
  assert.equal(result.semanticDrift.entryCount, 3);
});

test('deviceGet labels reuse semantic projection with notify gate, priority, bools, and fallback metadata', async () => {
  const sharedUrn = 'urn:miot-spec-v2:device:test:0000A000:shared:1';
  const failedUrn = 'urn:miot-spec-v2:device:test:0000A000:failed:1';
  const graph = [
    { ...traceNode('get-a', 'deviceGet', { siid: 2, piid: 1 }), cfg: { urn: sharedUrn } },
    { ...traceNode('get-b', 'deviceGet', { siid: 2, piid: 1 }), cfg: { urn: sharedUrn } },
    {
      ...traceNode('get-readonly', 'deviceGet', { siid: 2, piid: 2 }),
      cfg: { urn: sharedUrn },
    },
    { ...traceNode('get-motion', 'deviceGet', { siid: 2, piid: 3 }), cfg: { urn: sharedUrn } },
    { ...traceNode('get-on', 'deviceGet', { siid: 2, piid: 4 }), cfg: { urn: sharedUrn } },
    { ...traceNode('get-failed', 'deviceGet', { siid: 2, piid: 1 }), cfg: { urn: failedUrn } },
  ];
  const calls = [];
  const semanticCalls = [];
  const resolved = await resolveRuleTraceDeviceGetLabels(graph, {
    loadSpec: async (urn) => {
      calls.push(urn);
      if (urn === failedUrn) throw new Error('fixture failure');
      return {
        type: sharedUrn,
        description: 'fixture',
        services: [
          {
            iid: 2,
            type: 'urn:miot-spec-v2:service:test:00007800:fixture:1',
            description: 'service',
            properties: [
              {
                iid: 1,
                type: 'urn:miot-spec-v2:property:test:00000000:fixture:1',
                description: 'property',
                format: 'uint8',
                access: ['read', 'notify'],
                'value-list': [
                  { value: 1, description: 'raw-one' },
                  { value: 2, description: 'raw-two' },
                ],
              },
              {
                iid: 2,
                type: 'urn:miot-spec-v2:property:test2:00000001:fixture:1',
                description: 'read-only property',
                format: 'uint8',
                access: ['read'],
                'value-list': [{ value: 1, description: '不应使用' }],
              },
              {
                iid: 3,
                type: 'urn:miot-spec-v2:property:motion-state:0000007D:fixture:1',
                description: 'motion state',
                format: 'bool',
                access: ['read', 'notify'],
              },
              {
                iid: 4,
                type: 'urn:miot-spec-v2:property:on:00000006:fixture:1',
                description: 'on',
                format: 'bool',
                access: ['read', 'notify'],
              },
            ],
          },
        ],
      };
    },
    semanticOptions: {
      cache: new DeviceSpecSemanticCache(),
      fetch: async (input) => {
        const url = String(input);
        semanticCalls.push(url);
        if (url.includes('/multiLanguage')) {
          return Response.json({
            data: { zh_cn: { 'service:2:property:1:value:0': '多语一' } },
          });
        }
        if (url.includes('/normalization/list/property_value')) {
          return Response.json({
            result: [
              {
                urn: 'urn:miot-spec-v2:service:test:00007800',
                proName: 'test',
                normalization: 'raw-one',
                description: '归一一',
              },
              {
                urn: 'urn:miot-spec-v2:service:test:00007800',
                proName: 'test',
                normalization: 'raw-two',
                description: '归一二',
              },
            ],
          });
        }
        if (url.endsWith('/template/list/event')) {
          return new Response('fixture fallback', { status: 503 });
        }
        return Response.json({ result: [] });
      },
    },
  });

  assert.deepEqual(calls.sort(), [failedUrn, sharedUrn].sort());
  assert.equal(
    semanticCalls.length,
    7,
    'one successful URN uses the seven shared projector catalogs',
  );
  assert.deepEqual(resolved.labelsByNodeId, {
    'get-a': { 1: '多语一', 2: '归一二' },
    'get-b': { 1: '多语一', 2: '归一二' },
    'get-motion': { true: '有人', false: '无人' },
    'get-on': { true: '开启', false: '关闭' },
  });
  assert.deepEqual(resolved.specLookup, {
    requestedUrns: [sharedUrn, failedUrn],
    failedUrns: [failedUrn],
    failureCount: 1,
  });
  assert.deepEqual(resolved.semanticProjection.attemptedUrns, [sharedUrn]);
  assert.deepEqual(resolved.semanticProjection.failedUrns, []);
  assert.equal(resolved.semanticProjection.failureCount, 0);
  assert.deepEqual(resolved.semanticProjection.catalogFallbackUrns, [sharedUrn]);
  assert.equal(resolved.semanticProjection.catalogFallbackCount, 1);
  assert.deepEqual(resolved.semanticProjection.valueLabelFallbackUrns, []);
  assert.equal(resolved.semanticProjection.valueLabelFallbackCatalogCount, 0);
  assert.deepEqual(
    resolved.semanticProjection.catalogStatuses.filter(({ status }) => status === 'fallback'),
    [
      {
        urn: sharedUrn,
        catalog: 'event-template',
        status: 'fallback',
        reason: 'http',
        httpStatus: 503,
      },
    ],
  );
  const traced = calculateRuleTrace({
    ruleId: 'rule-1',
    nodes: graph,
    entries: logs([
      '3|1|i|rule-1|get-a|1',
      '3|2|i|rule-1|get-b|2',
      '3|3|i|rule-1|get-readonly|1',
      '3|4|i|rule-1|get-motion|true',
      '3|5|i|rule-1|get-motion|false',
      '3|6|i|rule-1|get-on|true',
      '3|7|i|rule-1|get-failed|1',
    ]),
    deviceGetLabels: resolved.labelsByNodeId,
  });
  assert.deepEqual(
    traced.frames.map((frame) => frame.status[frame.changed].info),
    [
      '查询成功, 值为多语一',
      '查询成功, 值为归一二',
      '查询成功, 值为1',
      '查询成功, 值为有人',
      '查询成功, 值为无人',
      '查询成功, 值为开启',
      '查询成功, 值为1',
    ],
  );
});

test('deviceGet semantic fallback keeps raw values and shares global catalogs across URNs', async () => {
  const urns = [
    'urn:miot-spec-v2:device:test:0000A000:raw-a:1',
    'urn:miot-spec-v2:device:test:0000A000:raw-b:1',
  ];
  const graph = urns.map((urn, index) => ({
    ...traceNode(`get-raw-${index}`, 'deviceGet', { siid: 2, piid: 1 }),
    cfg: { urn },
  }));
  const semanticCalls = [];
  const resolved = await resolveRuleTraceDeviceGetLabels(graph, {
    loadSpec: async (urn) => ({
      type: urn,
      description: 'fixture',
      services: [
        {
          iid: 2,
          type: 'urn:miot-spec-v2:service:test:00007800:fixture:1',
          description: 'service',
          properties: [
            {
              iid: 1,
              type: 'urn:miot-spec-v2:property:test:00000000:fixture:1',
              description: 'property',
              format: 'uint8',
              access: ['read', 'notify'],
              'value-list': [{ value: 1, description: 'raw-one' }],
            },
          ],
        },
      ],
    }),
    semanticOptions: {
      cache: new DeviceSpecSemanticCache(),
      fetch: async (input) => {
        const url = String(input);
        semanticCalls.push(url);
        if (url.includes('/multiLanguage')) {
          return Response.json({ data: { zh_cn: {} } });
        }
        if (url.includes('/normalization/list/property_value')) {
          return new Response('fixture fallback', { status: 503 });
        }
        return Response.json({ result: [] });
      },
    },
  });

  assert.equal(
    semanticCalls.length,
    8,
    'two URNs fetch two multiLanguage catalogs but share six global catalog requests',
  );
  assert.deepEqual(resolved.labelsByNodeId, {
    'get-raw-0': { 1: 'raw-one' },
    'get-raw-1': { 1: 'raw-one' },
  });
  assert.deepEqual(resolved.semanticProjection.catalogFallbackUrns, urns);
  assert.equal(resolved.semanticProjection.catalogFallbackCount, 2);
  assert.deepEqual(resolved.semanticProjection.valueLabelFallbackUrns, urns);
  assert.equal(resolved.semanticProjection.valueLabelFallbackCatalogCount, 2);
});

test('deviceGet semantic projector failure is bounded and leaves trace values raw', async () => {
  const urn = 'urn:miot-spec-v2:device:test:0000A000:projection-failure:1';
  const node = { ...traceNode('get-raw', 'deviceGet', { siid: 2, piid: 1 }), cfg: { urn } };
  const resolved = await resolveRuleTraceDeviceGetLabels([node], {
    loadSpec: async () => ({
      type: urn,
      description: 'fixture',
      services: [
        {
          iid: 2,
          type: 'urn:miot-spec-v2:service:test:00007800:fixture:1',
          description: 'service',
        },
      ],
    }),
    projectSemantics: async () => {
      throw new Error('fixture projection failure');
    },
  });

  assert.deepEqual(resolved.labelsByNodeId, {});
  assert.deepEqual(resolved.specLookup, {
    requestedUrns: [urn],
    failedUrns: [],
    failureCount: 0,
  });
  assert.deepEqual(resolved.semanticProjection, {
    attemptedUrns: [urn],
    failedUrns: [urn],
    failureCount: 1,
    catalogStatuses: [],
    catalogFallbackUrns: [],
    catalogFallbackCount: 0,
    valueLabelFallbackUrns: [],
    valueLabelFallbackCatalogCount: 0,
  });
  const traced = calculateRuleTrace({
    ruleId: 'rule-1',
    nodes: [node],
    entries: logs(['3|1|i|rule-1|get-raw|raw-value']),
    deviceGetLabels: resolved.labelsByNodeId,
  });
  assert.equal(traced.frames[0].status['node:get-raw'].info, '查询成功, 值为raw-value');
});

test('legacy deviceGet fallback skips malformed spec lookup and keeps raw trace info', async () => {
  const legacyNode = {
    id: 'legacy-get',
    type: 'deviceGet',
    cfg: { name: 'legacy' },
    inputs: {},
    outputs: {},
    props: {},
  };
  const calls = [];
  const resolved = await resolveRuleTraceDeviceGetLabels([legacyNode], {
    loadSpec: async (urn) => {
      calls.push(urn);
      throw new Error('malformed legacy node must not request a spec');
    },
  });

  assert.deepEqual(calls, []);
  assert.deepEqual(resolved, {
    labelsByNodeId: {},
    specLookup: { requestedUrns: [], failedUrns: [], failureCount: 0 },
    semanticProjection: {
      attemptedUrns: [],
      failedUrns: [],
      failureCount: 0,
      catalogStatuses: [],
      catalogFallbackUrns: [],
      catalogFallbackCount: 0,
      valueLabelFallbackUrns: [],
      valueLabelFallbackCatalogCount: 0,
    },
  });
  const traced = calculateRuleTrace({
    ruleId: 'rule-1',
    nodes: [legacyNode],
    entries: logs(['3|1|i|rule-1|legacy-get|raw-value']),
    deviceGetLabels: resolved.labelsByNodeId,
  });
  assert.equal(traced.frames[0].status['node:legacy-get'].info, '查询成功, 值为raw-value');
});
