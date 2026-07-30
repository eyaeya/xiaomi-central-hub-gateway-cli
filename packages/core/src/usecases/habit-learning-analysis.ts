import { createHash } from 'node:crypto';
import {
  type HabitLearningAnonymousDeviceKey,
  HabitLearningAnonymousDeviceKeySchema,
  type HabitLearningProfileCompleteness,
} from '../schemas/habit-learning-profile.js';
import {
  type HabitLearningAnalysisGap,
  type HabitLearningAnalysisRange,
  type HabitLearningDebouncedEpisode,
  type HabitLearningParameterValue,
  type HabitLearningRawParameterInterval,
  type HabitLearningUnpairedParameterEvent,
  extractHabitLearningDebouncedEpisodes,
  pairHabitLearningParameterEvents,
} from './habit-learning-episodes.js';
import {
  type HabitLearningObservation,
  type HabitLearningObservationValue,
  type HabitLearningPersistentStateInterval,
  type HabitLearningPersistentStateValue,
  type HabitLearningPreloadBaselineResult,
  classifyHabitLearningPreloadBaselines,
  intervalizeHabitLearningPersistentState,
} from './habit-learning-observations.js';
import {
  type AssessHabitLearningCompletenessInput,
  assessHabitLearningProfileCompleteness,
} from './habit-learning-profile.js';
import type { RuleLogEntry } from './rule-logs.js';

const SIGNAL_ID_PATTERN = /^[a-f0-9]{64}$/;

export type HabitLearningAnalysisSourceSemantics =
  | {
      sourceId: string;
      signalId: string;
      deviceKey: HabitLearningAnonymousDeviceKey;
      included: boolean;
      analysisKind: 'persistent-property';
      /** Present only when this property was configured with preload. */
      preloadNodeId?: string;
    }
  | {
      sourceId: string;
      signalId: string;
      deviceKey: HabitLearningAnonymousDeviceKey;
      included: boolean;
      analysisKind: 'point-event';
    }
  | {
      sourceId: string;
      signalId: string;
      deviceKey: HabitLearningAnonymousDeviceKey;
      included: boolean;
      analysisKind: 'parameter-event-start' | 'parameter-event-end';
      /**
       * Stable semantic channel shared by the matching start/end source.
       * The event's raw parameter remains the pairing key.
       */
      channelKey: string;
    };

export type HabitLearningEvidenceClassification =
  | 'behavior'
  | 'preload-baseline'
  | 'baseline-ambiguous'
  | 'gap-reanchor'
  | 'inside-gap'
  | 'outside-range'
  | 'excluded-source';

export interface HabitLearningClassifiedObservation {
  observationId: string;
  sourceId: string;
  signalId: string;
  deviceKey: HabitLearningAnonymousDeviceKey;
  analysisKind: HabitLearningAnalysisSourceSemantics['analysisKind'];
  observedAt: number;
  /** Exact normalized value; opaque region keys are not translated here. */
  value: HabitLearningObservationValue;
  classification: HabitLearningEvidenceClassification;
  provenance: {
    evidence: HabitLearningObservation['evidence'];
    entryIndex: number;
    timestamp: number;
    rawRef: string;
  };
  inferenceBoundary: 'sensor-evidence-only-no-person-or-household-inference';
}

export interface HabitLearningStateIntervalEvidence extends HabitLearningPersistentStateInterval {
  intervalId: string;
  signalId: string;
  deviceKey: HabitLearningAnonymousDeviceKey;
  /**
   * `firstObservedAt` / `lastObservedAt` retain real gateway timestamps. For a
   * preload anchor, `firstObservedAt` may precede the bounded interval start.
   */
  observationIds: string[];
  rawRefs: string[];
  inferenceBoundary: 'sensor-state-only';
}

export interface HabitLearningObservedSignalCoverage {
  plannedSignalIds: string[];
  includedSignalIds: string[];
  excludedSignalIds: string[];
  /** Included property signals expected to emit one preload transaction after enable. */
  expectedPreloadSignalIds: string[];
  /** Included signals for which an enable-boundary preload was actually classified. */
  baselineSeenSignalIds: string[];
  observedSignalIds: string[];
  behaviorObservedSignalIds: string[];
  baselineOnlySignalIds: string[];
  stateAnchorOnlySignalIds: string[];
  ambiguousSignalIds: string[];
  missingSignalIds: string[];
}

export interface HabitLearningAnalysisPlanSignal {
  signalId: string;
  included: boolean;
}

