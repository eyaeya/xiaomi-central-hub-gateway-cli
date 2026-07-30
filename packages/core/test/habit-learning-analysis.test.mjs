import assert from 'node:assert/strict';
import test from 'node:test';

import { buildHabitLearningProfileEvidence } from '../dist/usecases/habit-learning-analysis.js';
import {
  freezeHabitLearningSourceMap,
  normalizeHabitLearningObservations,
} from '../dist/usecases/habit-learning-observations.js';
import { parseLogLine } from '../dist/usecases/rule-logs.js';

const RULE_ID = 'synthetic-rule';
const DEVICE_KEY = `device_${'a'.repeat(32)}`;
const SIGNALS = {
  occupancy: 'a'.repeat(64),
  illuminance: 'b'.repeat(64),
  power: 'c'.repeat(64),
  enter: 'd'.repeat(64),
  exit: 'e'.repeat(64),
  button: 'f'.repeat(64),
  excluded: '0'.repeat(64),
};

function logs(lines) {
  return lines.map((line) => {
    const parsed = parseLogLine(line);
    assert.ok(parsed, line);
    return parsed;
  });
}

function fixture() {
  const entries = logs([
    `3|1000|r|${RULE_ID}|{"enable":true}`,
    `3|1010|i|${RULE_ID}|occupancy|[false]`,
    `3|1020|i|${RULE_ID}|illuminance|[5]`,
    `3|1030|i|${RULE_ID}|power|[10]`,
    `3|1030|i|${RULE_ID}|power|[11]`,
    `3|1100|i|${RULE_ID}|regionEnter|["A-4"]`,
    `3|1110|i|${RULE_ID}|occupancy|[true]`,
    `3|1200|i|${RULE_ID}|regionExit|["A-4"]`,
    `3|1290|i|${RULE_ID}|regionEnter|["A-4"]`,
    `3|1350|i|${RULE_ID}|occupancy|[true]`,
    `3|1410|i|${RULE_ID}|regionExit|["A-4"]`,
    `3|1420|i|${RULE_ID}|occupancy|[false]`,
    `3|1500|l|${RULE_ID}|button.output|marker.input|null`,
  ]);
  const sourceMap = freezeHabitLearningSourceMap({
    ruleId: RULE_ID,
    sources: [
      {
        sourceId: 'occupancy-state',
        kind: 'property',
        nodeId: 'occupancy',
      },
      {
        sourceId: 'illuminance-state',
        kind: 'property',
        nodeId: 'illuminance',
      },
      {
        sourceId: 'power-state',
        kind: 'property',
        nodeId: 'power',
      },
      {
        sourceId: 'region-enter',
        kind: 'parameter-event',
        nodeId: 'regionEnter',
        valueIndex: 0,
      },
      {
        sourceId: 'region-exit',
        kind: 'parameter-event',
        nodeId: 'regionExit',
        valueIndex: 0,
      },
      {
        sourceId: 'button-click',
        kind: 'zero-argument-event',
        firstHop: {
          src: 'button.output',
          dst: 'marker.input',
        },
      },
    ],
  });
  const observations = normalizeHabitLearningObservations(entries, sourceMap);
  const sources = [
    {
      sourceId: 'occupancy-state',
      signalId: SIGNALS.occupancy,
      deviceKey: DEVICE_KEY,
      included: true,
      analysisKind: 'persistent-property',
      preloadNodeId: 'occupancy',
    },
    {
      sourceId: 'illuminance-state',
      signalId: SIGNALS.illuminance,
      deviceKey: DEVICE_KEY,
      included: true,
      analysisKind: 'persistent-property',
      preloadNodeId: 'illuminance',
    },
    {
      sourceId: 'power-state',
      signalId: SIGNALS.power,
      deviceKey: DEVICE_KEY,
      included: true,
      analysisKind: 'persistent-property',
      preloadNodeId: 'power',
    },
    {
      sourceId: 'region-enter',
      signalId: SIGNALS.enter,
      deviceKey: DEVICE_KEY,
      included: true,
      analysisKind: 'parameter-event-start',
      channelKey: 'raw-region-occupancy',
    },
    {
      sourceId: 'region-exit',
      signalId: SIGNALS.exit,
      deviceKey: DEVICE_KEY,
      included: true,
      analysisKind: 'parameter-event-end',
      channelKey: 'raw-region-occupancy',
    },
    {
      sourceId: 'button-click',
      signalId: SIGNALS.button,
      deviceKey: DEVICE_KEY,
      included: true,
      analysisKind: 'point-event',
    },
  ];
  const planSignals = [
    ...sources.map((source) => ({ signalId: source.signalId, included: true })),
    { signalId: SIGNALS.excluded, included: false },
  ];
  return { entries, observations, sources, planSignals };
}

