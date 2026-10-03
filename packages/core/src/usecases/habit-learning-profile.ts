import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';
import {
  HABIT_LEARNING_CORRECTION_VERSION,
  HABIT_LEARNING_PROFILE_VERSION,
  type HabitLearningAnonymousDeviceKey,
  HabitLearningAnonymousDeviceKeySchema,
  type HabitLearningAutomationConstraintInput,
  HabitLearningAutomationConstraintSchema,
  type HabitLearningCorrection,
  HabitLearningCorrectionSchema,
  type HabitLearningCorrectionSubject,
  type HabitLearningJsonValue,
  type HabitLearningProfile,
  type HabitLearningProfileCompleteness,
  HabitLearningProfileCompletenessSchema,
  type HabitLearningProfileFreshness,
  HabitLearningProfileFreshnessSchema,
  type HabitLearningProfileHypothesis,
  type HabitLearningProfileHypothesisInput,
  HabitLearningProfileHypothesisSchema,
  type HabitLearningProfileObservation,
  type HabitLearningProfileObservationInput,
  HabitLearningProfileObservationSchema,
  HabitLearningProfileSchema,
  type HabitLearningResolvedConfirmation,
} from '../schemas/habit-learning-profile.js';

const DEVICE_KEY_DOMAIN = 'xgg-habit-learning-device-key-v1\0';
const PERMANENT_COMPLETENESS_REASONS = [
  'gateway-retention-unknown',
  'household-membership-not-observed',
  'manual-vs-automation-causality-unknown',
  'not-all-device-behavior-observable',
] as const;

export interface DeriveHabitLearningDeviceKeyInput {
  /**
   * Study- or household-local secret. At least 32 random bytes are required so
   * predictable DIDs cannot be recovered with an offline dictionary.
   */
  secret: Uint8Array;
  did: string;
}

/**
 * Derive a stable, domain-separated, non-reversible public device key.
 *
 * The same secret/DID pair is stable; changing the secret deliberately makes
 * studies unlinkable. Raw DIDs and the secret never appear in the result.
 */
export function deriveHabitLearningAnonymousDeviceKey(
  input: DeriveHabitLearningDeviceKeyInput,
): HabitLearningAnonymousDeviceKey {
  if (!(input.secret instanceof Uint8Array) || input.secret.byteLength < 32) {
    throw new TypeError('habit-learning device-key secret must contain at least 32 bytes');
  }
  assertNonEmptyString(input.did, 'did');
  const digest = createHmac('sha256', input.secret)
    .update(DEVICE_KEY_DOMAIN)
    .update(input.did)
    .digest('hex')
    .slice(0, 32);
  return HabitLearningAnonymousDeviceKeySchema.parse(`device_${digest}`);
}

export interface ResolveHabitLearningCorrectionsInput {
  /** Append order from corrections.ndjson; this array is never mutated. */
  corrections: readonly HabitLearningCorrection[];
  /** Semantic time whose view is requested. */
  asOf: number;
  /** Optional knowledge cutoff for reproducible historical views. */
  knownAt?: number;
}

/**
 * Validate an append-only correction stream and project one as-of view.
 *
 * Supersedes links must point backward to the same subject. Resolution uses
 * the latest effective `asOf`, then recorded time, then append order. Earlier
 * records remain intact and can still be projected with an older cutoff.
 */
export function resolveHabitLearningCorrectionsAsOf(
  input: ResolveHabitLearningCorrectionsInput,
): HabitLearningResolvedConfirmation[] {
  assertNonNegativeSafeInteger(input.asOf, 'asOf');
  if (input.knownAt !== undefined) {
    assertNonNegativeSafeInteger(input.knownAt, 'knownAt');
  }
  const knownAt = input.knownAt ?? Number.MAX_SAFE_INTEGER;
  const parsed = validateCorrectionJournal(input.corrections);
  const candidates = new Map<
    string,
    { correction: HabitLearningCorrection; appendIndex: number }
  >();

  parsed.forEach((correction, appendIndex) => {
    if (correction.recordedAt > knownAt || correction.asOf > input.asOf) return;
    const key = correctionSubjectKey(correction.subject);
    const current = candidates.get(key);
    if (
      current === undefined ||
      correction.asOf > current.correction.asOf ||
      (correction.asOf === current.correction.asOf &&
        correction.recordedAt > current.correction.recordedAt) ||
      (correction.asOf === current.correction.asOf &&
        correction.recordedAt === current.correction.recordedAt &&
        appendIndex > current.appendIndex)
    ) {
      candidates.set(key, { correction, appendIndex });
    }
  });

  return [...candidates.entries()]
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([, { correction }]) => ({
      correctionId: correction.correctionId,
      recordedAt: correction.recordedAt,
      asOf: correction.asOf,
      subject: correction.subject,
      value: correction.value,
      source: correction.source,
    }));
}

export interface HabitLearningObservedRegion {
  deviceKey: HabitLearningAnonymousDeviceKey;
  label: string;
  mapBank?: string;
  observedAt: number;
  observationId: string;
}

export interface HabitLearningRegionClarificationQuestion {
  questionId: string;
  deviceKey: HabitLearningAnonymousDeviceKey;
  unresolvedRegions: Array<{
    label: string;
    mapBank?: string;
    firstObservedAt: number;
    lastObservedAt: number;
    observationCount: number;
    observationIds: string[];
  }>;
  prompts: [
    {
      kind: 'region-meaning';
      labels: string[];
      instruction: string;
    },
    {
      kind: 'active-map-bank';
      candidateMapBanks: string[];
      instruction: string;
    },
    {
      kind: 'unused-regions';
      labels: string[];
      instruction: string;
    },
  ];
}

export interface BuildHabitLearningRegionClarificationsInput {
  regions: readonly HabitLearningObservedRegion[];
  corrections: readonly HabitLearningCorrection[];
  asOf: number;
  knownAt?: number;
}

/**
 * Build device-grouped Mi Home clarification questions for unresolved labels.
 *
 * Output uses only anonymous device keys. The caller may join a private device
 * mapping for local display, but raw names and DIDs never enter this result.
 */
