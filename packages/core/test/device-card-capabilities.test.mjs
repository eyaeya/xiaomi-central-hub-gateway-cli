import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ConfigError,
  addNode,
  exportRuleFromView,
  lintGraph,
  validateGraph,
} from '../dist/index.js';

const baseUrl = 'http://device-capabilities.invalid';
const agentStartedAt = '2026-07-21T00:00:00.000Z';
const did = 'device-capability-fixture';
const urn = 'urn:miot-spec-v2:device:test-device:0000A001:capability:1';

const property = (iid, name, access) => ({
  iid,
  type: `urn:miot-spec-v2:property:${name}:00000001:capability:1`,
  description: name,
  format: 'bool',
  access,
});

const spec = {
  type: urn,
  description: 'device card capability fixture',
  services: [
    {
      iid: 2,
      type: 'urn:miot-spec-v2:service:test-service:00007801:capability:1',
      description: 'fixture service',
      properties: [
        property(1, 'notify-only', ['notify']),
        property(2, 'read-only', ['read']),
        property(3, 'read-notify', ['read', 'notify']),
        property(4, 'write-only', ['write']),
      ],
      events: [
        {
          iid: 10,
          type: 'urn:miot-spec-v2:event:changed:00005001:capability:1',
          description: 'changed',
          arguments: [3],
        },
      ],
    },
  ],
};

function fakeDevice(pushAvailable) {
  return {
    specV2Access: true,
    specV3Access: false,
    online: true,
    pushAvailable,
    name: 'capability fixture',
    model: 'test.capability.v1',
    modelName: 'Capability Fixture',
    urn,
    roomId: 'room-1',
    roomName: 'Test Room',
    icon: '',
  };
}

function summary(id) {
  return {
    id,
    enable: false,
    uiType: 'rule',
    userData: {
      name: 'capability test',
      transform: { x: 0, y: 0, scale: 1, rotate: 0 },
      lastUpdateTime: 0,
      version: 0,
    },
  };
}

