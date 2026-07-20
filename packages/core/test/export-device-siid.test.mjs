import assert from 'node:assert/strict';
import test from 'node:test';

import { addNode, exportRuleFromView, nodeSchemaForType, validateGraph } from '../dist/index.js';

const baseUrl = 'http://gateway.invalid';
const startedAt = '2026-07-19T00:00:00.000Z';
const ruleId = '75';
const did = 'duplicate-device';
const urn = 'urn:miot-spec-v2:device:duplicate-device:0000A001:fixture:1';

function duplicateService(iid, propertyIids, actionIid, eventIid) {
  return {
    iid,
    type: `urn:miot-spec-v2:service:duplicate-service:00007801:fixture:${iid}`,
    description: `duplicate service ${iid}`,
    properties: [
      {
        iid: propertyIids[0],
        type: `urn:miot-spec-v2:property:shared-value:00000001:fixture:${iid}`,
        description: `shared value ${iid}`,
        format: 'uint8',
        access: ['read', 'write', 'notify'],
        'value-range': [0, 100, 1],
      },
      {
        iid: propertyIids[1],
        type: `urn:miot-spec-v2:property:event-payload:00000002:fixture:${iid}`,
        description: `event payload ${iid}`,
        format: 'string',
        access: ['read', 'write', 'notify'],
      },
    ],
    actions: [
      {
        iid: actionIid,
        type: `urn:miot-spec-v2:action:apply-shared:00002801:fixture:${iid}`,
        description: `apply shared ${iid}`,
        in: propertyIids,
        out: [],
      },
    ],
    events: [
      {
        iid: eventIid,
        type: `urn:miot-spec-v2:event:shared-event:00005001:fixture:${iid}`,
        description: `shared event ${iid}`,
        arguments: propertyIids,
      },
    ],
  };
}

const duplicateSpec = {
  type: urn,
  description: 'duplicate property/action/event fixture',
  services: [duplicateService(2, [1, 2], 10, 20), duplicateService(3, [11, 12], 30, 40)],
};

const device = {
  specV2Access: true,
  specV3Access: false,
  online: true,
  pushAvailable: true,
  name: 'duplicate fixture device',
  model: 'fixture.duplicate.v1',
  modelName: 'Duplicate Fixture',
  urn,
  roomId: 'room-1',
  roomName: 'Room',
  icon: '',
};

function summary(id = ruleId) {
  return {
    id,
    enable: false,
    uiType: 'rule',
    userData: {
      name: 'device SIID export fixture',
      transform: { x: 0, y: 0, scale: 1, rotate: 0 },
      lastUpdateTime: 0,
      version: 0,
    },
  };
}