export function buildHabitLearningRegionClarificationQuestions(
  input: BuildHabitLearningRegionClarificationsInput,
): HabitLearningRegionClarificationQuestion[] {
  const resolved = resolveHabitLearningCorrectionsAsOf({
    corrections: input.corrections,
    asOf: input.asOf,
    ...(input.knownAt !== undefined && { knownAt: input.knownAt }),
  });
  const resolvedSubjects = new Set(
    resolved
      .filter((confirmation) => confirmation.subject.kind === 'region-label')
      .map((confirmation) => correctionSubjectKey(confirmation.subject)),
  );
  const grouped = new Map<
    string,
    {
      deviceKey: HabitLearningAnonymousDeviceKey;
      label: string;
      mapBank?: string;
      observedAt: number[];
      observationIds: string[];
    }
  >();
  const observationIds = new Set<string>();

  for (const [index, region] of input.regions.entries()) {
    HabitLearningAnonymousDeviceKeySchema.parse(region.deviceKey);
    assertNonEmptyTrimmedString(region.label, `regions[${index}].label`);
    if (region.mapBank !== undefined) {
      assertNonEmptyTrimmedString(region.mapBank, `regions[${index}].mapBank`);
    }
    assertNonNegativeSafeInteger(region.observedAt, `regions[${index}].observedAt`);
    assertNonEmptyString(region.observationId, `regions[${index}].observationId`);
    if (observationIds.has(region.observationId)) {
      throw new TypeError(`duplicate region observationId: ${region.observationId}`);
    }
    observationIds.add(region.observationId);

    const subject: HabitLearningCorrectionSubject = {
      kind: 'region-label',
      deviceKey: region.deviceKey,
      label: region.label,
      ...(region.mapBank !== undefined && { mapBank: region.mapBank }),
    };
    if (resolvedSubjects.has(correctionSubjectKey(subject))) continue;

    const key = correctionSubjectKey(subject);
    const current = grouped.get(key);
    if (current === undefined) {
      grouped.set(key, {
        deviceKey: region.deviceKey,
        label: region.label,
        ...(region.mapBank !== undefined && { mapBank: region.mapBank }),
        observedAt: [region.observedAt],
        observationIds: [region.observationId],
      });
    } else {
      current.observedAt.push(region.observedAt);
      current.observationIds.push(region.observationId);
    }
  }

  const byDevice = new Map<
    HabitLearningAnonymousDeviceKey,
    HabitLearningRegionClarificationQuestion['unresolvedRegions']
  >();
  for (const entry of grouped.values()) {
    const regions = byDevice.get(entry.deviceKey) ?? [];
    const observedAt = [...entry.observedAt].sort((left, right) => left - right);
    regions.push({
      label: entry.label,
      ...(entry.mapBank !== undefined && { mapBank: entry.mapBank }),
      firstObservedAt: observedAt[0] ?? 0,
      lastObservedAt: observedAt.at(-1) ?? 0,
      observationCount: observedAt.length,
      observationIds: [...entry.observationIds].sort(compareStrings),
    });
    byDevice.set(entry.deviceKey, regions);
  }

  return [...byDevice.entries()]
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([deviceKey, regions]) => {
      regions.sort(
        (left, right) =>
          compareStrings(left.mapBank ?? '', right.mapBank ?? '') ||
          compareStrings(left.label, right.label),
      );
      const labels = regions.map((region) =>
        region.mapBank === undefined ? region.label : `${region.mapBank}:${region.label}`,
      );
      const candidateMapBanks = uniqueSortedStrings(
        regions.flatMap((region) => (region.mapBank === undefined ? [] : [region.mapBank])),
      );
      return {
        questionId: digestStable({ deviceKey, labels }),
        deviceKey,
        unresolvedRegions: regions,
        prompts: [
          {
            kind: 'region-meaning',
            labels,
            instruction:
              'Open Mi Home and confirm the real location represented by each opaque region label.',
          },
          {
            kind: 'active-map-bank',
            candidateMapBanks,
            instruction:
              'Confirm which map bank is active; do not infer it from activity timestamps.',
          },
          {
            kind: 'unused-regions',
            labels,
            instruction: 'Mark labels that are unconfigured, disabled, or interference-only.',
          },
        ],
      };
    });
}

export interface AssessHabitLearningCompletenessInput {
  plannedSignalIds: readonly string[];
  includedSignalIds: readonly string[];
  observedSignalIds: readonly string[];
  gapIds?: readonly string[];
  /** `continuous` must be supported by the durable collector; otherwise use unknown. */
  continuityEvidence: 'continuous' | 'unknown';
  reasonCodes?: readonly string[];
}

export function assessHabitLearningProfileCompleteness(
  input: AssessHabitLearningCompletenessInput,
): HabitLearningProfileCompleteness {
  const planned = uniqueValidatedStrings(input.plannedSignalIds, 'plannedSignalIds');
  const included = uniqueValidatedStrings(input.includedSignalIds, 'includedSignalIds');
  const observed = uniqueValidatedStrings(input.observedSignalIds, 'observedSignalIds');
  const gapIds = uniqueValidatedStrings(input.gapIds ?? [], 'gapIds');
  assertSubset(included, planned, 'includedSignalIds', 'plannedSignalIds');
  assertSubset(observed, included, 'observedSignalIds', 'includedSignalIds');

  const collectorContinuity = gapIds.length > 0 ? ('gapped' as const) : input.continuityEvidence;
  const status =
    included.length === 0 || observed.length === 0
      ? ('insufficient' as const)
      : observed.length === included.length && collectorContinuity === 'continuous'
        ? ('sufficient' as const)
        : ('bounded' as const);
  const reasonCodes = uniqueSortedStrings([
    ...PERMANENT_COMPLETENESS_REASONS,
    ...(input.reasonCodes ?? []),
    ...(gapIds.length > 0 ? ['collector-gaps-present'] : []),
    ...(observed.length < included.length ? ['runtime-signals-missing'] : []),
  ]);
  return HabitLearningProfileCompletenessSchema.parse({
    status,
    usableForHabitInference: status === 'insufficient' ? 'no' : 'yes-with-bounds',
    provesAllHouseholdBehavior: false,
    collectorContinuity,
    plannedSignalCount: planned.length,
    includedSignalCount: included.length,
    observedSignalCount: observed.length,
    gapCount: gapIds.length,
    observedCoverageRatio: included.length === 0 ? null : observed.length / included.length,
    reasonCodes,
    householdSizeInference: 'prohibited',
    personIdentityInference: 'prohibited',
  });
}

export interface DeriveHabitLearningHypothesesInput {
  observations: readonly HabitLearningProfileObservationInput[];
  timezone: string;
  /**
   * Append-only user confirmations. Region topology is suppressed unless both
   * ends have a region-label correction effective for their observation time.
   */
  corrections?: readonly HabitLearningCorrection[];
  /** Knowledge-time cutoff for reproducible correction resolution. */
  correctionKnownAt?: number;
  /**
   * When supplied, insufficient evidence disables inference even if individual
   * observations are otherwise well formed.
   */
  completeness?: HabitLearningProfileCompleteness;
  minimumRoutineDistinctDates?: number;
  maximumRoutineWindowMinutes?: number;
  minimumSequenceOccurrences?: number;
  minimumSequenceDistinctDates?: number;
  maximumSequenceGapMs?: number;
  maximumHypotheses?: number;
}