function createGateway({ pushAvailable = true, id = 'rule174' } = {}) {
  const state = { summary: summary(id), nodes: [] };
  const calls = [];
  const deps = {
    baseUrl,
    store: {
      read: async () => ({
        host: baseUrl,
        pid: 174,
        socketPath: '/tmp/xgg-capability-unused.sock',
        agentStartedAt,
        agentVersion: '0.1.4',
        lastValidatedAt: agentStartedAt,
      }),
    },
    ipcClient: () => ({
      request: async (method, params, options) => {
        if (method === '$ping') return { host: baseUrl, agentStartedAt };
        if (method === '$mutation.acquire') return { leaseId: 'capability-lease' };
        if (method === '$mutation.release' || method === '$mutation.fence') return { ok: true };
        calls.push({ method, params, options });
        if (method === '/api/getDevList') {
          return { devList: { [did]: fakeDevice(pushAvailable) } };
        }
        if (method === '/api/getVarList') {
          return params.scope === 'global'
            ? {
                captured: {
                  type: 'number',
                  value: 0,
                  userData: { name: 'Captured' },
                },
              }
            : {};
        }
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
  return { calls, deps, state };
}

async function addShortcut(gateway, shortcut) {
  return addNode(
    {
      ruleId: gateway.state.summary.id,
      shortcut,
      getDeviceSpec: async (requestedUrn) => {
        assert.equal(requestedUrn, urn);
        return spec;
      },
      varCheck: false,
    },
    gateway.deps,
  );
}

const typedCapabilityCases = [
  {
    type: 'deviceInput',
    supportedProperty: 'notify-only',
    unsupportedProperty: 'read-only',
    required: 'notify',
    extra: { op: 'eq', threshold: 1 },
  },
  {
    type: 'deviceInputSetVar',
    supportedProperty: 'notify-only',
    unsupportedProperty: 'read-only',
    required: 'notify',
    extra: { varScope: 'global', varId: 'captured' },
  },
  {
    type: 'deviceGet',
    supportedProperty: 'read-only',
    unsupportedProperty: 'notify-only',
    required: 'read',
    extra: { op: 'eq', threshold: 1 },
  },
  {
    type: 'deviceGetSetVar',
    supportedProperty: 'read-only',
    unsupportedProperty: 'notify-only',
    required: 'read',
    extra: { varScope: 'global', varId: 'captured' },
  },
  {
    type: 'deviceOutput',
    supportedProperty: 'write-only',
    unsupportedProperty: 'read-only',
    required: 'write',
    extra: { value: 'true' },
  },
];

test('typed property cards require their editor-selected MIoT access before graph write', async () => {
  for (const entry of typedCapabilityCases) {
    const rejected = createGateway();
    await assert.rejects(
      addShortcut(rejected, {
        type: entry.type,
        id: `${entry.type}Rejected`,
        deviceDid: did,
        deviceProperty: entry.unsupportedProperty,
        ...entry.extra,
      }),
      (error) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, new RegExp(`requires MIoT access "${entry.required}"`));
        return true;
      },
      entry.type,
    );
    assert.equal(
      rejected.calls.some(({ method }) => method === '/api/setGraph'),
      false,
      `${entry.type} must fail before setGraph`,
    );

    const accepted = createGateway();
    await addShortcut(accepted, {
      type: entry.type,
      id: `${entry.type}Accepted`,
      deviceDid: did,
      deviceProperty: entry.supportedProperty,
      ...entry.extra,
    });
    assert.equal(accepted.state.nodes.length, 1, entry.type);
  }
});

test('preload stays a startup toggle and neither manufactures nor widens property access', async () => {
  for (const type of ['deviceInput', 'deviceInputSetVar']) {
    const accepted = createGateway();
    await addShortcut(accepted, {
      type,
      id: `${type}PreloadNotifyOnly`,
      deviceDid: did,
      deviceProperty: 'notify-only',
      preload: true,
      ...(type === 'deviceInput'
        ? { op: 'eq', threshold: 1 }
        : { varScope: 'global', varId: 'captured' }),
    });
    assert.equal(accepted.state.nodes[0].props.preload, true);

    const rejected = createGateway();
    await assert.rejects(
      addShortcut(rejected, {
        type,
        id: `${type}PreloadReadOnly`,
        deviceDid: did,
        deviceProperty: 'read-only',
        preload: true,
        ...(type === 'deviceInput'
          ? { op: 'eq', threshold: 1 }
          : { varScope: 'global', varId: 'captured' }),
      }),
      /requires MIoT access "notify"/,
    );
  }
});

const pushSourceShortcuts = [
  {
    type: 'deviceInput',
    id: 'inputProperty',
    deviceDid: did,
    deviceProperty: 'notify-only',
    op: 'eq',
    threshold: 1,
  },
  { type: 'deviceInput', id: 'inputEvent', deviceDid: did, deviceEvent: 'changed' },
  {
    type: 'deviceInputSetVar',
    id: 'captureProperty',
    deviceDid: did,
    deviceProperty: 'notify-only',
    varScope: 'global',
    varId: 'captured',
  },
  {
    type: 'deviceInputSetVar',
    id: 'captureEvent',
    deviceDid: did,
    deviceEvent: 'changed',
    varScope: 'global',
    varId: 'captured',
  },
];

test('typed property and event push sources fail closed with a narrow explicit probe override', async () => {
  for (const shortcut of pushSourceShortcuts) {
    const rejected = createGateway({ pushAvailable: false });
    await assert.rejects(addShortcut(rejected, shortcut), /pushAvailable=false.*--allow-no-push/s);
    assert.equal(
      rejected.calls.some(({ method }) => method === '/api/setGraph'),
      false,
    );

    const probe = createGateway({ pushAvailable: false });
    await addShortcut(probe, { ...shortcut, allowNoPush: true });
    assert.equal(probe.state.nodes.length, 1);
    assert.equal('allowNoPush' in probe.state.nodes[0], false, 'override must not persist');
    assert.equal('allowNoPush' in probe.state.nodes[0].props, false, 'override must not persist');
  }

  const missingNotify = createGateway({ pushAvailable: false });
  await assert.rejects(
    addShortcut(missingNotify, {
      type: 'deviceInput',
      id: 'overrideCannotWidenAccess',
      deviceDid: did,
      deviceProperty: 'read-only',
      op: 'eq',
      threshold: 1,
      allowNoPush: true,
    }),
    /requires MIoT access "notify"/,
  );

  const wrongCard = createGateway({ pushAvailable: false });
  await assert.rejects(
    addShortcut(wrongCard, {
      type: 'deviceGet',
      id: 'overrideWrongCard',
      deviceDid: did,
      deviceProperty: 'read-only',
      op: 'eq',
      threshold: 1,
      allowNoPush: true,
    }),
    /allowNoPush only applies to deviceInput\/deviceInputSetVar/,
  );
  assert.deepEqual(wrongCard.calls, []);
});

function cfg(name) {
  return {
    urn,
    pos: { x: 0, y: 0, width: 400, height: 200 },
    name,
    version: 1,
  };
}

function persistedNodes({ mismatch = false } = {}) {
  const inputPiid = mismatch ? 2 : 1;
  const getPiid = mismatch ? 1 : 2;
  const outputPiid = mismatch ? 2 : 4;
  return [
    {
      id: 'persistedInput',
      type: 'deviceInput',
      cfg: cfg('deviceInput'),
      inputs: {},
      outputs: { output: [] },
      props: {
        did,
        siid: 2,
        piid: inputPiid,
        dtype: 'boolean',
        operator: '=',
        v1: true,
        preload: true,
      },
    },
    {
      id: 'persistedCapture',
      type: 'deviceInputSetVar',
      cfg: cfg('deviceInputSetVar'),
      inputs: {},
      outputs: { output: [] },
      props: {
        did,
        siid: 2,
        piid: inputPiid,
        dtype: 'number',
        scope: 'global',
        id: 'captured',
        preload: true,
      },
    },
    {
      id: 'persistedGet',
      type: 'deviceGet',
      cfg: cfg('deviceGet'),
      inputs: { input: null },
      outputs: { output: [], output2: [] },
      props: {
        did,
        siid: 2,
        piid: getPiid,
        dtype: 'boolean',
        operator: '=',
        v1: true,
      },
    },
    {
      id: 'persistedGetCapture',
      type: 'deviceGetSetVar',
      cfg: cfg('deviceGetSetVar'),
      inputs: { input: null },
      outputs: { output: [] },
      props: {
        did,
        siid: 2,
        piid: getPiid,
        dtype: 'number',
        scope: 'global',
        id: 'captured',
      },
    },
    {
      id: 'persistedOutput',
      type: 'deviceOutput',
      cfg: cfg('deviceOutput'),
      inputs: { trigger: null },
      outputs: { output: [] },
      props: { did, siid: 2, piid: outputPiid, value: true },
    },
  ];
}

test('spec-aware validation reports path-specific persisted access capability mismatches', async () => {
  const issues = await validateGraph({
    graph: { id: 'rule174', nodes: persistedNodes({ mismatch: true }) },
    getDeviceSpec: async () => spec,
  });
  const capabilityIssues = issues.filter((entry) => entry.message.includes('卡片能力不匹配'));
  assert.deepEqual(
    capabilityIssues.map(({ path }) => path),
    [
      'nodes[0].props.piid',
      'nodes[1].props.piid',
      'nodes[2].props.piid',
      'nodes[3].props.piid',
      'nodes[4].props.piid',
    ],
  );
  assert.deepEqual(
    capabilityIssues.map(({ message }) => /access "(notify|read|write)"/.exec(message)?.[1]),
    ['notify', 'notify', 'read', 'read', 'write'],
  );

  assert.deepEqual(
    await validateGraph({
      graph: { id: 'rule174', nodes: persistedNodes() },
      getDeviceSpec: async () => spec,
    }),
    [],
  );
});

function exportDeps(gateway) {
  return {
    ...gateway.deps,
    getDeviceSpec: async (requestedUrn) => {
      assert.equal(requestedUrn, urn);
      return spec;
    },
  };
}

test('strict export rejects persisted access mismatches that typed replay cannot recreate', async () => {
  const gateway = createGateway();
  const view = {
    id: 'rule174',
    cfg: summary('rule174'),
    nodes: persistedNodes({ mismatch: true }),
  };
  await assert.rejects(
    exportRuleFromView(view, exportDeps(gateway), undefined, true),
    /requires MIoT access "notify".*typed replay will reject/i,
  );

  const permissive = await exportRuleFromView(view, exportDeps(gateway), undefined, false);
  const accessWarnings = permissive.warnings.filter((warning) =>
    warning.includes('requires MIoT access'),
  );
  assert.equal(accessWarnings.length, 5, JSON.stringify(permissive.warnings));
  assert.deepEqual(
    accessWarnings.map((warning) => /access "(notify|read|write)"/.exec(warning)?.[1]),
    ['notify', 'notify', 'read', 'read', 'write'],
  );
});

function persistedPushNodes() {
  return [
    ...persistedNodes().slice(0, 2),
    {
      id: 'persistedInputEvent',
      type: 'deviceInput',
      cfg: cfg('deviceInput'),
      inputs: {},
      outputs: { output: [] },
      props: { did, siid: 2, eiid: 10, arguments: [] },
    },
    {
      id: 'persistedCaptureEvent',
      type: 'deviceInputSetVar',
      cfg: cfg('deviceInputSetVar'),
      inputs: {},
      outputs: { output: [] },
      props: {
        did,
        siid: 2,
        eiid: 10,
        arguments: [{ piid: 3, dtype: 'number', scope: 'global', id: 'captured' }],
      },
    },
  ];
}

test('no-push sources require permissive replay to carry explicit transient probe intent', async () => {
  const noPush = createGateway({ pushAvailable: false });
  const view = { id: 'rule174', cfg: summary('rule174'), nodes: persistedPushNodes() };
  await assert.rejects(
    exportRuleFromView(view, exportDeps(noPush), undefined, true),
    /pushAvailable=false.*strict round-trip refuses/i,
  );

  const permissive = await exportRuleFromView(view, exportDeps(noPush), undefined, false);
  const sourceCommands = permissive.commands.filter(
    (command) =>
      command.kind === 'node-add' &&
      (command.type === 'deviceInput' || command.type === 'deviceInputSetVar'),
  );
  assert.equal(sourceCommands.length, 4);
  assert.ok(
    sourceCommands.every((command) =>
      command.flags.some((flag) => flag.name === '--allow-no-push'),
    ),
  );
  assert.equal(
    permissive.warnings.filter((warning) => warning.includes('pushAvailable=false')).length,
    4,
  );
  assert.equal(
    noPush.calls.filter(({ method }) => method === '/api/getDevList').length,
    2,
    'strict and permissive exports each fetch one cached device inventory',
  );

  const pushCapable = createGateway({ pushAvailable: true });
  const strict = await exportRuleFromView(view, exportDeps(pushCapable), undefined, true);
  assert.ok(
    strict.commands
      .filter(
        (command) =>
          command.kind === 'node-add' &&
          (command.type === 'deviceInput' || command.type === 'deviceInputSetVar'),
      )
      .every((command) => !command.flags.some((flag) => flag.name === '--allow-no-push')),
  );
});

test('spec-aware live validation diagnoses push-unavailable property and event sources by DID path', async () => {
  let deviceReads = 0;
  const issues = await validateGraph({
    graph: { id: 'rule174', nodes: persistedPushNodes() },
    getDeviceSpec: async () => spec,
    getDevice: async (requestedDid) => {
      assert.equal(requestedDid, did);
      deviceReads += 1;
      return { pushAvailable: false };
    },
  });
  const pushIssues = issues.filter((entry) => entry.message.includes('pushAvailable=false'));
  assert.equal(deviceReads, 1, 'same-DID inventory checks should share one read');
  assert.deepEqual(
    pushIssues.map(({ path }) => path),
    ['nodes[0].props.did', 'nodes[1].props.did', 'nodes[2].props.did', 'nodes[3].props.did'],
  );
  assert.ok(pushIssues.every((entry) => entry.message.includes('not persisted')));
});

test('offline lint keeps transient probe intent visible for every persisted push source', () => {
  const issues = lintGraph({
    graph: { id: 'rule174', nodes: persistedPushNodes() },
    devices: { [did]: { pushAvailable: false } },
  });
  assert.deepEqual(
    issues
      .filter((entry) => entry.message.includes('pushAvailable=false'))
      .map(({ severity, path }) => ({ severity, path })),
    [
      { severity: 'warn', path: 'nodes[0].props.did' },
      { severity: 'warn', path: 'nodes[1].props.did' },
      { severity: 'warn', path: 'nodes[2].props.did' },
      { severity: 'warn', path: 'nodes[3].props.did' },
    ],
  );
});
