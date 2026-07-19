import assert from 'node:assert/strict';
import test from 'node:test';

import { addNode, exportRuleFromView, nodeSchemaForType } from '../dist/index.js';

const baseUrl = 'http://gateway.invalid';
const agentStartedAt = '2026-07-19T00:00:00.000Z';
const ruleId = 'rule-simplified';
const did = 'simplified-device';
const urn = 'urn:miot-spec-v2:device:simplified-device:0000A001:fixture:1';

const device = {
  specV2Access: true,
  specV3Access: false,
  online: true,
  pushAvailable: true,
  name: 'simplified fixture device',
  model: 'fixture.simplified.v1',
  modelName: 'Simplified Fixture',
  urn,
  roomId: 'room-1',
  roomName: 'Room',
  icon: '',
};

const spec = {
  type: urn,
  description: 'simplified round-trip fixture',
  services: [
    {
      iid: 2,
      type: 'urn:miot-spec-v2:service:fixture:00007801:fixture:1',
      description: 'fixture service',
      properties: [
        {
          iid: 1,
          type: 'urn:miot-spec-v2:property:level:0000000D:fixture:1',
          description: 'level',
          format: 'uint8',
          access: ['read', 'write', 'notify'],
          'value-range': [0, 100, 1],
        },
      ],
    },
  ],
};

function summary() {
  return {
    id: ruleId,
    enable: false,
    uiType: 'rule',
    userData: {
      name: 'simplified round-trip',
      transform: { x: 0, y: 0, scale: 1, rotate: 0 },
      lastUpdateTime: 0,
      version: 0,
    },
  };
}

