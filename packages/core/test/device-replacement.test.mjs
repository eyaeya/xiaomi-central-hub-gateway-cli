import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  evaluateDeviceReplacementCandidate,
  planDeviceReplacement,
  replaceDevice,
  replaceDeviceNode,
  resolveDeviceReplacementSource,
  selectDeviceReplacementMapping,
} from '../dist/index.js';

const baseUrl = 'http://gateway.invalid';
const startedAt = '2026-07-19T00:00:00.000Z';
const ruleId = '107';
const sourceDid = 'source-device';
const targetDid = 'target-device';
const sourceUrn = 'urn:miot-spec-v2:device:fixture-source:0000A001:source:1';
const targetUrn = 'urn:miot-spec-v2:device:fixture-target:0000A002:target:9';

const position = (width = 584, height = 206) => ({ x: 11, y: 22, width, height });

function service({ siid = 2, vendor = 'source', version = 1, rangeStep = 1, list = [1, 2] } = {}) {
  return {
    iid: siid,
    type: `urn:miot-spec-v2:service:fixture-service:00007801:${vendor}:${version}`,
    description: `fixture service ${vendor}`,
    properties: [
      {
        iid: 1,
        type: `urn:miot-spec-v2:property:level:00000001:${vendor}:${version}`,
        description: 'level',
        format: 'uint8',
        access: ['read', 'write', 'notify'],
        'value-range': [0, 100, rangeStep],
      },
      {
        iid: 2,
        type: `urn:miot-spec-v2:property:mode:00000002:${vendor}:${version}`,
        description: 'mode',
        format: 'float',
        access: ['read', 'write', 'notify'],
        'value-list': list.map((value) => ({ value, description: String(value) })),
      },
    ],
    events: [
      {
        iid: vendor === 'source' ? 5 : 15,
        type: `urn:miot-spec-v2:event:changed:00005001:${vendor}:${version}`,
        description: 'changed',
        arguments: [1, 2],
      },
    ],
    actions: [
      {
        iid: vendor === 'source' ? 6 : 16,
        type: `urn:miot-spec-v2:action:apply:00002801:${vendor}:${version}`,
        description: 'apply',
        in: [1, 2],
        out: [],
      },
    ],
  };
}

function spec(urn, options) {
  return {
    type: urn,
    description: urn === sourceUrn ? 'source fixture' : 'target fixture',
    services: [service(options)],
  };
}

const sourceSpec = spec(sourceUrn);
const compatibleTargetSpec = spec(targetUrn, { siid: 9, vendor: 'target', version: 9 });

function mutatedTargetSpec(mutate) {
  const target = structuredClone(compatibleTargetSpec);
  mutate(target.services[0]);
  return target;
}

function device(did, urn, name, overrides = {}) {
  return {
    did,
    specV2Access: true,
    specV3Access: false,
    online: true,
    pushAvailable: true,
    name,
    model: `fixture.${did}`,
    modelName: name,
    urn,
    roomId: 'room',
    roomName: 'Room',
    icon: '',
    ...overrides,
  };
}

const sourceDevice = device(sourceDid, sourceUrn, 'Source');
const targetDevice = device(targetDid, targetUrn, 'Target');

function cfg(type, urn = sourceUrn, width = 584, height = 206) {
  return { urn, pos: position(width, height), name: type, version: 1 };
}

function deviceInputProperty() {
  return {
    id: 'input-property',
    type: 'deviceInput',
    cfg: { ...cfg('deviceInput'), simplified: true },
    inputs: {},
    outputs: { output: ['sink.input'] },
    props: {
      did: sourceDid,
      siid: 2,
      piid: 1,
      dtype: 'int',
      operator: '>=',
      v1: 42,
      preload: true,
    },
  };
}

function deviceInputEvent() {
  return {
    id: 'input-event',
    type: 'deviceInput',
    cfg: cfg('deviceInput'),
    inputs: {},
    outputs: { output: [] },
    props: {
      did: sourceDid,
      siid: 2,
      eiid: 5,
      arguments: [
        { piid: 1, dtype: 'int', operator: '>=', v1: 10 },
        { piid: 2, dtype: 'int', operator: 'include', v1: [1, 2] },
      ],
    },
  };
}

