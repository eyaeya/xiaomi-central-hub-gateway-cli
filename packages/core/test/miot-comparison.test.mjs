import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  MIOT_COMPARISON_CONTRACT,
  addNode,
  exportRuleFromView,
  miotNumericOperandDomainIssue,
  nodeSchemaForType,
  parseFiniteDecimalLiteral,
  parseSafeIntegerDecimalLiteral,
  projectMiotComparisonDtype,
  renderExportedAsShell,
  validateGraph,
} from '../dist/index.js';

const fakeBaseUrl = 'http://gateway.invalid';
const fakeAgentStartedAt = '2026-07-19T00:00:00.000Z';
const did = 'fake-device';
const urn = 'urn:miot-spec-v2:device:test-device:0000A001:fake:1';

const fakeSpec = {
  type: urn,
  description: 'offline comparison fixture',
  services: [
    {
      iid: 2,
      type: 'urn:miot-spec-v2:service:test-service:00007801:fake:1',
      description: 'offline service',
      properties: [
        {
          iid: 1,
          type: 'urn:miot-spec-v2:property:mode:00000008:fake:1',
          description: 'string mode',
          format: 'string',
          access: ['read', 'notify'],
        },
        {
          iid: 2,
          type: 'urn:miot-spec-v2:property:enum-level:0000000D:fake:1',
          description: 'float-backed enum',
          format: 'float',
          access: ['read', 'notify'],
          'value-list': [
            { value: 1, description: 'one' },
            { value: 2, description: 'two' },
          ],
          'value-range': [1, 2, 1],
        },
        {
          iid: 3,
          type: 'urn:miot-spec-v2:property:temperature:00000020:fake:1',
          description: 'continuous float',
          format: 'float',
          access: ['read', 'notify'],
          'value-range': [0, 100, 0.25],
        },
        {
          iid: 4,
          type: 'urn:miot-spec-v2:property:on:00000006:fake:1',
          description: 'boolean state',
          format: 'bool',
          access: ['read', 'notify'],
        },
        {
          iid: 5,
          type: 'urn:miot-spec-v2:property:count:0000001C:fake:1',
          description: 'integer count',
          format: 'uint16',
          access: ['read', 'notify'],
          'value-range': [0, 10, 2],
        },
        {
          iid: 6,
          type: 'urn:miot-spec-v2:property:large-count:0000001C:fake:1',
          description: 'large integer count',
          format: 'uint64',
          access: ['read', 'notify'],
        },
      ],
      events: [
        {
          iid: 10,
          type: 'urn:miot-spec-v2:event:enum-event:00005001:fake:1',
          description: 'enum event',
          arguments: [2],
        },
        {
          iid: 11,
          type: 'urn:miot-spec-v2:event:continuous-event:00005002:fake:1',
          description: 'continuous event',
          arguments: [3],
        },
        {
          iid: 12,
          type: 'urn:miot-spec-v2:event:mixed-event:00005003:fake:1',
          description: 'mixed event',
          arguments: [1, 4, 5],
        },
        {
          iid: 13,
          type: 'urn:miot-spec-v2:event:large-event:00005004:fake:1',
          description: 'large integer event',
          arguments: [6],
        },
      ],
    },
  ],
};

const fakeDevice = {
  specV2Access: true,
  specV3Access: false,
  online: true,
  pushAvailable: true,
  name: 'fake device',
  model: 'fake.model.v1',
  modelName: 'Fake Device',
  urn,
  roomId: 'room-1',
  roomName: 'Test Room',
  icon: '',
};

function ruleSummary(id = 'rule-1') {
  return {
    id,
    enable: false,
    uiType: 'rule',
    userData: {
      name: 'MIoT comparison test',
      transform: { x: 0, y: 0, scale: 1, rotate: 0 },
      lastUpdateTime: 0,
      version: 0,
    },
  };
}

