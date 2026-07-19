import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ConfigError,
  addNode,
  exportRuleFromView,
  nodeSchemaForType,
  renderExportedAsShell,
} from '../dist/index.js';

const baseUrl = 'http://preload.test';
const startedAt = '2026-07-19T00:00:00.000Z';
const ruleId = '100';
const did = 'preload-device';
const urn = 'urn:miot-spec-v2:device:preload:0000A001:fixture:1';

const spec = {
  type: urn,
  description: 'preload fixture',
  services: [
    {
      iid: 2,
      type: 'urn:miot-spec-v2:service:preload:00007801:fixture:1',
      description: 'preload service',
      properties: [
        {
          iid: 1,
          type: 'urn:miot-spec-v2:property:level:0000000D:fixture:1',
          description: 'level',
          format: 'uint8',
          access: ['read', 'notify'],
          'value-range': [0, 100, 1],
        },
      ],
      events: [
        {
          iid: 10,
          type: 'urn:miot-spec-v2:event:changed:00005001:fixture:1',
          description: 'changed',
          arguments: [1],
        },
      ],
    },
  ],
};

const device = {
  specV2Access: true,
  specV3Access: false,
  online: true,
  pushAvailable: true,
  name: 'preload fixture',
  model: 'fixture.preload.v1',
  modelName: 'Preload Fixture',
  urn,
  roomId: 'room-1',
  roomName: 'Room',
  icon: '',
};

function summary() {
  return {
    id: ruleId,
    enable: false,
    uiType: 'rule',
    userData: {
      name: 'preload round-trip',
      transform: { x: 0, y: 0, scale: 1, rotate: 0 },
      lastUpdateTime: 0,
      version: 0,
    },
  };
}