function deviceOutputAction() {
  return {
    id: 'output-action',
    type: 'deviceOutput',
    cfg: cfg('deviceOutput', sourceUrn, 684, 204),
    inputs: { trigger: null },
    outputs: { output: ['after.input'] },
    props: {
      did: sourceDid,
      siid: 2,
      aiid: 6,
      ins: [
        { piid: 1, value: 30 },
        { piid: 2, scope: 'global', id: 'mode', dtype: 'number', min: 1, max: 2, step: 1 },
      ],
    },
  };
}

function deviceOutputProperty() {
  return {
    id: 'output-property',
    type: 'deviceOutput',
    cfg: cfg('deviceOutput', sourceUrn, 684, 204),
    inputs: { trigger: null },
    outputs: { output: [] },
    props: { did: sourceDid, siid: 2, piid: 1, value: 30 },
  };
}

function deviceInputSetVarProperty() {
  return {
    id: 'input-set-var-property',
    type: 'deviceInputSetVar',
    cfg: cfg('deviceInputSetVar', sourceUrn, 554, 206),
    inputs: {},
    outputs: { output: [] },
    props: {
      did: sourceDid,
      siid: 2,
      piid: 1,
      dtype: 'number',
      scope: 'global',
      id: 'level',
      preload: false,
    },
  };
}

function familyNodes() {
  return [
    deviceInputProperty(),
    {
      id: 'get',
      type: 'deviceGet',
      cfg: cfg('deviceGet', sourceUrn, 700, 240),
      inputs: { input: null },
      outputs: { output: [], output2: [] },
      props: { did: sourceDid, siid: 2, piid: 1, dtype: 'int', operator: '<', v1: 50 },
    },
    deviceOutputProperty(),
    deviceOutputAction(),
    deviceInputSetVarProperty(),
    {
      id: 'input-set-var',
      type: 'deviceInputSetVar',
      cfg: cfg('deviceInputSetVar', sourceUrn, 554, 206),
      inputs: {},
      outputs: { output: [] },
      props: {
        did: sourceDid,
        siid: 2,
        eiid: 5,
        arguments: [
          { piid: 1, dtype: 'number', scope: 'global', id: 'level' },
          { piid: 2, dtype: 'number', scope: 'global', id: 'mode' },
        ],
      },
    },
    {
      id: 'get-set-var',
      type: 'deviceGetSetVar',
      cfg: cfg('deviceGetSetVar', sourceUrn, 566, 200),
      inputs: { input: null },
      outputs: { output: [] },
      props: {
        did: sourceDid,
        siid: 2,
        piid: 1,
        dtype: 'number',
        scope: 'global',
        id: 'level',
      },
    },
  ];
}

test('property matching uses URN[:5], dtype, exact range, and exact value-list values', () => {
  const source = resolveDeviceReplacementSource({ node: deviceInputProperty(), sourceSpec });
  const compatible = evaluateDeviceReplacementCandidate(source, targetDevice, compatibleTargetSpec);
  const mapping = selectDeviceReplacementMapping(compatible, { siid: 9, piid: 1 });
  assert.equal(mapping.compatible, true);
  assert.equal(mapping.target.siid, 9);
  assert.equal(mapping.target.piid, 1);
  assert.equal(
    mapping.checks.find((entry) => entry.contract === 'property.serviceUrn[:5]').compatible,
    true,
  );
  assert.equal(
    mapping.checks.find((entry) => entry.contract === 'property.valueRange').compatible,
    true,
  );

  const wrongRange = evaluateDeviceReplacementCandidate(
    source,
    targetDevice,
    spec(targetUrn, { siid: 9, vendor: 'target', version: 9, rangeStep: 5 }),
  );
  const rangeEvaluation = wrongRange.evaluations.find(
    (entry) => entry.target.kind === 'property' && entry.target.piid === 1,
  );
  assert.equal(rangeEvaluation.compatible, false);
  assert.match(rangeEvaluation.reasons.join('\n'), /value-range/);

  const wrongUrn = evaluateDeviceReplacementCandidate(
    source,
    targetDevice,
    mutatedTargetSpec((targetService) => {
      targetService.properties[0].type = 'urn:miot-spec-v2:property:brightness:00000002:target:9';
    }),
  );
  const urnEvaluation = wrongUrn.evaluations.find(
    (entry) => entry.target.kind === 'property' && entry.target.piid === 1,
  );
  assert.equal(urnEvaluation.compatible, false);
  assert.equal(
    urnEvaluation.checks.find((entry) => entry.contract === 'property.urn[:5]').compatible,
    false,
  );

  const wrongDtype = evaluateDeviceReplacementCandidate(
    source,
    targetDevice,
    mutatedTargetSpec((targetService) => {
      targetService.properties[0].format = 'string';
    }),
  );
  const dtypeEvaluation = wrongDtype.evaluations.find(
    (entry) => entry.target.kind === 'property' && entry.target.piid === 1,
  );
  assert.equal(dtypeEvaluation.compatible, false);
  assert.equal(
    dtypeEvaluation.checks.find((entry) => entry.contract === 'property.dtype').compatible,
    false,
  );

  const listSource = resolveDeviceReplacementSource({
    node: {
      ...deviceInputProperty(),
      props: {
        did: sourceDid,
        siid: 2,
        piid: 2,
        dtype: 'int',
        operator: 'include',
        v1: [1, 2],
      },
    },
    sourceSpec,
  });
  const wrongList = evaluateDeviceReplacementCandidate(
    listSource,
    targetDevice,
    spec(targetUrn, { siid: 9, vendor: 'target', version: 9, list: [1, 3] }),
  );
  const listEvaluation = wrongList.evaluations.find(
    (entry) => entry.target.kind === 'property' && entry.target.piid === 2,
  );
  assert.equal(listEvaluation.compatible, false);
  assert.match(listEvaluation.reasons.join('\n'), /value-list/);
});