interface HabitLearningHypothesisOccurrence {
  observation: HabitLearningProfileObservation;
  /** Exact representative instant used for ordering and local-clock inference. */
  observedAt: number;
  /** End of the evidence occurrence; point-event day buckets use observedAt. */
  observedUntil: number;
  tokenKey: string;
  label: string;
  localDate: string;
  localMinute: number;
  regionObserved?: true;
  region?: {
    rawLabel: string;
    mapBank?: string;
    meaning: string;
    correctionId: string;
  };
}

interface HabitLearningClockWindow {
  startMinute: number;
  endMinute: number;
  spanMinutes: number;
}

interface HabitLearningSequenceOccurrence {
  from: HabitLearningHypothesisOccurrence;
  to: HabitLearningHypothesisOccurrence;
  subject: 'region-topology' | 'device-use-pattern';
  localDate: string;
  gapMs: number;
}

/**
 * Derive conservative, deterministic candidates from direct profile evidence.
 *
 * The result is intentionally not a conclusion:
 *
 * - routine windows require corroboration on at least two distinct local dates;
 * - topology/device sequences require repeated ordered evidence on distinct dates;
 * - ambiguous observations and censored initial state snapshots are excluded;
 * - region topology requires effective user-confirmed meanings for both ends;
 * - raw labels remain attached to translations and never imply person meaning;
 * - every candidate cites the exact observation IDs that support it.
 */
export function deriveHabitLearningHypotheses(
  input: DeriveHabitLearningHypothesesInput,
): HabitLearningProfileHypothesis[] {
  assertNonEmptyTrimmedString(input.timezone, 'timezone');
  const observations = z.array(HabitLearningProfileObservationSchema).parse(input.observations);
  assertUniqueField(observations, 'observationId', 'observation');
  const corrections = validateCorrectionJournal(input.corrections ?? []);
  if (input.correctionKnownAt !== undefined) {
    assertNonNegativeSafeInteger(input.correctionKnownAt, 'correctionKnownAt');
  }
  const completeness =
    input.completeness === undefined
      ? undefined
      : HabitLearningProfileCompletenessSchema.parse(input.completeness);
  if (completeness?.status === 'insufficient') return [];

  const minimumRoutineDistinctDates = input.minimumRoutineDistinctDates ?? 2;
  const maximumRoutineWindowMinutes = input.maximumRoutineWindowMinutes ?? 120;
  const minimumSequenceOccurrences = input.minimumSequenceOccurrences ?? 2;
  const minimumSequenceDistinctDates = input.minimumSequenceDistinctDates ?? 2;
  const maximumSequenceGapMs = input.maximumSequenceGapMs ?? 15 * 60 * 1_000;
  const maximumHypotheses = input.maximumHypotheses ?? 64;
  assertIntegerAtLeast(minimumRoutineDistinctDates, 2, 'minimumRoutineDistinctDates');
  assertIntegerInRange(maximumRoutineWindowMinutes, 1, 12 * 60, 'maximumRoutineWindowMinutes');
  assertIntegerAtLeast(minimumSequenceOccurrences, 2, 'minimumSequenceOccurrences');
  assertIntegerAtLeast(minimumSequenceDistinctDates, 2, 'minimumSequenceDistinctDates');
  assertNonNegativeSafeInteger(maximumSequenceGapMs, 'maximumSequenceGapMs');
  assertPositiveSafeInteger(maximumHypotheses, 'maximumHypotheses');

  const localClock = createHabitLearningLocalClock(input.timezone);
  const occurrences = observations
    .flatMap((observation) => {
      const semantics = profileHypothesisOccurrenceSemantics(
        observation,
        corrections,
        input.correctionKnownAt,
      );
      if (
        semantics === undefined ||
        observation.certainty === 'ambiguous' ||
        observation.gapIds.length > 0
      ) {
        return [];
      }
      const local = localClock(semantics.observedAt);
      return [
        {
          observation,
          observedAt: semantics.observedAt,
          observedUntil: semantics.observedUntil,
          tokenKey: semantics.tokenKey,
          label: semantics.label,
          localDate: local.date,
          localMinute: local.minute,
          ...(semantics.region !== undefined && {
            region: semantics.region,
          }),
          ...(semantics.regionObserved === true && { regionObserved: true as const }),
        },
      ];
    })
    .sort(compareHypothesisOccurrences);

  const candidates: HabitLearningProfileHypothesisInput[] = [
    ...deriveRoutineWindowHypotheses({
      occurrences,
      timezone: input.timezone,
      minimumDistinctDates: minimumRoutineDistinctDates,
      maximumWindowMinutes: maximumRoutineWindowMinutes,
    }),
    ...deriveRepeatedSequenceHypotheses({
      occurrences,
      minimumOccurrences: minimumSequenceOccurrences,
      minimumDistinctDates: minimumSequenceDistinctDates,
      maximumGapMs: maximumSequenceGapMs,
    }),
  ];
  return z
    .array(HabitLearningProfileHypothesisSchema)
    .parse(candidates)
    .sort(
      (left, right) =>
        compareStrings(left.subject, right.subject) ||
        compareStrings(left.hypothesisId, right.hypothesisId),
    )
    .slice(0, maximumHypotheses);
}

export interface GenerateHabitLearningProfileInput {
  sourceSemanticDigest: string;
  sourceInventoryHash: string;
  /** Required for authoring reuse; optional only for legacy callers/artifacts. */
  sourcePlanId?: string;
  generatedAt: number;
  observedFrom: number;
  observedUntil: number;
  timezone: string;
  expiresAfterMs: number;
  observations: readonly HabitLearningProfileObservationInput[];
  hypotheses: readonly HabitLearningProfileHypothesisInput[];
  corrections: readonly HabitLearningCorrection[];
  correctionAsOf?: number;
  correctionKnownAt?: number;
  automationConstraints: readonly HabitLearningAutomationConstraintInput[];
  completeness: HabitLearningProfileCompleteness;
  invalidatedAt?: number;
  invalidationReason?: string;
}

/**
 * Generate a deterministic, anonymized profile without inventing hypotheses.
 *
 * The caller supplies direct observations and bounded hypotheses separately.
 * User confirmations are always projected from the append-only correction
 * journal. The schema structurally excludes household-size/person-identity
 * hypotheses; those facts can only appear as explicit user confirmations.
 */