export interface BuildHabitLearningProfileEvidenceInput {
  /** Parsed rule logs in gateway order, oldest first. */
  entries: readonly RuleLogEntry[];
  /** Output of normalizeHabitLearningObservations for the same entries/rule. */
  observations: readonly HabitLearningObservation[];
  sources: readonly HabitLearningAnalysisSourceSemantics[];
  /**
   * Full planner coverage, including excluded signals that have no compiled
   * source. When omitted, coverage is derived from `sources`.
   */
  planSignals?: readonly HabitLearningAnalysisPlanSignal[];
  range: HabitLearningAnalysisRange;
  gaps?: readonly HabitLearningAnalysisGap[];
  baseline: {
    ruleId: string;
    quietPeriodMs: number;
    hardCapMs: number;
    /**
     * Exact enable row selected by the study lifecycle. Supplying it is
     * preferred when the observation clock starts after enable readback.
     */
    enableBoundary?: {
      entryIndex: number;
      timestamp: number;
    };
  };
  debounceMs: number;
  /**
   * `continuous` is accepted only as caller-provided durable collector
   * evidence. This use case does not infer continuity from an empty gap list.
   */
  continuityEvidence: 'continuous' | 'unknown';
  completenessReasonCodes?: readonly string[];
}

export interface HabitLearningProfileEvidence {
  baseline: HabitLearningPreloadBaselineResult;
  classifiedObservations: HabitLearningClassifiedObservation[];
  behaviorObservations: HabitLearningClassifiedObservation[];
  pointEvents: HabitLearningClassifiedObservation[];
  stateIntervals: HabitLearningStateIntervalEvidence[];
  parameterIntervals: HabitLearningRawParameterInterval[];
  parameterEpisodes: HabitLearningDebouncedEpisode[];
  unpairedParameterEvents: HabitLearningUnpairedParameterEvent[];
  coverage: HabitLearningObservedSignalCoverage;
  completenessInput: AssessHabitLearningCompletenessInput;
  completeness: HabitLearningProfileCompleteness;
  inferencePolicy: {
    regionKeys: 'opaque-until-user-confirmed';
    householdSizeInference: 'prohibited';
    personIdentityInference: 'prohibited';
    roomSemanticsInference: 'prohibited';
  };
}

/**
 * Build bounded, profile-ready evidence from normalized study observations.
 *
 * This pure function deliberately stops before habit/route interpretation:
 *
 * - preload candidates are delegated to the existing enable-aware classifier;
 * - ambiguous preload rows never become behavior;
 * - the first property state after each gap is a re-anchor, not a transition;
 * - raw parameter values remain opaque pairing keys;
 * - debounce cannot bridge a declared evidence gap;
 * - completeness is computed from behavior-bearing signals, not baselines.
 */