test('event arguments and action inputs recursively enforce property contracts and stable piids', () => {
  const eventSource = resolveDeviceReplacementSource({ node: deviceInputEvent(), sourceSpec });
  const eventCandidate = evaluateDeviceReplacementCandidate(
    eventSource,
    targetDevice,
    compatibleTargetSpec,
  );
  assert.equal(selectDeviceReplacementMapping(eventCandidate).target.eiid, 15);

  const incompatibleEvent = evaluateDeviceReplacementCandidate(
    eventSource,
    targetDevice,
    spec(targetUrn, { siid: 9, vendor: 'target', version: 9, list: [1, 3] }),
  );
  const eventEvaluation = incompatibleEvent.evaluations.find(
    (entry) => entry.target.kind === 'event',
  );
  assert.equal(eventEvaluation.compatible, false);
  assert.match(eventEvaluation.reasons.join('\n'), /value-list/);

  const eventCountMismatch = evaluateDeviceReplacementCandidate(
    eventSource,
    targetDevice,
    mutatedTargetSpec((targetService) => {
      targetService.events[0].arguments = [1];
    }),
  ).evaluations.find((entry) => entry.target.kind === 'event');
  assert.equal(eventCountMismatch.compatible, false);
  assert.match(eventCountMismatch.reasons.join('\n'), /argument count/);

  const eventPiidMismatch = evaluateDeviceReplacementCandidate(
    eventSource,
    targetDevice,
    mutatedTargetSpec((targetService) => {
      targetService.properties[1].iid = 3;
      targetService.events[0].arguments = [1, 3];
    }),
  ).evaluations.find((entry) => entry.target.kind === 'event');
  assert.equal(eventPiidMismatch.compatible, false);
  assert.match(eventPiidMismatch.reasons.join('\n'), /argument piid 2 is missing/);

  const actionSource = resolveDeviceReplacementSource({ node: deviceOutputAction(), sourceSpec });
  const actionCandidate = evaluateDeviceReplacementCandidate(
    actionSource,
    targetDevice,
    compatibleTargetSpec,
  );
  assert.equal(selectDeviceReplacementMapping(actionCandidate).target.aiid, 16);

  const incompatibleAction = evaluateDeviceReplacementCandidate(
    actionSource,
    targetDevice,
    spec(targetUrn, { siid: 9, vendor: 'target', version: 9, rangeStep: 10 }),
  );
  const actionEvaluation = incompatibleAction.evaluations.find(
    (entry) => entry.target.kind === 'action',
  );
  assert.equal(actionEvaluation.compatible, false);
  assert.match(actionEvaluation.reasons.join('\n'), /value-range/);

  const actionCountMismatch = evaluateDeviceReplacementCandidate(
    actionSource,
    targetDevice,
    mutatedTargetSpec((targetService) => {
      targetService.actions[0].in = [1];
    }),
  ).evaluations.find((entry) => entry.target.kind === 'action');
  assert.equal(actionCountMismatch.compatible, false);
  assert.match(actionCountMismatch.reasons.join('\n'), /input count/);

  const actionPiidMismatch = evaluateDeviceReplacementCandidate(
    actionSource,
    targetDevice,
    mutatedTargetSpec((targetService) => {
      targetService.properties[1].iid = 3;
      targetService.actions[0].in = [1, 3];
    }),
  ).evaluations.find((entry) => entry.target.kind === 'action');
  assert.equal(actionPiidMismatch.compatible, false);
  assert.match(actionPiidMismatch.reasons.join('\n'), /input piid 2 is missing/);
});