export function generateHabitLearningProfile(
  input: GenerateHabitLearningProfileInput,
): HabitLearningProfile {
  assertNonNegativeSafeInteger(input.generatedAt, 'generatedAt');
  assertNonNegativeSafeInteger(input.observedFrom, 'observedFrom');
  assertNonNegativeSafeInteger(input.observedUntil, 'observedUntil');
  assertPositiveSafeInteger(input.expiresAfterMs, 'expiresAfterMs');
  assertNonEmptyTrimmedString(input.timezone, 'timezone');
  const expiresAt = safeAdd(input.generatedAt, input.expiresAfterMs, 'expiresAfterMs');

  const observations = z.array(HabitLearningProfileObservationSchema).parse(input.observations);
  const hypotheses = z.array(HabitLearningProfileHypothesisSchema).parse(input.hypotheses);
  const automationConstraints = z
    .array(HabitLearningAutomationConstraintSchema)
    .parse(input.automationConstraints);
  const completeness = HabitLearningProfileCompletenessSchema.parse(input.completeness);
  const corrections = validateCorrectionJournal(input.corrections);
  const userConfirmed = resolveHabitLearningCorrectionsAsOf({
    corrections,
    asOf: input.correctionAsOf ?? input.observedUntil,
    knownAt: input.correctionKnownAt ?? input.generatedAt,
  });

  assertUniqueField(observations, 'observationId', 'observation');
  assertUniqueField(hypotheses, 'hypothesisId', 'hypothesis');
  assertUniqueField(automationConstraints, 'constraintId', 'automation constraint');
  const observationIds = new Set(observations.map((observation) => observation.observationId));
  for (const hypothesis of hypotheses) {
    for (const observationId of hypothesis.evidenceObservationIds) {
      if (!observationIds.has(observationId)) {
        throw new TypeError(
          `hypothesis ${hypothesis.hypothesisId} references unknown observation ${observationId}`,
        );
      }
    }
  }
  const correctionIds = new Set(corrections.map((correction) => correction.correctionId));
  for (const constraint of automationConstraints) {
    for (const correctionId of constraint.correctionIds) {
      if (!correctionIds.has(correctionId)) {
        throw new TypeError(
          `automation constraint ${constraint.constraintId} references unknown correction ${correctionId}`,
        );
      }
    }
  }

  const stableLayers = {
    profileVersion: HABIT_LEARNING_PROFILE_VERSION,
    sourceSemanticDigest: input.sourceSemanticDigest,
    sourceInventoryHash: input.sourceInventoryHash,
    ...(input.sourcePlanId !== undefined && { sourcePlanId: input.sourcePlanId }),
    generatedAt: input.generatedAt,
    observedFrom: input.observedFrom,
    observedUntil: input.observedUntil,
    timezone: input.timezone,
    expiresAt,
    ...(input.invalidatedAt !== undefined && { invalidatedAt: input.invalidatedAt }),
    ...(input.invalidationReason !== undefined && {
      invalidationReason: input.invalidationReason,
    }),
    observations: [...observations].sort((left, right) =>
      compareStrings(left.observationId, right.observationId),
    ),
    hypotheses: [...hypotheses].sort((left, right) =>
      compareStrings(left.hypothesisId, right.hypothesisId),
    ),
    userConfirmed,
    automationConstraints: [...automationConstraints].sort((left, right) =>
      compareStrings(left.constraintId, right.constraintId),
    ),
    completeness,
    privacy: {
      anonymizedDeviceKeys: true as const,
      containsRawDeviceIdentifiers: false as const,
      householdSizeInference: 'prohibited' as const,
      personIdentityInference: 'prohibited' as const,
    },
  };
  return HabitLearningProfileSchema.parse({
    ...stableLayers,
    profileId: digestStable(stableLayers),
  });
}

export interface EvaluateHabitLearningProfileFreshnessInput {
  profile: HabitLearningProfile;
  evaluatedAt: number;
  minimumCompleteness?: 'sufficient' | 'bounded';
  /** Current compiled graph identity, when the caller has reconciled live state. */
  currentSemanticDigest?: string;
  /** Current inventory identity, when the caller has refreshed live inventory. */
  currentInventoryHash?: string;
  /** Current plan identity, computed using freshly fetched MIoT semantics. */
  currentPlanId?: string;
}

/**
 * Decide whether a profile may be reused for rule authoring at one instant.
 *
 * The conservative default requires `sufficient`; callers must explicitly opt
 * into bounded evidence. Expired, invalidated, or insufficient profiles always
 * fall back to user questions or a new observation study.
 */
export function evaluateHabitLearningProfileFreshness(
  input: EvaluateHabitLearningProfileFreshnessInput,
): HabitLearningProfileFreshness {
  const profile = HabitLearningProfileSchema.parse(input.profile);
  assertNonNegativeSafeInteger(input.evaluatedAt, 'evaluatedAt');
  if (input.evaluatedAt < profile.generatedAt) {
    throw new RangeError('evaluatedAt cannot be earlier than profile.generatedAt');
  }
  const minimumCompleteness = input.minimumCompleteness ?? 'sufficient';

  if (profile.invalidatedAt !== undefined && profile.invalidatedAt <= input.evaluatedAt) {
    return HabitLearningProfileFreshnessSchema.parse({
      evaluatedAt: input.evaluatedAt,
      status: 'invalidated',
      reusableForRuleAuthoring: false,
      minimumCompleteness,
      reasons: ['profile-invalidated'],
    });
  }
  if (input.evaluatedAt >= profile.expiresAt) {
    return HabitLearningProfileFreshnessSchema.parse({
      evaluatedAt: input.evaluatedAt,
      status: 'expired',
      reusableForRuleAuthoring: false,
      minimumCompleteness,
      reasons: ['profile-expired'],
    });
  }
  if (
    input.currentSemanticDigest === undefined ||
    input.currentInventoryHash === undefined ||
    input.currentPlanId === undefined
  ) {
    return HabitLearningProfileFreshnessSchema.parse({
      evaluatedAt: input.evaluatedAt,
      status: 'stale',
      reusableForRuleAuthoring: false,
      minimumCompleteness,
      reasons: ['live-drift-check-required'],
    });
  }
  if (profile.sourcePlanId === undefined) {
    return HabitLearningProfileFreshnessSchema.parse({
      evaluatedAt: input.evaluatedAt,
      status: 'stale',
      reusableForRuleAuthoring: false,
      minimumCompleteness,
      reasons: ['source-plan-unavailable'],
    });
  }
  const driftReasons: Array<'semantic-digest-mismatch' | 'inventory-drift' | 'plan-drift'> = [];
  if (
    input.currentSemanticDigest !== undefined &&
    input.currentSemanticDigest !== profile.sourceSemanticDigest
  ) {
    driftReasons.push('semantic-digest-mismatch');
  }
  if (
    input.currentInventoryHash !== undefined &&
    input.currentInventoryHash !== profile.sourceInventoryHash
  ) {
    driftReasons.push('inventory-drift');
  }
  if (input.currentPlanId !== profile.sourcePlanId) driftReasons.push('plan-drift');
  if (driftReasons.length > 0) {
    return HabitLearningProfileFreshnessSchema.parse({
      evaluatedAt: input.evaluatedAt,
      status: 'stale',
      reusableForRuleAuthoring: false,
      minimumCompleteness,
      reasons: driftReasons,
    });
  }
  const completenessAcceptable =
    profile.completeness.status === 'sufficient' ||
    (minimumCompleteness === 'bounded' && profile.completeness.status === 'bounded');
  if (!completenessAcceptable) {
    return HabitLearningProfileFreshnessSchema.parse({
      evaluatedAt: input.evaluatedAt,
      status: 'insufficient',
      reusableForRuleAuthoring: false,
      minimumCompleteness,
      reasons: ['insufficient-completeness'],
    });
  }
  return HabitLearningProfileFreshnessSchema.parse({
    evaluatedAt: input.evaluatedAt,
    status: 'current',
    reusableForRuleAuthoring: true,
    minimumCompleteness,
    reasons: ['current'],
  });
}

