import assert from 'node:assert/strict';
import test from 'node:test';

import { HabitLearningProfileSchema } from '../dist/schemas/habit-learning-profile.js';
import {
  assessHabitLearningProfileCompleteness,
  buildHabitLearningRegionClarificationQuestions,
  createHabitLearningCorrection,
  deriveHabitLearningAnonymousDeviceKey,
  deriveHabitLearningHypotheses,
  evaluateHabitLearningProfileFreshness,
  generateHabitLearningProfile,
  resolveHabitLearningCorrectionsAsOf,
} from '../dist/usecases/habit-learning-profile.js';

const OBSERVATION_1 = '1'.repeat(64);
const OBSERVATION_2 = '2'.repeat(64);
const HYPOTHESIS = '3'.repeat(64);
const CONSTRAINT = '4'.repeat(64);
const SEMANTIC_DIGEST = 'a'.repeat(64);
const INVENTORY_HASH = 'b'.repeat(64);
const PLAN_ID = 'e'.repeat(64);

function correction(input) {
  return createHabitLearningCorrection({
    correctionIdMaterial: { fixture: input.fixture },
    recordedAt: input.recordedAt,
    asOf: input.asOf,
    subject: input.subject,
    value: input.value,
    source: input.source ?? 'user-direct',
    ...(input.supersedes !== undefined && { supersedes: input.supersedes }),
  });
}

test('anonymous device keys are stable within one secret and unlinkable across secrets', () => {
  const did = 'synthetic-device-id-for-test';
  const first = deriveHabitLearningAnonymousDeviceKey({
    secret: Buffer.alloc(32, 1),
    did,
  });
  const repeated = deriveHabitLearningAnonymousDeviceKey({
    secret: Buffer.alloc(32, 1),
    did,
  });
  const otherStudy = deriveHabitLearningAnonymousDeviceKey({
    secret: Buffer.alloc(32, 2),
    did,
  });

  assert.equal(first, repeated);
  assert.notEqual(first, otherStudy);
  assert.match(first, /^device_[a-f0-9]{32}$/);
  assert.equal(first.includes(did), false);
  assert.throws(
    () =>
      deriveHabitLearningAnonymousDeviceKey({
        secret: Buffer.alloc(16, 1),
        did,
      }),
    /at least 32 bytes/,
  );
});

test('append-only corrections retain history and resolve by semantic and knowledge time', () => {
  const deviceKey = deriveHabitLearningAnonymousDeviceKey({
    secret: Buffer.alloc(32, 3),
    did: 'synthetic-bedroom-sensor',
  });
  const firstRegion = correction({
    fixture: 'region-v1',
    recordedAt: 200,
    asOf: 100,
    subject: { kind: 'region-label', deviceKey, label: 'A-4', mapBank: 'A' },
    value: { meaning: 'sleep-zone' },
    source: 'user-mi-home-app',
  });
  const residents = correction({
    fixture: 'resident-count',
    recordedAt: 250,
    asOf: 100,
    subject: { kind: 'household-fact', field: 'resident-count' },
    value: 2,
  });
  const correctedRegion = correction({
    fixture: 'region-v2',
    recordedAt: 400,
    asOf: 300,
    subject: { kind: 'region-label', deviceKey, label: 'A-4', mapBank: 'A' },
    value: { meaning: 'bed' },
    source: 'user-mi-home-app',
    supersedes: firstRegion.correctionId,
  });
  const journal = [firstRegion, residents, correctedRegion];

  const historical = resolveHabitLearningCorrectionsAsOf({
    corrections: journal,
    asOf: 250,
    knownAt: 300,
  });
  assert.deepEqual(
    historical.map((entry) => [entry.correctionId, entry.value]),
    [
      [residents.correctionId, 2],
      [firstRegion.correctionId, { meaning: 'sleep-zone' }],
    ],
  );

  const current = resolveHabitLearningCorrectionsAsOf({
    corrections: journal,
    asOf: 500,
    knownAt: 500,
  });
  assert.deepEqual(
    current.map((entry) => [entry.correctionId, entry.value]),
    [
      [residents.correctionId, 2],
      [correctedRegion.correctionId, { meaning: 'bed' }],
    ],
  );
  assert.equal(journal.length, 3, 'resolution must not rewrite append-only evidence');

  assert.throws(
    () =>
      resolveHabitLearningCorrectionsAsOf({
        corrections: [residents, firstRegion],
        asOf: 500,
      }),
    /append order by recordedAt/,
  );
  const wrongSubject = correction({
    fixture: 'wrong-subject',
    recordedAt: 500,
    asOf: 400,
    subject: { kind: 'household-fact', field: 'pet-presence' },
    value: true,
    supersedes: correctedRegion.correctionId,
  });
  assert.throws(
    () =>
      resolveHabitLearningCorrectionsAsOf({
        corrections: [...journal, wrongSubject],
        asOf: 500,
      }),
    /different subject/,
  );
});