function createGateway() {
  const state = { summary: summary(), nodes: [] };
  const calls = [];
  const deps = {
    baseUrl,
    store: {
      read: async () => ({
        host: baseUrl,
        pid: 1,
        socketPath: '/tmp/xgg-preload-unused.sock',
        agentStartedAt: startedAt,
        agentVersion: 'test',
        lastValidatedAt: startedAt,
      }),
    },
    ipcClient: () => ({
      request: async (method, params) => {
        if (method === '$ping') return { host: baseUrl, agentStartedAt: startedAt };
        if (method === '$mutation.acquire') return { leaseId: 'preload-test-lease' };
        if (method === '$mutation.release' || method === '$mutation.fence') return { ok: true };
        calls.push({ method, params });
        if (method === '/api/getDevList') return { devList: { [did]: device } };
        if (method === '/api/getGraphList') return [structuredClone(state.summary)];
        if (method === '/api/getGraph') return { id: ruleId, nodes: structuredClone(state.nodes) };
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

function positioned(index, shortcut) {
  return {
    ...shortcut,
    pos: { x: index * 600, y: index * 20, width: 532, height: 206 },
  };
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

function flag(command, name) {
  return command.flags.find((candidate) => candidate.name === name);
}

function shortcutFromExport(command) {
  const value = (name) => flag(command, name)?.value;
  const shortcut = { type: command.type, id: value('--id') };
  const copy = (name, key) => {
    const candidate = value(name);
    if (candidate !== undefined) shortcut[key] = candidate;
  };
  copy('--device-did', 'deviceDid');
  copy('--device-property', 'deviceProperty');
  copy('--var-scope', 'varScope');
  copy('--var-id', 'varId');
  copy('--var-type', 'varType');
  copy('--op', 'op');
  const siid = value('--device-siid');
  if (siid !== undefined) shortcut.deviceSiid = Number(siid);
  const threshold = value('--threshold');
  if (threshold !== undefined) shortcut.threshold = Number(threshold);
  const pos = value('--pos')?.split(',').map(Number);
  if (pos?.length === 4) {
    shortcut.pos = { x: pos[0], y: pos[1], width: pos[2], height: pos[3] };
  }
  if (flag(command, '--preload') !== undefined) shortcut.preload = true;
  if (flag(command, '--no-preload') !== undefined) shortcut.preload = false;
  return shortcut;
}

const shortcuts = [
  ...[true, false, undefined].map((preload, index) =>
    positioned(index, {
      type: 'deviceInput',
      id: `input-${String(preload)}`,
      deviceDid: did,
      deviceProperty: 'level',
      op: 'gt',
      threshold: 10,
      ...(preload !== undefined && { preload }),
    }),
  ),
  ...[true, false, undefined].map((preload, offset) =>
    positioned(offset + 3, {
      type: 'deviceInputSetVar',
      id: `set-var-${String(preload)}`,
      deviceDid: did,
      deviceProperty: 'level',
      varScope: 'global',
      varId: `captured${offset}`,
      ...(preload !== undefined && { preload }),
    }),
  ),
  ...[true, false, undefined].map((preload, offset) =>
    positioned(offset + 6, {
      type: 'varChange',
      id: `var-change-${String(preload)}`,
      varScope: 'global',
      varId: `observed${offset}`,
      varType: 'number',
      op: 'gte',
      threshold: 1,
      ...(preload !== undefined && { preload }),
    }),
  ),
];

test('supported typed shortcuts default to false and schemas accept both preload values', async () => {
  const gateway = createGateway();
  for (const shortcut of shortcuts) await addShortcut(gateway, shortcut);

  assert.deepEqual(
    gateway.state.nodes.map((node) => node.props.preload),
    [true, false, false, true, false, false, true, false, false],
  );
  for (const node of gateway.state.nodes) {
    assert.equal(nodeSchemaForType(node.type).safeParse(node).success, true, node.id);
  }

  const inputEvent = {
    id: 'input-event',
    type: 'deviceInput',
    cfg: {
      urn,
      pos: { x: 0, y: 0, width: 584, height: 206 },
      name: 'deviceInput',
      version: 0,
    },
    inputs: {},
    outputs: { output: [] },
    props: { did, siid: 2, eiid: 10, arguments: [], preload: true },
  };
  const setVarEvent = {
    id: 'set-var-event',
    type: 'deviceInputSetVar',
    cfg: {
      urn,
      pos: { x: 0, y: 0, width: 554, height: 206 },
      name: 'deviceInputSetVar',
      version: 1,
    },
    inputs: {},
    outputs: { output: [] },
    props: {
      did,
      siid: 2,
      eiid: 10,
      arguments: [{ piid: 1, dtype: 'number', scope: 'global', id: 'captured' }],
      preload: false,
    },
  };
  assert.equal(nodeSchemaForType('deviceInput').safeParse(inputEvent).success, false);
  assert.equal(nodeSchemaForType('deviceInputSetVar').safeParse(setVarEvent).success, false);
});

test('export emits exact positive/negative preload flags and replay preserves every value', async () => {
  const source = createGateway();
  for (const shortcut of shortcuts) await addShortcut(source, shortcut);

  const exported = await exportRuleFromView(
    { id: ruleId, cfg: source.state.summary, nodes: source.state.nodes },
    source.deps,
  );
  const commands = exported.commands.filter((command) => command.kind === 'node-add');
  assert.deepEqual(
    commands.map((command) => [
      flag(command, '--preload') !== undefined,
      flag(command, '--no-preload') !== undefined,
    ]),
    [
      [true, false],
      [false, true],
      [false, true],
      [true, false],
      [false, true],
      [false, true],
      [true, false],
      [false, true],
      [false, true],
    ],
  );
  const shell = renderExportedAsShell(exported);
  assert.equal((shell.match(/'--preload'/g) ?? []).length, 3);
  assert.equal((shell.match(/'--no-preload'/g) ?? []).length, 6);

  const replay = createGateway();
  for (const command of commands) await addShortcut(replay, shortcutFromExport(command));
  assert.deepEqual(replay.state.nodes, source.state.nodes);
});

test('typed preload misuse fails before session access', async () => {
  let reads = 0;
  const deps = {
    baseUrl,
    store: {
      read: async () => {
        reads += 1;
        throw new Error('session access must not happen');
      },
    },
  };
  const unsupported = [
    { type: 'deviceInput', deviceDid: did, deviceEvent: 'changed', preload: true },
    {
      type: 'deviceInputSetVar',
      deviceDid: did,
      deviceEvent: 'changed',
      deviceEventArgVars: ['1=global.captured'],
      preload: false,
    },
    { type: 'deviceGet', deviceDid: did, deviceProperty: 'level', preload: true },
    {
      type: 'varGet',
      varScope: 'global',
      varId: 'observed',
      varType: 'number',
      preload: false,
    },
    { type: 'onLoad', preload: true },
  ];
  for (const shortcut of unsupported) {
    await assert.rejects(
      addNode({ ruleId, shortcut, varCheck: false }, deps),
      (error) => error instanceof ConfigError && /preload only applies/.test(error.message),
    );
  }
  assert.equal(reads, 0);
});