export function buildHabitLearningProfileEvidence(
  input: BuildHabitLearningProfileEvidenceInput,
): HabitLearningProfileEvidence {
  assertRange(input.range);
  const gaps = validateGaps(input.gaps ?? [], input.range);
  assertNonEmptyString(input.baseline.ruleId, 'baseline.ruleId');
  assertNonNegativeSafeInteger(input.debounceMs, 'debounceMs');
  const baselineEntries = isolateSingleAnalysisEpoch(
    input.entries,
    input.baseline.ruleId,
    input.range,
    input.baseline.enableBoundary,
  );
  const semantics = validateSourceSemantics(input.sources);
  const planSignals = validatePlanSignals(
    input.planSignals ??
      uniquePlanSignalsFromSources(
        semantics.map((source) => ({
          signalId: source.signalId,
          included: source.included,
        })),
      ),
  );
  assertPlanSourceConsistency(planSignals, semantics);
  const bySourceId = new Map(semantics.map((source) => [source.sourceId, source]));
  assertNormalizedObservationProvenance(
    input.observations,
    input.entries,
    input.baseline.ruleId,
    bySourceId,
  );

  const preloadNodeIds = semantics
    .filter(
      (
        source,
      ): source is Extract<
        HabitLearningAnalysisSourceSemantics,
        { analysisKind: 'persistent-property' }
      > & { preloadNodeId: string } =>
        source.included &&
        source.analysisKind === 'persistent-property' &&
        source.preloadNodeId !== undefined,
    )
    .map((source) => source.preloadNodeId)
    .sort(compareStrings);
  const baseline = classifyHabitLearningPreloadBaselines({
    entries: baselineEntries,
    ruleId: input.baseline.ruleId,
    expectedSourceIds: preloadNodeIds,
    quietPeriodMs: input.baseline.quietPeriodMs,
    hardCapMs: input.baseline.hardCapMs,
  });
  assertBaselineWindowDoesNotCrossGap(baseline, gaps);
  const preloadMarks = classifyPreloadEntryIndexes(baseline, semantics, input.entries);

  const classifiedObservations = input.observations.map((observation) => {
    const source = bySourceId.get(observation.sourceId);
    if (source === undefined) {
      throw new TypeError(`missing analysis semantics for source ${observation.sourceId}`);
    }
    const rawRef = `rule-log-entry:${observation.entryIndex}`;
    return {
      observationId: digestStable({
        ruleId: input.baseline.ruleId,
        sourceId: observation.sourceId,
        entryIndex: observation.entryIndex,
        observedAt: observation.observedAt,
        value: observation.value,
      }),
      sourceId: observation.sourceId,
      signalId: source.signalId,
      deviceKey: source.deviceKey,
      analysisKind: source.analysisKind,
      observedAt: observation.observedAt,
      value: observation.value,
      classification: initialObservationClassification({
        observation,
        source,
        range: input.range,
        gaps,
        preloadMarks,
        preloadBoundaryFound: baseline.boundary.status === 'found',
      }),
      provenance: {
        evidence: observation.evidence,
        entryIndex: observation.entryIndex,
        timestamp: observation.timestamp,
        rawRef,
      },
      inferenceBoundary: 'sensor-evidence-only-no-person-or-household-inference' as const,
    };
  });
  markPropertyGapReanchors(classifiedObservations, gaps);

  const stateIntervals = buildStateIntervals({
    classifiedObservations,
    semantics,
    range: input.range,
    gaps,
  });
  const parameterEvents = classifiedObservations
    .filter(
      (observation) =>
        observation.classification === 'behavior' &&
        (observation.analysisKind === 'parameter-event-start' ||
          observation.analysisKind === 'parameter-event-end'),
    )
    .map((observation) => {
      const source = bySourceId.get(observation.sourceId);
      if (
        source === undefined ||
        (source.analysisKind !== 'parameter-event-start' &&
          source.analysisKind !== 'parameter-event-end')
      ) {
        throw new Error('internal error: parameter event semantics are unavailable');
      }
      return {
        eventId: observation.observationId,
        sourceId: observation.sourceId,
        deviceKey: observation.deviceKey,
        channelKey: source.channelKey,
        parameterValue: requireParameterValue(
          observation.value,
          `observation ${observation.observationId}`,
        ),
        phase:
          source.analysisKind === 'parameter-event-start' ? ('start' as const) : ('end' as const),
        observedAt: observation.observedAt,
        rawRefs: [observation.provenance.rawRef],
      };
    });
  const paired = pairHabitLearningParameterEvents({
    events: parameterEvents,
    range: input.range,
    gaps,
  });
  const parameterEpisodes = extractHabitLearningDebouncedEpisodes({
    intervals: paired.intervals,
    debounceMs: input.debounceMs,
    gaps,
  });

  const behaviorObservations = classifiedObservations.filter(
    (observation) => observation.classification === 'behavior',
  );
  const pointEvents = behaviorObservations.filter(
    (observation) => observation.analysisKind === 'point-event',
  );
  const coverage = calculateObservedSignalCoverage(planSignals, classifiedObservations, semantics);
  const completenessInput: AssessHabitLearningCompletenessInput = {
    plannedSignalIds: coverage.plannedSignalIds,
    includedSignalIds: coverage.includedSignalIds,
    // Baseline snapshots and post-gap state anchors prove observability, not habits.
    observedSignalIds: coverage.behaviorObservedSignalIds,
    gapIds: gaps.map((gap) => gap.gapId),
    continuityEvidence: input.continuityEvidence,
    ...(input.completenessReasonCodes !== undefined && {
      reasonCodes: [...input.completenessReasonCodes],
    }),
  };
  return {
    baseline,
    classifiedObservations,
    behaviorObservations,
    pointEvents,
    stateIntervals,
    parameterIntervals: paired.intervals,
    parameterEpisodes,
    unpairedParameterEvents: paired.unpairedEvents,
    coverage,
    completenessInput,
    completeness: assessHabitLearningProfileCompleteness(completenessInput),
    inferencePolicy: {
      regionKeys: 'opaque-until-user-confirmed',
      householdSizeInference: 'prohibited',
      personIdentityInference: 'prohibited',
      roomSemanticsInference: 'prohibited',
    },
  };
}

/**
 * Keep preload classification inside one explicit study epoch.
 *
 * We preserve the original entry indexes by masking same-rule rows before the
 * selected boundary and slicing only the suffix after the range. A missing enable
 * boundary is still representable as ambiguous evidence, but a disable,
 * re-enable, or late enable inside the range cannot be interpreted safely as
 * one continuous study.
 */
