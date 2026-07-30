import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyHabitLearningPreloadBaselines,
  freezeHabitLearningSourceMap,
  intervalizeHabitLearningPersistentState,
  normalizeHabitLearningObservations,
  projectHabitLearningStateAsOf,
} from '../dist/usecases/habit-learning-observations.js';
import { parseLogLine } from '../dist/usecases/rule-logs.js';

function logs(lines) {
  return lines.map((line) => {
    const parsed = parseLogLine(line);
    assert.ok(parsed, line);
    return parsed;
  });
}

function source(result, sourceId) {
  const found = result.sources.find((entry) => entry.sourceId === sourceId);
  assert.ok(found, sourceId);
  return found;
}

test('preload classification uses an explicit rolling quiet period and hard cap', () => {
  const entries = logs([
    '3|900|r|rule-1|{"enable":true}',
    '3|1000|r|rule-1|{"enable":true}',
    '3|1010|i|rule-1|propertyOnce|[false]',
    '3|1020|i|rule-1|propertyTwice|[1]',
    '3|1050|i|rule-1|propertyTwice|[2]',
    '3|1051|l|rule-1|propertyOnce.output|support.input|false',
    '3|1200|i|rule-1|propertyLate|[true]',
  ]);
  const result = classifyHabitLearningPreloadBaselines({
    entries,
    ruleId: 'rule-1',
    expectedSourceIds: ['propertyOnce', 'propertyTwice', 'propertyLate', 'propertyAbsent'],
    quietPeriodMs: 100,
    hardCapMs: 300,
  });

  assert.deepEqual(result.boundary, {
    status: 'found',
    entryIndex: 1,
    timestamp: 1000,
    supersededCount: 1,
  });
  assert.deepEqual(result.window, {
    start: 1000,
    end: 1150,
    closedBy: 'quiet-period',
  });
  assert.deepEqual(
    [source(result, 'propertyOnce').status, source(result, 'propertyOnce').provenance],
    ['seen', 'single-info-within-window'],
  );
  assert.deepEqual(
    [source(result, 'propertyTwice').status, source(result, 'propertyTwice').provenance],
    ['ambiguous', 'multiple-info-within-window'],
  );
  assert.deepEqual(
    [source(result, 'propertyLate').status, source(result, 'propertyLate').provenance],
    ['ambiguous', 'first-info-after-window'],
  );
  assert.deepEqual(
    [source(result, 'propertyAbsent').status, source(result, 'propertyAbsent').provenance],
    ['missing', 'not-observed'],
  );
  assert.deepEqual(result.seenSourceIds, ['propertyOnce']);
  assert.deepEqual(result.missingSourceIds, ['propertyAbsent']);
  assert.deepEqual(result.ambiguousSourceIds, ['propertyTwice', 'propertyLate']);
});

test('preload classification reports a missing enable boundary and hard-cap closure', () => {
  const noBoundary = classifyHabitLearningPreloadBaselines({
    entries: logs(['3|1010|i|rule-1|property|[false]']),
    ruleId: 'rule-1',
    expectedSourceIds: ['property'],
    quietPeriodMs: 10,
    hardCapMs: 20,
  });
  assert.deepEqual(noBoundary.boundary, { status: 'missing' });
  assert.equal(noBoundary.window, undefined);
  assert.deepEqual(source(noBoundary, 'property'), {
    sourceId: 'property',
    status: 'ambiguous',
    provenance: 'enable-boundary-missing',
    entryIndexes: [],
    laterEntryIndexes: [0],
  });

  const hardCapped = classifyHabitLearningPreloadBaselines({
    entries: logs([
      '3|2000|r|rule-1|{"enable":true}',
      '3|2010|i|rule-1|a|[0]',
      '3|2080|i|rule-1|b|[0]',
      '3|2150|i|rule-1|c|[0]',
    ]),
    ruleId: 'rule-1',
    expectedSourceIds: ['a', 'b', 'c'],
    quietPeriodMs: 100,
    hardCapMs: 150,
  });
  assert.deepEqual(hardCapped.window, {
    start: 2000,
    end: 2150,
    closedBy: 'hard-cap',
  });
  assert.equal(source(hardCapped, 'c').status, 'seen');
});