function deriveRoutineWindowHypotheses(input: {
  occurrences: readonly HabitLearningHypothesisOccurrence[];
  timezone: string;
  minimumDistinctDates: number;
  maximumWindowMinutes: number;
}): HabitLearningProfileHypothesisInput[] {
  const groups = new Map<string, HabitLearningHypothesisOccurrence[]>();
  for (const occurrence of input.occurrences) {
    const current = groups.get(occurrence.tokenKey) ?? [];
    current.push(occurrence);
    groups.set(occurrence.tokenKey, current);
  }

  const hypotheses: HabitLearningProfileHypothesisInput[] = [];
  for (const [tokenKey, occurrences] of [...groups.entries()].sort(([left], [right]) =>
    compareStrings(left, right),
  )) {
    const localDates = uniqueSortedStrings(occurrences.map(({ localDate }) => localDate));
    if (localDates.length < input.minimumDistinctDates) continue;
    const window = minimalCircularClockWindow(occurrences.map(({ localMinute }) => localMinute));
    if (window.spanMinutes > input.maximumWindowMinutes) continue;

    const evidenceObservationIds = uniqueSortedStrings(
      occurrences.map(({ observation }) => observation.observationId),
    );
    const label = occurrences[0]?.label;
    if (label === undefined) continue;
    const windowDescription =
      window.spanMinutes === 0
        ? `around ${formatClockMinute(window.startMinute)}`
        : `between ${formatClockMinute(window.startMinute)} and ${formatClockMinute(window.endMinute)}${
            window.endMinute < window.startMinute ? ' across midnight' : ''
          }`;
    const material = {
      kind: 'routine-window-v1',
      tokenKey,
      timezone: input.timezone,
      localDates,
      window,
      evidenceObservationIds,
    };
    hypotheses.push({
      hypothesisId: digestStable(material),
      subject: 'routine-window',
      statement: `${label} started ${windowDescription} on ${localDates.length} distinct local dates in ${input.timezone}. This is a recurring evidence candidate that requires user confirmation, not proof of a resident routine.`,
      confidence: Math.min(0.6, 0.45 + Math.max(0, localDates.length - 2) * 0.03),
      evidenceObservationIds,
      alternativeExplanations: [
        'Schedules, existing automations, guests, pets, sensor latency, or coincidence may produce the same timing.',
      ],
      questions: [
        'Does this recurring local-time window reflect a routine that future automations should consider?',
      ],
      status: 'candidate-needs-user-confirmation',
      interpretationBoundary: 'does-not-identify-person-or-household-size',
    });
  }
  return hypotheses;
}

function deriveRepeatedSequenceHypotheses(input: {
  occurrences: readonly HabitLearningHypothesisOccurrence[];
  minimumOccurrences: number;
  minimumDistinctDates: number;
  maximumGapMs: number;
}): HabitLearningProfileHypothesisInput[] {
  const sequences: HabitLearningSequenceOccurrence[] = [];
  const regionGroups = new Map<string, HabitLearningHypothesisOccurrence[]>();
  for (const occurrence of input.occurrences) {
    if (occurrence.observation.deviceKey === undefined || occurrence.region === undefined) {
      continue;
    }
    const key = JSON.stringify([
      occurrence.observation.deviceKey,
      occurrence.region.mapBank ?? null,
    ]);
    const current = regionGroups.get(key) ?? [];
    current.push(occurrence);
    regionGroups.set(key, current);
  }
  for (const occurrences of regionGroups.values()) {
    appendAdjacentSequenceOccurrences(
      sequences,
      occurrences,
      'region-topology',
      input.maximumGapMs,
    );
  }

  const ordered = [...input.occurrences].sort(compareHypothesisOccurrences);
  for (let index = 1; index < ordered.length; index += 1) {
    const from = ordered[index - 1];
    const to = ordered[index];
    if (from === undefined || to === undefined) continue;
    if (
      from.observation.deviceKey === to.observation.deviceKey &&
      from.regionObserved === true &&
      to.regionObserved === true
    ) {
      continue;
    }
    appendSequenceOccurrence(sequences, from, to, 'device-use-pattern', input.maximumGapMs);
  }

  const grouped = new Map<string, HabitLearningSequenceOccurrence[]>();
  for (const sequence of sequences) {
    const key = JSON.stringify([sequence.subject, sequence.from.tokenKey, sequence.to.tokenKey]);
    const current = grouped.get(key) ?? [];
    current.push(sequence);
    grouped.set(key, current);
  }

  const hypotheses: HabitLearningProfileHypothesisInput[] = [];
  for (const [sequenceKey, occurrences] of [...grouped.entries()].sort(([left], [right]) =>
    compareStrings(left, right),
  )) {
    const localDates = uniqueSortedStrings(occurrences.map(({ localDate }) => localDate));
    if (
      occurrences.length < input.minimumOccurrences ||
      localDates.length < input.minimumDistinctDates
    ) {
      continue;
    }
    const first = occurrences[0];
    if (first === undefined) continue;
    const evidenceObservationIds = uniqueSortedStrings(
      occurrences.flatMap(({ from, to }) => [
        from.observation.observationId,
        to.observation.observationId,
      ]),
    );
    const minGapMs = Math.min(...occurrences.map(({ gapMs }) => gapMs));
    const maxGapMs = Math.max(...occurrences.map(({ gapMs }) => gapMs));
    const hypothesisId = digestStable({
      kind: 'repeated-sequence-v1',
      sequenceKey,
      localDates,
      minGapMs,
      maxGapMs,
      evidenceObservationIds,
    });
    if (first.subject === 'region-topology') {
      const fromRegion = first.from.region;
      const toRegion = first.to.region;
      if (fromRegion === undefined || toRegion === undefined) continue;
      const confirmationCorrectionIds = uniqueSortedStrings(
        occurrences.flatMap(({ from, to }) =>
          [from.region?.correctionId, to.region?.correctionId].filter(
            (value): value is string => value !== undefined,
          ),
        ),
      );
      hypotheses.push({
        hypothesisId,
        subject: 'region-topology',
        statement: `The same anonymous sensor repeatedly reported user-confirmed region ${renderProfileScalar(
          fromRegion.meaning,
        )} (raw ${renderProfileScalar(fromRegion.rawLabel)}) followed by ${renderProfileScalar(
          toRegion.meaning,
        )} (raw ${renderProfileScalar(
          toRegion.rawLabel,
        )}) on ${localDates.length} distinct local dates, with ${formatDurationRange(
          minGapMs,
          maxGapMs,
        )} between episodes. The meanings come only from cited user corrections; this remains a sensor-order candidate, not proof of a physical route.`,
        confidence: Math.min(0.6, 0.48 + Math.max(0, occurrences.length - 2) * 0.02),
        evidenceObservationIds,
        confirmationCorrectionIds,
        alternativeExplanations: [
          'Overlapping regions, sensor latency, pets, automation, or unrelated movement may produce the same order.',
        ],
        questions: [
          'Do the confirmed region meanings still apply to this observation window, and is the repeated order meaningful?',
        ],
        status: 'candidate-needs-user-confirmation',
        interpretationBoundary: 'does-not-identify-person-or-household-size',
      });
      continue;
    }
    hypotheses.push({
      hypothesisId,
      subject: 'device-use-pattern',
      statement: `${first.from.label} repeatedly preceded ${first.to.label} on ${localDates.length} distinct local dates, with ${formatDurationRange(
        minGapMs,
        maxGapMs,
      )} between observations. This is an evidence-order candidate, not proof that one event caused the other or that a particular person performed it.`,
      confidence: Math.min(0.58, 0.45 + Math.max(0, occurrences.length - 2) * 0.02),
      evidenceObservationIds,
      confirmationCorrectionIds: [],
      alternativeExplanations: [
        'Existing automations, shared schedules, sensor latency, pets, or coincidence may produce the same order.',
      ],
      questions: [
        'Does this repeated order describe a useful device-use pattern, and should future automation treat it as related?',
      ],
      status: 'candidate-needs-user-confirmation',
      interpretationBoundary: 'does-not-identify-person-or-household-size',
    });
  }
  return hypotheses;
}