test('all five official device card families resolve and find a compatible target mapping', () => {
  const expected = [
    ['deviceInput', 'property'],
    ['deviceGet', 'property'],
    ['deviceOutput', 'property'],
    ['deviceOutput', 'action'],
    ['deviceInputSetVar', 'property'],
    ['deviceInputSetVar', 'event'],
    ['deviceGetSetVar', 'property'],
  ];
  for (const [index, node] of familyNodes().entries()) {
    const source = resolveDeviceReplacementSource({ node, sourceSpec });
    assert.deepEqual([source.nodeType, source.capability.kind], expected[index]);
    const candidate = evaluateDeviceReplacementCandidate(
      source,
      targetDevice,
      compatibleTargetSpec,
    );
    assert.equal(candidate.compatible, true, node.type);
    assert.equal(selectDeviceReplacementMapping(candidate).compatible, true, node.type);
  }
});

test('replacement preserves node id, edges, card settings, comparisons, and variable/action inputs', () => {
  for (const node of [
    deviceInputProperty(),
    deviceOutputProperty(),
    deviceOutputAction(),
    deviceInputSetVarProperty(),
  ]) {
    const source = resolveDeviceReplacementSource({ node, sourceSpec });
    const candidate = evaluateDeviceReplacementCandidate(
      source,
      targetDevice,
      compatibleTargetSpec,
    );
    const mapping = selectDeviceReplacementMapping(candidate);
    const replaced = replaceDeviceNode(node, targetDid, targetUrn, mapping);
    assert.equal(replaced.id, node.id);
    assert.deepEqual(replaced.inputs, node.inputs);
    assert.deepEqual(replaced.outputs, node.outputs);
    assert.deepEqual(replaced.cfg.pos, node.cfg.pos);
    assert.equal(replaced.cfg.urn, targetUrn);
    assert.equal(replaced.props.did, targetDid);
    assert.equal(replaced.props.siid, 9);
    for (const key of ['operator', 'v1', 'value', 'preload', 'scope', 'id', 'dtype', 'ins']) {
      if (key in node.props) assert.deepEqual(replaced.props[key], node.props[key]);
    }
  }
});

function summary() {
  return {
    id: ruleId,
    enable: false,
    uiType: 'rule',
    userData: {
      name: 'replacement fixture',
      transform: { x: 0, y: 0, scale: 1, rotate: 0 },
      lastUpdateTime: 0,
      version: 0,
    },
  };
}

function fakeGateway(node = deviceInputProperty()) {
  const calls = [];
  const sink = {
    id: 'sink',
    type: 'delay',
    cfg: {
      pos: position(320, 120),
      name: 'delay',
      version: 1,
      unit: 's',
      value: 1,
    },
    inputs: { input: null },
    outputs: { output: [] },
    props: { timeout: 1_000 },
  };
  const state = { cfg: summary(), nodes: [structuredClone(node), sink] };
  const control = {
    getGraphCount: 0,
    ignoreSetGraph: false,
    mutateOnGetGraphCall: undefined,
    targetDevice: structuredClone(targetDevice),
  };
  const deps = {
    baseUrl,
    store: {
      read: async () => ({
        host: baseUrl,
        pid: 1,
        socketPath: '/tmp/xgg-device-replacement-unused.sock',
        agentStartedAt: startedAt,
        agentVersion: '0.1.4',
        lastValidatedAt: startedAt,
      }),
    },
    ipcClient: () => ({
      request: async (method, params, options) => {
        if (method === '$ping') return { host: baseUrl, agentStartedAt: startedAt };
        if (method === '$mutation.acquire') {
          calls.push({ method, params, options });
          return { leaseId: 'replacement-lease' };
        }
        if (method === '$mutation.release' || method === '$mutation.fence') {
          calls.push({ method, params, options });
          return { ok: true };
        }
        calls.push({ method, params, options });
        if (method === '/api/getDevList') {
          return {
            devList: {
              [sourceDid]: { ...sourceDevice, did: undefined },
              [targetDid]: { ...control.targetDevice, did: undefined },
            },
          };
        }
        if (method === '/api/getGraphList') return [structuredClone(state.cfg)];
        if (method === '/api/getGraph') {
          control.getGraphCount += 1;
          if (control.getGraphCount === control.mutateOnGetGraphCall) {
            state.nodes[1].props.timeout += 1_000;
          }
          return { id: ruleId, nodes: structuredClone(state.nodes) };
        }
        if (method === '/api/getVarList') return {};
        if (method === '/api/setGraph') {
          if (!control.ignoreSetGraph) {
            state.cfg = structuredClone(params.cfg);
            state.nodes = structuredClone(params.nodes);
          }
          return null;
        }
        throw new Error(`unexpected RPC: ${method}`);
      },
      close: () => {},
    }),
  };
  return { calls, control, deps, state };
}