function isolateSingleAnalysisEpoch(
  entries: readonly RuleLogEntry[],
  ruleId: string,
  range: HabitLearningAnalysisRange,
  requestedBoundary?: { entryIndex: number; timestamp: number },
): RuleLogEntry[] {
  let previousTimestamp = Number.NEGATIVE_INFINITY;
  for (const [index, entry] of entries.entries()) {
    if (entry.timestamp < previousTimestamp) {
      throw new RangeError(`entries must be ordered oldest first (entry ${index})`);
    }
    previousTimestamp = entry.timestamp;
  }

  const lifecycleBoundaries = entries
    .map((entry, entryIndex) => ({
      entry,
      entryIndex,
      enable: ruleEnableState(entry, ruleId),
    }))
    .filter(
      (
        candidate,
      ): candidate is {
        entry: RuleLogEntry;
        entryIndex: number;
        enable: boolean;
      } => candidate.enable !== undefined && candidate.entry.timestamp < range.end,
    );

  let boundary:
    | {
        entry: RuleLogEntry;
        entryIndex: number;
        enable: boolean;
      }
    | undefined;
  if (requestedBoundary !== undefined) {
    assertNonNegativeSafeInteger(
      requestedBoundary.entryIndex,
      'baseline.enableBoundary.entryIndex',
    );
    assertNonNegativeSafeInteger(requestedBoundary.timestamp, 'baseline.enableBoundary.timestamp');
    const entry = entries[requestedBoundary.entryIndex];
    if (
      entry === undefined ||
      entry.timestamp !== requestedBoundary.timestamp ||
      ruleEnableState(entry, ruleId) !== true
    ) {
      throw new TypeError('baseline.enableBoundary must reference an enabled rule lifecycle row');
    }
    if (entry.timestamp > range.start) {
      throw new RangeError('baseline.enableBoundary must not occur after range.start');
    }
    boundary = {
      entry,
      entryIndex: requestedBoundary.entryIndex,
      enable: true,
    };
  } else {
    boundary = lifecycleBoundaries
      .filter((candidate) => candidate.entry.timestamp <= range.start)
      .at(-1);
  }

  if (boundary !== undefined && !boundary.enable) {
    throw new RangeError('analysis range starts after a disable boundary');
  }
  if (boundary !== undefined) {
    const boundaryTimestamp = boundary.entry.timestamp;
    const sameTimestampBoundaries = lifecycleBoundaries.filter(
      (candidate) => candidate.entry.timestamp === boundaryTimestamp,
    );
    if (sameTimestampBoundaries.length !== 1) {
      throw new RangeError('analysis enable lifecycle boundary is ambiguous at one timestamp');
    }
    const laterBoundary = lifecycleBoundaries.find(
      (candidate) => candidate.entryIndex > boundary.entryIndex,
    );
    if (laterBoundary !== undefined) {
      throw new RangeError(
        'analysis range crosses a disable or re-enable lifecycle boundary; split epochs before analysis',
      );
    }
  } else if (lifecycleBoundaries.length > 0) {
    throw new RangeError('analysis range starts before its enable lifecycle boundary');
  }

  const endIndex = entries.findIndex((entry) => entry.timestamp >= range.end);
  const prefix = entries.slice(0, endIndex === -1 ? entries.length : endIndex);
  return prefix.map((entry, entryIndex) =>
    entry.graphId === ruleId && boundary !== undefined && entryIndex < boundary.entryIndex
      ? { ...entry, graphId: '' }
      : entry,
  );
}

function ruleEnableState(entry: RuleLogEntry, ruleId: string): boolean | undefined {
  if (
    entry.graphId !== ruleId ||
    entry.rawType !== 'r' ||
    !isRecord(entry.ruleConfig) ||
    typeof entry.ruleConfig.enable !== 'boolean'
  ) {
    return undefined;
  }
  return entry.ruleConfig.enable;
}

function assertBaselineWindowDoesNotCrossGap(
  baseline: HabitLearningPreloadBaselineResult,
  gaps: readonly HabitLearningAnalysisGap[],
): void {
  if (baseline.boundary.status !== 'found' || baseline.window === undefined) return;
  const { boundary, window } = baseline;
  const crossing = gaps.find((gap) => gap.start <= window.end && gap.end > boundary.timestamp);
  if (crossing !== undefined) {
    throw new RangeError(
      `baseline preload window intersects collector gap ${crossing.gapId}; restart or split the study epoch`,
    );
  }
}