function appendAdjacentSequenceOccurrences(
  output: HabitLearningSequenceOccurrence[],
  input: readonly HabitLearningHypothesisOccurrence[],
  subject: HabitLearningSequenceOccurrence['subject'],
  maximumGapMs: number,
): void {
  const ordered = [...input].sort(compareHypothesisOccurrences);
  for (let index = 1; index < ordered.length; index += 1) {
    const from = ordered[index - 1];
    const to = ordered[index];
    if (from === undefined || to === undefined) continue;
    appendSequenceOccurrence(output, from, to, subject, maximumGapMs);
  }
}

function appendSequenceOccurrence(
  output: HabitLearningSequenceOccurrence[],
  from: HabitLearningHypothesisOccurrence,
  to: HabitLearningHypothesisOccurrence,
  subject: HabitLearningSequenceOccurrence['subject'],
  maximumGapMs: number,
): void {
  if (
    from.tokenKey === to.tokenKey ||
    from.observation.gapIds.length > 0 ||
    to.observation.gapIds.length > 0 ||
    to.observedAt < from.observedUntil
  ) {
    return;
  }
  const gapMs = to.observedAt - from.observedUntil;
  if (gapMs > maximumGapMs) return;
  output.push({
    from,
    to,
    subject,
    localDate: from.localDate,
    gapMs,
  });
}

function profileHypothesisOccurrenceSemantics(
  observation: HabitLearningProfileObservation,
  corrections: readonly HabitLearningCorrection[],
  correctionKnownAt?: number,
):
  | {
      observedAt: number;
      observedUntil: number;
      tokenKey: string;
      label: string;
      regionObserved?: true;
      region?: HabitLearningHypothesisOccurrence['region'];
    }
  | undefined {
  const deviceLabel =
    observation.deviceKey === undefined
      ? 'an unassigned sensor'
      : `anonymous device ${observation.deviceKey}`;
  if (observation.kind === 'event-count') {
    if (
      observation.count === undefined ||
      observation.count.min < 1 ||
      !isRecord(observation.value)
    ) {
      return undefined;
    }
    const representativeObservedAt =
      typeof observation.value.firstObservedAt === 'number' &&
      Number.isSafeInteger(observation.value.firstObservedAt) &&
      observation.value.firstObservedAt >= observation.observedFrom &&
      observation.value.firstObservedAt <= observation.observedUntil
        ? observation.value.firstObservedAt
        : observation.observedFrom;
    return {
      observedAt: representativeObservedAt,
      observedUntil: representativeObservedAt,
      tokenKey: JSON.stringify([
        'point-event',
        observation.deviceKey ?? null,
        observation.signalKey,
      ]),
      label: `${observation.signalKey} point event on ${deviceLabel}`,
    };
  }
  if (observation.kind === 'episode') {
    if (
      !isRecord(observation.value) ||
      observation.value.ambiguous !== false ||
      observation.value.leftCensored !== false ||
      observation.value.rightCensored !== false
    ) {
      return undefined;
    }
    const parameterValue = profileOpaqueParameterValue(observation.value.parameterValue);
    const regionReference = episodeRegionReference(observation.value, parameterValue);
    const region =
      observation.deviceKey === undefined || regionReference === undefined
        ? undefined
        : resolveConfirmedRegion({
            corrections,
            deviceKey: observation.deviceKey,
            observedAt: observation.observedFrom,
            ...(correctionKnownAt !== undefined && { knownAt: correctionKnownAt }),
            ...regionReference,
          });
    return {
      observedAt: observation.observedFrom,
      observedUntil: observation.observedUntil,
      tokenKey: JSON.stringify([
        'episode',
        observation.deviceKey ?? null,
        observation.signalKey,
        parameterValue ?? null,
        region?.correctionId ?? null,
      ]),
      label:
        region !== undefined
          ? `${observation.signalKey} confirmed region ${renderProfileScalar(
              region.meaning,
            )} (raw ${renderProfileScalar(region.rawLabel)}) on ${deviceLabel}`
          : parameterValue === undefined
            ? `${observation.signalKey} episode on ${deviceLabel}`
            : `${observation.signalKey} opaque value ${renderProfileScalar(
                parameterValue,
              )} on ${deviceLabel}`,
      ...(region !== undefined && { region }),
      ...(regionReference !== undefined && { regionObserved: true as const }),
    };
  }
  if (
    observation.kind !== 'state-interval' ||
    !isRecord(observation.value) ||
    observation.value.leftCensored !== false
  ) {
    return undefined;
  }
  const rawState = profileStateRawValue(observation.value.state);
  if (rawState === undefined) return undefined;
  const regionReference = stateRegionReference(observation.value);
  const region =
    observation.deviceKey === undefined || regionReference === undefined
      ? undefined
      : resolveConfirmedRegion({
          corrections,
          deviceKey: observation.deviceKey,
          observedAt: observation.observedFrom,
          ...(correctionKnownAt !== undefined && { knownAt: correctionKnownAt }),
          rawLabel: regionReference.label,
          ...(regionReference.mapBank !== undefined && { mapBank: regionReference.mapBank }),
        });
  return {
    observedAt: observation.observedFrom,
    observedUntil: observation.observedUntil,
    tokenKey: JSON.stringify([
      'state-transition',
      observation.deviceKey ?? null,
      observation.signalKey,
      rawState,
      region?.correctionId ?? null,
    ]),
    label:
      region === undefined
        ? `${observation.signalKey} state ${renderProfileScalar(rawState)} on ${deviceLabel}`
        : `${observation.signalKey} confirmed region ${renderProfileScalar(
            region.meaning,
          )} (raw ${renderProfileScalar(region.rawLabel)}) active on ${deviceLabel}`,
    ...(region !== undefined && { region }),
    ...(regionReference !== undefined && { regionObserved: true as const }),
  };
}