function createGateway(id = ruleId) {
  const state = { summary: summary(id), nodes: [] };
  const deps = {
    baseUrl,
    store: {
      read: async () => ({
        host: baseUrl,
        pid: 1,
        socketPath: '/tmp/xgg-export-device-siid-unused.sock',
        agentStartedAt: startedAt,
        agentVersion: '0.1.4',
        lastValidatedAt: startedAt,
      }),
    },
    ipcClient: () => ({
      request: async (method, params) => {
        if (method === '$ping') return { host: baseUrl, agentStartedAt: startedAt };
        if (method === '$mutation.acquire') return { leaseId: 'test-lease' };
        if (method === '$mutation.release' || method === '$mutation.fence') return { ok: true };
        if (method === '/api/getDevList') return { devList: { [did]: device } };
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
    getDeviceSpec: async (requestedUrn) => {
      assert.equal(requestedUrn, urn);
      return duplicateSpec;
    },
  };
  return { deps, state };
}

function flagValues(command, name) {
  return command.flags.filter((flag) => flag.name === name).map((flag) => flag.value);
}

function shortcutFromExport(command) {
  const one = (name) => flagValues(command, name)[0];
  const shortcut = {
    type: command.type,
    id: one('--id'),
    deviceDid: one('--device-did'),
  };
  const copy = (flag, key) => {
    const value = one(flag);
    if (value !== undefined) shortcut[key] = value;
  };
  copy('--device-property', 'deviceProperty');
  copy('--device-action', 'deviceAction');
  copy('--device-event', 'deviceEvent');
  copy('--value', 'value');
  copy('--var-scope', 'varScope');
  copy('--var-id', 'varId');
  copy('--op', 'op');
  copy('--property-value', 'propertyValue');
  const propertyInclude = one('--property-include');
  if (propertyInclude !== undefined)
    shortcut.propertyInclude = propertyInclude.split(',').map(Number);

  const deviceSiid = one('--device-siid');
  if (deviceSiid !== undefined) shortcut.deviceSiid = Number(deviceSiid);
  const threshold = one('--threshold');
  if (threshold !== undefined) shortcut.threshold = Number(threshold);
  const threshold2 = one('--threshold2');
  if (threshold2 !== undefined) shortcut.threshold2 = Number(threshold2);
  const params = one('--params');
  if (params !== undefined) shortcut.params = JSON.parse(params);

  const pos = one('--pos')?.split(',').map(Number);
  if (pos?.length === 4) {
    shortcut.pos = { x: pos[0], y: pos[1], width: pos[2], height: pos[3] };
  }
  const eventFilters = flagValues(command, '--event-filter').filter((value) => value !== undefined);
  if (eventFilters.length > 0) shortcut.deviceEventArgs = eventFilters;
  const eventIncludes = flagValues(command, '--event-filter-include').filter(
    (value) => value !== undefined,
  );
  if (eventIncludes.length > 0) shortcut.deviceEventIncludes = eventIncludes;
  const eventBetweens = flagValues(command, '--event-filter-between').filter(
    (value) => value !== undefined,
  );
  if (eventBetweens.length > 0) shortcut.deviceEventBetweens = eventBetweens;
  const eventArgVars = flagValues(command, '--event-arg-var').filter(
    (value) => value !== undefined,
  );
  if (eventArgVars.length > 0) shortcut.deviceEventArgVars = eventArgVars;
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

function positioned(index, shortcut) {
  return {
    ...shortcut,
    pos: { x: index * 500, y: index * 20, width: 420, height: 200 },
  };
}

const affectedIds = [
  'input-event',
  'output-action',
  'output-property',
  'input-set-var-event',
  'input-set-var-property',
  'get-set-var-property',
];
const controlIds = ['input-property-control', 'get-property-control'];

test('all device shortcut branches export one SIID and replay duplicate MIoT names exactly', async () => {
  const source = createGateway();
  const shortcuts = [
    positioned(0, {
      type: 'deviceInput',
      id: 'input-event',
      deviceDid: did,
      deviceSiid: 2,
      deviceEvent: 'shared-event',
      deviceEventArgs: ['1>=7', '2=ready'],
    }),
    positioned(1, {
      type: 'deviceOutput',
      id: 'output-action',
      deviceDid: did,
      deviceSiid: 2,
      deviceAction: 'apply-shared',
      params: { 'shared-value': 9, 'event-payload': 'payload' },
    }),
    positioned(2, {
      type: 'deviceOutput',
      id: 'output-property',
      deviceDid: did,
      deviceSiid: 2,
      deviceProperty: 'shared-value',
      value: '13',
    }),
    positioned(3, {
      type: 'deviceInputSetVar',
      id: 'input-set-var-event',
      deviceDid: did,
      deviceSiid: 2,
      deviceEvent: 'shared-event',
      deviceEventArgVars: ['1=global.eventNumber', '2=global.eventText'],
    }),
    positioned(4, {
      type: 'deviceInputSetVar',
      id: 'input-set-var-property',
      deviceDid: did,
      deviceSiid: 2,
      deviceProperty: 'shared-value',
      varScope: 'global',
      varId: 'inputCapture',
    }),
    positioned(5, {
      type: 'deviceGetSetVar',
      id: 'get-set-var-property',
      deviceDid: did,
      deviceSiid: 2,
      deviceProperty: 'shared-value',
      varScope: 'global',
      varId: 'getCapture',
    }),
    positioned(6, {
      type: 'deviceInput',
      id: 'input-property-control',
      deviceDid: did,
      deviceSiid: 2,
      deviceProperty: 'shared-value',
      op: 'gte',
      threshold: 4,
    }),
    positioned(7, {
      type: 'deviceGet',
      id: 'get-property-control',
      deviceDid: did,
      deviceSiid: 2,
      deviceProperty: 'shared-value',
      op: 'eq',
      threshold: 5,
    }),
  ];
  for (const shortcut of shortcuts) await addShortcut(source, shortcut);

  const exported = await exportRuleFromView(
    { id: ruleId, cfg: source.state.summary, nodes: source.state.nodes },
    source.deps,
  );
  const commands = exported.commands.filter((command) => command.kind === 'node-add');
  assert.deepEqual(
    commands.map((command) => command.nodeId),
    [...affectedIds, ...controlIds],
  );
  for (const command of commands) {
    assert.deepEqual(flagValues(command, '--device-siid'), ['2'], command.nodeId);
  }

  const replay = createGateway();
  for (const command of commands) {
    await addShortcut(replay, shortcutFromExport(command));
  }
  assert.deepEqual(replay.state.nodes, source.state.nodes);

  const props = Object.fromEntries(replay.state.nodes.map((node) => [node.id, node.props]));
  for (const id of [...affectedIds, ...controlIds]) assert.equal(props[id].siid, 2, id);
  assert.equal(props['input-event'].eiid, 20);
  assert.deepEqual(props['input-event'].arguments, [
    { piid: 1, dtype: 'int', operator: '>=', v1: 7 },
    { piid: 2, dtype: 'string', operator: '=', v1: 'ready' },
  ]);
  assert.equal(props['output-action'].aiid, 10);
  assert.deepEqual(props['output-action'].ins, [
    { piid: 1, value: 9 },
    { piid: 2, value: 'payload' },
  ]);
  assert.equal(props['output-property'].piid, 1);
  assert.equal(props['input-set-var-event'].eiid, 20);
  assert.deepEqual(props['input-set-var-event'].arguments, [
    { piid: 1, dtype: 'number', scope: 'global', id: 'eventNumber' },
    { piid: 2, dtype: 'string', scope: 'global', id: 'eventText' },
  ]);
  for (const id of [
    'input-set-var-property',
    'get-set-var-property',
    'input-property-control',
    'get-property-control',
  ]) {
    assert.equal(props[id].piid, 1, id);
  }
});

test('legacy version-0 event input stays readable and exports without mutation to canonical replay', async () => {
  const source = createGateway();
  const legacyNode = {
    id: 'legacyEvent',
    type: 'deviceInput',
    cfg: {
      ...legacyCfg('deviceInput', 0),
      version: 0,
    },
    inputs: {},
    outputs: { output: [] },
    props: { did, siid: 2, eiid: 20, arguments: [] },
  };
  source.state.nodes = [structuredClone(legacyNode)];

  assert.equal(nodeSchemaForType('deviceInput').safeParse(legacyNode).success, true);
  const issues = await validateGraph({
    graph: { id: ruleId, cfg: source.state.summary, nodes: source.state.nodes },
    getDeviceSpec: source.deps.getDeviceSpec,
  });
  assert.equal(
    issues.some((issue) => issue.path === 'nodes[0].cfg.version'),
    false,
  );

  const before = structuredClone(source.state.nodes);
  const exported = await exportRuleFromView(
    { id: ruleId, cfg: source.state.summary, nodes: source.state.nodes },
    source.deps,
  );
  assert.deepEqual(source.state.nodes, before, 'read/export must not rewrite the observed graph');

  const command = exported.commands.find((candidate) => candidate.kind === 'node-add');
  assert.ok(command);
  const replay = createGateway();
  await addShortcut(replay, shortcutFromExport(command));
  assert.equal(replay.state.nodes[0].cfg.name, 'deviceInput');
  assert.equal(replay.state.nodes[0].cfg.version, 1);
});

function legacyCfg(type, index) {
  return {
    urn,
    name: type,
    version: 1,
    pos: { x: index * 100, y: 0, width: 420, height: 200 },
  };
}

test('missing and invalid legacy SIIDs never emit a device-siid flag', async () => {
  const legacyNodes = [
    {
      id: 'missing-input-event',
      type: 'deviceInput',
      cfg: legacyCfg('deviceInput', 0),
      props: { did, eiid: 20, arguments: [] },
    },
    {
      id: 'nan-output-action',
      type: 'deviceOutput',
      cfg: legacyCfg('deviceOutput', 1),
      props: { did, siid: Number.NaN, aiid: 10, ins: [] },
    },
    {
      id: 'infinite-output-property',
      type: 'deviceOutput',
      cfg: legacyCfg('deviceOutput', 2),
      props: { did, siid: Number.POSITIVE_INFINITY, piid: 1, value: 1 },
    },
    {
      id: 'fractional-input-set-var-event',
      type: 'deviceInputSetVar',
      cfg: legacyCfg('deviceInputSetVar', 3),
      props: { did, siid: 1.5, eiid: 20, arguments: [] },
    },
    {
      id: 'zero-input-set-var-property',
      type: 'deviceInputSetVar',
      cfg: legacyCfg('deviceInputSetVar', 4),
      props: { did, siid: 0, piid: 1, dtype: 'number' },
    },
    {
      id: 'negative-get-set-var-property',
      type: 'deviceGetSetVar',
      cfg: legacyCfg('deviceGetSetVar', 5),
      props: { did, siid: -2, piid: 1, dtype: 'number' },
    },
    {
      id: 'string-input-property-control',
      type: 'deviceInput',
      cfg: legacyCfg('deviceInput', 6),
      props: { did, siid: '2', piid: 1, dtype: 'int', operator: '>', v1: 1 },
    },
    {
      id: 'unsafe-get-property-control',
      type: 'deviceGet',
      cfg: legacyCfg('deviceGet', 7),
      props: {
        did,
        siid: Number.MAX_SAFE_INTEGER + 1,
        piid: 1,
        dtype: 'int',
        operator: '>',
        v1: 1,
      },
    },
  ];
  const gateway = createGateway();
  const exported = await exportRuleFromView(
    { id: ruleId, cfg: gateway.state.summary, nodes: legacyNodes },
    gateway.deps,
  );
  const commands = exported.commands.filter((command) => command.kind === 'node-add');
  assert.equal(commands.length, legacyNodes.length);
  for (const command of commands) {
    assert.deepEqual(flagValues(command, '--device-siid'), [], command.nodeId);
    assert.equal(
      command.flags.some((flag) => flag.name === '--device-siid' && flag.value === 'NaN'),
      false,
      command.nodeId,
    );
  }
});