function buildStateIntervals(input: {
  classifiedObservations: readonly HabitLearningClassifiedObservation[];
  semantics: readonly HabitLearningAnalysisSourceSemantics[];
  range: HabitLearningAnalysisRange;
  gaps: readonly HabitLearningAnalysisGap[];
}): HabitLearningStateIntervalEvidence[] {
  const semantics = new Map(input.semantics.map((source) => [source.sourceId, source]));
  const usable = input.classifiedObservations.filter(
    (observation) =>
      observation.analysisKind === 'persistent-property' &&
      (observation.classification === 'behavior' ||
        observation.classification === 'preload-baseline' ||
        observation.classification === 'gap-reanchor'),
  );
  const stateObservations = usable.map((observation) => ({
    sourceId: observation.sourceId,
    observedAt: effectiveStateObservedAt(observation, input.range),
    value: requirePersistentStateValue(
      observation.value,
      `observation ${observation.observationId}`,
    ),
    evidence:
      observation.classification === 'behavior'
        ? ('change' as const)
        : ('preload-snapshot' as const),
  }));
  const intervalized = intervalizeHabitLearningPersistentState({
    observations: stateObservations,
    range: input.range,
    gaps: input.gaps,
  });
  return intervalized.intervals.map((interval) => {
    const source = semantics.get(interval.sourceId);
    if (source === undefined) {
      throw new Error(`internal error: semantics missing for interval ${interval.sourceId}`);
    }
    const supporting = usable.filter(
      (observation) =>
        observation.sourceId === interval.sourceId &&
        effectiveStateObservedAt(observation, input.range) >= interval.firstObservedAt &&
        effectiveStateObservedAt(observation, input.range) <= interval.lastObservedAt &&
        Object.is(observation.value, interval.value),
    );
    if (supporting.length === 0) {
      throw new Error(`internal error: interval ${interval.sourceId} has no supporting evidence`);
    }
    const observationIds = supporting.map((observation) => observation.observationId);
    const rawRefs = supporting.map((observation) => observation.provenance.rawRef);
    const firstObservedAt = Math.min(...supporting.map((observation) => observation.observedAt));
    const lastObservedAt = Math.max(...supporting.map((observation) => observation.observedAt));
    return {
      ...interval,
      firstObservedAt,
      lastObservedAt,
      intervalId: digestStable({
        sourceId: interval.sourceId,
        value: interval.value,
        start: interval.start,
        end: interval.end,
        observationIds,
      }),
      signalId: source.signalId,
      deviceKey: source.deviceKey,
      observationIds,
      rawRefs,
      inferenceBoundary: 'sensor-state-only' as const,
    };
  });
}

function calculateObservedSignalCoverage(
  planSignals: readonly HabitLearningAnalysisPlanSignal[],
  observations: readonly HabitLearningClassifiedObservation[],
  semantics: readonly HabitLearningAnalysisSourceSemantics[],
): HabitLearningObservedSignalCoverage {
  const plannedSignalIds = uniqueSortedStrings(planSignals.map((signal) => signal.signalId));
  const includedSignalIds = uniqueSortedStrings(
    planSignals.filter((signal) => signal.included).map((signal) => signal.signalId),
  );
  const excludedSignalIds = uniqueSortedStrings(
    planSignals.filter((signal) => !signal.included).map((signal) => signal.signalId),
  );
  const includedSet = new Set(includedSignalIds);
  const reliable = new Set(
    observations
      .filter((observation) =>
        ['behavior', 'preload-baseline', 'gap-reanchor'].includes(observation.classification),
      )
      .map((observation) => observation.signalId),
  );
  const behavior = new Set(
    observations
      .filter((observation) => observation.classification === 'behavior')
      .map((observation) => observation.signalId),
  );
  const baseline = new Set(
    observations
      .filter((observation) => observation.classification === 'preload-baseline')
      .map((observation) => observation.signalId),
  );
  const anchor = new Set(
    observations
      .filter((observation) =>
        ['preload-baseline', 'gap-reanchor'].includes(observation.classification),
      )
      .map((observation) => observation.signalId),
  );
  const ambiguous = new Set(
    observations
      .filter((observation) => observation.classification === 'baseline-ambiguous')
      .map((observation) => observation.signalId),
  );
  const expectedPreload = new Set(
    semantics
      .filter(
        (source) =>
          source.included &&
          source.analysisKind === 'persistent-property' &&
          source.preloadNodeId !== undefined,
      )
      .map((source) => source.signalId),
  );
  return {
    plannedSignalIds,
    includedSignalIds,
    excludedSignalIds,
    expectedPreloadSignalIds: sortedIntersection(expectedPreload, includedSet),
    baselineSeenSignalIds: sortedIntersection(baseline, includedSet),
    observedSignalIds: sortedIntersection(reliable, includedSet),
    behaviorObservedSignalIds: sortedIntersection(behavior, includedSet),
    baselineOnlySignalIds: sortedIntersection(
      new Set([...baseline].filter((signalId) => !behavior.has(signalId))),
      includedSet,
    ),
    stateAnchorOnlySignalIds: sortedIntersection(
      new Set([...anchor].filter((signalId) => !behavior.has(signalId))),
      includedSet,
    ),
    ambiguousSignalIds: sortedIntersection(ambiguous, includedSet),
    missingSignalIds: includedSignalIds.filter(
      (signalId) => !reliable.has(signalId) && !ambiguous.has(signalId),
    ),
  };
}