test('region questions are grouped by anonymous device and omit already confirmed labels', () => {
  const deviceKey = deriveHabitLearningAnonymousDeviceKey({
    secret: Buffer.alloc(32, 4),
    did: 'synthetic-region-sensor',
  });
  const confirmed = correction({
    fixture: 'confirmed-a4',
    recordedAt: 300,
    asOf: 100,
    subject: { kind: 'region-label', deviceKey, label: 'A-4', mapBank: 'A' },
    value: { meaning: 'bed' },
    source: 'user-mi-home-app',
  });
  const questions = buildHabitLearningRegionClarificationQuestions({
    asOf: 500,
    knownAt: 500,
    corrections: [confirmed],
    regions: [
      {
        deviceKey,
        label: 'A-4',
        mapBank: 'A',
        observedAt: 120,
        observationId: 'region-a4',
      },
      {
        deviceKey,
        label: 'A-5',
        mapBank: 'A',
        observedAt: 130,
        observationId: 'region-a5-1',
      },
      {
        deviceKey,
        label: 'A-5',
        mapBank: 'A',
        observedAt: 180,
        observationId: 'region-a5-2',
      },
    ],
  });

  assert.equal(questions.length, 1);
  assert.equal(questions[0].deviceKey, deviceKey);
  assert.deepEqual(questions[0].unresolvedRegions, [
    {
      label: 'A-5',
      mapBank: 'A',
      firstObservedAt: 130,
      lastObservedAt: 180,
      observationCount: 2,
      observationIds: ['region-a5-1', 'region-a5-2'],
    },
  ]);
  assert.deepEqual(
    questions[0].prompts.map((prompt) => prompt.kind),
    ['region-meaning', 'active-map-bank', 'unused-regions'],
  );
  assert.deepEqual(questions[0].prompts[1].candidateMapBanks, ['A']);
  assert.equal(JSON.stringify(questions).includes('synthetic-region-sensor'), false);
});

test('completeness preserves permanent limitations and never claims all behavior', () => {
  const bounded = assessHabitLearningProfileCompleteness({
    plannedSignalIds: ['signal-1', 'signal-2', 'signal-3'],
    includedSignalIds: ['signal-1', 'signal-2'],
    observedSignalIds: ['signal-1'],
    gapIds: ['poll-gap'],
    continuityEvidence: 'continuous',
  });
  assert.deepEqual(
    {
      status: bounded.status,
      usable: bounded.usableForHabitInference,
      continuity: bounded.collectorContinuity,
      gapCount: bounded.gapCount,
      ratio: bounded.observedCoverageRatio,
      provesAll: bounded.provesAllHouseholdBehavior,
      householdSizeInference: bounded.householdSizeInference,
      personIdentityInference: bounded.personIdentityInference,
    },
    {
      status: 'bounded',
      usable: 'yes-with-bounds',
      continuity: 'gapped',
      gapCount: 1,
      ratio: 0.5,
      provesAll: false,
      householdSizeInference: 'prohibited',
      personIdentityInference: 'prohibited',
    },
  );
  assert.ok(bounded.reasonCodes.includes('gateway-retention-unknown'));
  assert.ok(bounded.reasonCodes.includes('household-membership-not-observed'));
  assert.ok(bounded.reasonCodes.includes('collector-gaps-present'));

  const sufficient = assessHabitLearningProfileCompleteness({
    plannedSignalIds: ['signal-1', 'signal-2'],
    includedSignalIds: ['signal-1', 'signal-2'],
    observedSignalIds: ['signal-1', 'signal-2'],
    continuityEvidence: 'continuous',
  });
  assert.equal(sufficient.status, 'sufficient');

  const insufficient = assessHabitLearningProfileCompleteness({
    plannedSignalIds: ['signal-1'],
    includedSignalIds: ['signal-1'],
    observedSignalIds: [],
    continuityEvidence: 'unknown',
  });
  assert.equal(insufficient.status, 'insufficient');
  assert.equal(insufficient.usableForHabitInference, 'no');

  assert.throws(
    () =>
      assessHabitLearningProfileCompleteness({
        plannedSignalIds: ['signal-1'],
        includedSignalIds: ['signal-2'],
        observedSignalIds: [],
        continuityEvidence: 'unknown',
      }),
    /must be a subset/,
  );
});

