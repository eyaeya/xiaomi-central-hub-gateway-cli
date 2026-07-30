import assert from 'node:assert/strict';
import test from 'node:test';

import {
  lintGraph,
  normalizeHabitLearningObservations,
  parseLogLine,
  planHabitLearning,
} from '../dist/index.js';
import {
  HABIT_LEARNING_COMPILE_VERSION,
  assertCompiledHabitLearningRule,
  compileHabitLearningRule,
  habitLearningRuleLayoutDigest,
  habitLearningRuleSemanticDigest,
} from '../dist/usecases/habit-learning-compile.js';

const deviceUrn = (name) => `urn:miot-spec-v2:device:${name}:0000A001:habit-compile:1`;
const serviceUrn = (name) => `urn:miot-spec-v2:service:${name}:00007801:habit-compile:1`;
const propertyUrn = (name) => `urn:miot-spec-v2:property:${name}:00000001:habit-compile:1`;
const eventUrn = (name) => `urn:miot-spec-v2:event:${name}:00005001:habit-compile:1`;

function fixturePlan() {
  const spec = {
    type: deviceUrn('occupancy-sensor'),
    description: 'Habit compiler fixture',
    services: [
      {
        iid: 2,
        type: serviceUrn('occupancy-sensor'),
        description: 'Occupancy sensor',
        properties: [
          {
            iid: 1,
            type: propertyUrn('occupancy-status'),
            description: 'Occupancy status',
            format: 'bool',
            access: ['read', 'notify'],
          },
          {
            iid: 2,
            type: propertyUrn('zone-number'),
            description: 'Zone number',
            format: 'uint8',
            access: [],
            'value-range': [0, 16, 1],
          },
          {
            iid: 3,
            type: propertyUrn('activity-label'),
            description: 'Activity label',
            format: 'string',
            access: [],
          },
        ],
        events: [
          {
            iid: 1,
            type: eventUrn('presence-changed'),
            description: 'Presence changed',
            arguments: [2, 3],
          },
          {
            iid: 2,
            type: eventUrn('motion-detected'),
            description: 'Motion detected',
            arguments: [],
          },
        ],
        actions: [],
      },
    ],
  };
  return planHabitLearning({
    devices: [
      {
        device: {
          did: 'did.fixture',
          specV2Access: true,
          specV3Access: false,
          online: true,
          pushAvailable: true,
          name: 'Study sensor',
          model: 'fixture.habit.compiler',
          modelName: 'Habit compiler',
          urn: spec.type,
          roomId: 'study',
          roomName: 'Study',
          icon: '',
        },
        spec,
      },
    ],
  });
}

function singlePropertyPlan() {
  const spec = {
    type: deviceUrn('single-switch'),
    description: 'Single-source fixture',
    services: [
      {
        iid: 2,
        type: serviceUrn('switch'),
        description: 'Switch',
        properties: [
          {
            iid: 1,
            type: propertyUrn('on'),
            description: 'Power',
            format: 'bool',
            access: ['read', 'notify'],
          },
        ],
        events: [],
        actions: [],
      },
    ],
  };
  return planHabitLearning({
    devices: [
      {
        device: {
          did: 'did.single',
          specV2Access: true,
          specV3Access: false,
          online: true,
          pushAvailable: true,
          name: 'Single switch',
          model: 'fixture.single',
          modelName: 'Single switch',
          urn: spec.type,
          roomId: 'study',
          roomName: 'Study',
          icon: '',
        },
        spec,
      },
    ],
  });
}

function clone(value) {
  return structuredClone(value);
}