function validatePlanSignals(
  input: readonly HabitLearningAnalysisPlanSignal[],
): HabitLearningAnalysisPlanSignal[] {
  const signalIds = new Set<string>();
  return input.map((signal, index) => {
    if (!SIGNAL_ID_PATTERN.test(signal.signalId)) {
      throw new TypeError(`planSignals[${index}].signalId must be a SHA-256 hex digest`);
    }
    if (signalIds.has(signal.signalId)) {
      throw new TypeError(`duplicate plan signalId: ${signal.signalId}`);
    }
    signalIds.add(signal.signalId);
    if (typeof signal.included !== 'boolean') {
      throw new TypeError(`planSignals[${index}].included must be boolean`);
    }
    return { ...signal };
  });
}

function uniquePlanSignalsFromSources(
  input: readonly HabitLearningAnalysisPlanSignal[],
): HabitLearningAnalysisPlanSignal[] {
  const bySignalId = new Map<string, HabitLearningAnalysisPlanSignal>();
  for (const signal of input) {
    bySignalId.set(signal.signalId, signal);
  }
  return [...bySignalId.values()];
}

function assertPlanSourceConsistency(
  planSignals: readonly HabitLearningAnalysisPlanSignal[],
  sources: readonly HabitLearningAnalysisSourceSemantics[],
): void {
  const planBySignalId = new Map(planSignals.map((signal) => [signal.signalId, signal]));
  const sourceSignalIds = new Set<string>();
  for (const source of sources) {
    const planSignal = planBySignalId.get(source.signalId);
    if (planSignal === undefined) {
      throw new TypeError(`source ${source.sourceId} references signal absent from planSignals`);
    }
    if (planSignal.included !== source.included) {
      throw new TypeError(
        `source ${source.sourceId} inclusion disagrees with plan signal ${source.signalId}`,
      );
    }
    sourceSignalIds.add(source.signalId);
  }
  for (const signal of planSignals) {
    if (signal.included && !sourceSignalIds.has(signal.signalId)) {
      throw new TypeError(`included plan signal ${signal.signalId} has no source semantics`);
    }
  }
}

function classifyPreloadEntryIndexes(
  baseline: HabitLearningPreloadBaselineResult,
  semantics: readonly HabitLearningAnalysisSourceSemantics[],
  entries: readonly RuleLogEntry[],
): Map<string, 'preload-baseline' | 'baseline-ambiguous'> {
  const sourceIdByNodeId = new Map<string, string>();
  for (const source of semantics) {
    if (
      source.analysisKind !== 'persistent-property' ||
      source.preloadNodeId === undefined ||
      !source.included
    ) {
      continue;
    }
    if (sourceIdByNodeId.has(source.preloadNodeId)) {
      throw new TypeError(`duplicate preload node mapping: ${source.preloadNodeId}`);
    }
    sourceIdByNodeId.set(source.preloadNodeId, source.sourceId);
  }
  const marks = new Map<string, 'preload-baseline' | 'baseline-ambiguous'>();
  for (const source of baseline.sources) {
    const sourceId = sourceIdByNodeId.get(source.sourceId);
    if (sourceId === undefined) {
      throw new Error(`internal error: baseline node ${source.sourceId} has no source semantics`);
    }
    if (source.status === 'seen') {
      for (const entryIndex of source.entryIndexes) {
        marks.set(observationTransportKey(sourceId, entryIndex), 'preload-baseline');
      }
      continue;
    }
    if (source.status !== 'ambiguous') continue;
    let ambiguousIndexes: readonly number[];
    if (source.provenance === 'enable-boundary-missing') {
      ambiguousIndexes = source.laterEntryIndexes;
    } else if (source.provenance === 'first-info-after-window') {
      const firstIndex = source.laterEntryIndexes[0];
      const firstTimestamp = firstIndex === undefined ? undefined : entries[firstIndex]?.timestamp;
      ambiguousIndexes =
        firstTimestamp === undefined
          ? []
          : source.laterEntryIndexes.filter(
              (entryIndex) => entries[entryIndex]?.timestamp === firstTimestamp,
            );
    } else {
      ambiguousIndexes = source.entryIndexes;
    }
    for (const entryIndex of ambiguousIndexes) {
      marks.set(observationTransportKey(sourceId, entryIndex), 'baseline-ambiguous');
    }
  }
  return marks;
}

function initialObservationClassification(input: {
  observation: HabitLearningObservation;
  source: HabitLearningAnalysisSourceSemantics;
  range: HabitLearningAnalysisRange;
  gaps: readonly HabitLearningAnalysisGap[];
  preloadMarks: ReadonlyMap<string, 'preload-baseline' | 'baseline-ambiguous'>;
  preloadBoundaryFound: boolean;
}): HabitLearningEvidenceClassification {
  if (!input.source.included) return 'excluded-source';
  const preloadMark =
    input.source.analysisKind === 'persistent-property'
      ? input.preloadMarks.get(
          observationTransportKey(input.observation.sourceId, input.observation.entryIndex),
        )
      : undefined;
  if (input.preloadBoundaryFound && preloadMark !== undefined) return preloadMark;
  if (
    input.observation.observedAt < input.range.start ||
    input.observation.observedAt >= input.range.end
  ) {
    return 'outside-range';
  }
  if (
    input.gaps.some(
      (gap) => input.observation.observedAt >= gap.start && input.observation.observedAt < gap.end,
    )
  ) {
    return 'inside-gap';
  }
  if (preloadMark !== undefined) return preloadMark;
  return 'behavior';
}