test('hypothesis derivation requires cross-date routines and repeated opaque-region order', () => {
  const deviceKey = deriveHabitLearningAnonymousDeviceKey({
    secret: Buffer.alloc(32, 8),
    did: 'synthetic-hypothesis-sensor',
  });
  const episode = (id, start, end, parameterValue, gapIds = []) => ({
    observationId: id.repeat(64),
    kind: 'episode',
    deviceKey,
    signalKey: 'zone-presence',
    observedFrom: Date.parse(start),
    observedUntil: Date.parse(end),
    value: {
      parameterValue,
      parameterSemantic: {
        rawValue: parameterValue,
        valueAuthority: 'raw-gateway-log',
        capabilityUrn: 'urn:miot-spec-v2:property:zone-id:000000D2',
        capabilityDescription: 'zone-id',
        semanticAuthority: 'miot-spec',
        regionIdentifier: true,
      },
      spanMs: Date.parse(end) - Date.parse(start),
      observedActiveMs: Date.parse(end) - Date.parse(start),
      debouncedInactiveMs: 0,
      debounceMs: 5_000,
      leftCensored: false,
      rightCensored: false,
      ambiguous: false,
    },
    evidenceRefs: [`episode:${id}`],
    gapIds,
    certainty: 'direct',
  });
  const peopleState = (id, start, end) => ({
    observationId: id.repeat(64),
    kind: 'state-interval',
    deviceKey,
    signalKey: 'people-num',
    observedFrom: Date.parse(start),
    observedUntil: Date.parse(end),
    value: {
      state: {
        rawValue: 2,
        valueAuthority: 'raw-gateway-log',
        capabilityUrn: 'urn:miot-spec-v2:property:people-num:000000D1',
        capabilityDescription: 'people-num',
        semanticAuthority: 'miot-spec',
      },
      firstObservedAt: Date.parse(start),
      lastObservedAt: Date.parse(start),
      observationCount: 1,
      leftCensored: false,
      rightCensored: false,
      endedBy: 'change',
    },
    count: { min: 1, max: 1 },
    evidenceRefs: [`state:${id}`],
    gapIds: [],
    certainty: 'direct',
  });
  const observations = [
    episode('5', '2026-07-28T08:00:00+08:00', '2026-07-28T08:01:00+08:00', 'A-4'),
    episode('6', '2026-07-28T08:03:00+08:00', '2026-07-28T08:04:00+08:00', 'A-5'),
    peopleState('9', '2026-07-28T07:55:00+08:00', '2026-07-28T07:56:00+08:00'),
    episode('7', '2026-07-29T08:10:00+08:00', '2026-07-29T08:11:00+08:00', 'A-4'),
    episode('8', '2026-07-29T08:13:00+08:00', '2026-07-29T08:14:00+08:00', 'A-5'),
    peopleState('a', '2026-07-29T08:05:00+08:00', '2026-07-29T08:06:00+08:00'),
  ];
  const input = {
    observations,
    timezone: 'Asia/Shanghai',
  };
  const unconfirmed = deriveHabitLearningHypotheses(input);
  assert.equal(
    unconfirmed.some(({ subject }) => subject === 'region-topology'),
    false,
    'opaque region order must not become topology before applicable user confirmations',
  );
  const a4 = correction({
    fixture: 'hypothesis-a4',
    recordedAt: Date.parse('2026-07-27T12:00:00+08:00'),
    asOf: Date.parse('2026-07-27T00:00:00+08:00'),
    subject: { kind: 'region-label', deviceKey, label: 'A-4', mapBank: 'A' },
    value: { meaning: 'bed' },
    source: 'user-mi-home-app',
  });
  const a5 = correction({
    fixture: 'hypothesis-a5',
    recordedAt: Date.parse('2026-07-27T12:01:00+08:00'),
    asOf: Date.parse('2026-07-27T00:00:00+08:00'),
    subject: { kind: 'region-label', deviceKey, label: 'A-5', mapBank: 'A' },
    value: { meaning: 'corridor' },
    source: 'user-mi-home-app',
  });
  const lateConfirmation = correction({
    fixture: 'hypothesis-a4-late',
    recordedAt: Date.parse('2026-07-30T12:00:00+08:00'),
    asOf: Date.parse('2026-07-30T12:00:00+08:00'),
    subject: { kind: 'region-label', deviceKey, label: 'A-4', mapBank: 'A' },
    value: { meaning: 'bed' },
    source: 'user-mi-home-app',
  });
  assert.equal(
    deriveHabitLearningHypotheses({
      ...input,
      corrections: [lateConfirmation],
      correctionKnownAt: Date.parse('2026-07-30T12:01:00+08:00'),
    }).some(({ subject }) => subject === 'region-topology'),
    false,
    'a current App label must not be projected backward before its correction asOf',
  );
  const confirmedInput = {
    ...input,
    corrections: [a4, a5],
    correctionKnownAt: Date.parse('2026-07-30T00:00:00+08:00'),
  };
  const hypotheses = deriveHabitLearningHypotheses(confirmedInput);
  const repeated = deriveHabitLearningHypotheses({
    ...confirmedInput,
    observations: [...observations].reverse(),
  });
  const originalHostTimezone = process.env.TZ;
  let hostUtc;
  let hostPacific;
  try {
    process.env.TZ = 'UTC';
    hostUtc = deriveHabitLearningHypotheses(confirmedInput);
    process.env.TZ = 'America/Los_Angeles';
    hostPacific = deriveHabitLearningHypotheses(confirmedInput);
  } finally {
    if (originalHostTimezone === undefined) Reflect.deleteProperty(process.env, 'TZ');
    else process.env.TZ = originalHostTimezone;
  }

  assert.deepEqual(hypotheses, repeated);
  assert.deepEqual(
    hostUtc,
    hostPacific,
    'explicit study timezone must make routine windows and IDs independent of host timezone',
  );
  assert.deepEqual(
    hypotheses.map(({ subject }) => subject),
    ['device-use-pattern', 'region-topology', 'routine-window', 'routine-window', 'routine-window'],
  );
  assert.ok(
    hypotheses.every(
      ({ status, interpretationBoundary, confidence }) =>
        status === 'candidate-needs-user-confirmation' &&
        interpretationBoundary === 'does-not-identify-person-or-household-size' &&
        confidence <= 0.6,
    ),
  );

  const topology = hypotheses.find(({ subject }) => subject === 'region-topology');
  assert.ok(topology);
  assert.deepEqual(topology.evidenceObservationIds, [
    '5'.repeat(64),
    '6'.repeat(64),
    '7'.repeat(64),
    '8'.repeat(64),
  ]);
  assert.match(topology.statement, /"bed" \(raw "A-4"\) followed by "corridor" \(raw "A-5"\)/);
  assert.match(topology.statement, /not proof of a physical route/);
  assert.deepEqual(topology.confirmationCorrectionIds, [a4.correctionId, a5.correctionId].sort());

  const peopleRoutine = hypotheses.find(
    ({ subject, statement }) => subject === 'routine-window' && statement.includes('people-num'),
  );
  assert.ok(peopleRoutine);
  assert.match(peopleRoutine.statement, /state 2/);
  assert.doesNotMatch(peopleRoutine.statement, /resident count|two residents|person identity/i);

  const knownObservationIds = new Set(observations.map(({ observationId }) => observationId));
  assert.ok(
    hypotheses.every(({ evidenceObservationIds }) =>
      evidenceObservationIds.every((observationId) => knownObservationIds.has(observationId)),
    ),
  );
});

