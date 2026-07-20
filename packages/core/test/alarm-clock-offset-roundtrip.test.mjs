import assert from 'node:assert/strict';
import test from 'node:test';

import { addNode, exportRuleFromView, nodeSchemaForType, validateGraph } from '../dist/index.js';

const fakeBaseUrl = 'http://gateway.invalid';
const fakeAgentStartedAt = '2026-07-20T00:00:00.000Z';

function ruleSummary(id) {
  return {
    id,
    enable: false,
    uiType: 'rule',
    userData: {
      name: 'alarm clock offset round-trip test',
      transform: { x: 0, y: 0, scale: 1, rotate: 0 },
      lastUpdateTime: 0,
      version: 0,
    },
  };
}

function createStatefulGateway(id) {
  const state = { summary: ruleSummary(id), nodes: [] };
  const deps = {
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
      request: async (method, params) => {
        if (method === '$ping') {
          return { host: fakeBaseUrl, agentStartedAt: fakeAgentStartedAt };
        }
        if (method === '$mutation.acquire') return { leaseId: 'test-lease' };
        if (method === '$mutation.release' || method === '$mutation.fence') return { ok: true };
        if (method === '/api/getGraphList') return [structuredClone(state.summary)];
        if (method === '/api/getGraph') return { id, nodes: structuredClone(state.nodes) };
        if (method === '/api/setGraph') {
          state.summary = structuredClone(params.cfg);
          state.nodes = structuredClone(params.nodes);
          return null;
        }
        throw new Error(`unexpected RPC: ${method}`);
      },
      close: () => {},
    }),
  };
  return { deps, state };
}

function flagValue(command, name) {
  return command.flags.find((flag) => flag.name === name)?.value;
}

function hasFlag(command, name) {
  return command.flags.some((flag) => flag.name === name);
}

function shortcutFromExport(command) {
  const rawPos = flagValue(command, '--pos');
  const posParts = rawPos?.split(',').map(Number);
  const rawOffset = flagValue(command, '--offset-min');
  return {
    type: 'alarmClock',
    id: flagValue(command, '--id'),
    ...(posParts?.length === 4 && {
      pos: {
        x: posParts[0],
        y: posParts[1],
        width: posParts[2],
        height: posParts[3],
      },
    }),
    ...(hasFlag(command, '--sunrise') && { sunrise: true }),
    ...(hasFlag(command, '--sunset') && { sunset: true }),
    ...(rawOffset !== undefined && { offsetMin: Number(rawOffset) }),
    latitude: Number(flagValue(command, '--latitude')),
    longitude: Number(flagValue(command, '--longitude')),
  };
}

function alarmWireState(node) {
  return {
    id: node.id,
    cfg: {
      happenType: node.cfg.happenType,
      tempOffset: node.cfg.tempOffset,
    },
    props: node.props,
  };
}

const cases = [
  {
    label: 'negative sunrise offset',
    id: 'sunrise-before',
    form: 'sunrise',
    offsetMin: -15,
    happenType: 'before',
    latitude: 30.46,
    longitude: 114.41,
  },
  {
    label: 'positive sunset offset',
    id: 'sunset-after',
    form: 'sunset',
    offsetMin: 20,
    happenType: 'after',
    latitude: -33.86,
    longitude: 151.21,
  },
  {
    label: 'zero sunrise offset',
    id: 'sunrise-now',
    form: 'sunrise',
    offsetMin: 0,
    happenType: 'now',
    latitude: 0,
    longitude: 0,
  },
];

for (const scenario of cases) {
  test(`alarmClock ${scenario.label} keeps signed minutes through synth, validation, and export replay`, async () => {
    const ruleId = `rule-${scenario.id}`;
    const sourceGateway = createStatefulGateway(ruleId);
    const shortcut = {
      type: 'alarmClock',
      id: scenario.id,
      [scenario.form]: true,
      offsetMin: scenario.offsetMin,
      latitude: scenario.latitude,
      longitude: scenario.longitude,
    };

    await addNode({ ruleId, shortcut, varCheck: false }, sourceGateway.deps);

    const sourceNode = sourceGateway.state.nodes[0];
    assert.ok(sourceNode);
    assert.deepEqual(sourceNode.props, {
      type: 'sunset',
      isSunset: scenario.form === 'sunset',
      offset: scenario.offsetMin,
      latitude: scenario.latitude,
      longitude: scenario.longitude,
      filter: {},
    });
    assert.equal(sourceNode.cfg.happenType, scenario.happenType);
    assert.equal(sourceNode.cfg.tempOffset, Math.abs(scenario.offsetMin));

    const schema = nodeSchemaForType('alarmClock');
    assert.ok(schema);
    assert.equal(schema.safeParse(sourceNode).success, true);
    assert.deepEqual(
      (await validateGraph({ graph: { id: ruleId, nodes: [sourceNode] } })).filter(
        (issue) => issue.severity === 'error',
      ),
      [],
    );

    const exported = await exportRuleFromView(
      { id: ruleId, cfg: sourceGateway.state.summary, nodes: [sourceNode] },
      sourceGateway.deps,
      undefined,
      true,
    );
    const command = exported.commands.find(
      (candidate) => candidate.kind === 'node-add' && candidate.nodeId === scenario.id,
    );
    assert.ok(command);
    assert.equal(hasFlag(command, scenario.form === 'sunset' ? '--sunset' : '--sunrise'), true);
    assert.equal(flagValue(command, '--offset-min'), String(scenario.offsetMin));

    const replayGateway = createStatefulGateway(ruleId);
    await addNode(
      {
        ruleId,
        shortcut: shortcutFromExport(command),
        varCheck: false,
      },
      replayGateway.deps,
    );

    assert.deepEqual(alarmWireState(replayGateway.state.nodes[0]), alarmWireState(sourceNode));
  });
}