async function writeCheckpoint(t, gateway, mutate = undefined) {
  const directory = await mkdtemp(join(tmpdir(), 'xgg-device-replacement-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'dump.json');
  const payload = {
    kind: 'xgg-pre-write-rollback',
    schemaVersion: 1,
    devices: {},
    rules: [
      {
        id: ruleId,
        cfg: structuredClone(gateway.state.cfg),
        nodes: structuredClone(gateway.state.nodes),
      },
    ],
    variables: {},
    capturedAt: new Date().toISOString(),
  };
  mutate?.(payload);
  await writeFile(path, JSON.stringify(payload));
  return path;
}

function fixedSpecs(urn) {
  if (urn === sourceUrn) return Promise.resolve(sourceSpec);
  if (urn === targetUrn) return Promise.resolve(compatibleTargetSpec);
  throw new Error(`unexpected URN: ${urn}`);
}

test('default dry-run excludes a spec-compatible ghost without lease, snapshot, or setGraph', async () => {
  const gateway = fakeGateway();
  gateway.control.targetDevice = device(targetDid, targetUrn, 'Ghost target', {
    specV2Access: false,
    specV3Access: false,
    online: true,
  });
  const specCalls = [];
  const plan = await planDeviceReplacement({ ruleId, nodeId: 'input-property' }, gateway.deps, {
    getDeviceSpec: async (urn) => {
      specCalls.push(urn);
      if (urn === sourceUrn) return sourceSpec;
      if (urn === targetUrn) return compatibleTargetSpec;
      throw new Error(`unexpected URN: ${urn}`);
    },
  });

  assert.deepEqual(
    plan.candidates.map((candidate) => candidate.did),
    [sourceDid],
  );
  assert.equal(specCalls.includes(targetUrn), false, 'an excluded ghost must not trigger spec IO');
  assert.equal(gateway.calls.filter((call) => call.method === '$mutation.acquire').length, 0);
  assert.equal(gateway.calls.filter((call) => call.method === '/api/getVarList').length, 0);
  assert.equal(gateway.calls.filter((call) => call.method === '/api/setGraph').length, 0);
});

test('focused spec-compatible ghost is explicitly ineligible and receives no planId', async () => {
  const gateway = fakeGateway();
  gateway.control.targetDevice = device(targetDid, targetUrn, 'Ghost target', {
    specV2Access: false,
    specV3Access: false,
    online: true,
  });
  const plan = await planDeviceReplacement(
    { ruleId, nodeId: 'input-property', targetDid },
    gateway.deps,
    { getDeviceSpec: fixedSpecs },
  );

  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.candidates[0].eligible, false);
  assert.equal(plan.candidates[0].compatible, true);
  assert.match(plan.candidates[0].eligibilityReasons.join('\n'), /ghost|autoLocal|ineligible/i);
  assert.equal(plan.selectedMapping, undefined);
  assert.equal(plan.planId, undefined);
  assert.equal(plan.selectionError.code, 'CONFIG');
  assert.match(plan.selectionError.message, /ghost|ineligible/i);
  assert.equal(gateway.calls.filter((call) => call.method === '$mutation.acquire').length, 0);
  assert.equal(gateway.calls.filter((call) => call.method === '/api/setGraph').length, 0);
});

test('visible compatible target remains eligible and receives an applicable planId', async () => {
  const gateway = fakeGateway();
  const plan = await planDeviceReplacement(
    { ruleId, nodeId: 'input-property', targetDid },
    gateway.deps,
    { getDeviceSpec: fixedSpecs },
  );

  assert.equal(plan.candidates[0].eligible, true);
  assert.deepEqual(plan.candidates[0].eligibilityReasons, []);
  assert.equal(plan.candidates[0].compatible, true);
  assert.equal(plan.selectedMapping?.compatible, true);
  assert.equal(plan.planId?.length, 64);
});

test('focused dry-run rejects selector kinds that contradict the source capability', async () => {
  const gateway = fakeGateway();
  await assert.rejects(
    planDeviceReplacement(
      {
        ruleId,
        nodeId: 'input-property',
        targetDid,
        selector: { aiid: 16 },
      },
      gateway.deps,
      { getDeviceSpec: fixedSpecs },
    ),
    (error) =>
      error?.code === 'CONFIG' && /property device replacement selector/.test(error.message),
  );
});

test('focused dry-run explains an ambiguous compatible mapping', async () => {
  const gateway = fakeGateway();
  const ambiguousSpec = structuredClone(compatibleTargetSpec);
  ambiguousSpec.services.push(service({ siid: 10, vendor: 'another-target', version: 10 }));
  const plan = await planDeviceReplacement(
    { ruleId, nodeId: 'input-property', targetDid },
    gateway.deps,
    {
      getDeviceSpec: async (urn) => {
        if (urn === sourceUrn) return sourceSpec;
        if (urn === targetUrn) return ambiguousSpec;
        throw new Error(`unexpected URN: ${urn}`);
      },
    },
  );
  assert.equal(plan.candidates[0].compatible, true);
  assert.equal(plan.selectedMapping, undefined);
  assert.equal(plan.planId, undefined);
  assert.equal(plan.selectionError.code, 'CONFIG');
  assert.match(plan.selectionError.message, /2 compatible mappings/);
  assert.deepEqual(plan.selectionError.selector, {});
});

test('write path replans under one lease, validates, writes once, and confirms readback', async (t) => {
  const gateway = fakeGateway();
  const initial = await planDeviceReplacement(
    { ruleId, nodeId: 'input-property', targetDid },
    gateway.deps,
    { getDeviceSpec: fixedSpecs },
  );
  assert.equal(initial.planId?.length, 64);
  const rollbackSnapshotPath = await writeCheckpoint(t, gateway);
  const result = await replaceDevice(
    {
      ruleId,
      nodeId: 'input-property',
      targetDid,
      expectedPlanId: initial.planId,
      rollbackSnapshotPath,
    },
    gateway.deps,
    { getDeviceSpec: fixedSpecs },
  );
  assert.equal(result.readbackConfirmed, true);
  assert.equal(gateway.state.nodes[0].props.did, targetDid);
  assert.equal(gateway.state.nodes[0].props.siid, 9);
  assert.equal(gateway.state.nodes[0].props.piid, 1);
  assert.deepEqual(gateway.state.nodes[0].outputs, { output: ['sink.input'] });
  assert.equal(gateway.calls.filter((call) => call.method === '$mutation.acquire').length, 1);
  assert.equal(gateway.calls.filter((call) => call.method === '/api/setGraph').length, 1);
  assert.equal(
    gateway.calls.filter((call) => !call.method.startsWith('$')).at(-1).method,
    '/api/getGraph',
  );
});

test('fresh spec recheck rejects a stale target plan before setGraph', async (t) => {
  const gateway = fakeGateway();
  const counts = new Map();
  const requestedCacheModes = [];
  const changingSpecs = async (urn, options) => {
    requestedCacheModes.push([urn, options?.cache]);
    const count = (counts.get(urn) ?? 0) + 1;
    counts.set(urn, count);
    if (urn === sourceUrn) return sourceSpec;
    if (urn === targetUrn && count === 1) return compatibleTargetSpec;
    if (urn === targetUrn) {
      return spec(targetUrn, { siid: 9, vendor: 'target', version: 9, rangeStep: 5 });
    }
    throw new Error(`unexpected URN: ${urn}`);
  };
  const initial = await planDeviceReplacement(
    { ruleId, nodeId: 'input-property', targetDid },
    gateway.deps,
    { getDeviceSpec: changingSpecs },
  );
  const rollbackSnapshotPath = await writeCheckpoint(t, gateway);
  await assert.rejects(
    replaceDevice(
      {
        ruleId,
        nodeId: 'input-property',
        targetDid,
        expectedPlanId: initial.planId,
        rollbackSnapshotPath,
      },
      gateway.deps,
      { getDeviceSpec: changingSpecs },
    ),
    (error) => error?.code === 'CONFIG' && /became stale/.test(error.message),
  );
  assert.ok(
    requestedCacheModes.some(([urn, cache]) => urn === targetUrn && cache === 'reload'),
    'the post-snapshot target spec check must explicitly bypass caches',
  );
  assert.equal(
    gateway.calls.some((call) => call.method === '/api/setGraph'),
    false,
  );
  assert.equal(gateway.state.nodes[0].props.did, sourceDid);
});

test('fresh device inventory hard-rejects eligibility drift to ghost before setGraph', async (t) => {
  const gateway = fakeGateway();
  const initial = await planDeviceReplacement(
    { ruleId, nodeId: 'input-property', targetDid },
    gateway.deps,
    { getDeviceSpec: fixedSpecs },
  );
  assert.equal(initial.candidates[0].eligible, true);
  assert.equal(initial.planId?.length, 64);
  const rollbackSnapshotPath = await writeCheckpoint(t, gateway);

  gateway.control.targetDevice = device(targetDid, targetUrn, 'Ghost target', {
    specV2Access: false,
    specV3Access: false,
    online: true,
  });
  await assert.rejects(
    replaceDevice(
      {
        ruleId,
        nodeId: 'input-property',
        targetDid,
        expectedPlanId: initial.planId,
        rollbackSnapshotPath,
      },
      gateway.deps,
      { getDeviceSpec: fixedSpecs },
    ),
    (error) =>
      error?.code === 'CONFIG' &&
      /fresh device inventory|ghost|ineligible/i.test(error.message) &&
      error.details?.freshCandidate?.eligible === false,
  );

  assert.equal(gateway.calls.filter((call) => call.method === '$mutation.acquire').length, 1);
  assert.equal(gateway.calls.filter((call) => call.method === '/api/setGraph').length, 0);
  assert.equal(gateway.state.nodes[0].props.did, sourceDid);
});

test('write rejects a missing rollback checkpoint before any gateway graph read or write', async () => {
  const gateway = fakeGateway();
  const initial = await planDeviceReplacement(
    { ruleId, nodeId: 'input-property', targetDid },
    gateway.deps,
    { getDeviceSpec: fixedSpecs },
  );
  const callsBeforeWriteAttempt = gateway.calls.length;
  await assert.rejects(
    replaceDevice(
      {
        ruleId,
        nodeId: 'input-property',
        targetDid,
        expectedPlanId: initial.planId,
      },
      gateway.deps,
      { getDeviceSpec: fixedSpecs },
    ),
    (error) =>
      error?.code === 'CONFIG' && /requires the rollback snapshot path/.test(error.message),
  );
  assert.equal(
    gateway.calls.slice(callsBeforeWriteAttempt).some((call) => call.method === '/api/getGraph'),
    false,
  );
  assert.equal(
    gateway.calls.some((call) => call.method === '/api/setGraph'),
    false,
  );
});

test('write rejects partial or malformed rollback envelopes before gateway reads or writes', async (t) => {
  const cases = [
    {
      name: 'missing devices',
      mutate: (payload) => {
        payload.devices = undefined;
      },
      message: /complete devices inventory/,
    },
    {
      name: 'missing variables',
      mutate: (payload) => {
        payload.variables = undefined;
      },
      message: /complete variables inventory/,
    },
    {
      name: 'invalid capturedAt',
      mutate: (payload) => {
        payload.capturedAt = 'yesterday';
      },
      message: /valid ISO capturedAt/,
    },
    {
      name: 'invalid variable entry',
      mutate: (payload) => {
        payload.variables = { global: { broken: { type: 'number', value: 'not-a-number' } } };
      },
      message: /DeviceReplacement\.rollbackSnapshot\.variables\.global\.broken/,
    },
    {
      name: 'duplicate rule id',
      mutate: (payload) => {
        payload.rules.push(structuredClone(payload.rules[0]));
      },
      message: /duplicate rule/,
    },
  ];

  for (const scenario of cases) {
    const gateway = fakeGateway();
    const initial = await planDeviceReplacement(
      { ruleId, nodeId: 'input-property', targetDid },
      gateway.deps,
      { getDeviceSpec: fixedSpecs },
    );
    const rollbackSnapshotPath = await writeCheckpoint(t, gateway, scenario.mutate);
    const callsBeforeWriteAttempt = gateway.calls.length;
    await assert.rejects(
      replaceDevice(
        {
          ruleId,
          nodeId: 'input-property',
          targetDid,
          expectedPlanId: initial.planId,
          rollbackSnapshotPath,
        },
        gateway.deps,
        { getDeviceSpec: fixedSpecs },
      ),
      (error) =>
        (error?.code === 'CONFIG' || error?.code === 'SCHEMA') &&
        scenario.message.test(error.message),
      scenario.name,
    );
    assert.equal(
      gateway.calls.slice(callsBeforeWriteAttempt).some((call) => call.method === '/api/getGraph'),
      false,
      scenario.name,
    );
    assert.equal(
      gateway.calls.some((call) => call.method === '/api/setGraph'),
      false,
      scenario.name,
    );
  }
});

test('write rejects when the rollback checkpoint no longer matches the live graph', async (t) => {
  const gateway = fakeGateway();
  const initial = await planDeviceReplacement(
    { ruleId, nodeId: 'input-property', targetDid },
    gateway.deps,
    { getDeviceSpec: fixedSpecs },
  );
  const rollbackSnapshotPath = await writeCheckpoint(t, gateway);
  gateway.state.nodes[1].props.timeout = 9_000;
  await assert.rejects(
    replaceDevice(
      {
        ruleId,
        nodeId: 'input-property',
        targetDid,
        expectedPlanId: initial.planId,
        rollbackSnapshotPath,
      },
      gateway.deps,
      { getDeviceSpec: fixedSpecs },
    ),
    (error) => error?.code === 'CONFIG' && /snapshot no longer matches/.test(error.message),
  );
  assert.equal(
    gateway.calls.some((call) => call.method === '/api/setGraph'),
    false,
  );
});

test('final pre-write graph read rejects an external canvas edit after validation', async (t) => {
  const gateway = fakeGateway();
  const initial = await planDeviceReplacement(
    { ruleId, nodeId: 'input-property', targetDid },
    gateway.deps,
    { getDeviceSpec: fixedSpecs },
  );
  const rollbackSnapshotPath = await writeCheckpoint(t, gateway);
  gateway.control.mutateOnGetGraphCall = 3;
  await assert.rejects(
    replaceDevice(
      {
        ruleId,
        nodeId: 'input-property',
        targetDid,
        expectedPlanId: initial.planId,
        rollbackSnapshotPath,
      },
      gateway.deps,
      { getDeviceSpec: fixedSpecs },
    ),
    (error) => error?.code === 'CONFIG' && /changed before write/.test(error.message),
  );
  assert.equal(
    gateway.calls.some((call) => call.method === '/api/setGraph'),
    false,
  );
  assert.equal(gateway.state.nodes[0].props.did, sourceDid);
});

test('strict graph validation rejects an invalid preserved edge before setGraph', async (t) => {
  const node = deviceInputProperty();
  node.outputs.output = ['missing.input'];
  const gateway = fakeGateway(node);
  const initial = await planDeviceReplacement(
    { ruleId, nodeId: 'input-property', targetDid },
    gateway.deps,
    { getDeviceSpec: fixedSpecs },
  );
  const rollbackSnapshotPath = await writeCheckpoint(t, gateway);
  await assert.rejects(
    replaceDevice(
      {
        ruleId,
        nodeId: 'input-property',
        targetDid,
        expectedPlanId: initial.planId,
        rollbackSnapshotPath,
      },
      gateway.deps,
      { getDeviceSpec: fixedSpecs },
    ),
    (error) => error?.code === 'CONFIG' && /does not exist|missing/.test(error.message),
  );
  assert.equal(
    gateway.calls.some((call) => call.method === '/api/setGraph'),
    false,
  );
});

test('readback mismatch fences the mutation and reports NOT_CONFIRMED', async (t) => {
  const gateway = fakeGateway();
  const initial = await planDeviceReplacement(
    { ruleId, nodeId: 'input-property', targetDid },
    gateway.deps,
    { getDeviceSpec: fixedSpecs },
  );
  const rollbackSnapshotPath = await writeCheckpoint(t, gateway);
  gateway.control.ignoreSetGraph = true;
  await assert.rejects(
    replaceDevice(
      {
        ruleId,
        nodeId: 'input-property',
        targetDid,
        expectedPlanId: initial.planId,
        rollbackSnapshotPath,
      },
      gateway.deps,
      { getDeviceSpec: fixedSpecs },
    ),
    (error) => error?.code === 'NOT_CONFIRMED' && /readback/.test(error.message),
  );
  assert.equal(gateway.calls.filter((call) => call.method === '/api/setGraph').length, 1);
  assert.equal(
    gateway.calls.some((call) => call.method === '$mutation.fence'),
    true,
  );
  assert.equal(gateway.state.nodes[0].props.did, sourceDid);
});