test('daily point-event buckets retain one-shot timing evidence for routine hypotheses', () => {
  const deviceKey = deriveHabitLearningAnonymousDeviceKey({
    secret: Buffer.alloc(32, 11),
    did: 'synthetic-button',
  });
  const dailyEvent = (observationId, localDate, firstClock, lastClock, count) => {
    const firstObservedAt = Date.parse(`${localDate}T${firstClock}+08:00`);
    const lastObservedAt = Date.parse(`${localDate}T${lastClock}+08:00`);
    return {
      observationId,
      kind: 'event-count',
      deviceKey,
      signalKey: 'button.clicked',
      observedFrom: firstObservedAt,
      observedUntil: lastObservedAt,
      value: {
        bucket: 'local-day',
        firstObservedAt,
        lastObservedAt,
      },
      count: { min: count, max: count },
      evidenceRefs: [`event:${localDate}:first`, `event:${localDate}:last`],
      gapIds: [],
      certainty: 'direct',
    };
  };
  const observations = [
    dailyEvent('6'.repeat(64), '2026-07-28', '08:03:00', '20:01:00', 3),
    dailyEvent('7'.repeat(64), '2026-07-29', '08:07:00', '19:55:00', 2),
  ];

  const hypotheses = deriveHabitLearningHypotheses({
    observations,
    timezone: 'Asia/Shanghai',
  });
  const routine = hypotheses.find(({ subject }) => subject === 'routine-window');
  assert.ok(routine);
  assert.match(routine.statement, /around 08:0[3-7]|between 08:03 and 08:07/);
  assert.deepEqual(routine.evidenceObservationIds, ['6'.repeat(64), '7'.repeat(64)]);
});