function episodeRegionReference(
  value: Record<string, unknown>,
  parameterValue: string | number | boolean | undefined,
): { rawLabel: string; mapBank?: string } | undefined {
  const semantic = value.parameterSemantic;
  if (!isRecord(semantic) || semantic.regionIdentifier !== true) return undefined;
  const derivedLabel =
    typeof semantic.derivedLabel === 'string' && semantic.derivedLabel.trim().length > 0
      ? semantic.derivedLabel.trim()
      : undefined;
  const rawLabel =
    derivedLabel ??
    (typeof parameterValue === 'string' && /^(?:[AB]-\d{1,2}|Zone-\d{1,2})$/.test(parameterValue)
      ? parameterValue
      : typeof parameterValue === 'number' &&
          Number.isInteger(parameterValue) &&
          parameterValue >= 1 &&
          parameterValue <= 64
        ? `Zone-${parameterValue}`
        : undefined);
  if (rawLabel === undefined) return undefined;
  const mapBank = /^([AB])-\d{1,2}$/.exec(rawLabel)?.[1];
  return {
    rawLabel,
    ...(mapBank !== undefined && { mapBank }),
  };
}

function stateRegionReference(
  value: Record<string, unknown>,
): { label: string; mapBank?: string } | undefined {
  const region = value.region;
  if (
    !isRecord(region) ||
    region.activity !== 'active' ||
    typeof region.label !== 'string' ||
    region.label.trim().length === 0
  ) {
    return undefined;
  }
  return {
    label: region.label.trim(),
    ...(typeof region.mapBank === 'string' &&
      region.mapBank.trim().length > 0 && { mapBank: region.mapBank.trim() }),
  };
}

function resolveConfirmedRegion(input: {
  corrections: readonly HabitLearningCorrection[];
  deviceKey: HabitLearningAnonymousDeviceKey;
  rawLabel: string;
  mapBank?: string;
  observedAt: number;
  knownAt?: number;
}): HabitLearningHypothesisOccurrence['region'] | undefined {
  const confirmation = resolveHabitLearningCorrectionsAsOf({
    corrections: input.corrections,
    asOf: input.observedAt,
    ...(input.knownAt !== undefined && { knownAt: input.knownAt }),
  }).find(
    (candidate) =>
      candidate.subject.kind === 'region-label' &&
      candidate.subject.deviceKey === input.deviceKey &&
      candidate.subject.label === input.rawLabel &&
      candidate.subject.mapBank === input.mapBank,
  );
  if (confirmation === undefined) return undefined;
  const meaning = confirmedRegionMeaning(confirmation.value);
  if (meaning === undefined) return undefined;
  return {
    rawLabel: input.rawLabel,
    ...(input.mapBank !== undefined && { mapBank: input.mapBank }),
    meaning,
    correctionId: confirmation.correctionId,
  };
}

function confirmedRegionMeaning(value: HabitLearningJsonValue): string | undefined {
  if (typeof value === 'string') {
    const meaning = value.trim();
    return meaning.length > 0 ? meaning : undefined;
  }
  if (!isRecord(value) || typeof value.meaning !== 'string') return undefined;
  const meaning = value.meaning.trim();
  return meaning.length > 0 ? meaning : undefined;
}

function profileStateRawValue(value: unknown): string | number | boolean | null | undefined {
  if (isProfileScalar(value)) return value;
  if (isRecord(value) && isProfileScalar(value.rawValue)) return value.rawValue;
  return undefined;
}

function profileOpaqueParameterValue(value: unknown): string | number | boolean | undefined {
  if (isOpaqueParameterValue(value)) return value;
  if (isRecord(value) && isOpaqueParameterValue(value.rawValue)) return value.rawValue;
  return undefined;
}

function createHabitLearningLocalClock(
  timezone: string,
): (timestamp: number) => { date: string; minute: number } {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US-u-ca-iso8601-nu-latn', {
      timeZone: timezone.trim(),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    throw new RangeError(`timezone is not recognized: ${timezone}`);
  }
  return (timestamp) => {
    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime())) {
      throw new RangeError(
        `observation timestamp is outside the supported Date range: ${timestamp}`,
      );
    }
    const parts = Object.fromEntries(
      formatter
        .formatToParts(date)
        .filter(({ type }) => ['year', 'month', 'day', 'hour', 'minute'].includes(type))
        .map(({ type, value }) => [type, value]),
    );
    const year = parts.year;
    const month = parts.month;
    const day = parts.day;
    const hour = Number(parts.hour);
    const minute = Number(parts.minute);
    if (
      year === undefined ||
      month === undefined ||
      day === undefined ||
      !Number.isInteger(hour) ||
      hour < 0 ||
      hour > 23 ||
      !Number.isInteger(minute) ||
      minute < 0 ||
      minute > 59
    ) {
      throw new RangeError(`could not project observation timestamp in ${timezone}`);
    }
    return {
      date: `${year}-${month}-${day}`,
      minute: hour * 60 + minute,
    };
  };
}