test('preload classification closes as soon as every expected source is seen', () => {
  const completed = classifyHabitLearningPreloadBaselines({
    entries: logs([
      '3|2500|r|rule-1|{"enable":true}',
      '3|2510|i|rule-1|a|[0]',
      '3|2520|i|rule-1|b|[0]',
      '3|2520|i|rule-1|b|[0]',
      '3|2530|i|rule-1|a|[1]',
    ]),
    ruleId: 'rule-1',
    expectedSourceIds: ['a', 'b'],
    quietPeriodMs: 100,
    hardCapMs: 500,
  });

  assert.deepEqual(completed.window, {
    start: 2500,
    end: 2520,
    closedBy: 'all-expected-seen',
  });
  assert.deepEqual(source(completed, 'a'), {
    sourceId: 'a',
    status: 'seen',
    provenance: 'single-info-within-window',
    entryIndexes: [1],
    laterEntryIndexes: [4],
  });
  assert.deepEqual(source(completed, 'b'), {
    sourceId: 'b',
    status: 'ambiguous',
    provenance: 'multiple-info-within-window',
    entryIndexes: [2, 3],
    laterEntryIndexes: [],
  });
});

test('normalization accepts only frozen primary transports and preserves repeated same-ms events', () => {
  const sourceMap = freezeHabitLearningSourceMap({
    ruleId: 'rule-1',
    sources: [
      { sourceId: 'living.occupancy', kind: 'property', nodeId: 'occupancy' },
      {
        sourceId: 'door.action',
        kind: 'parameter-event',
        nodeId: 'doorEvent',
        valueIndex: 1,
      },
      {
        sourceId: 'doorbell.click',
        kind: 'zero-argument-event',
        firstHop: { src: 'doorbell.output', dst: 'merge.input1' },
      },
      {
        sourceId: 'button.click',
        kind: 'zero-argument-event',
        firstHop: { src: 'button.output', dst: 'merge.input2' },
      },
    ],
  });
  const entries = logs([
    '3|3000|i|rule-1|occupancy|[true]',
    '3|3000|l|rule-1|occupancy.output|merge.input0|true',
    '3|3001|i|rule-1|doorEvent|[7,"open"]',
    '3|3001|l|rule-1|doorEvent.output|merge.input3|null',
    '3|3002|l|rule-1|doorbell.output|merge.input1|null',
    '3|3002|l|rule-1|doorbell.output|merge.input1|null',
    '3|3002|l|rule-1|button.output|merge.input2|null',
    '3|3002|l|rule-1|merge.output|counter.input|null',
    '3|3002|i|rule-1|counter|[42]',
    '3|3003|i|other-rule|occupancy|[false]',
  ]);
  const observations = normalizeHabitLearningObservations(entries, sourceMap);

  assert.equal(Object.isFrozen(sourceMap), true);
  assert.equal(Object.isFrozen(sourceMap.sources), true);
  assert.deepEqual(
    observations.map(({ sourceId, kind, timestamp, value, evidence, entryIndex }) => ({
      sourceId,
      kind,
      timestamp,
      value,
      evidence,
      entryIndex,
    })),
    [
      {
        sourceId: 'living.occupancy',
        kind: 'property',
        timestamp: 3000,
        value: true,
        evidence: 'node-info',
        entryIndex: 0,
      },
      {
        sourceId: 'door.action',
        kind: 'parameter-event',
        timestamp: 3001,
        value: 'open',
        evidence: 'node-info',
        entryIndex: 2,
      },
      {
        sourceId: 'doorbell.click',
        kind: 'zero-argument-event',
        timestamp: 3002,
        value: null,
        evidence: 'first-hop-link',
        entryIndex: 4,
      },
      {
        sourceId: 'doorbell.click',
        kind: 'zero-argument-event',
        timestamp: 3002,
        value: null,
        evidence: 'first-hop-link',
        entryIndex: 5,
      },
      {
        sourceId: 'button.click',
        kind: 'zero-argument-event',
        timestamp: 3002,
        value: null,
        evidence: 'first-hop-link',
        entryIndex: 6,
      },
    ],
  );
  assert.throws(
    () =>
      normalizeHabitLearningObservations(entries, {
        ruleId: 'rule-1',
        sources: [],
      }),
    /source map must be created/,
  );
});