function build(overrides = {}) {
  const current = fixture();
  return buildHabitLearningProfileEvidence({
    entries: current.entries,
    observations: current.observations,
    sources: current.sources,
    planSignals: current.planSignals,
    range: { start: 1_000, end: 1_600 },
    gaps: [{ gapId: 'collector-gap', start: 1_300, end: 1_400 }],
    baseline: {
      ruleId: RULE_ID,
      quietPeriodMs: 100,
      hardCapMs: 300,
    },
    debounceMs: 100,
    continuityEvidence: 'continuous',
    ...overrides,
  });
}

test('analysis excludes preload behavior, reanchors after gaps, and preserves provenance', () => {
  const result = build();

  assert.deepEqual(result.baseline.seenSourceIds, ['illuminance', 'occupancy']);
  assert.deepEqual(result.baseline.ambiguousSourceIds, ['power']);
  assert.deepEqual(
    result.classifiedObservations.map((observation) => [
      observation.sourceId,
      observation.observedAt,
      observation.value,
      observation.classification,
      observation.provenance.entryIndex,
    ]),
    [
      ['occupancy-state', 1_010, false, 'preload-baseline', 1],
      ['illuminance-state', 1_020, 5, 'preload-baseline', 2],
      ['power-state', 1_030, 10, 'baseline-ambiguous', 3],
      ['power-state', 1_030, 11, 'baseline-ambiguous', 4],
      ['region-enter', 1_100, 'A-4', 'behavior', 5],
      ['occupancy-state', 1_110, true, 'behavior', 6],
      ['region-exit', 1_200, 'A-4', 'behavior', 7],
      ['region-enter', 1_290, 'A-4', 'behavior', 8],
      ['occupancy-state', 1_350, true, 'inside-gap', 9],
      ['region-exit', 1_410, 'A-4', 'behavior', 10],
      ['occupancy-state', 1_420, false, 'gap-reanchor', 11],
      ['button-click', 1_500, null, 'behavior', 12],
    ],
  );
  assert.ok(
    result.classifiedObservations.every(
      (observation) =>
        observation.inferenceBoundary === 'sensor-evidence-only-no-person-or-household-inference' &&
        observation.provenance.rawRef === `rule-log-entry:${observation.provenance.entryIndex}`,
    ),
  );
  assert.equal(
    result.behaviorObservations.some(
      (observation) =>
        observation.classification === 'preload-baseline' ||
        observation.classification === 'gap-reanchor',
    ),
    false,
  );

  assert.deepEqual(
    result.stateIntervals.map(
      ({ sourceId, value, start, end, leftCensored, rightCensored, endedBy, observationIds }) => ({
        sourceId,
        value,
        start,
        end,
        leftCensored,
        rightCensored,
        endedBy,
        evidenceCount: observationIds.length,
      }),
    ),
    [
      {
        sourceId: 'occupancy-state',
        value: false,
        start: 1_010,
        end: 1_110,
        leftCensored: true,
        rightCensored: false,
        endedBy: 'change',
        evidenceCount: 1,
      },
      {
        sourceId: 'illuminance-state',
        value: 5,
        start: 1_020,
        end: 1_300,
        leftCensored: true,
        rightCensored: true,
        endedBy: 'gap',
        evidenceCount: 1,
      },
      {
        sourceId: 'occupancy-state',
        value: true,
        start: 1_110,
        end: 1_300,
        leftCensored: false,
        rightCensored: true,
        endedBy: 'gap',
        evidenceCount: 1,
      },
      {
        sourceId: 'occupancy-state',
        value: false,
        start: 1_420,
        end: 1_600,
        leftCensored: true,
        rightCensored: true,
        endedBy: 'window-end',
        evidenceCount: 1,
      },
    ],
  );
  assert.ok(result.stateIntervals.every((interval) => interval.rawRefs.length > 0));
});