test('compiler emits one disabled observation graph with canonical source cards and geometry', () => {
  const plan = fixturePlan();
  const compiled = compileHabitLearningRule({
    plan,
    ruleId: '1700000000000',
    ruleName: 'Household habit observation',
  });

  assert.equal(compiled.compileVersion, HABIT_LEARNING_COMPILE_VERSION);
  assert.equal(compiled.planId, plan.planId);
  assert.equal(compiled.planGraphId, plan.graph.graphId);
  assert.equal(compiled.rule.id, '1700000000000');
  assert.equal(compiled.rule.cfg.id, compiled.rule.id);
  assert.equal(compiled.rule.cfg.enable, false);
  assert.equal(compiled.rule.cfg.userData.name, 'Household habit observation');
  assert.equal(Object.isFrozen(compiled.sourceMap), true);
  assert.equal(Object.isFrozen(compiled.sourceMap.sources), true);

  const types = compiled.rule.nodes.map((node) => node.type).sort();
  assert.deepEqual(types, ['deviceInput', 'deviceInputSetVar', 'deviceInputSetVar', 'signalOr']);
  assert.equal(
    compiled.rule.nodes.some((node) => node.type === 'deviceOutput' || node.type === 'loop'),
    false,
  );

  const property = compiled.rule.nodes.find(
    (node) => node.type === 'deviceInputSetVar' && 'piid' in node.props,
  );
  assert.ok(property);
  assert.equal(property.props.preload, true);
  assert.deepEqual(
    { width: property.cfg.pos.width, height: property.cfg.pos.height },
    { width: 554, height: 204 },
  );

  const parameterEvent = compiled.rule.nodes.find(
    (node) =>
      node.type === 'deviceInputSetVar' &&
      'arguments' in node.props &&
      node.props.arguments.length === 2,
  );
  assert.ok(parameterEvent);
  assert.deepEqual(
    { width: parameterEvent.cfg.pos.width, height: parameterEvent.cfg.pos.height },
    { width: 418, height: 244 },
  );
  assert.deepEqual(
    parameterEvent.props.arguments.map(({ piid, dtype, scope }) => ({ piid, dtype, scope })),
    [
      { piid: 2, dtype: 'number', scope: 'R1700000000000' },
      { piid: 3, dtype: 'string', scope: 'R1700000000000' },
    ],
  );

  const zeroArgumentEvent = compiled.rule.nodes.find((node) => node.type === 'deviceInput');
  assert.ok(zeroArgumentEvent);
  assert.deepEqual(zeroArgumentEvent.props.arguments, []);
  assert.deepEqual(
    { width: zeroArgumentEvent.cfg.pos.width, height: zeroArgumentEvent.cfg.pos.height },
    { width: 280, height: 164 },
  );

  const fanIn = compiled.rule.nodes.find((node) => node.type === 'signalOr');
  assert.ok(fanIn);
  assert.deepEqual(Object.keys(fanIn.inputs), ['input0', 'input1', 'input2']);
  assert.deepEqual(
    { width: fanIn.cfg.pos.width, height: fanIn.cfg.pos.height },
    { width: 160, height: 220 },
  );
  assert.deepEqual(fanIn.outputs.output, []);
  assert.equal(fanIn.cfg.pos.x, 626);

  const sources = compiled.rule.nodes.filter((node) => node.type !== 'signalOr');
  sources.forEach((source, index) => {
    assert.deepEqual(source.outputs.output, [`${fanIn.id}.input${index}`]);
    assert.equal(source.cfg.pos.x, 40);
  });
  assert.equal(new Set(sources.map((source) => source.cfg.pos.y)).size, sources.length);

  assert.equal(compiled.localVariables.length, 3);
  assert.equal(
    compiled.localVariables.every(
      ({ request }) =>
        request.scope === 'R1700000000000' &&
        /^v[a-f0-9]{32}$/.test(request.id) &&
        ((request.type === 'number' && request.value === 0) ||
          (request.type === 'string' && request.value === '')),
    ),
    true,
  );
  assert.equal(new Set(compiled.localVariables.map(({ request }) => request.id)).size, 3);

  assert.equal(compiled.sourceMap.ruleId, compiled.rule.id);
  assert.equal(compiled.sourceMap.sources.length, 4);
  assert.equal(compiled.sourceMap.sources.filter((source) => source.kind === 'property').length, 1);
  assert.equal(
    compiled.sourceMap.sources.filter((source) => source.kind === 'parameter-event').length,
    2,
  );
  const zeroSource = compiled.sourceMap.sources.find(
    (source) => source.kind === 'zero-argument-event',
  );
  assert.ok(zeroSource);
  assert.deepEqual(zeroSource.firstHop, {
    src: `${zeroArgumentEvent.id}.output`,
    dst: zeroArgumentEvent.outputs.output[0],
  });

  const propertySource = compiled.sourceMap.sources.find((source) => source.kind === 'property');
  const parameterSources = compiled.sourceMap.sources
    .filter((source) => source.kind === 'parameter-event')
    .sort((left, right) => left.valueIndex - right.valueIndex);
  assert.ok(propertySource);
  assert.equal(parameterSources.length, 2);
  const logLines = [
    `3|1000|i|${compiled.rule.id}|${propertySource.nodeId}|[true]`,
    `3|1001|i|${compiled.rule.id}|${parameterSources[0].nodeId}|[7,"walking"]`,
    `3|1002|l|${compiled.rule.id}|${zeroSource.firstHop.src}|${zeroSource.firstHop.dst}|null`,
  ];
  const logEntries = logLines.map((line) => {
    const parsed = parseLogLine(line);
    assert.ok(parsed);
    return parsed;
  });
  assert.deepEqual(
    normalizeHabitLearningObservations(logEntries, compiled.sourceMap).map(
      ({ sourceId, kind, value }) => ({ sourceId, kind, value }),
    ),
    [
      { sourceId: propertySource.sourceId, kind: 'property', value: true },
      {
        sourceId: parameterSources[0].sourceId,
        kind: 'parameter-event',
        value: 7,
      },
      {
        sourceId: parameterSources[1].sourceId,
        kind: 'parameter-event',
        value: 'walking',
      },
      {
        sourceId: zeroSource.sourceId,
        kind: 'zero-argument-event',
        value: null,
      },
    ],
  );

  assert.deepEqual(lintGraph({ graph: compiled.rule, strict: true }), []);
  assert.doesNotThrow(() => assertCompiledHabitLearningRule(compiled));
});

