import assert from 'node:assert/strict';
import test from 'node:test';

import { addNode, exportRuleFromView, nodeSchemaForType } from '../dist/index.js';

const fakeBaseUrl = 'http://gateway.invalid';
const fakeAgentStartedAt = '2026-07-19T00:00:00.000Z';

function summary(id = 'rule-1') {
  return {
    id,
    enable: false,
    uiType: 'test',
    userData: {
      name: 'timeRange capabilities',
      transform: { x: 0, y: 0, scale: 1, rotate: 0 },
      lastUpdateTime: 0,
      version: 0,
    },
  };
}

function timeRangeNode(id, start, end, mingTextShow) {
  return {
    id,
    type: 'timeRange',
    cfg: {
      pos: { x: 0, y: 0, width: 524, height: 152 },
      name: 'timeRange',
      version: 1,
    },
    inputs: {},
    outputs: { output: [] },
    props: {
      start,
      end,
      filter: {},
      ...(mingTextShow !== undefined && { mingTextShow }),
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

function createStatefulGateway(id = 'rule-1') {
  const state = { summary: summary(id), nodes: [] };
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
    start: flagValue(command, '--start'),
    end: flagValue(command, '--end'),
  };
  if (posParts?.length === 4) {
    shortcut.pos = {
      x: posParts[0],
      y: posParts[1],
      width: posParts[2],
      height: posParts[3],
    };
  }
  const marker = flagValue(command, '--ming-text-show');
  if (marker !== undefined) shortcut.mingTextShow = marker === 'true';
  return shortcut;
}

test('timeRange schema accepts and preserves the official optional mingTextShow boolean', () => {
  const schema = nodeSchemaForType('timeRange');
  assert.ok(schema);
  const start = { hour: 8, minute: 0, second: 0 };
  const end = { hour: 22, minute: 0, second: 0 };

  for (const marker of [undefined, false, true]) {
    const node = timeRangeNode(`window-${String(marker)}`, start, end, marker);
    const parsed = schema.safeParse(node);
    assert.equal(parsed.success, true, String(marker));
    assert.deepEqual(parsed.data.props, node.props);
  }

  const invalid = timeRangeNode('invalid', start, end, undefined);
  invalid.props.mingTextShow = 'true';
  assert.equal(schema.safeParse(invalid).success, false);
});

test('timeRange shortcut derives the bundle next-day marker only for start later than end', async () => {
  const gateway = createStatefulGateway();
  await addNode(
    {
      ruleId: 'rule-1',
      shortcut: { type: 'timeRange', id: 'overnight', start: '22:00', end: '06:00' },
      validate: false,
      varCheck: false,
    },
    gateway.deps,
  );
  await addNode(
    {
      ruleId: 'rule-1',
      shortcut: { type: 'timeRange', id: 'same-day', start: '08:00', end: '22:00' },
      validate: false,
      varCheck: false,
    },
    gateway.deps,
  );

  assert.equal(gateway.state.nodes[0].props.mingTextShow, true);
  assert.equal('mingTextShow' in gateway.state.nodes[1].props, false);
});

test('timeRange export replay preserves explicit mingTextShow true and false values', async () => {
  const id = 'rule-1';
  const sourceNodes = [
    timeRangeNode(
      'same-day',
      { hour: 8, minute: 0, second: 0 },
      { hour: 22, minute: 0, second: 0 },
      false,
    ),
    timeRangeNode(
      'overnight',
      { hour: 22, minute: 0, second: 0 },
      { hour: 6, minute: 0, second: 0 },
      true,
    ),
  ];
  const gateway = createStatefulGateway(id);
  const exported = await exportRuleFromView(
    { id, cfg: summary(id), nodes: sourceNodes },
    gateway.deps,
  );
  const commands = exported.commands.filter(
    (command) => command.kind === 'node-add' && command.type === 'timeRange',
  );
  assert.deepEqual(
    commands.map((command) => flagValue(command, '--ming-text-show')),
    ['false', 'true'],
  );

  for (const command of commands) {
    await addNode(
      {
        ruleId: id,
        shortcut: shortcutFromExport(command),
        validate: false,
        varCheck: false,
      },
      gateway.deps,
    );
  }
  assert.deepEqual(
    gateway.state.nodes.map((node) => node.props),
    sourceNodes.map((node) => node.props),
  );
});