test('persistent-state intervals are censored at snapshots, gaps, and the observation end', () => {
  const observations = [
    { sourceId: 'presence', observedAt: 10, value: false, evidence: 'preload-snapshot' },
    { sourceId: 'presence', observedAt: 20, value: true, evidence: 'change' },
    { sourceId: 'presence', observedAt: 35, value: false, evidence: 'change' },
    { sourceId: 'presence', observedAt: 45, value: true, evidence: 'preload-snapshot' },
    { sourceId: 'presence', observedAt: 50, value: true, evidence: 'change' },
    { sourceId: 'other', observedAt: 55, value: 7, evidence: 'change' },
    { sourceId: 'presence', observedAt: 60, value: false, evidence: 'change' },
    { sourceId: 'presence', observedAt: 75, value: true, evidence: 'change' },
  ];
  const result = intervalizeHabitLearningPersistentState({
    observations,
    range: { start: 0, end: 70 },
    gaps: [{ start: 30, end: 40 }],
  });

  assert.equal(result.ignoredInsideGaps, 1);
  assert.equal(result.ignoredOutsideRange, 1);
  assert.deepEqual(
    result.intervals.filter((interval) => interval.sourceId === 'presence'),
    [
      {
        sourceId: 'presence',
        value: false,
        start: 10,
        end: 20,
        firstObservedAt: 10,
        lastObservedAt: 10,
        observationCount: 1,
        leftCensored: true,
        rightCensored: false,
        endedBy: 'change',
      },
      {
        sourceId: 'presence',
        value: true,
        start: 20,
        end: 30,
        firstObservedAt: 20,
        lastObservedAt: 20,
        observationCount: 1,
        leftCensored: false,
        rightCensored: true,
        endedBy: 'gap',
      },
      {
        sourceId: 'presence',
        value: true,
        start: 45,
        end: 60,
        firstObservedAt: 45,
        lastObservedAt: 50,
        observationCount: 2,
        leftCensored: true,
        rightCensored: false,
        endedBy: 'change',
      },
      {
        sourceId: 'presence',
        value: false,
        start: 60,
        end: 70,
        firstObservedAt: 60,
        lastObservedAt: 60,
        observationCount: 1,
        leftCensored: false,
        rightCensored: true,
        endedBy: 'window-end',
      },
    ],
  );
});

test('asOf returns last supporting observation and never carries state across a gap', () => {
  const observations = [
    { sourceId: 'presence', observedAt: 10, value: false, evidence: 'preload-snapshot' },
    { sourceId: 'presence', observedAt: 20, value: true, evidence: 'change' },
    { sourceId: 'presence', observedAt: 45, value: true, evidence: 'preload-snapshot' },
    { sourceId: 'presence', observedAt: 50, value: true, evidence: 'change' },
    { sourceId: 'presence', observedAt: 50, value: false, evidence: 'change' },
  ];
  const base = {
    observations,
    sourceId: 'presence',
    gaps: [{ start: 30, end: 40 }],
  };

  assert.deepEqual(projectHabitLearningStateAsOf({ ...base, timestamp: 29 }), {
    value: true,
    observedAt: 20,
    staleness: 9,
  });
  assert.equal(projectHabitLearningStateAsOf({ ...base, timestamp: 35 }), undefined);
  assert.equal(projectHabitLearningStateAsOf({ ...base, timestamp: 42 }), undefined);
  assert.deepEqual(projectHabitLearningStateAsOf({ ...base, timestamp: 49 }), {
    value: true,
    observedAt: 45,
    staleness: 4,
  });
  assert.deepEqual(projectHabitLearningStateAsOf({ ...base, timestamp: 50 }), {
    value: false,
    observedAt: 50,
    staleness: 0,
  });
});

test('invalid source maps, ordering, and overlapping gaps fail closed', () => {
  assert.throws(
    () =>
      freezeHabitLearningSourceMap({
        ruleId: 'rule-1',
        sources: [
          { sourceId: 'a', kind: 'property', nodeId: 'same' },
          { sourceId: 'b', kind: 'property', nodeId: 'same' },
        ],
      }),
    /duplicate habit-learning primary transport/,
  );
  assert.throws(
    () =>
      intervalizeHabitLearningPersistentState({
        observations: [
          { sourceId: 'state', observedAt: 2, value: true, evidence: 'change' },
          { sourceId: 'state', observedAt: 1, value: false, evidence: 'change' },
        ],
        range: { start: 0, end: 10 },
      }),
    /ordered oldest first/,
  );
  assert.throws(
    () =>
      projectHabitLearningStateAsOf({
        observations: [],
        sourceId: 'state',
        timestamp: 5,
        gaps: [
          { start: 1, end: 4 },
          { start: 3, end: 6 },
        ],
      }),
    /must not overlap/,
  );
});