test('a one-source plan stays one graph and uses a valid two-pin observation fan-in', () => {
  const compiled = compileHabitLearningRule({
    plan: singlePropertyPlan(),
    ruleId: '1700000000000',
  });
  assert.equal(compiled.rule.nodes.length, 2);
  assert.equal(compiled.localVariables.length, 1);
  assert.equal(compiled.sourceMap.sources.length, 1);

  const source = compiled.rule.nodes.find((node) => node.type === 'deviceInputSetVar');
  const fanIn = compiled.rule.nodes.find((node) => node.type === 'signalOr');
  assert.ok(source);
  assert.ok(fanIn);
  assert.deepEqual(Object.keys(fanIn.inputs), ['input0', 'input1']);
  assert.deepEqual(source.outputs.output, [`${fanIn.id}.input0`]);
  assert.deepEqual(lintGraph({ graph: compiled.rule, strict: true }), []);
  assert.doesNotThrow(() => assertCompiledHabitLearningRule(compiled));
});

test('compiler output and all node, variable, source identities are deterministic', () => {
  const plan = fixturePlan();
  const first = compileHabitLearningRule({ plan, ruleId: '1700000000000' });
  const second = compileHabitLearningRule({
    plan: { ...plan, signals: [...plan.signals].reverse() },
    ruleId: '1700000000000',
  });
  assert.deepEqual(second, first);
  assert.equal(
    first.rule.nodes.every((node) => /^n[a-f0-9]{32}$/.test(node.id)),
    true,
  );

  const otherRule = compileHabitLearningRule({ plan, ruleId: '1700000000001' });
  assert.deepEqual(
    otherRule.rule.nodes.map(({ id }) => id),
    first.rule.nodes.map(({ id }) => id),
  );
  assert.deepEqual(
    otherRule.localVariables.map(({ request }) => request.id),
    first.localVariables.map(({ request }) => request.id),
  );
  assert.notEqual(otherRule.digests.semantic, first.digests.semantic);
});

test('semantic and layout digests have independent mutation boundaries', () => {
  const compiled = compileHabitLearningRule({
    plan: fixturePlan(),
    ruleId: '1700000000000',
  });
  const moved = clone(compiled.rule);
  moved.nodes[0].cfg.pos.x += 123;

  assert.equal(
    habitLearningRuleSemanticDigest(moved, compiled.localVariables, compiled.sourceMap),
    compiled.digests.semantic,
  );
  assert.notEqual(habitLearningRuleLayoutDigest(moved), compiled.digests.layout);

  const renamed = clone(compiled.rule);
  renamed.cfg.userData.name = 'Renamed without semantic drift';
  assert.equal(
    habitLearningRuleSemanticDigest(renamed, compiled.localVariables, compiled.sourceMap),
    compiled.digests.semantic,
  );
  assert.equal(habitLearningRuleLayoutDigest(renamed), compiled.digests.layout);

  const enabled = clone(compiled.rule);
  enabled.cfg.enable = true;
  assert.equal(
    habitLearningRuleSemanticDigest(enabled, compiled.localVariables, compiled.sourceMap),
    compiled.digests.semantic,
  );
  assert.equal(habitLearningRuleLayoutDigest(enabled), compiled.digests.layout);
});