function minimalCircularClockWindow(minutes: readonly number[]): HabitLearningClockWindow {
  const ordered = [...new Set(minutes)].sort((left, right) => left - right);
  const first = ordered[0];
  if (first === undefined) throw new TypeError('clock window requires at least one occurrence');
  if (ordered.length === 1) {
    return { startMinute: first, endMinute: first, spanMinutes: 0 };
  }
  let largestGap = Number.NEGATIVE_INFINITY;
  let largestGapIndex = 0;
  for (let index = 0; index < ordered.length; index += 1) {
    const current = ordered[index];
    const next = ordered[(index + 1) % ordered.length];
    if (current === undefined || next === undefined) continue;
    const gap = index === ordered.length - 1 ? next + 24 * 60 - current : next - current;
    if (gap > largestGap) {
      largestGap = gap;
      largestGapIndex = index;
    }
  }
  const endMinute = ordered[largestGapIndex];
  const startMinute = ordered[(largestGapIndex + 1) % ordered.length];
  if (startMinute === undefined || endMinute === undefined) {
    throw new Error('internal error: clock-window boundary is unavailable');
  }
  return {
    startMinute,
    endMinute,
    spanMinutes: (endMinute - startMinute + 24 * 60) % (24 * 60),
  };
}

function compareHypothesisOccurrences(
  left: HabitLearningHypothesisOccurrence,
  right: HabitLearningHypothesisOccurrence,
): number {
  return (
    left.observedAt - right.observedAt ||
    left.observedUntil - right.observedUntil ||
    compareStrings(left.observation.observationId, right.observation.observationId)
  );
}

function formatClockMinute(minute: number): string {
  const hour = Math.floor(minute / 60);
  return `${String(hour).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

function formatDurationRange(minimumMs: number, maximumMs: number): string {
  const minimumSeconds = Math.round(minimumMs / 1_000);
  const maximumSeconds = Math.round(maximumMs / 1_000);
  return minimumSeconds === maximumSeconds
    ? `${minimumSeconds} seconds`
    : `${minimumSeconds}–${maximumSeconds} seconds`;
}

function renderProfileScalar(value: string | number | boolean | null | undefined): string {
  const rendered = JSON.stringify(value ?? null);
  return rendered.length <= 96 ? rendered : `${rendered.slice(0, 95)}…`;
}

function isOpaqueParameterValue(value: unknown): value is string | number | boolean {
  return (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

function isProfileScalar(value: unknown): value is string | number | boolean | null {
  return value === null || isOpaqueParameterValue(value);
}

function assertIntegerAtLeast(
  value: unknown,
  minimum: number,
  path: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new TypeError(`${path} must be a safe integer greater than or equal to ${minimum}`);
  }
}

function assertIntegerInRange(
  value: unknown,
  minimum: number,
  maximum: number,
  path: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${path} must be a safe integer in [${minimum}, ${maximum}]`);
  }
}

function validateCorrectionJournal(
  input: readonly HabitLearningCorrection[],
): HabitLearningCorrection[] {
  const parsed = z.array(HabitLearningCorrectionSchema).parse(input);
  const byId = new Map<string, HabitLearningCorrection>();
  let previousRecordedAt = Number.NEGATIVE_INFINITY;
  for (const [index, correction] of parsed.entries()) {
    if (correction.recordedAt < previousRecordedAt) {
      throw new RangeError(`corrections must preserve append order by recordedAt (index ${index})`);
    }
    previousRecordedAt = correction.recordedAt;
    if (byId.has(correction.correctionId)) {
      throw new TypeError(`duplicate correctionId: ${correction.correctionId}`);
    }
    if (correction.supersedes !== undefined) {
      const superseded = byId.get(correction.supersedes);
      if (superseded === undefined) {
        throw new TypeError(
          `correction ${correction.correctionId} supersedes an unknown or later record`,
        );
      }
      if (correctionSubjectKey(superseded.subject) !== correctionSubjectKey(correction.subject)) {
        throw new TypeError(
          `correction ${correction.correctionId} cannot supersede a different subject`,
        );
      }
    }
    byId.set(correction.correctionId, correction);
  }
  return parsed;
}

function correctionSubjectKey(subject: HabitLearningCorrectionSubject): string {
  switch (subject.kind) {
    case 'region-label':
      return JSON.stringify([
        subject.kind,
        subject.deviceKey,
        subject.mapBank ?? null,
        subject.label,
      ]);
    case 'household-fact':
      return JSON.stringify([subject.kind, subject.field]);
    case 'automation-constraint':
      return JSON.stringify([subject.kind, subject.constraintKey]);
    case 'profile-field':
      return JSON.stringify([subject.kind, subject.field]);
  }
}

function assertUniqueField<Value extends Record<Field, string>, Field extends keyof Value>(
  values: readonly Value[],
  field: Field,
  label: string,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    const id = value[field];
    if (seen.has(id)) throw new TypeError(`duplicate ${label} id: ${id}`);
    seen.add(id);
  }
}

function assertSubset(
  subset: readonly string[],
  superset: readonly string[],
  subsetName: string,
  supersetName: string,
): void {
  const allowed = new Set(superset);
  const missing = subset.filter((value) => !allowed.has(value));
  if (missing.length > 0) {
    throw new TypeError(
      `${subsetName} must be a subset of ${supersetName}; missing: ${missing.join(', ')}`,
    );
  }
}

function uniqueValidatedStrings(values: readonly string[], path: string): string[] {
  const result = new Set<string>();
  values.forEach((value, index) => {
    assertNonEmptyString(value, `${path}[${index}]`);
    if (result.has(value)) throw new TypeError(`${path} contains duplicate value: ${value}`);
    result.add(value);
  });
  return [...result].sort(compareStrings);
}

function uniqueSortedStrings(values: readonly string[]): string[] {
  for (const [index, value] of values.entries()) {
    assertNonEmptyString(value, `values[${index}]`);
  }
  return [...new Set(values)].sort(compareStrings);
}

function digestStable(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex');
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function safeAdd(left: number, right: number, path: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new RangeError(`${path} exceeds safe timestamp range`);
  return result;
}

function assertPositiveSafeInteger(value: unknown, path: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${path} must be a positive safe integer`);
  }
}

function assertNonNegativeSafeInteger(value: unknown, path: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${path} must be a non-negative safe integer`);
  }
}

function assertNonEmptyString(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${path} must be a non-empty string`);
  }
}

function assertNonEmptyTrimmedString(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${path} must be a non-empty string`);
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createHabitLearningCorrection(
  input: Omit<HabitLearningCorrection, 'correctionVersion' | 'correctionId'> & {
    correctionIdMaterial: HabitLearningJsonValue;
  },
): HabitLearningCorrection {
  const { correctionIdMaterial, ...correction } = input;
  return HabitLearningCorrectionSchema.parse({
    correctionVersion: HABIT_LEARNING_CORRECTION_VERSION,
    correctionId: digestStable({
      recordedAt: correction.recordedAt,
      asOf: correction.asOf,
      subject: correction.subject,
      value: correction.value,
      source: correction.source,
      supersedes: correction.supersedes,
      correctionIdMaterial,
    }),
    ...correction,
  });
}