test('raw region parameters pair and debounce only within continuous segments', () => {
  const result = build();

  assert.deepEqual(
    result.parameterIntervals.map(
      ({ parameterValue, start, end, leftCensored, rightCensored, endedBy }) => ({
        parameterValue,
        start,
        end,
        leftCensored,
        rightCensored,
        endedBy,
      }),
    ),
    [
      {
        parameterValue: 'A-4',
        start: 1_100,
        end: 1_200,
        leftCensored: false,
        rightCensored: false,
        endedBy: 'end-event',
      },
      {
        parameterValue: 'A-4',
        start: 1_290,
        end: 1_300,
        leftCensored: false,
        rightCensored: true,
        endedBy: 'gap',
      },
      {
        parameterValue: 'A-4',
        start: 1_400,
        end: 1_410,
        leftCensored: true,
        rightCensored: false,
        endedBy: 'end-event',
      },
    ],
  );
  assert.deepEqual(
    result.parameterEpisodes.map(
      ({ parameterValue, start, end, intervalIds, leftCensored, rightCensored }) => ({
        parameterValue,
        start,
        end,
        intervalCount: intervalIds.length,
        leftCensored,
        rightCensored,
      }),
    ),
    [
      {
        parameterValue: 'A-4',
        start: 1_100,
        end: 1_300,
        intervalCount: 2,
        leftCensored: false,
        rightCensored: true,
      },
      {
        parameterValue: 'A-4',
        start: 1_400,
        end: 1_410,
        intervalCount: 1,
        leftCensored: true,
        rightCensored: false,
      },
    ],
  );
  assert.equal(JSON.stringify(result).includes('bedroom'), false);
  assert.deepEqual(result.inferencePolicy, {
    regionKeys: 'opaque-until-user-confirmed',
    householdSizeInference: 'prohibited',
    personIdentityInference: 'prohibited',
    roomSemanticsInference: 'prohibited',
  });
});

test('coverage separates runtime observation, behavior, anchors, ambiguity, and completeness', () => {
  const result = build();

  assert.deepEqual(result.coverage, {
    plannedSignalIds: [
      SIGNALS.excluded,
      SIGNALS.occupancy,
      SIGNALS.illuminance,
      SIGNALS.power,
      SIGNALS.enter,
      SIGNALS.exit,
      SIGNALS.button,
    ],
    includedSignalIds: [
      SIGNALS.occupancy,
      SIGNALS.illuminance,
      SIGNALS.power,
      SIGNALS.enter,
      SIGNALS.exit,
      SIGNALS.button,
    ],
    excludedSignalIds: [SIGNALS.excluded],
    expectedPreloadSignalIds: [SIGNALS.occupancy, SIGNALS.illuminance, SIGNALS.power],
    baselineSeenSignalIds: [SIGNALS.occupancy, SIGNALS.illuminance],
    observedSignalIds: [
      SIGNALS.occupancy,
      SIGNALS.illuminance,
      SIGNALS.enter,
      SIGNALS.exit,
      SIGNALS.button,
    ],
    behaviorObservedSignalIds: [SIGNALS.occupancy, SIGNALS.enter, SIGNALS.exit, SIGNALS.button],
    baselineOnlySignalIds: [SIGNALS.illuminance],
    stateAnchorOnlySignalIds: [SIGNALS.illuminance],
    ambiguousSignalIds: [SIGNALS.power],
    missingSignalIds: [],
  });
  assert.deepEqual(result.completenessInput, {
    plannedSignalIds: result.coverage.plannedSignalIds,
    includedSignalIds: result.coverage.includedSignalIds,
    observedSignalIds: result.coverage.behaviorObservedSignalIds,
    gapIds: ['collector-gap'],
    continuityEvidence: 'continuous',
  });
  assert.equal(result.completeness.status, 'bounded');
  assert.equal(result.completeness.collectorContinuity, 'gapped');
  assert.equal(result.completeness.plannedSignalCount, 7);
  assert.equal(result.completeness.includedSignalCount, 6);
  assert.equal(result.completeness.observedSignalCount, 4);
  assert.equal(result.completeness.provesAllHouseholdBehavior, false);
  assert.equal(result.completeness.householdSizeInference, 'prohibited');
  assert.equal(result.completeness.personIdentityInference, 'prohibited');
  assert.deepEqual(
    result.pointEvents.map((observation) => [observation.sourceId, observation.value]),
    [['button-click', null]],
  );
});