function createStatefulGateway(id = 'rule-1') {
  const state = { summary: ruleSummary(id), nodes: [] };
  const calls = [];
  const deps = {
    baseUrl: fakeBaseUrl,
    store: {
      read: async () => ({
        host: fakeBaseUrl,
        pid: 123,
        socketPath: '/tmp/xgg-miot-test-unused.sock',
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
        if (method === '/api/getDevList') return { devList: { [did]: fakeDevice } };
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
      return fakeSpec;
    },
  };
  return { calls, deps, state };
}

function flagValues(command, name) {
  return command.flags.filter((flag) => flag.name === name).map((flag) => flag.value);
}

function shortcutFromExport(command) {
  const one = (name) => flagValues(command, name)[0];
  const rawPos = one('--pos');
  const posParts = rawPos?.split(',').map(Number);
  const shortcut = {
    type: command.type,
    id: one('--id'),
    deviceDid: one('--device-did'),
  };
  if (posParts?.length === 4) {
    shortcut.pos = {
      x: posParts[0],
      y: posParts[1],
      width: posParts[2],
      height: posParts[3],
    };
  }
  const property = one('--device-property');
  if (property !== undefined) shortcut.deviceProperty = property;
  const deviceSiid = one('--device-siid');
  if (deviceSiid !== undefined) shortcut.deviceSiid = Number(deviceSiid);
  const event = one('--device-event');
  if (event !== undefined) shortcut.deviceEvent = event;
  const op = one('--op');
  if (op !== undefined) shortcut.op = op;
  const propertyValue = one('--property-value');
  if (propertyValue !== undefined) shortcut.propertyValue = propertyValue;
  const propertyInclude = one('--property-include');
  if (propertyInclude !== undefined)
    shortcut.propertyInclude = propertyInclude.split(',').map(Number);
  const threshold = one('--threshold');
  if (threshold !== undefined) {
    shortcut.threshold = Number(threshold);
    shortcut.thresholdLiteral = threshold;
  }
  const threshold2 = one('--threshold2');
  if (threshold2 !== undefined) {
    shortcut.threshold2 = Number(threshold2);
    shortcut.threshold2Literal = threshold2;
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
  if (command.flags.some((flag) => flag.name === '--preload')) shortcut.preload = true;
  if (command.flags.some((flag) => flag.name === '--no-preload')) shortcut.preload = false;
  if (command.flags.some((flag) => flag.name === '--force-out-of-range')) {
    shortcut.forceOutOfRange = true;
  }
  return shortcut;
}

function shortcutFromArgv(argv) {
  const flags = [];
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i];
    if (typeof name !== 'string' || !name.startsWith('--')) continue;
    const next = argv[i + 1];
    if (typeof next === 'string' && !next.startsWith('--')) {
      flags.push({ name, value: next });
      i += 1;
    } else {
      flags.push({ name });
    }
  }
  const type = flags.find((flag) => flag.name === '--type')?.value;
  return shortcutFromExport({ type, flags });
}

async function shortcutsFromRenderedShell(exported, t) {
  const root = await mkdtemp(join(tmpdir(), 'xgg-comparison-shell-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const fakeXgg = join(root, 'xgg-capture.mjs');
  const capture = join(root, 'calls.jsonl');
  await writeFile(
    fakeXgg,
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.XGG_CAPTURE, JSON.stringify(process.argv.slice(2)) + '\\n');
`,
  );
  await chmod(fakeXgg, 0o700);
  const result = spawnSync('bash', ['-c', renderExportedAsShell(exported)], {
    encoding: 'utf8',
    env: { ...process.env, XGG: fakeXgg, XGG_CAPTURE: capture },
  });
  assert.equal(result.status, 0, result.stderr);
  const calls = (await readFile(capture, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  return calls
    .filter((argv) => argv[0] === 'rule' && argv[1] === 'node' && argv[2] === 'add')
    .map(shortcutFromArgv);
}

async function addShortcut(gateway, shortcut) {
  return addNode(
    {
      ruleId: gateway.state.summary.id,
      shortcut,
      getDeviceSpec: gateway.deps.getDeviceSpec,
      varCheck: false,
    },
    gateway.deps,
  );
}

function comparisonProps(nodes) {
  return Object.fromEntries(nodes.map((node) => [node.id, node.props]));
}

test('shared MIoT projector and contract distinguish enum floats from continuous floats', () => {
  const properties = fakeSpec.services[0].properties;
  assert.deepEqual(
    properties.map((property) => projectMiotComparisonDtype(property)),
    ['string', 'int', 'float', 'boolean', 'int', 'int'],
  );
  assert.deepEqual(MIOT_COMPARISON_CONTRACT.string.shortcutOperators, ['eq']);
  assert.equal(MIOT_COMPARISON_CONTRACT.string.equalityWireOperator, '=');
  assert.deepEqual(MIOT_COMPARISON_CONTRACT.int.eventWireOperators, [
    '=',
    '!=',
    '>',
    '<',
    '>=',
    '<=',
    'between',
    'include',
  ]);
  assert.deepEqual(MIOT_COMPARISON_CONTRACT.float.shortcutOperators, ['gt', 'lt', 'between']);
  assert.deepEqual(MIOT_COMPARISON_CONTRACT.float.eventWireOperators, ['>', '<', 'between']);
  assert.equal(parseFiniteDecimalLiteral(' 1.5e2 '), 150);
  assert.equal(parseFiniteDecimalLiteral(''), null);
  assert.equal(parseFiniteDecimalLiteral('0x10'), null);
  assert.equal(parseFiniteDecimalLiteral('1oops'), null);
});

test('safe-integer decimal parsing is mathematical rather than IEEE-rounded', () => {
  for (const [literal, expected] of [
    ['0', 0],
    ['-0', -0],
    ['1.0', 1],
    ['1e3', 1000],
    ['1.2300e2', 123],
    ['9.007199254740991e15', Number.MAX_SAFE_INTEGER],
    ['-9.007199254740991e15', Number.MIN_SAFE_INTEGER],
  ]) {
    assert.equal(parseSafeIntegerDecimalLiteral(literal), expected, literal);
  }
  for (const literal of [
    '1.0000000000000001',
    '9007199254740990.9',
    '1e-324',
    '9.007199254740992e15',
    '0x10',
    '1oops',
  ]) {
    assert.equal(parseSafeIntegerDecimalLiteral(literal), null, literal);
  }
});

test('large safe-integer steps are checked exactly while decimal steps retain bounded tolerance', () => {
  assert.equal(
    miotNumericOperandDomainIssue(
      { 'value-range': [0, Number.MAX_SAFE_INTEGER, 2] },
      Number.MAX_SAFE_INTEGER,
    )?.kind,
    'step',
  );
  assert.equal(miotNumericOperandDomainIssue({ 'value-range': [0, 1, 0.1] }, 0.3), null);
  assert.equal(miotNumericOperandDomainIssue({ 'value-range': [0.01, 100, 0.01] }, 99.99), null);
  assert.equal(miotNumericOperandDomainIssue({ 'value-range': [0.1, 1, 0.0001] }, 0.3), null);
  assert.equal(miotNumericOperandDomainIssue({ 'value-range': [0, 1, 0.1] }, 0.1 + 0.2), null);
  assert.equal(
    miotNumericOperandDomainIssue({ 'value-range': [0, 10_000_001, 1] }, 10_000_000.000000002)
      ?.kind,
    'step',
  );
});

test('string property shortcut creates, validates, exports, and replays without coercion', async () => {
  const source = createStatefulGateway();
  await addShortcut(source, {
    type: 'deviceInput',
    id: 'string-input',
    deviceDid: did,
    deviceProperty: 'mode',
    op: 'eq',
    propertyValue: '00123',
  });
  await addShortcut(source, {
    type: 'deviceGet',
    id: 'string-get',
    deviceDid: did,
    deviceProperty: 'mode',
    op: 'eq',
    propertyValue: '待机 模式',
  });

  const props = comparisonProps(source.state.nodes);
  assert.deepEqual(props['string-input'], {
    did,
    siid: 2,
    piid: 1,
    dtype: 'string',
    operator: '=',
    v1: '00123',
    preload: false,
  });
  assert.deepEqual(props['string-get'], {
    did,
    siid: 2,
    piid: 1,
    dtype: 'string',
    operator: '=',
    v1: '待机 模式',
  });
  assert.equal(nodeSchemaForType('deviceInput').safeParse(source.state.nodes[0]).success, true);
  assert.equal(nodeSchemaForType('deviceGet').safeParse(source.state.nodes[1]).success, true);
  assert.deepEqual(
    await validateGraph({
      graph: { id: 'rule-1', nodes: source.state.nodes },
      getDeviceSpec: source.deps.getDeviceSpec,
    }),
    [],
  );

  const exported = await exportRuleFromView(
    { id: 'rule-1', cfg: source.state.summary, nodes: source.state.nodes },
    source.deps,
  );
  assert.deepEqual(exported.warnings, []);
  const nodeCommands = exported.commands.filter((command) => command.kind === 'node-add');
  assert.deepEqual(
    nodeCommands.map((command) => flagValues(command, '--property-value')),
    [['00123'], ['待机 模式']],
  );
  assert.deepEqual(
    nodeCommands.map((command) => flagValues(command, '--threshold')),
    [[], []],
  );
  assert.deepEqual(
    nodeCommands.map((command) => flagValues(command, '--device-siid')),
    [['2'], ['2']],
  );

  const replay = createStatefulGateway();
  const replaySpec = structuredClone(fakeSpec);
  replaySpec.services.push({
    iid: 3,
    type: 'urn:miot-spec-v2:service:alternate:00007802:fake:1',
    description: 'duplicate property-name service',
    properties: [
      {
        iid: 9,
        type: 'urn:miot-spec-v2:property:mode:00000008:fake:2',
        description: 'another string mode',
        format: 'string',
        access: ['read', 'notify'],
      },
    ],
  });
  replay.deps.getDeviceSpec = async (requestedUrn) => {
    assert.equal(requestedUrn, urn);
    return replaySpec;
  };
  for (const command of nodeCommands) {
    await addShortcut(replay, shortcutFromExport(command));
  }
  assert.deepEqual(comparisonProps(replay.state.nodes), comparisonProps(source.state.nodes));
});

test('string property shortcut rejects missing, empty, and mixed comparison literals', async () => {
  const cases = [
    [{}, /requires a non-empty --property-value/],
    [{ propertyValue: '' }, /requires a non-empty --property-value/],
    [{ propertyValue: 'open', threshold: 1 }, /cannot use numeric --threshold/],
    [{ propertyValue: 'open', op: 'ne' }, /only supports --op eq/],
  ];

  for (const [extra, expected] of cases) {
    const gateway = createStatefulGateway();
    await assert.rejects(
      addShortcut(gateway, {
        type: 'deviceInput',
        deviceDid: did,
        deviceProperty: 'mode',
        ...extra,
      }),
      expected,
    );
    assert.equal(
      gateway.calls.some((call) => call.method === '/api/setGraph'),
      false,
    );
  }

  const wrongMode = createStatefulGateway();
  await assert.rejects(
    addShortcut(wrongMode, {
      type: 'deviceInput',
      deviceDid: did,
      deviceEvent: 'mixed-event',
      propertyValue: 'open',
    }),
    /only applies to deviceInput\/deviceGet property-mode shortcuts/,
  );
  assert.equal(wrongMode.calls.length, 0);

  const emptyWire = createStatefulGateway();
  await addShortcut(emptyWire, {
    type: 'deviceInput',
    deviceDid: did,
    deviceProperty: 'mode',
    propertyValue: 'open',
  });
  emptyWire.state.nodes[0].props.v1 = '';
  assert.equal(nodeSchemaForType('deviceInput').safeParse(emptyWire.state.nodes[0]).success, false);
  const emptyIssues = await validateGraph({
    graph: { id: 'rule-1', nodes: emptyWire.state.nodes },
    getDeviceSpec: emptyWire.deps.getDeviceSpec,
  });
  assert.equal(
    emptyIssues.some((issue) => issue.path === 'nodes[0].props.v1'),
    true,
  );
});

test('continuous float property shortcut keeps its numeric comparison contract', async () => {
  const gateway = createStatefulGateway();
  await addShortcut(gateway, {
    type: 'deviceGet',
    id: 'continuous-property',
    deviceDid: did,
    deviceProperty: 'temperature',
    op: 'between',
    threshold: 19.5,
    threshold2: 24.75,
  });
  assert.deepEqual(gateway.state.nodes[0].props, {
    did,
    siid: 2,
    piid: 3,
    dtype: 'float',
    operator: 'between',
    v1: 19.5,
    v2: 24.75,
  });

  const invalid = createStatefulGateway();
  await assert.rejects(
    addShortcut(invalid, {
      type: 'deviceGet',
      deviceDid: did,
      deviceProperty: 'temperature',
      op: 'eq',
      threshold: 20,
    }),
    /float property "temperature" only supports --op gt\|lt\|between/,
  );
  assert.equal(
    invalid.calls.some((call) => call.method === '/api/setGraph'),
    false,
  );
});

test('complete property/event operands survive strict JSON and rendered-shell replay', async (t) => {
  const source = createStatefulGateway();
  const shortcuts = [
    {
      type: 'deviceInput',
      id: 'property-enum-include',
      deviceDid: did,
      deviceProperty: 'enum-level',
      propertyInclude: [1, 2],
      preload: true,
    },
    {
      type: 'deviceInput',
      id: 'property-enum-include-no-preload',
      deviceDid: did,
      deviceProperty: 'enum-level',
      propertyInclude: [2, 1],
      preload: false,
    },
    {
      type: 'deviceGet',
      id: 'property-int-include',
      deviceDid: did,
      deviceProperty: 'count',
      propertyInclude: [2, 4, 6],
    },
    {
      type: 'deviceInput',
      id: 'event-enum-include',
      deviceDid: did,
      deviceEvent: 'enum-event',
      deviceEventIncludes: ['2=1,2'],
    },
    {
      type: 'deviceInput',
      id: 'event-int-between',
      deviceDid: did,
      deviceEvent: 'mixed-event',
      deviceEventBetweens: ['5=2,6'],
    },
    {
      type: 'deviceInput',
      id: 'event-float-between',
      deviceDid: did,
      deviceEvent: 'continuous-event',
      deviceEventBetweens: ['3=1.5,2.5'],
    },
  ];
  for (const shortcut of shortcuts) await addShortcut(source, shortcut);

  assert.deepEqual(comparisonProps(source.state.nodes), {
    'property-enum-include': {
      did,
      siid: 2,
      piid: 2,
      dtype: 'int',
      operator: 'include',
      v1: [1, 2],
      preload: true,
    },
    'property-enum-include-no-preload': {
      did,
      siid: 2,
      piid: 2,
      dtype: 'int',
      operator: 'include',
      v1: [2, 1],
      preload: false,
    },
    'property-int-include': {
      did,
      siid: 2,
      piid: 5,
      dtype: 'int',
      operator: 'include',
      v1: [2, 4, 6],
    },
    'event-enum-include': {
      did,
      siid: 2,
      eiid: 10,
      arguments: [{ piid: 2, dtype: 'int', operator: 'include', v1: [1, 2] }],
    },
    'event-int-between': {
      did,
      siid: 2,
      eiid: 12,
      arguments: [{ piid: 5, dtype: 'int', operator: 'between', v1: 2, v2: 6 }],
    },
    'event-float-between': {
      did,
      siid: 2,
      eiid: 11,
      arguments: [{ piid: 3, dtype: 'float', operator: 'between', v1: 1.5, v2: 2.5 }],
    },
  });
  assert.deepEqual(
    await validateGraph({
      graph: { id: 'rule-1', nodes: source.state.nodes },
      getDeviceSpec: source.deps.getDeviceSpec,
    }),
    [],
  );

  const exported = await exportRuleFromView(
    { id: 'rule-1', cfg: source.state.summary, nodes: source.state.nodes },
    source.deps,
    undefined,
    true,
  );
  assert.deepEqual(exported.warnings, []);
  const nodeCommands = exported.commands.filter((command) => command.kind === 'node-add');
  assert.deepEqual(
    nodeCommands.map((command) => flagValues(command, '--property-include')),
    [['1,2'], ['2,1'], ['2,4,6'], [], [], []],
  );
  assert.deepEqual(
    nodeCommands.map((command) => [
      command.flags.some((flag) => flag.name === '--preload'),
      command.flags.some((flag) => flag.name === '--no-preload'),
    ]),
    [
      [true, false],
      [false, true],
      [false, false],
      [false, false],
      [false, false],
      [false, false],
    ],
  );
  assert.deepEqual(
    nodeCommands.map((command) => flagValues(command, '--event-filter-include')),
    [[], [], [], ['2=1,2'], [], []],
  );
  assert.deepEqual(
    nodeCommands.map((command) => flagValues(command, '--event-filter-between')),
    [[], [], [], [], ['5=2,6'], ['3=1.5,2.5']],
  );

  const jsonPayload = JSON.parse(JSON.stringify(exported));
  const jsonReplay = createStatefulGateway();
  for (const command of jsonPayload.commands.filter((entry) => entry.kind === 'node-add')) {
    await addShortcut(jsonReplay, shortcutFromExport(command));
  }
  assert.deepEqual(jsonReplay.state.nodes, source.state.nodes);

  const shellReplay = createStatefulGateway();
  for (const shortcut of await shortcutsFromRenderedShell(exported, t)) {
    await addShortcut(shellReplay, shortcut);
  }
  assert.deepEqual(shellReplay.state.nodes, source.state.nodes);
});

test('int operands preserve MAX_SAFE_INTEGER and reject every unsafe numeric path', async () => {
  const max = Number.MAX_SAFE_INTEGER;
  const source = createStatefulGateway();
  await addShortcut(source, {
    type: 'deviceGet',
    id: 'safe-property-include',
    deviceDid: did,
    deviceProperty: 'large-count',
    propertyInclude: [max],
  });
  await addShortcut(source, {
    type: 'deviceInput',
    id: 'safe-event-include',
    deviceDid: did,
    deviceEvent: 'large-event',
    deviceEventIncludes: [`6=${max}`],
  });
  await addShortcut(source, {
    type: 'deviceInput',
    id: 'safe-event-between',
    deviceDid: did,
    deviceEvent: 'large-event',
    deviceEventBetweens: [`6=${max - 1},${max}`],
  });

  assert.deepEqual(source.state.nodes[0].props.v1, [max]);
  assert.deepEqual(source.state.nodes[1].props.arguments[0].v1, [max]);
  assert.equal(source.state.nodes[2].props.arguments[0].v1, max - 1);
  assert.equal(source.state.nodes[2].props.arguments[0].v2, max);
  assert.deepEqual(
    await validateGraph({
      graph: { id: 'rule-1', nodes: source.state.nodes },
      getDeviceSpec: source.deps.getDeviceSpec,
    }),
    [],
  );

  const exported = await exportRuleFromView(
    { id: 'rule-1', cfg: source.state.summary, nodes: source.state.nodes },
    source.deps,
    undefined,
    true,
  );
  const commands = exported.commands.filter((command) => command.kind === 'node-add');
  assert.deepEqual(flagValues(commands[0], '--property-include'), [String(max)]);
  assert.deepEqual(flagValues(commands[1], '--event-filter-include'), [`6=${max}`]);
  assert.deepEqual(flagValues(commands[2], '--event-filter-between'), [`6=${max - 1},${max}`]);

  const unsafeCases = [
    {
      type: 'deviceGet',
      deviceDid: did,
      deviceProperty: 'large-count',
      propertyInclude: [Number.MAX_SAFE_INTEGER + 1],
    },
    {
      type: 'deviceInput',
      deviceDid: did,
      deviceEvent: 'large-event',
      deviceEventIncludes: ['6=9007199254740993'],
    },
    {
      type: 'deviceInput',
      deviceDid: did,
      deviceEvent: 'large-event',
      deviceEventBetweens: ['6=0,9007199254740993'],
    },
    {
      type: 'deviceInput',
      deviceDid: did,
      deviceEvent: 'large-event',
      deviceEventArgs: ['6=9007199254740993'],
    },
  ];
  for (const shortcut of unsafeCases) {
    const rejected = createStatefulGateway();
    await assert.rejects(addShortcut(rejected, shortcut), /safe range/);
    assert.equal(
      rejected.calls.some((call) => call.method === '/api/setGraph'),
      false,
    );
  }

  const unsafeNode = structuredClone(source.state.nodes[0]);
  unsafeNode.props.v1 = [Number.MAX_SAFE_INTEGER + 1];
  const unsafeView = { id: 'rule-1', cfg: source.state.summary, nodes: [unsafeNode] };
  const issues = await validateGraph({
    graph: { id: 'rule-1', nodes: [unsafeNode] },
    getDeviceSpec: source.deps.getDeviceSpec,
  });
  assert.equal(
    issues.some((entry) => entry.path === 'nodes[0].props.v1'),
    true,
  );
  await assert.rejects(
    exportRuleFromView(unsafeView, source.deps, undefined, true),
    /safe integer|safe-integer v1 array/,
  );
});

test('integer shortcuts reject decimal tokens that only become integers after IEEE rounding', async () => {
  const exact = createStatefulGateway();
  await addShortcut(exact, {
    type: 'deviceGet',
    id: 'exact-scientific-int',
    deviceDid: did,
    deviceProperty: 'large-count',
    op: 'gt',
    threshold: Number.MAX_SAFE_INTEGER,
    thresholdLiteral: '9.007199254740991e15',
  });
  assert.equal(exact.state.nodes[0].props.v1, Number.MAX_SAFE_INTEGER);

  for (const raw of ['1.0000000000000001', '9007199254740990.9', '1e-324']) {
    const property = createStatefulGateway();
    await assert.rejects(
      addShortcut(property, {
        type: 'deviceGet',
        deviceDid: did,
        deviceProperty: 'large-count',
        op: 'gt',
        threshold: Number(raw),
        thresholdLiteral: raw,
      }),
      /exact safe integer --threshold literal/,
      raw,
    );

    for (const eventShortcut of [
      { deviceEventArgs: [`6>${raw}`] },
      { deviceEventIncludes: [`6=${raw}`] },
      { deviceEventBetweens: [`6=0,${raw}`] },
    ]) {
      const event = createStatefulGateway();
      await assert.rejects(
        addShortcut(event, {
          type: 'deviceInput',
          deviceDid: did,
          deviceEvent: 'large-event',
          ...eventShortcut,
        }),
        /safe range/,
        `${raw}: ${JSON.stringify(eventShortcut)}`,
      );
    }
  }

  const roundedBoolean = createStatefulGateway();
  await assert.rejects(
    addShortcut(roundedBoolean, {
      type: 'deviceGet',
      deviceDid: did,
      deviceProperty: 'on',
      op: 'eq',
      threshold: Number('1.0000000000000001'),
      thresholdLiteral: '1.0000000000000001',
    }),
    /requires an exact 0 or 1 --threshold literal/,
  );
});

test('--force-out-of-range survives injected spec validation and strict replay without weakening closed enums', async () => {
  const source = createStatefulGateway();
  await addShortcut(source, {
    type: 'deviceGet',
    id: 'forced-range',
    deviceDid: did,
    deviceProperty: 'count',
    op: 'gt',
    threshold: 12,
    thresholdLiteral: '12',
    forceOutOfRange: true,
  });
  assert.equal(source.state.nodes[0].props.v1, 12);

  const ordinaryIssues = await validateGraph({
    graph: { id: 'rule-1', nodes: source.state.nodes },
    getDeviceSpec: source.deps.getDeviceSpec,
  });
  assert.equal(
    ordinaryIssues.some((entry) => entry.message.includes('outside MIoT value-range')),
    true,
  );
  assert.deepEqual(
    await validateGraph({
      graph: { id: 'rule-1', nodes: source.state.nodes },
      getDeviceSpec: source.deps.getDeviceSpec,
      forceOutOfRangeNodeIds: new Set(['forced-range']),
    }),
    [],
  );

  for (const shortcut of [
    {
      type: 'deviceGet',
      deviceDid: did,
      deviceProperty: 'count',
      propertyInclude: [3],
      forceOutOfRange: true,
    },
    {
      type: 'deviceGet',
      deviceDid: did,
      deviceProperty: 'count',
      op: 'between',
      threshold: 2,
      threshold2: 12,
      forceOutOfRange: true,
    },
  ]) {
    const gateway = createStatefulGateway();
    await addShortcut(gateway, shortcut);
    assert.equal(gateway.state.nodes.length, 1);
  }

  const closedEnum = createStatefulGateway();
  await assert.rejects(
    addShortcut(closedEnum, {
      type: 'deviceGet',
      deviceDid: did,
      deviceProperty: 'enum-level',
      propertyInclude: [3],
      forceOutOfRange: true,
    }),
    /not in MIoT value-list/,
  );

  const exported = await exportRuleFromView(
    { id: 'rule-1', cfg: source.state.summary, nodes: source.state.nodes },
    source.deps,
    undefined,
    true,
  );
  assert.deepEqual(exported.warnings, []);
  const command = exported.commands.find((entry) => entry.kind === 'node-add');
  assert.ok(command);
  assert.equal(command.flags.filter((flag) => flag.name === '--force-out-of-range').length, 1);

  const replay = createStatefulGateway();
  await addShortcut(replay, shortcutFromExport(command));
  assert.deepEqual(replay.state.nodes[0].props, source.state.nodes[0].props);
});

test('raw validation rejects empty includes, unsafe/non-finite operands, reversed bounds, and duplicate event piids', async () => {
  const source = createStatefulGateway();
  await addShortcut(source, {
    type: 'deviceGet',
    id: 'property-include',
    deviceDid: did,
    deviceProperty: 'count',
    propertyInclude: [2],
  });
  await addShortcut(source, {
    type: 'deviceInput',
    id: 'event-int',
    deviceDid: did,
    deviceEvent: 'large-event',
    deviceEventArgs: ['6>1'],
  });
  await addShortcut(source, {
    type: 'deviceInput',
    id: 'event-int-between',
    deviceDid: did,
    deviceEvent: 'large-event',
    deviceEventBetweens: ['6=1,2'],
  });
  await addShortcut(source, {
    type: 'deviceInput',
    id: 'event-float-between',
    deviceDid: did,
    deviceEvent: 'continuous-event',
    deviceEventBetweens: ['3=1,2'],
  });

  const cases = [];
  const emptyInclude = structuredClone(source.state.nodes[0]);
  emptyInclude.props.v1 = [];
  cases.push([emptyInclude, 'nodes[0].props.v1']);

  const unsafeScalar = structuredClone(source.state.nodes[1]);
  unsafeScalar.props.arguments[0].v1 = Number.MAX_SAFE_INTEGER + 1;
  cases.push([unsafeScalar, 'nodes[0].props.arguments[0].v1']);

  const unsafeInclude = structuredClone(source.state.nodes[1]);
  unsafeInclude.props.arguments[0].operator = 'include';
  unsafeInclude.props.arguments[0].v1 = [Number.MAX_SAFE_INTEGER + 1];
  cases.push([unsafeInclude, 'nodes[0].props.arguments[0].v1']);

  const reversedInt = structuredClone(source.state.nodes[2]);
  reversedInt.props.arguments[0].v1 = 3;
  reversedInt.props.arguments[0].v2 = 2;
  cases.push([reversedInt, 'nodes[0].props.arguments[0].v2']);

  const nonFiniteFloat = structuredClone(source.state.nodes[3]);
  nonFiniteFloat.props.arguments[0].v1 = Number.POSITIVE_INFINITY;
  cases.push([nonFiniteFloat, 'nodes[0].props.arguments[0].v1']);

  const reversedFloat = structuredClone(source.state.nodes[3]);
  reversedFloat.props.arguments[0].v1 = 3;
  reversedFloat.props.arguments[0].v2 = 2;
  cases.push([reversedFloat, 'nodes[0].props.arguments[0].v2']);

  const duplicate = structuredClone(source.state.nodes[1]);
  duplicate.props.arguments.push(structuredClone(duplicate.props.arguments[0]));
  cases.push([duplicate, 'nodes[0].props.arguments[1].piid']);

  for (const [node, expectedPath] of cases) {
    const issues = await validateGraph({
      graph: { id: 'rule-1', nodes: [node] },
      getDeviceSpec: source.deps.getDeviceSpec,
    });
    assert.equal(
      issues.some((entry) => entry.path === expectedPath),
      true,
      `${expectedPath}: ${JSON.stringify(issues)}`,
    );
  }
});

test('complete operands reject dtype, value-list, range, step, order, and duplicate-piid errors', async () => {
  const cases = [
    [
      {
        type: 'deviceInput',
        deviceDid: did,
        deviceProperty: 'temperature',
        propertyInclude: [1, 2],
      },
      /float property "temperature" does not support --property-include/,
    ],
    [
      {
        type: 'deviceInput',
        deviceDid: did,
        deviceProperty: 'enum-level',
        propertyInclude: [1, 3],
      },
      /not in MIoT value-list/,
    ],
    [
      {
        type: 'deviceGet',
        deviceDid: did,
        deviceProperty: 'count',
        propertyInclude: [2, 3],
      },
      /not aligned to MIoT value-range step/,
    ],
    [
      {
        type: 'deviceGet',
        deviceDid: did,
        deviceProperty: 'count',
        op: 'between',
        threshold: 2,
        threshold2: 12,
      },
      /outside MIoT value-range/,
    ],
    [
      {
        type: 'deviceGet',
        deviceDid: did,
        deviceProperty: 'count',
        op: 'between',
        threshold: 6,
        threshold2: 2,
      },
      /requires --threshold 6 <= --threshold2 2/,
    ],
    [
      {
        type: 'deviceInput',
        deviceDid: did,
        deviceEvent: 'continuous-event',
        deviceEventIncludes: ['3=1,2'],
      },
      /float event arg piid=3 does not support include/,
    ],
    [
      {
        type: 'deviceInput',
        deviceDid: did,
        deviceEvent: 'enum-event',
        deviceEventIncludes: ['2=1,3'],
      },
      /not in MIoT value-list/,
    ],
    [
      {
        type: 'deviceInput',
        deviceDid: did,
        deviceEvent: 'continuous-event',
        deviceEventBetweens: ['3=1.5,2.6'],
      },
      /not aligned to MIoT value-range step/,
    ],
    [
      {
        type: 'deviceInput',
        deviceDid: did,
        deviceEvent: 'mixed-event',
        deviceEventBetweens: ['5=6,2'],
      },
      /lower bound 6 must be <= upper bound 2/,
    ],
    [
      {
        type: 'deviceInput',
        deviceDid: did,
        deviceEvent: 'enum-event',
        deviceEventArgs: ['2=1'],
        deviceEventIncludes: ['2=1,2'],
      },
      /piid=2 specified more than once/,
    ],
  ];

  for (const [shortcut, expected] of cases) {
    const gateway = createStatefulGateway();
    await assert.rejects(addShortcut(gateway, shortcut), expected);
    assert.equal(
      gateway.calls.some((call) => call.method === '/api/setGraph'),
      false,
    );
  }

  const rawGraph = createStatefulGateway();
  await addShortcut(rawGraph, {
    type: 'deviceInput',
    id: 'raw-property-domain',
    deviceDid: did,
    deviceProperty: 'enum-level',
    propertyInclude: [1, 2],
  });
  await addShortcut(rawGraph, {
    type: 'deviceInput',
    id: 'raw-event-domain',
    deviceDid: did,
    deviceEvent: 'continuous-event',
    deviceEventBetweens: ['3=1.5,2.5'],
  });
  rawGraph.state.nodes[0].props.v1[1] = 3;
  rawGraph.state.nodes[1].props.arguments[0].v2 = 2.6;
  const issues = await validateGraph({
    graph: { id: 'rule-1', nodes: rawGraph.state.nodes },
    getDeviceSpec: rawGraph.deps.getDeviceSpec,
  });
  assert.equal(
    issues.some(
      (entry) => entry.path === 'nodes[0].props.v1[1]' && entry.message.includes('value-list'),
    ),
    true,
  );
  assert.equal(
    issues.some(
      (entry) => entry.path === 'nodes[1].props.arguments[0].v2' && entry.message.includes('step'),
    ),
    true,
  );
});

test('strict round-trip rejects every remaining comparison semantic-loss warning', async () => {
  const source = createStatefulGateway();
  await addShortcut(source, {
    type: 'deviceInput',
    id: 'future-filter',
    deviceDid: did,
    deviceEvent: 'enum-event',
    deviceEventArgs: ['2=1'],
  });
  source.state.nodes[0].props.arguments[0].operator = 'future-operator';

  const view = { id: 'rule-1', cfg: source.state.summary, nodes: source.state.nodes };
  const permissive = await exportRuleFromView(view, source.deps);
  assert.equal(
    permissive.warnings.some((warning) => warning.includes('unsupported operator')),
    true,
  );
  await assert.rejects(
    exportRuleFromView(view, source.deps, undefined, true),
    /strict round-trip cannot preserve node future-filter/,
  );

  const scalarProperty = createStatefulGateway();
  await addShortcut(scalarProperty, {
    type: 'deviceGet',
    id: 'scalar-int-equality',
    deviceDid: did,
    deviceProperty: 'count',
    op: 'eq',
    threshold: 2,
  });
  scalarProperty.state.nodes[0].props.operator = '=';
  scalarProperty.state.nodes[0].props.v1 = 2;
  const scalarView = {
    id: 'rule-1',
    cfg: scalarProperty.state.summary,
    nodes: scalarProperty.state.nodes,
  };
  await assert.rejects(
    exportRuleFromView(scalarView, scalarProperty.deps, undefined, true),
    /scalar int operator "=" cannot round-trip exactly/,
  );

  const malformed = createStatefulGateway();
  await addShortcut(malformed, {
    type: 'deviceInput',
    id: 'duplicate-event-piid',
    deviceDid: did,
    deviceEvent: 'mixed-event',
    deviceEventArgs: ['4=1'],
  });
  await addShortcut(malformed, {
    type: 'deviceGet',
    id: 'invalid-bool-operator',
    deviceDid: did,
    deviceProperty: 'on',
    op: 'eq',
    threshold: 1,
  });
  await addShortcut(malformed, {
    type: 'deviceGet',
    id: 'invalid-float-operator',
    deviceDid: did,
    deviceProperty: 'temperature',
    op: 'gt',
    threshold: 1,
  });

  const duplicate = structuredClone(malformed.state.nodes[0]);
  duplicate.props.arguments.push(structuredClone(duplicate.props.arguments[0]));
  const invalidBool = structuredClone(malformed.state.nodes[1]);
  invalidBool.props.operator = '!=';
  const invalidFloat = structuredClone(malformed.state.nodes[2]);
  invalidFloat.props.operator = '>=';
  const futureProps = structuredClone(malformed.state.nodes[1]);
  futureProps.props.futureComparisonMode = 'new-gateway-mode';

  for (const [node, expected] of [
    [duplicate, /duplicate event argument piid/],
    [invalidBool, /modeled schema|invalid for projected dtype/],
    [invalidFloat, /modeled schema|invalid for projected dtype/],
    [futureProps, /futureComparisonMode/],
  ]) {
    await assert.rejects(
      exportRuleFromView(
        { id: 'rule-1', cfg: malformed.state.summary, nodes: [node] },
        malformed.deps,
        undefined,
        true,
      ),
      expected,
    );
  }
});

test('float value-list event args validate as int while continuous floats remain float', async () => {
  const gateway = createStatefulGateway();
  await addShortcut(gateway, {
    type: 'deviceInput',
    id: 'enum-event',
    deviceDid: did,
    deviceEvent: 'enum-event',
    deviceEventArgs: ['2=1'],
  });
  await addShortcut(gateway, {
    type: 'deviceInput',
    id: 'continuous-event',
    deviceDid: did,
    deviceEvent: 'continuous-event',
    deviceEventArgs: ['3>1.5'],
  });

  const [enumNode, continuousNode] = gateway.state.nodes;
  assert.deepEqual(enumNode.props.arguments, [{ piid: 2, dtype: 'int', operator: '=', v1: 1 }]);
  assert.deepEqual(continuousNode.props.arguments, [
    { piid: 3, dtype: 'float', operator: '>', v1: 1.5 },
  ]);
  assert.deepEqual(
    await validateGraph({
      graph: { id: 'rule-1', nodes: gateway.state.nodes },
      getDeviceSpec: gateway.deps.getDeviceSpec,
    }),
    [],
  );

  const wrongEnum = structuredClone(enumNode);
  wrongEnum.props.arguments[0].dtype = 'float';
  const enumIssues = await validateGraph({
    graph: { id: 'rule-1', nodes: [wrongEnum] },
    getDeviceSpec: gateway.deps.getDeviceSpec,
  });
  assert.equal(
    enumIssues.some(
      (issue) =>
        issue.path === 'nodes[0].props.arguments[0]' &&
        issue.message.includes('format float with a non-empty value-list') &&
        issue.message.includes('expects dtype "int"'),
    ),
    true,
  );

  const wrongContinuous = structuredClone(continuousNode);
  wrongContinuous.props.arguments[0].dtype = 'int';
  const issues = await validateGraph({
    graph: { id: 'rule-1', nodes: [wrongContinuous] },
    getDeviceSpec: gateway.deps.getDeviceSpec,
  });
  assert.equal(
    issues.some(
      (issue) =>
        issue.path === 'nodes[0].props.arguments[0]' &&
        issue.message.includes('expects dtype "float"'),
    ),
    true,
  );
});

test('event-filter parser preserves bool, string, and integer contracts and rejects numeric coercion', async () => {
  const gateway = createStatefulGateway();
  await addShortcut(gateway, {
    type: 'deviceInput',
    id: 'mixed-event',
    deviceDid: did,
    deviceEvent: 'mixed-event',
    deviceEventArgs: ['1=open', '4=1', '5>=2'],
  });
  assert.deepEqual(gateway.state.nodes[0].props.arguments, [
    { piid: 1, dtype: 'string', operator: '=', v1: 'open' },
    { piid: 4, dtype: 'boolean', operator: '=', v1: true },
    { piid: 5, dtype: 'int', operator: '>=', v1: 2 },
  ]);

  for (const [raw, message] of [
    ['2=', /must be <piid><op><v1>/],
    ['2=0x10', /int v1 must be an integer/],
    ['2=1oops', /int v1 must be an integer/],
  ]) {
    const invalid = createStatefulGateway();
    await assert.rejects(
      addShortcut(invalid, {
        type: 'deviceInput',
        deviceDid: did,
        deviceEvent: 'enum-event',
        deviceEventArgs: [raw],
      }),
      message,
    );
    assert.equal(
      invalid.calls.some((call) => call.method === '/api/setGraph'),
      false,
    );
  }
});