function createGateway() {
  const calls = [];
  const state = { summary: summary(), nodes: [] };
  const deps = {
    baseUrl,
    store: {
      read: async () => ({
        host: baseUrl,
        pid: 1,
        socketPath: '/tmp/xgg-simplified-roundtrip-unused.sock',
        agentStartedAt,
        agentVersion: '0.1.4',
        lastValidatedAt: agentStartedAt,
      }),
    },
    ipcClient: () => ({
      request: async (method, params) => {
        if (method === '$ping') return { host: baseUrl, agentStartedAt };
        if (method === '$mutation.acquire') return { leaseId: 'test-lease' };
        if (method === '$mutation.release' || method === '$mutation.fence') return { ok: true };
        calls.push({ method, params });
        if (method === '/api/getDevList') return { devList: { [did]: device } };
        if (method === '/api/getGraphList') return [structuredClone(state.summary)];
        if (method === '/api/getGraph') {
          return { id: ruleId, nodes: structuredClone(state.nodes) };
        }
        if (method === '/api/setGraph') {
          state.summary = structuredClone(params.cfg);
          state.nodes = structuredClone(params.nodes);
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
  return { calls, deps, state };
}

function values(command, name) {
  return command.flags.filter((flag) => flag.name === name).map((flag) => flag.value);
}

function value(command, name) {
  return values(command, name)[0];
}

function shortcutFromExport(command) {
  const rawPos = value(command, '--pos');
  const posParts = rawPos?.split(',').map(Number);
  assert.ok(posParts?.length === 4 || posParts?.length === 5);

  const rawSimplified = value(command, '--simplified');
  assert.ok(rawSimplified === 'true' || rawSimplified === 'false');

  const shortcut = {
    type: command.type,
    id: value(command, '--id'),
    pos: {
      x: posParts[0],
      y: posParts[1],
      width: posParts[2],
      height: posParts[3],
      ...(posParts.length === 5 && { exprHeight: posParts[4] }),
    },
    simplified: rawSimplified === 'true',
  };

  if (command.type === 'deviceOutput') {
    shortcut.deviceDid = value(command, '--device-did');
    shortcut.deviceSiid = Number(value(command, '--device-siid'));
    shortcut.deviceProperty = value(command, '--device-property');
    shortcut.value = value(command, '--value');
  } else if (command.type === 'logicAnd') {
    shortcut.inputs = Number(value(command, '--inputs'));
  } else if (command.type === 'delay') {
    shortcut.duration = value(command, '--duration');
  } else if (command.type === 'varSetNumber') {
    shortcut.varScope = value(command, '--var-scope');
    shortcut.varId = value(command, '--var-id');
    shortcut.expr = value(command, '--expr');
  }

  return shortcut;
}

async function addShortcut(gateway, shortcut) {
  await addNode(
    {
      ruleId,
      shortcut,
      getDeviceSpec: gateway.deps.getDeviceSpec,
      validate: false,
      varCheck: false,
    },
    gateway.deps,
  );
}

const shortcuts = [
  {
    type: 'deviceOutput',
    id: 'device',
    pos: { x: 10, y: 20, width: 420, height: 160 },
    simplified: true,
    deviceDid: did,
    deviceSiid: 2,
    deviceProperty: 'level',
    value: '7',
  },
  {
    type: 'logicAnd',
    id: 'logic',
    pos: { x: 500, y: 20, width: 320, height: 140 },
    simplified: false,
    inputs: 3,
  },
  {
    type: 'delay',
    id: 'time',
    pos: { x: 900, y: 20, width: 320, height: 120 },
    simplified: true,
    duration: '5s',
  },
  {
    type: 'varSetNumber',
    id: 'expression',
    pos: { x: 1300, y: 20, width: 740, height: 220, exprHeight: 37 },
    simplified: false,
    varScope: 'global',
    varId: 'target',
    expr: '42',
  },
];

const modeledTypes = [
  'alarmClock',
  'condition',
  'counter',
  'delay',
  'deviceGet',
  'deviceGetSetVar',
  'deviceInput',
  'deviceInputSetVar',
  'deviceOutput',
  'eventSequence',
  'logicAnd',
  'logicNot',
  'logicOr',
  'loop',
  'modeSwitch',
  'onLoad',
  'onlyNTimes',
  'register',
  'signalOr',
  'statusLast',
  'timeRange',
  'varChange',
  'varGet',
  'varSetNumber',
  'varSetString',
];

test('all 25 modeled cfg schemas recognize only boolean simplified without relaxing strictness', () => {
  for (const type of modeledTypes) {
    const schema = nodeSchemaForType(type);
    assert.ok(schema, type);
    const shell = { type, id: 'node', inputs: {}, outputs: {}, props: {} };

    const acceptedKey = schema.safeParse({ ...shell, cfg: { simplified: true } });
    assert.equal(acceptedKey.success, false, `${type}: intentionally incomplete shell`);
    assert.equal(
      acceptedKey.error.issues.some(
        (issue) =>
          issue.code === 'unrecognized_keys' &&
          issue.path.join('.') === 'cfg' &&
          issue.keys.includes('simplified'),
      ),
      false,
      `${type}: simplified must be a recognized cfg key`,
    );

    const wrongType = schema.safeParse({ ...shell, cfg: { simplified: 'true' } });
    assert.equal(wrongType.success, false, type);
    assert.equal(
      wrongType.error.issues.some((issue) => issue.path.join('.') === 'cfg.simplified'),
      true,
      `${type}: simplified must stay boolean-typed`,
    );

    const unknownKey = schema.safeParse({ ...shell, cfg: { futureUiKey: true } });
    assert.equal(unknownKey.success, false, type);
    assert.equal(
      unknownKey.error.issues.some(
        (issue) =>
          issue.code === 'unrecognized_keys' &&
          issue.path.join('.') === 'cfg' &&
          issue.keys.includes('futureUiKey'),
      ),
      true,
      `${type}: cfg must remain strict`,
    );
  }
});

test('representative device, logic, time, and expression schemas accept only boolean simplified', async () => {
  const gateway = createGateway();
  for (const shortcut of shortcuts) await addShortcut(gateway, shortcut);

  for (const node of gateway.state.nodes) {
    const schema = nodeSchemaForType(node.type);
    assert.ok(schema, node.type);
    assert.equal(schema.safeParse(node).success, true, node.type);

    const wrongType = structuredClone(node);
    wrongType.cfg.simplified = 'true';
    assert.equal(schema.safeParse(wrongType).success, false, `${node.type}: non-boolean`);

    const unknownKey = structuredClone(node);
    unknownKey.cfg.futureUiKey = true;
    assert.equal(schema.safeParse(unknownKey).success, false, `${node.type}: strict cfg`);
  }
});

test('strict export replay preserves explicit true and false simplified state across families', async () => {
  const source = createGateway();
  for (const shortcut of shortcuts) await addShortcut(source, shortcut);

  const exported = await exportRuleFromView(
    { id: ruleId, cfg: source.state.summary, nodes: source.state.nodes },
    source.deps,
    undefined,
    true,
  );
  assert.equal(
    exported.warnings.some((warning) => /cfg keys.*simplified|simplified.*drops/.test(warning)),
    false,
  );

  const commands = exported.commands.filter((command) => command.kind === 'node-add');
  assert.deepEqual(
    commands.map((command) => value(command, '--simplified')),
    ['true', 'false', 'true', 'false'],
  );

  const replay = createGateway();
  for (const command of commands) await addShortcut(replay, shortcutFromExport(command));
  assert.deepEqual(replay.state.nodes, source.state.nodes);
});