test('without a trustworthy enable boundary, property rows remain ambiguous', () => {
  const entries = logs([`3|1010|i|${RULE_ID}|occupancy|[false]`]);
  const sourceMap = freezeHabitLearningSourceMap({
    ruleId: RULE_ID,
    sources: [{ sourceId: 'occupancy-state', kind: 'property', nodeId: 'occupancy' }],
  });
  const result = buildHabitLearningProfileEvidence({
    entries,
    observations: normalizeHabitLearningObservations(entries, sourceMap),
    sources: [
      {
        sourceId: 'occupancy-state',
        signalId: SIGNALS.occupancy,
        deviceKey: DEVICE_KEY,
        included: true,
        analysisKind: 'persistent-property',
        preloadNodeId: 'occupancy',
      },
    ],
    range: { start: 1_000, end: 1_100 },
    baseline: {
      ruleId: RULE_ID,
      quietPeriodMs: 10,
      hardCapMs: 20,
    },
    debounceMs: 0,
    continuityEvidence: 'unknown',
  });

  assert.deepEqual(result.baseline.boundary, { status: 'missing' });
  assert.equal(result.classifiedObservations[0].classification, 'baseline-ambiguous');
  assert.deepEqual(result.stateIntervals, []);
  assert.deepEqual(result.coverage.ambiguousSignalIds, [SIGNALS.occupancy]);
  assert.deepEqual(result.coverage.behaviorObservedSignalIds, []);
  assert.equal(result.completeness.status, 'insufficient');
});

test('analysis isolates one enable epoch and ignores later epochs outside the range', () => {
  const sourceMap = freezeHabitLearningSourceMap({
    ruleId: RULE_ID,
    sources: [{ sourceId: 'occupancy-state', kind: 'property', nodeId: 'occupancy' }],
  });
  const source = {
    sourceId: 'occupancy-state',
    signalId: SIGNALS.occupancy,
    deviceKey: DEVICE_KEY,
    included: true,
    analysisKind: 'persistent-property',
    preloadNodeId: 'occupancy',
  };
  const entriesWithLaterEpoch = logs([
    `3|1000|r|${RULE_ID}|{"enable":true}`,
    `3|1010|i|${RULE_ID}|occupancy|[false]`,
    `3|2000|r|${RULE_ID}|{"enable":true}`,
    `3|2010|i|${RULE_ID}|occupancy|[true]`,
  ]);
  const isolated = buildHabitLearningProfileEvidence({
    entries: entriesWithLaterEpoch,
    observations: normalizeHabitLearningObservations(entriesWithLaterEpoch, sourceMap),
    sources: [source],
    range: { start: 1_000, end: 1_500 },
    baseline: {
      ruleId: RULE_ID,
      quietPeriodMs: 20,
      hardCapMs: 100,
    },
    debounceMs: 0,
    continuityEvidence: 'unknown',
  });
  assert.deepEqual(isolated.baseline.boundary, {
    status: 'found',
    entryIndex: 0,
    timestamp: 1_000,
    supersededCount: 0,
  });
  assert.deepEqual(
    isolated.classifiedObservations.map((observation) => observation.classification),
    ['preload-baseline', 'outside-range'],
  );

  const reenabled = logs([
    `3|1000|r|${RULE_ID}|{"enable":true}`,
    `3|1010|i|${RULE_ID}|occupancy|[false]`,
    `3|1200|r|${RULE_ID}|{"enable":false}`,
    `3|1210|r|${RULE_ID}|{"enable":true}`,
    `3|1220|i|${RULE_ID}|occupancy|[true]`,
  ]);
  assert.throws(
    () =>
      buildHabitLearningProfileEvidence({
        entries: reenabled,
        observations: normalizeHabitLearningObservations(reenabled, sourceMap),
        sources: [source],
        range: { start: 1_000, end: 1_300 },
        baseline: {
          ruleId: RULE_ID,
          quietPeriodMs: 20,
          hardCapMs: 100,
        },
        debounceMs: 0,
        continuityEvidence: 'unknown',
      }),
    /crosses a disable or re-enable lifecycle boundary/,
  );
});