function effectiveStateObservedAt(
  observation: HabitLearningClassifiedObservation,
  range: HabitLearningAnalysisRange,
): number {
  return observation.classification === 'preload-baseline' && observation.observedAt < range.start
    ? range.start
    : observation.observedAt;
}

function markPropertyGapReanchors(
  observations: HabitLearningClassifiedObservation[],
  gaps: readonly HabitLearningAnalysisGap[],
): void {
  const propertySources = uniqueSortedStrings(
    observations
      .filter((observation) => observation.analysisKind === 'persistent-property')
      .map((observation) => observation.sourceId),
  );
  for (const sourceId of propertySources) {
    for (const gap of gaps) {
      const nextGapStart =
        gaps.find((candidate) => candidate.start >= gap.end)?.start ?? Number.POSITIVE_INFINITY;
      const firstAfterGap = observations.find(
        (observation) =>
          observation.sourceId === sourceId &&
          observation.analysisKind === 'persistent-property' &&
          observation.classification === 'behavior' &&
          observation.observedAt >= gap.end &&
          observation.observedAt < nextGapStart,
      );
      if (firstAfterGap === undefined) continue;
      const sameTimestamp = observations.filter(
        (observation) =>
          observation.sourceId === sourceId &&
          observation.analysisKind === 'persistent-property' &&
          observation.classification === 'behavior' &&
          observation.observedAt === firstAfterGap.observedAt,
      );
      const distinctValues = new Set(
        sameTimestamp.map((observation) => JSON.stringify(stableValue(observation.value))),
      );
      for (const observation of sameTimestamp) {
        observation.classification =
          distinctValues.size === 1 ? 'gap-reanchor' : 'baseline-ambiguous';
      }
    }
  }
}

function validateSourceSemantics(
  input: readonly HabitLearningAnalysisSourceSemantics[],
): HabitLearningAnalysisSourceSemantics[] {
  const sourceIds = new Set<string>();
  const preloadNodeIds = new Set<string>();
  const signalContracts = new Map<
    string,
    { included: boolean; deviceKey: HabitLearningAnonymousDeviceKey }
  >();
  const sources = input.map((source, index) => {
    assertNonEmptyString(source.sourceId, `sources[${index}].sourceId`);
    if (sourceIds.has(source.sourceId)) {
      throw new TypeError(`duplicate analysis sourceId: ${source.sourceId}`);
    }
    sourceIds.add(source.sourceId);
    if (!SIGNAL_ID_PATTERN.test(source.signalId)) {
      throw new TypeError(`sources[${index}].signalId must be a SHA-256 hex digest`);
    }
    HabitLearningAnonymousDeviceKeySchema.parse(source.deviceKey);
    const signalContract = signalContracts.get(source.signalId);
    if (
      signalContract !== undefined &&
      (signalContract.included !== source.included || signalContract.deviceKey !== source.deviceKey)
    ) {
      throw new TypeError(
        `sources for signal ${source.signalId} must share inclusion and anonymous device key`,
      );
    }
    signalContracts.set(source.signalId, {
      included: source.included,
      deviceKey: source.deviceKey,
    });
    if (
      source.analysisKind === 'parameter-event-start' ||
      source.analysisKind === 'parameter-event-end'
    ) {
      assertNonEmptyString(source.channelKey, `sources[${index}].channelKey`);
    }
    if (source.analysisKind === 'persistent-property' && source.preloadNodeId !== undefined) {
      assertNonEmptyString(source.preloadNodeId, `sources[${index}].preloadNodeId`);
      if (preloadNodeIds.has(source.preloadNodeId)) {
        throw new TypeError(`duplicate preload node mapping: ${source.preloadNodeId}`);
      }
      preloadNodeIds.add(source.preloadNodeId);
    }
    return { ...source };
  });
  const pairingContracts = new Map<string, Set<'start' | 'end'>>();
  for (const source of sources) {
    if (
      !source.included ||
      (source.analysisKind !== 'parameter-event-start' &&
        source.analysisKind !== 'parameter-event-end')
    ) {
      continue;
    }
    const key = JSON.stringify([source.deviceKey, source.channelKey]);
    const phases = pairingContracts.get(key) ?? new Set<'start' | 'end'>();
    phases.add(source.analysisKind === 'parameter-event-start' ? 'start' : 'end');
    pairingContracts.set(key, phases);
  }
  for (const [key, phases] of pairingContracts) {
    if (!phases.has('start') || !phases.has('end')) {
      throw new TypeError(
        `parameter event pairing channel ${key} requires reviewed start and end semantics`,
      );
    }
  }
  return sources;
}