test('confirmed A/B partition state transitions produce translated topology with correction evidence', () => {
  const deviceKey = deriveHabitLearningAnonymousDeviceKey({
    secret: Buffer.alloc(32, 10),
    did: 'synthetic-partition-sensor',
  });
  const state = (id, start, end, label) => ({
    observationId: id.repeat(64),
    kind: 'state-interval',
    deviceKey,
    signalKey: `occupancy.${label}`,
    observedFrom: Date.parse(start),
    observedUntil: Date.parse(end),
    value: {
      state: {
        rawValue: 1,
        specLabel: 'Occupied',
        valueAuthority: 'raw-gateway-log',
        semanticAuthority: 'miot-spec',
      },
      region: {
        label,
        mapBank: 'A',
        activity: 'active',
        mappingAuthority: 'planner-model-partition',
      },
      firstObservedAt: Date.parse(start),
      lastObservedAt: Date.parse(start),
      observationCount: 1,
      leftCensored: false,
      rightCensored: false,
      endedBy: 'change',
    },
    count: { min: 1, max: 1 },
    evidenceRefs: [`state:${id}`],
    gapIds: [],
    certainty: 'direct',
  });
  const observations = [
    state('b', '2026-07-28T22:00:00+08:00', '2026-07-28T22:00:10+08:00', 'A-4'),
    state('c', '2026-07-28T22:01:00+08:00', '2026-07-28T22:01:10+08:00', 'A-5'),
    state('d', '2026-07-29T22:03:00+08:00', '2026-07-29T22:03:10+08:00', 'A-4'),
    state('e', '2026-07-29T22:04:00+08:00', '2026-07-29T22:04:10+08:00', 'A-5'),
  ];
  const corrections = [
    correction({
      fixture: 'partition-a4',
      recordedAt: Date.parse('2026-07-27T10:00:00+08:00'),
      asOf: Date.parse('2026-07-27T00:00:00+08:00'),
      subject: { kind: 'region-label', deviceKey, label: 'A-4', mapBank: 'A' },
      value: { meaning: 'bed' },
      source: 'user-mi-home-app',
    }),
    correction({
      fixture: 'partition-a5',
      recordedAt: Date.parse('2026-07-27T10:01:00+08:00'),
      asOf: Date.parse('2026-07-27T00:00:00+08:00'),
      subject: { kind: 'region-label', deviceKey, label: 'A-5', mapBank: 'A' },
      value: { meaning: 'corridor' },
      source: 'user-mi-home-app',
    }),
  ];
  const topology = deriveHabitLearningHypotheses({
    observations,
    corrections,
    correctionKnownAt: Date.parse('2026-07-30T00:00:00+08:00'),
    timezone: 'Asia/Shanghai',
  }).find(({ subject }) => subject === 'region-topology');

  assert.ok(topology);
  assert.match(topology.statement, /"bed" \(raw "A-4"\) followed by "corridor" \(raw "A-5"\)/);
  assert.deepEqual(
    topology.confirmationCorrectionIds,
    corrections.map(({ correctionId }) => correctionId).sort(),
  );
});