test('preload just before the observation clock anchors state at range start', () => {
  const entries = logs([
    `3|995|r|${RULE_ID}|{"enable":true}`,
    `3|998|i|${RULE_ID}|occupancy|[false]`,
    `3|1200|i|${RULE_ID}|occupancy|[true]`,
  ]);
  const sourceMap = freezeHabitLearningSourceMap({
    ruleId: RULE_ID,
    sources: [{ sourceId: 'occupancy-state', kind: 'property', nodeId: 'occupancy' }],
  });
  const result = buildHabitLearningProfileEvidence({
    entries,
    observations: normalizeHabitLearningObservations(entries, sourceMap),
    sources: [
      {
        sourceId: 'occupancy-state',
        signalId: SIGNALS.occupancy,
        deviceKey: DEVICE_KEY,
        included: true,
        analysisKind: 'persistent-property',
        preloadNodeId: 'occupancy',
      },
    ],
    range: { start: 1_000, end: 1_300 },
    baseline: {
      ruleId: RULE_ID,
      quietPeriodMs: 20,
      hardCapMs: 100,
      enableBoundary: { entryIndex: 0, timestamp: 995 },
    },
    debounceMs: 0,
    continuityEvidence: 'unknown',
  });
  assert.deepEqual(
    result.classifiedObservations.map(({ observedAt, classification }) => ({
      observedAt,
      classification,
    })),
    [
      { observedAt: 998, classification: 'preload-baseline' },
      { observedAt: 1_200, classification: 'behavior' },
    ],
  );
  assert.deepEqual(
    result.stateIntervals.map(({ value, start, end, firstObservedAt, leftCensored }) => ({
      value,
      start,
      end,
      firstObservedAt,
      leftCensored,
    })),
    [
      {
        value: false,
        start: 1_000,
        end: 1_200,
        firstObservedAt: 998,
        leftCensored: true,
      },
      {
        value: true,
        start: 1_200,
        end: 1_300,
        firstObservedAt: 1_200,
        leftCensored: false,
      },
    ],
  );
});

test('analysis fails closed when a collector gap crosses the preload window', () => {
  const entries = logs([
    `3|1000|r|${RULE_ID}|{"enable":true}`,
    `3|1100|i|${RULE_ID}|occupancy|[false]`,
  ]);
  const sourceMap = freezeHabitLearningSourceMap({
    ruleId: RULE_ID,
    sources: [{ sourceId: 'occupancy-state', kind: 'property', nodeId: 'occupancy' }],
  });
  assert.throws(
    () =>
      buildHabitLearningProfileEvidence({
        entries,
        observations: normalizeHabitLearningObservations(entries, sourceMap),
        sources: [
          {
            sourceId: 'occupancy-state',
            signalId: SIGNALS.occupancy,
            deviceKey: DEVICE_KEY,
            included: true,
            analysisKind: 'persistent-property',
            preloadNodeId: 'occupancy',
          },
        ],
        range: { start: 1_000, end: 1_300 },
        gaps: [{ gapId: 'preload-gap', start: 1_050, end: 1_080 }],
        baseline: {
          ruleId: RULE_ID,
          quietPeriodMs: 200,
          hardCapMs: 300,
        },
        debounceMs: 0,
        continuityEvidence: 'unknown',
      }),
    /baseline preload window intersects collector gap preload-gap/,
  );
});