function assertNormalizedObservationProvenance(
  observations: readonly HabitLearningObservation[],
  entries: readonly RuleLogEntry[],
  ruleId: string,
  semantics: ReadonlyMap<string, HabitLearningAnalysisSourceSemantics>,
): void {
  let previousTimestamp = Number.NEGATIVE_INFINITY;
  let previousEntryIndex = -1;
  for (const [index, observation] of observations.entries()) {
    const source = semantics.get(observation.sourceId);
    if (source === undefined) {
      throw new TypeError(`missing analysis semantics for source ${observation.sourceId}`);
    }
    if (
      (source.analysisKind === 'persistent-property' && observation.kind !== 'property') ||
      ((source.analysisKind === 'parameter-event-start' ||
        source.analysisKind === 'parameter-event-end') &&
        observation.kind !== 'parameter-event') ||
      (source.analysisKind === 'point-event' && observation.kind === 'property')
    ) {
      throw new TypeError(
        `observations[${index}] kind ${observation.kind} is incompatible with ${source.analysisKind}`,
      );
    }
    assertNonNegativeSafeInteger(observation.entryIndex, `observations[${index}].entryIndex`);
    const entry = entries[observation.entryIndex];
    if (entry === undefined) {
      throw new RangeError(`observations[${index}].entryIndex is outside entries`);
    }
    if (entry.graphId !== ruleId) {
      throw new TypeError(`observations[${index}] does not belong to baseline.ruleId`);
    }
    if (
      entry.timestamp !== observation.timestamp ||
      observation.timestamp !== observation.observedAt
    ) {
      throw new TypeError(`observations[${index}] timestamp/provenance mismatch`);
    }
    if (
      observation.observedAt < previousTimestamp ||
      (observation.observedAt === previousTimestamp && observation.entryIndex < previousEntryIndex)
    ) {
      throw new RangeError('observations must preserve normalized gateway order');
    }
    previousTimestamp = observation.observedAt;
    previousEntryIndex = observation.entryIndex;
  }
}

function requirePersistentStateValue(
  value: HabitLearningObservationValue,
  path: string,
): HabitLearningPersistentStateValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  throw new TypeError(`${path} must contain one scalar persistent-state value`);
}

function requireParameterValue(
  value: HabitLearningObservationValue,
  path: string,
): HabitLearningParameterValue {
  if (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  throw new TypeError(`${path} must contain one scalar parameter value`);
}

function validateGaps(
  input: readonly HabitLearningAnalysisGap[],
  range: HabitLearningAnalysisRange,
): HabitLearningAnalysisGap[] {
  const ids = new Set<string>();
  const gaps = input.map((gap, index) => {
    assertNonEmptyString(gap.gapId, `gaps[${index}].gapId`);
    if (ids.has(gap.gapId)) throw new TypeError(`duplicate gapId: ${gap.gapId}`);
    ids.add(gap.gapId);
    assertNonNegativeSafeInteger(gap.start, `gaps[${index}].start`);
    assertNonNegativeSafeInteger(gap.end, `gaps[${index}].end`);
    if (gap.end <= gap.start) {
      throw new RangeError(`gaps[${index}].end must be greater than start`);
    }
    if (gap.start < range.start || gap.end > range.end) {
      throw new RangeError(`gaps[${index}] must be contained by range`);
    }
    return { ...gap };
  });
  gaps.sort(
    (left, right) =>
      left.start - right.start || left.end - right.end || compareStrings(left.gapId, right.gapId),
  );
  for (let index = 1; index < gaps.length; index += 1) {
    const previous = gaps[index - 1];
    const current = gaps[index];
    if (previous !== undefined && current !== undefined && current.start < previous.end) {
      throw new RangeError(`gaps overlap: ${previous.gapId} and ${current.gapId}`);
    }
  }
  return gaps;
}

function assertRange(range: HabitLearningAnalysisRange): void {
  assertNonNegativeSafeInteger(range.start, 'range.start');
  assertNonNegativeSafeInteger(range.end, 'range.end');
  if (range.end <= range.start) {
    throw new RangeError('range.end must be greater than range.start');
  }
}

function observationTransportKey(sourceId: string, entryIndex: number): string {
  return JSON.stringify([sourceId, entryIndex]);
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

function sortedIntersection(values: ReadonlySet<string>, allowed: ReadonlySet<string>): string[] {
  return [...values].filter((value) => allowed.has(value)).sort(compareStrings);
}

function uniqueSortedStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertNonEmptyString(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${path} must be a non-empty string`);
  }
}

function assertNonNegativeSafeInteger(value: unknown, path: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${path} must be a non-negative safe integer`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