test('compiler rejects invalid graph identities, empty plans, and unobservable sources', () => {
  const plan = fixturePlan();
  assert.throws(
    () => compileHabitLearningRule({ plan, ruleId: 'rule-with-hyphens' }),
    /ASCII alphanumeric/,
  );
  assert.throws(
    () => compileHabitLearningRule({ plan, ruleId: '1700000000000', ruleName: '   ' }),
    /ruleName must be a non-empty string/,
  );

  const missingSignal = clone(plan);
  missingSignal.graph.signalIds.pop();
  assert.throws(
    () => compileHabitLearningRule({ plan: missingSignal, ruleId: '1700000000000' }),
    /must exactly match/,
  );

  const wrongCount = clone(plan);
  wrongCount.graph.sourceCount += 1;
  assert.throws(
    () => compileHabitLearningRule({ plan: wrongCount, ruleId: '1700000000000' }),
    /sourceCount/,
  );

  const wrongGraphId = clone(plan);
  wrongGraphId.graph.graphId = '0'.repeat(64);
  assert.throws(
    () => compileHabitLearningRule({ plan: wrongGraphId, ruleId: '1700000000000' }),
    /graphId does not match/,
  );

  const duplicateSignal = clone(plan);
  duplicateSignal.signals.push(clone(duplicateSignal.signals[0]));
  assert.throws(
    () => compileHabitLearningRule({ plan: duplicateSignal, ruleId: '1700000000000' }),
    /duplicate habit-learning signalId/,
  );

  const empty = clone(plan);
  for (const signal of empty.signals) {
    signal.included = false;
    signal.tier = 'excluded';
    signal.reasonCodes = ['default-policy-excluded'];
    signal.estimatedNodes = 0;
    signal.estimatedVariables = 0;
    signal.estimatedLogLinesPerOccurrence = { min: 0, max: 0 };
  }
  empty.graph.signalIds = [];
  empty.graph.sourceCount = 0;
  empty.graph.graphId = 'f2ea005481baf634121a617570c0bf36a8f86dbf7be083a13b11553f7f50e781';
  assert.throws(
    () => compileHabitLearningRule({ plan: empty, ruleId: '1700000000000' }),
    /no included observable signals/,
  );

  const unobservable = clone(plan);
  const property = unobservable.signals.find(
    (signal) => signal.included && signal.selector.kind === 'property',
  );
  property.observability = 'sample-only';
  assert.throws(
    () => compileHabitLearningRule({ plan: unobservable, ruleId: '1700000000000' }),
    /notify-capable push source/,
  );

  const unresolvedEvent = clone(plan);
  const event = unresolvedEvent.signals.find(
    (signal) =>
      signal.included &&
      signal.selector.kind === 'event' &&
      signal.selector.argumentPiids.length > 0,
  );
  event.selector.arguments.pop();
  assert.throws(
    () => compileHabitLearningRule({ plan: unresolvedEvent, ruleId: '1700000000000' }),
    /resolved arguments/,
  );
});

test('self-validation rejects forbidden nodes, unknown sources, non-local vars, and drift', () => {
  const compiled = compileHabitLearningRule({
    plan: fixturePlan(),
    ruleId: '1700000000000',
  });

  const forbidden = clone(compiled);
  forbidden.rule.nodes[0].type = 'deviceOutput';
  assert.throws(
    () => assertCompiledHabitLearningRule(forbidden),
    /forbidden or unknown node type "deviceOutput"/,
  );

  const unknownSource = clone(compiled);
  const mapped = unknownSource.sourceMap.sources.find((source) => source.kind === 'property');
  mapped.nodeId = 'n00000000000000000000000000000000';
  assert.throws(() => assertCompiledHabitLearningRule(unknownSource), /unknown source node/);

  const globalVariable = clone(compiled);
  globalVariable.localVariables[0].request.scope = 'global';
  assert.throws(() => assertCompiledHabitLearningRule(globalVariable), /must use local scope/);

  const semanticDrift = clone(compiled);
  const propertyNode = semanticDrift.rule.nodes.find(
    (node) => node.type === 'deviceInputSetVar' && 'preload' in node.props,
  );
  propertyNode.props.preload = false;
  assert.throws(() => assertCompiledHabitLearningRule(semanticDrift), /must set preload=true/);

  const layoutDrift = clone(compiled);
  layoutDrift.rule.nodes[0].cfg.pos.y += 1;
  assert.throws(() => assertCompiledHabitLearningRule(layoutDrift), /layout digest mismatch/);

  const enabled = clone(compiled);
  enabled.rule.cfg.enable = true;
  assert.throws(() => assertCompiledHabitLearningRule(enabled), /must remain disabled/);
});