test('same-ms late baselines and contradictory post-gap anchors stay ambiguous', () => {
  const lateEntries = logs([
    `3|1000|r|${RULE_ID}|{"enable":true}`,
    `3|1100|i|${RULE_ID}|occupancy|[false]`,
    `3|1100|i|${RULE_ID}|occupancy|[true]`,
  ]);
  const sourceMap = freezeHabitLearningSourceMap({
    ruleId: RULE_ID,
    sources: [{ sourceId: 'occupancy-state', kind: 'property', nodeId: 'occupancy' }],
  });
  const source = {
    sourceId: 'occupancy-state',
    signalId: SIGNALS.occupancy,
    deviceKey: DEVICE_KEY,
    included: true,
    analysisKind: 'persistent-property',
    preloadNodeId: 'occupancy',
  };
  const late = buildHabitLearningProfileEvidence({
    entries: lateEntries,
    observations: normalizeHabitLearningObservations(lateEntries, sourceMap),
    sources: [source],
    range: { start: 1_000, end: 1_200 },
    baseline: {
      ruleId: RULE_ID,
      quietPeriodMs: 10,
      hardCapMs: 20,
    },
    debounceMs: 0,
    continuityEvidence: 'unknown',
  });
  assert.deepEqual(
    late.classifiedObservations.map((observation) => observation.classification),
    ['baseline-ambiguous', 'baseline-ambiguous'],
  );
  assert.deepEqual(late.stateIntervals, []);

  const gapEntries = logs([
    `3|1000|r|${RULE_ID}|{"enable":true}`,
    `3|1010|i|${RULE_ID}|occupancy|[false]`,
    `3|1210|i|${RULE_ID}|occupancy|[false]`,
    `3|1210|i|${RULE_ID}|occupancy|[true]`,
  ]);
  const afterGap = buildHabitLearningProfileEvidence({
    entries: gapEntries,
    observations: normalizeHabitLearningObservations(gapEntries, sourceMap),
    sources: [source],
    range: { start: 1_000, end: 1_300 },
    gaps: [{ gapId: 'gap', start: 1_100, end: 1_200 }],
    baseline: {
      ruleId: RULE_ID,
      quietPeriodMs: 20,
      hardCapMs: 100,
    },
    debounceMs: 0,
    continuityEvidence: 'continuous',
  });
  assert.deepEqual(
    afterGap.classifiedObservations.map((observation) => observation.classification),
    ['preload-baseline', 'baseline-ambiguous', 'baseline-ambiguous'],
  );
  assert.deepEqual(
    afterGap.stateIntervals.map(({ value, start, end }) => ({ value, start, end })),
    [{ value: false, start: 1_010, end: 1_100 }],
  );
});

test('analysis fails closed for missing semantics, incompatible kinds, and aggregate parameters', () => {
  const current = fixture();
  assert.throws(
    () =>
      build({
        sources: current.sources.filter((source) => source.sourceId !== 'button-click'),
      }),
    /included plan signal .* has no source semantics/,
  );
  assert.throws(
    () =>
      build({
        sources: current.sources.map((source) =>
          source.sourceId === 'occupancy-state'
            ? {
                ...source,
                analysisKind: 'point-event',
              }
            : source,
        ),
      }),
    /kind property is incompatible with point-event/,
  );
  assert.throws(
    () =>
      build({
        observations: current.observations.map((observation) =>
          observation.sourceId === 'region-enter' && observation.observedAt === 1_100
            ? { ...observation, value: ['A-4', 'unexpected-second-argument'] }
            : observation,
        ),
      }),
    /must contain one scalar parameter value/,
  );
  assert.throws(
    () =>
      build({
        sources: current.sources.filter((source) => source.sourceId !== 'region-exit'),
        observations: current.observations.filter(
          (observation) => observation.sourceId !== 'region-exit',
        ),
      }),
    /requires reviewed start and end semantics/,
  );
});