test('hypothesis derivation rejects one-day, ambiguous, gapped-sequence, and insufficient evidence', () => {
  const deviceKey = deriveHabitLearningAnonymousDeviceKey({
    secret: Buffer.alloc(32, 9),
    did: 'synthetic-conservative-sensor',
  });
  const observation = (id, start, parameterValue, overrides = {}) => ({
    observationId: id.repeat(64),
    kind: 'episode',
    deviceKey,
    signalKey: 'zone-presence',
    observedFrom: Date.parse(start),
    observedUntil: Date.parse(start) + 1_000,
    value: {
      parameterValue,
      leftCensored: false,
      rightCensored: false,
      ambiguous: false,
    },
    evidenceRefs: [`episode:${id}`],
    gapIds: [],
    certainty: 'direct',
    ...overrides,
  });
  const oneDay = [
    observation('b', '2026-07-28T08:00:00+08:00', 'A-4'),
    observation('c', '2026-07-28T08:02:00+08:00', 'A-5'),
    observation('d', '2026-07-28T09:00:00+08:00', 'A-4'),
    observation('e', '2026-07-28T09:02:00+08:00', 'A-5'),
  ];
  assert.deepEqual(
    deriveHabitLearningHypotheses({
      observations: oneDay,
      timezone: 'Asia/Shanghai',
    }),
    [],
  );

  const twoDayGapped = [
    observation('b', '2026-07-28T08:00:00+08:00', 'A-4', { gapIds: ['gap-1'] }),
    observation('c', '2026-07-28T08:02:00+08:00', 'A-5', { gapIds: ['gap-1'] }),
    observation('d', '2026-07-29T08:00:00+08:00', 'A-4', { gapIds: ['gap-1'] }),
    observation('e', '2026-07-29T08:02:00+08:00', 'A-5', { gapIds: ['gap-1'] }),
  ];
  const gapped = deriveHabitLearningHypotheses({
    observations: twoDayGapped,
    timezone: 'Asia/Shanghai',
  });
  assert.equal(
    gapped.some(({ subject }) => subject === 'region-topology'),
    false,
  );
  assert.deepEqual(gapped, []);

  const ambiguous = twoDayGapped.map((entry) => ({
    ...entry,
    gapIds: [],
    certainty: 'ambiguous',
  }));
  assert.deepEqual(
    deriveHabitLearningHypotheses({
      observations: ambiguous,
      timezone: 'Asia/Shanghai',
    }),
    [],
  );

  const insufficient = assessHabitLearningProfileCompleteness({
    plannedSignalIds: ['signal-1'],
    includedSignalIds: ['signal-1'],
    observedSignalIds: [],
    continuityEvidence: 'unknown',
  });
  assert.deepEqual(
    deriveHabitLearningHypotheses({
      observations: twoDayGapped,
      timezone: 'Asia/Shanghai',
      completeness: insufficient,
    }),
    [],
  );
});

test('profile generation keeps four layers separate and enforces freshness for reuse', () => {
  const deviceKey = deriveHabitLearningAnonymousDeviceKey({
    secret: Buffer.alloc(32, 5),
    did: 'synthetic-device',
  });
  const region = correction({
    fixture: 'profile-region',
    recordedAt: 800,
    asOf: 200,
    subject: { kind: 'region-label', deviceKey, label: 'A-4', mapBank: 'A' },
    value: { meaning: 'bed' },
    source: 'user-mi-home-app',
  });
  const constraintCorrection = correction({
    fixture: 'profile-constraint',
    recordedAt: 850,
    asOf: 200,
    subject: {
      kind: 'automation-constraint',
      constraintKey: 'no-bedroom-actions-after-midnight',
    },
    value: true,
  });
  const completeness = assessHabitLearningProfileCompleteness({
    plannedSignalIds: ['occupancy', 'illuminance'],
    includedSignalIds: ['occupancy', 'illuminance'],
    observedSignalIds: ['occupancy', 'illuminance'],
    continuityEvidence: 'continuous',
  });
  const input = {
    sourceSemanticDigest: SEMANTIC_DIGEST,
    sourceInventoryHash: INVENTORY_HASH,
    sourcePlanId: PLAN_ID,
    generatedAt: 1_000,
    observedFrom: 100,
    observedUntil: 900,
    timezone: 'Asia/Shanghai',
    expiresAfterMs: 1_000,
    observations: [
      {
        observationId: OBSERVATION_2,
        kind: 'event-count',
        deviceKey,
        signalKey: 'region-entry',
        observedFrom: 300,
        observedUntil: 700,
        count: { min: 3, max: 3 },
        evidenceRefs: ['journal:entry-1'],
        certainty: 'direct',
      },
      {
        observationId: OBSERVATION_1,
        kind: 'episode',
        deviceKey,
        signalKey: 'region-occupancy',
        observedFrom: 200,
        observedUntil: 600,
        evidenceRefs: ['episode:1'],
        gapIds: [],
        certainty: 'bounded',
      },
    ],
    hypotheses: [
      {
        hypothesisId: HYPOTHESIS,
        subject: 'region-topology',
        statement: 'The two confirmed sensor regions may form a frequently observed transition.',
        confidence: 0.7,
        evidenceObservationIds: [OBSERVATION_1, OBSERVATION_2],
        alternativeExplanations: ['Sensor overlap may produce the same sequence.'],
        questions: ['Does this match the path shown in Mi Home?'],
        status: 'candidate-needs-user-confirmation',
        interpretationBoundary: 'does-not-identify-person-or-household-size',
      },
    ],
    corrections: [region, constraintCorrection],
    automationConstraints: [
      {
        constraintId: CONSTRAINT,
        kind: 'exclude-time-window',
        description: 'Do not create bedroom actions after midnight without confirmation.',
        deviceKey,
        source: 'user-confirmed',
        correctionIds: [constraintCorrection.correctionId],
      },
    ],
    completeness,
  };
  const profile = generateHabitLearningProfile(input);
  const repeated = generateHabitLearningProfile({
    ...input,
    observations: [...input.observations].reverse(),
  });

  assert.equal(profile.profileId, repeated.profileId);
  assert.equal(profile.sourceSemanticDigest, SEMANTIC_DIGEST);
  assert.equal(profile.sourceInventoryHash, INVENTORY_HASH);
  assert.equal(profile.sourcePlanId, PLAN_ID);
  assert.match(profile.profileId, /^[a-f0-9]{64}$/);
  assert.equal(profile.expiresAt, 2_000);
  assert.deepEqual(
    profile.observations.map((observation) => observation.observationId),
    [OBSERVATION_1, OBSERVATION_2],
  );
  assert.deepEqual(
    profile.userConfirmed.map((confirmation) => confirmation.correctionId),
    [constraintCorrection.correctionId, region.correctionId],
  );
  assert.equal(profile.privacy.containsRawDeviceIdentifiers, false);
  assert.equal(profile.privacy.householdSizeInference, 'prohibited');
  assert.equal(profile.privacy.personIdentityInference, 'prohibited');

  assert.deepEqual(
    evaluateHabitLearningProfileFreshness({
      profile,
      evaluatedAt: 1_500,
      currentSemanticDigest: SEMANTIC_DIGEST,
      currentInventoryHash: INVENTORY_HASH,
      currentPlanId: PLAN_ID,
    }),
    {
      evaluatedAt: 1_500,
      status: 'current',
      reusableForRuleAuthoring: true,
      minimumCompleteness: 'sufficient',
      reasons: ['current'],
    },
  );
  assert.equal(
    evaluateHabitLearningProfileFreshness({
      profile,
      evaluatedAt: 2_000,
    }).status,
    'expired',
  );
  assert.deepEqual(
    evaluateHabitLearningProfileFreshness({
      profile,
      evaluatedAt: 1_500,
      currentSemanticDigest: SEMANTIC_DIGEST,
      currentInventoryHash: INVENTORY_HASH,
      currentPlanId: 'f'.repeat(64),
    }).reasons,
    ['plan-drift'],
  );
  assert.deepEqual(
    evaluateHabitLearningProfileFreshness({
      profile,
      evaluatedAt: 1_500,
      currentSemanticDigest: SEMANTIC_DIGEST,
      currentInventoryHash: INVENTORY_HASH,
    }).reasons,
    ['live-drift-check-required'],
  );
  const { sourcePlanId: _sourcePlanId, ...legacyProfile } = profile;
  assert.deepEqual(
    evaluateHabitLearningProfileFreshness({
      profile: legacyProfile,
      evaluatedAt: 1_500,
      currentSemanticDigest: SEMANTIC_DIGEST,
      currentInventoryHash: INVENTORY_HASH,
      currentPlanId: PLAN_ID,
    }).reasons,
    ['source-plan-unavailable'],
  );
  assert.deepEqual(
    evaluateHabitLearningProfileFreshness({
      profile,
      evaluatedAt: 1_500,
    }),
    {
      evaluatedAt: 1_500,
      status: 'stale',
      reusableForRuleAuthoring: false,
      minimumCompleteness: 'sufficient',
      reasons: ['live-drift-check-required'],
    },
  );
  assert.deepEqual(
    evaluateHabitLearningProfileFreshness({
      profile,
      evaluatedAt: 1_500,
      currentSemanticDigest: 'c'.repeat(64),
      currentInventoryHash: 'd'.repeat(64),
      currentPlanId: PLAN_ID,
    }),
    {
      evaluatedAt: 1_500,
      status: 'stale',
      reusableForRuleAuthoring: false,
      minimumCompleteness: 'sufficient',
      reasons: ['semantic-digest-mismatch', 'inventory-drift'],
    },
  );
});

test('bounded, invalidated, and forbidden-inference profiles fail closed', () => {
  const boundedCompleteness = assessHabitLearningProfileCompleteness({
    plannedSignalIds: ['signal-1', 'signal-2'],
    includedSignalIds: ['signal-1', 'signal-2'],
    observedSignalIds: ['signal-1'],
    continuityEvidence: 'unknown',
  });
  const profile = generateHabitLearningProfile({
    sourceSemanticDigest: SEMANTIC_DIGEST,
    sourceInventoryHash: INVENTORY_HASH,
    sourcePlanId: PLAN_ID,
    generatedAt: 1_000,
    observedFrom: 100,
    observedUntil: 900,
    timezone: 'UTC',
    expiresAfterMs: 1_000,
    observations: [
      {
        observationId: OBSERVATION_1,
        kind: 'event-count',
        signalKey: 'synthetic',
        observedFrom: 100,
        observedUntil: 900,
        count: { min: 1, max: 2 },
        evidenceRefs: ['journal:synthetic'],
        certainty: 'bounded',
      },
    ],
    hypotheses: [],
    corrections: [],
    automationConstraints: [],
    completeness: boundedCompleteness,
    invalidatedAt: 1_200,
    invalidationReason: 'Sensor regions were reconfigured.',
  });
  assert.equal(
    evaluateHabitLearningProfileFreshness({
      profile,
      evaluatedAt: 1_100,
      currentSemanticDigest: SEMANTIC_DIGEST,
      currentInventoryHash: INVENTORY_HASH,
      currentPlanId: PLAN_ID,
    }).status,
    'insufficient',
  );
  assert.equal(
    evaluateHabitLearningProfileFreshness({
      profile,
      evaluatedAt: 1_100,
      minimumCompleteness: 'bounded',
      currentSemanticDigest: SEMANTIC_DIGEST,
      currentInventoryHash: INVENTORY_HASH,
      currentPlanId: PLAN_ID,
    }).status,
    'current',
  );
  assert.equal(
    evaluateHabitLearningProfileFreshness({
      profile,
      evaluatedAt: 1_300,
      minimumCompleteness: 'bounded',
    }).status,
    'invalidated',
  );

  assert.throws(
    () =>
      generateHabitLearningProfile({
        sourceSemanticDigest: SEMANTIC_DIGEST,
        sourceInventoryHash: INVENTORY_HASH,
        sourcePlanId: PLAN_ID,
        generatedAt: 1_000,
        observedFrom: 100,
        observedUntil: 900,
        timezone: 'UTC',
        expiresAfterMs: 1_000,
        observations: [
          {
            observationId: OBSERVATION_1,
            kind: 'event-count',
            signalKey: 'synthetic',
            observedFrom: 100,
            observedUntil: 900,
            evidenceRefs: ['journal:synthetic'],
            certainty: 'direct',
          },
        ],
        hypotheses: [
          {
            hypothesisId: HYPOTHESIS,
            subject: 'household-size',
            statement: 'Forbidden structural inference.',
            confidence: 0.1,
            evidenceObservationIds: [OBSERVATION_1],
            alternativeExplanations: ['Unknown.'],
            status: 'candidate-needs-user-confirmation',
            interpretationBoundary: 'does-not-identify-person-or-household-size',
          },
        ],
        corrections: [],
        automationConstraints: [],
        completeness: boundedCompleteness,
      }),
    /Invalid enum value/,
  );

  assert.throws(
    () =>
      HabitLearningProfileSchema.parse({
        ...profile,
        observations: [
          {
            ...profile.observations[0],
            deviceKey: 'raw-device-id',
          },
        ],
      }),
    /Invalid/,
  );
  assert.throws(
    () =>
      HabitLearningProfileSchema.parse({
        ...profile,
        invalidatedAt: 999,
        invalidationReason: 'Impossible pre-generation invalidation.',
      }),
    /invalidatedAt cannot be earlier/,
  );
  assert.throws(
    () =>
      HabitLearningProfileSchema.parse({
        ...profile,
        observations: [
          {
            ...profile.observations[0],
            observedFrom: 99,
          },
        ],
      }),
    /contained by the profile observation window/,
  );
});
