import type { RuleLogEntry } from './rule-logs.js';

export type HabitLearningBaselineStatus = 'seen' | 'missing' | 'ambiguous';

export type HabitLearningBaselineProvenance =
  | 'single-info-within-window'
  | 'multiple-info-within-window'
  | 'first-info-after-window'
  | 'not-observed'
  | 'enable-boundary-missing';

export interface HabitLearningPreloadBaselineSource {
  sourceId: string;
  status: HabitLearningBaselineStatus;
  provenance: HabitLearningBaselineProvenance;
  /** Entry indexes are positions in the caller's ordered `entries` array. */
  entryIndexes: number[];
  /** Matching source rows after the baseline window are not baseline candidates. */
  laterEntryIndexes: number[];
}

export type HabitLearningEnableBoundary =
  | {
      status: 'found';
      entryIndex: number;
      timestamp: number;
      /** Older enable boundaries were superseded by the selected latest one. */
      supersededCount: number;
    }
  | {
      status: 'missing';
    };

export interface HabitLearningBaselineWindow {
  /** Timestamp of the selected enable record. */
  start: number;
  /** Inclusive upper bound used for baseline candidates. */
  end: number;
  closedBy: 'all-expected-seen' | 'quiet-period' | 'hard-cap';
}

export interface ClassifyHabitLearningPreloadBaselinesInput {
  /** Parsed rule logs in gateway order, oldest first. */
  entries: readonly RuleLogEntry[];
  ruleId: string;
  /** Node IDs expected to emit one preload info row when the rule is enabled. */
  expectedSourceIds: readonly string[];
  /**
   * A candidate extends the baseline window by this many milliseconds.
   * Required explicitly because gateway/device preload timing is runtime evidence.
   */
  quietPeriodMs: number;
  /** Absolute bound measured from the enable boundary. */
  hardCapMs: number;
}

export interface HabitLearningPreloadBaselineResult {
  boundary: HabitLearningEnableBoundary;
  window?: HabitLearningBaselineWindow;
  sources: HabitLearningPreloadBaselineSource[];
  seenSourceIds: string[];
  missingSourceIds: string[];
  ambiguousSourceIds: string[];
}

/**
 * Classify expected preload rows without treating an arbitrary fixed delay as
 * a gateway contract.
 *
 * The latest enable record starts the current observation epoch. A source info
 * row arriving inside the rolling quiet-period window is a baseline candidate.
 * The window closes when every expected source has appeared, when the stream
 * stays quiet, or at the hard cap. Rows sharing the exact completion timestamp
 * are still inspected so duplicate preload candidates remain visible. One
 * candidate is seen, multiple candidates are ambiguous, and a source first
 * observed only after the window is also ambiguous. With no enable boundary,
 * no row can be safely attributed to preload.
 */
export function classifyHabitLearningPreloadBaselines(
  input: ClassifyHabitLearningPreloadBaselinesInput,
): HabitLearningPreloadBaselineResult {
  assertNonEmptyString(input.ruleId, 'ruleId');
  assertOrderedRuleLogEntries(input.entries);
  assertPositiveSafeInteger(input.quietPeriodMs, 'quietPeriodMs');
  assertPositiveSafeInteger(input.hardCapMs, 'hardCapMs');
  if (input.hardCapMs < input.quietPeriodMs) {
    throw new RangeError('hardCapMs must be greater than or equal to quietPeriodMs');
  }

  const expectedSourceIds = uniqueStrings(input.expectedSourceIds, 'expectedSourceIds');
  const enableIndexes: number[] = [];
  input.entries.forEach((entry, index) => {
    if (
      entry.graphId === input.ruleId &&
      entry.rawType === 'r' &&
      isEnabledRuleConfig(entry.ruleConfig)
    ) {
      enableIndexes.push(index);
    }
  });

  const boundaryIndex = enableIndexes.at(-1);
  if (boundaryIndex === undefined) {
    const sources = expectedSourceIds.map((sourceId) => ({
      sourceId,
      status: 'ambiguous' as const,
      provenance: 'enable-boundary-missing' as const,
      entryIndexes: [],
      laterEntryIndexes: matchingInfoIndexes(input.entries, input.ruleId, sourceId, 0),
    }));
    return summarizeBaselineResult({ status: 'missing' }, undefined, sources);
  }

  const boundaryEntry = input.entries[boundaryIndex];
  if (boundaryEntry === undefined) {
    throw new Error('internal error: selected enable boundary is unavailable');
  }
  const hardEnd = safeTimestampAdd(boundaryEntry.timestamp, input.hardCapMs, 'hardCapMs');
  let quietEnd = safeTimestampAdd(boundaryEntry.timestamp, input.quietPeriodMs, 'quietPeriodMs');
  const expectedSet = new Set(expectedSourceIds);
  const candidateIndexes = new Map<string, number[]>(
    expectedSourceIds.map((sourceId) => [sourceId, []]),
  );
  let allExpectedSeenAt = expectedSourceIds.length === 0 ? boundaryEntry.timestamp : undefined;

  for (let index = boundaryIndex + 1; index < input.entries.length; index += 1) {
    const entry = input.entries[index];
    if (entry === undefined) continue;
    if (allExpectedSeenAt !== undefined && entry.timestamp > allExpectedSeenAt) break;
    const currentEnd = Math.min(quietEnd, hardEnd);
    if (entry.timestamp > currentEnd) break;
    if (
      entry.graphId !== input.ruleId ||
      entry.rawType !== 'i' ||
      entry.nodeId === undefined ||
      !expectedSet.has(entry.nodeId)
    ) {
      continue;
    }
    candidateIndexes.get(entry.nodeId)?.push(index);
    quietEnd = Math.min(
      hardEnd,
      safeTimestampAdd(entry.timestamp, input.quietPeriodMs, 'quietPeriodMs'),
    );
    if (
      allExpectedSeenAt === undefined &&
      expectedSourceIds.every((sourceId) => (candidateIndexes.get(sourceId)?.length ?? 0) > 0)
    ) {
      allExpectedSeenAt = entry.timestamp;
    }
  }

  const windowEnd = allExpectedSeenAt ?? Math.min(quietEnd, hardEnd);
  const window: HabitLearningBaselineWindow = {
    start: boundaryEntry.timestamp,
    end: windowEnd,
    closedBy:
      windowEnd === hardEnd
        ? 'hard-cap'
        : allExpectedSeenAt !== undefined
          ? 'all-expected-seen'
          : 'quiet-period',
  };
  const sources = expectedSourceIds.map((sourceId) => {
    const entryIndexes = candidateIndexes.get(sourceId) ?? [];
    const laterEntryIndexes = matchingInfoIndexes(
      input.entries,
      input.ruleId,
      sourceId,
      boundaryIndex + 1,
    ).filter((index) => (input.entries[index]?.timestamp ?? Number.NEGATIVE_INFINITY) > windowEnd);

    if (entryIndexes.length === 1) {
      return {
        sourceId,
        status: 'seen' as const,
        provenance: 'single-info-within-window' as const,
        entryIndexes,
        laterEntryIndexes,
      };
    }
    if (entryIndexes.length > 1) {
      return {
        sourceId,
        status: 'ambiguous' as const,
        provenance: 'multiple-info-within-window' as const,
        entryIndexes,
        laterEntryIndexes,
      };
    }
    if (laterEntryIndexes.length > 0) {
      return {
        sourceId,
        status: 'ambiguous' as const,
        provenance: 'first-info-after-window' as const,
        entryIndexes,
        laterEntryIndexes,
      };
    }
    return {
      sourceId,
      status: 'missing' as const,
      provenance: 'not-observed' as const,
      entryIndexes,
      laterEntryIndexes,
    };
  });

  return summarizeBaselineResult(
    {
      status: 'found',
      entryIndex: boundaryIndex,
      timestamp: boundaryEntry.timestamp,
      supersededCount: enableIndexes.length - 1,
    },
    window,
    sources,
  );
}

export type HabitLearningInfoSourceKind = 'property' | 'parameter-event';

export interface HabitLearningInfoSourceDefinition {
  sourceId: string;
  kind: HabitLearningInfoSourceKind;
  nodeId: string;
  /**
   * Select one item from a JSON-array info payload. When omitted, a one-item
   * array is unwrapped and every other valid JSON value is preserved.
   */
  valueIndex?: number;
}

export interface HabitLearningZeroArgumentEventSourceDefinition {
  sourceId: string;
  kind: 'zero-argument-event';
  /** The one canonical first-hop edge selected when the graph was frozen. */
  firstHop: {
    src: string;
    dst: string;
  };
}

export type HabitLearningObservationSourceDefinition =
  | HabitLearningInfoSourceDefinition
  | HabitLearningZeroArgumentEventSourceDefinition;

export interface HabitLearningSourceMap {
  ruleId: string;
  sources: readonly HabitLearningObservationSourceDefinition[];
}

export type HabitLearningObservationValue = string | number | boolean | null | unknown[];

export interface HabitLearningObservation {
  sourceId: string;
  kind: HabitLearningObservationSourceDefinition['kind'];
  timestamp: number;
  observedAt: number;
  value: HabitLearningObservationValue;
  evidence: 'node-info' | 'first-hop-link';
  /** Position in the caller's ordered RuleLogEntry array. */
  entryIndex: number;
}

/**
 * Copy, validate, and deeply freeze a source map. The canonical link for a
 * zero-argument event is part of the snapshot, so later fan-out rows cannot be
 * mistaken for additional physical occurrences.
 */
export function freezeHabitLearningSourceMap(
  input: HabitLearningSourceMap,
): HabitLearningSourceMap {
  assertNonEmptyString(input.ruleId, 'sourceMap.ruleId');
  if (!Array.isArray(input.sources)) {
    throw new TypeError('sourceMap.sources must be an array');
  }

  const sourceIds = new Set<string>();
  const transportKeys = new Set<string>();
  const sources = input.sources.map((source, index): HabitLearningObservationSourceDefinition => {
    const path = `sourceMap.sources[${index}]`;
    assertNonEmptyString(source.sourceId, `${path}.sourceId`);
    if (sourceIds.has(source.sourceId)) {
      throw new TypeError(`duplicate habit-learning sourceId: ${source.sourceId}`);
    }
    sourceIds.add(source.sourceId);

    if (source.kind === 'zero-argument-event') {
      assertNonEmptyString(source.firstHop.src, `${path}.firstHop.src`);
      assertNonEmptyString(source.firstHop.dst, `${path}.firstHop.dst`);
      assertEndpoint(source.firstHop.src, `${path}.firstHop.src`);
      assertEndpoint(source.firstHop.dst, `${path}.firstHop.dst`);
      const transportKey = `link\0${source.firstHop.src}\0${source.firstHop.dst}`;
      if (transportKeys.has(transportKey)) {
        throw new TypeError(
          `duplicate habit-learning primary transport: ${source.firstHop.src} -> ${source.firstHop.dst}`,
        );
      }
      transportKeys.add(transportKey);
      return Object.freeze({
        sourceId: source.sourceId,
        kind: source.kind,
        firstHop: Object.freeze({
          src: source.firstHop.src,
          dst: source.firstHop.dst,
        }),
      });
    }

    if (source.kind !== 'property' && source.kind !== 'parameter-event') {
      throw new TypeError(`${path}.kind is not a supported habit-learning source kind`);
    }
    assertNonEmptyString(source.nodeId, `${path}.nodeId`);
    if (source.valueIndex !== undefined) {
      assertNonNegativeSafeInteger(source.valueIndex, `${path}.valueIndex`);
    }
    const transportKey = `info\0${source.nodeId}\0${source.valueIndex ?? '*'}`;
    if (transportKeys.has(transportKey)) {
      throw new TypeError(
        `duplicate habit-learning primary transport: info node ${source.nodeId} value index ${source.valueIndex ?? '*'}`,
      );
    }
    transportKeys.add(transportKey);
    return Object.freeze({
      sourceId: source.sourceId,
      kind: source.kind,
      nodeId: source.nodeId,
      ...(source.valueIndex !== undefined && { valueIndex: source.valueIndex }),
    });
  });

  return Object.freeze({
    ruleId: input.ruleId,
    sources: Object.freeze(sources),
  });
}

/**
 * Reduce verbose graph logs to physical/source observations.
 *
 * Property and parameter-event sources use their own info rows. Zero-argument
 * events use exactly one frozen first-hop link. No timestamp/value de-duplication
 * is performed: repeated identical physical events and distinct same-ms sources
 * remain separate observations.
 */
export function normalizeHabitLearningObservations(
  entries: readonly RuleLogEntry[],
  sourceMap: HabitLearningSourceMap,
): HabitLearningObservation[] {
  assertOrderedRuleLogEntries(entries);
  assertFrozenSourceMap(sourceMap);

  const infoSources = new Map<string, HabitLearningInfoSourceDefinition[]>();
  const linkSources = new Map<string, HabitLearningZeroArgumentEventSourceDefinition>();
  for (const source of sourceMap.sources) {
    if (source.kind === 'zero-argument-event') {
      linkSources.set(linkTransportKey(source.firstHop.src, source.firstHop.dst), source);
    } else {
      const definitions = infoSources.get(source.nodeId) ?? [];
      definitions.push(source);
      infoSources.set(source.nodeId, definitions);
    }
  }

  const observations: HabitLearningObservation[] = [];
  entries.forEach((entry, entryIndex) => {
    if (entry.graphId !== sourceMap.ruleId) return;
    if (entry.rawType === 'i' && entry.nodeId !== undefined) {
      const definitions = infoSources.get(entry.nodeId);
      if (definitions === undefined) return;
      if (entry.info === undefined) {
        throw new TypeError(`matching info entry ${entryIndex} is missing its info payload`);
      }
      const parsed = parseInfoPayload(entry.info);
      for (const definition of definitions) {
        observations.push({
          sourceId: definition.sourceId,
          kind: definition.kind,
          timestamp: entry.timestamp,
          observedAt: entry.timestamp,
          value: selectInfoValue(parsed, definition.valueIndex, definition.sourceId),
          evidence: 'node-info',
          entryIndex,
        });
      }
      return;
    }

    if (entry.rawType === 'l' && entry.src !== undefined && entry.dst !== undefined) {
      const definition = linkSources.get(linkTransportKey(entry.src, entry.dst));
      if (definition === undefined) return;
      observations.push({
        sourceId: definition.sourceId,
        kind: definition.kind,
        timestamp: entry.timestamp,
        observedAt: entry.timestamp,
        value: null,
        evidence: 'first-hop-link',
        entryIndex,
      });
    }
  });
  return observations;
}

export type HabitLearningPersistentStateValue = string | number | boolean | null;

export type HabitLearningPersistentStateEvidence = 'preload-snapshot' | 'change';

export interface HabitLearningPersistentStateObservation<
  Value extends HabitLearningPersistentStateValue = HabitLearningPersistentStateValue,
> {
  sourceId: string;
  observedAt: number;
  value: Value;
  evidence: HabitLearningPersistentStateEvidence;
}

export interface HabitLearningObservationGap {
  /** Inclusive lower bound. */
  start: number;
  /** Exclusive upper bound. */
  end: number;
}

export interface HabitLearningPersistentStateRange {
  /** Inclusive lower bound. */
  start: number;
  /** Exclusive upper bound. */
  end: number;
}

export interface IntervalizeHabitLearningPersistentStateInput<
  Value extends HabitLearningPersistentStateValue = HabitLearningPersistentStateValue,
> {
  observations: readonly HabitLearningPersistentStateObservation<Value>[];
  range: HabitLearningPersistentStateRange;
  gaps?: readonly HabitLearningObservationGap[];
}

export interface HabitLearningPersistentStateInterval<
  Value extends HabitLearningPersistentStateValue = HabitLearningPersistentStateValue,
> {
  sourceId: string;
  value: Value;
  /** Half-open interval [start, end). */
  start: number;
  end: number;
  firstObservedAt: number;
  lastObservedAt: number;
  observationCount: number;
  /** The value came from a current-state snapshot, so its true start is unknown. */
  leftCensored: boolean;
  /** The observation window or a declared gap ended before a change was seen. */
  rightCensored: boolean;
  endedBy: 'change' | 'gap' | 'window-end';
}

export interface IntervalizeHabitLearningPersistentStateResult<
  Value extends HabitLearningPersistentStateValue = HabitLearningPersistentStateValue,
> {
  intervals: HabitLearningPersistentStateInterval<Value>[];
  ignoredOutsideRange: number;
  ignoredInsideGaps: number;
}

/**
 * Build persistent-state intervals without carrying a value across a declared
 * observation gap. Identical re-observations extend the evidence for the same
 * interval; a different value closes it at the change timestamp.
 */
export function intervalizeHabitLearningPersistentState<
  Value extends HabitLearningPersistentStateValue,
>(
  input: IntervalizeHabitLearningPersistentStateInput<Value>,
): IntervalizeHabitLearningPersistentStateResult<Value> {
  assertRange(input.range, 'range');
  const gaps = normalizeGaps(input.gaps ?? [], input.range);
  assertOrderedStateObservations(input.observations);

  const observationsBySource = new Map<string, HabitLearningPersistentStateObservation<Value>[]>();
  let ignoredOutsideRange = 0;
  let ignoredInsideGaps = 0;
  for (const observation of input.observations) {
    validateStateObservation(observation);
    if (observation.observedAt < input.range.start || observation.observedAt >= input.range.end) {
      ignoredOutsideRange += 1;
      continue;
    }
    if (gapContaining(gaps, observation.observedAt) !== undefined) {
      ignoredInsideGaps += 1;
      continue;
    }
    const existing = observationsBySource.get(observation.sourceId) ?? [];
    existing.push(observation);
    observationsBySource.set(observation.sourceId, existing);
  }

  const segments = coverageSegments(input.range, gaps);
  const intervals: HabitLearningPersistentStateInterval<Value>[] = [];
  for (const [sourceId, observations] of observationsBySource) {
    for (const segment of segments) {
      const segmentObservations = observations.filter(
        (observation) =>
          observation.observedAt >= segment.start && observation.observedAt < segment.end,
      );
      if (segmentObservations.length === 0) continue;
      appendSegmentIntervals(intervals, sourceId, segmentObservations, segment);
    }
  }

  intervals.sort(
    (left, right) =>
      left.start - right.start ||
      compareStrings(left.sourceId, right.sourceId) ||
      left.end - right.end,
  );
  return { intervals, ignoredOutsideRange, ignoredInsideGaps };
}

export interface ProjectHabitLearningStateAsOfInput<
  Value extends HabitLearningPersistentStateValue = HabitLearningPersistentStateValue,
> {
  observations: readonly HabitLearningPersistentStateObservation<Value>[];
  sourceId: string;
  timestamp: number;
  gaps?: readonly HabitLearningObservationGap[];
}

export interface HabitLearningStateAsOf<
  Value extends HabitLearningPersistentStateValue = HabitLearningPersistentStateValue,
> {
  value: Value;
  observedAt: number;
  /** Milliseconds since the most recent supporting observation. */
  staleness: number;
}

/**
 * Project the most recently observed state at one timestamp. A gap containing
 * the query, or any completed gap between the candidate and query, invalidates
 * carry-forward until the source is observed again.
 */
export function projectHabitLearningStateAsOf<Value extends HabitLearningPersistentStateValue>(
  input: ProjectHabitLearningStateAsOfInput<Value>,
): HabitLearningStateAsOf<Value> | undefined {
  assertNonEmptyString(input.sourceId, 'sourceId');
  assertFiniteTimestamp(input.timestamp, 'timestamp');
  assertOrderedStateObservations(input.observations);
  for (const observation of input.observations) {
    validateStateObservation(observation);
  }
  const gaps = normalizeUnboundedGaps(input.gaps ?? []);
  if (gapContaining(gaps, input.timestamp) !== undefined) return undefined;

  let barrier = Number.NEGATIVE_INFINITY;
  for (const gap of gaps) {
    if (gap.end <= input.timestamp) barrier = Math.max(barrier, gap.end);
  }

  let candidate: HabitLearningPersistentStateObservation<Value> | undefined;
  for (const observation of input.observations) {
    if (observation.observedAt > input.timestamp) break;
    if (
      observation.sourceId === input.sourceId &&
      observation.observedAt >= barrier &&
      gapContaining(gaps, observation.observedAt) === undefined
    ) {
      candidate = observation;
    }
  }
  if (candidate === undefined) return undefined;
  return {
    value: candidate.value,
    observedAt: candidate.observedAt,
    staleness: input.timestamp - candidate.observedAt,
  };
}

function summarizeBaselineResult(
  boundary: HabitLearningEnableBoundary,
  window: HabitLearningBaselineWindow | undefined,
  sources: HabitLearningPreloadBaselineSource[],
): HabitLearningPreloadBaselineResult {
  return {
    boundary,
    ...(window !== undefined && { window }),
    sources,
    seenSourceIds: sources
      .filter((source) => source.status === 'seen')
      .map((source) => source.sourceId),
    missingSourceIds: sources
      .filter((source) => source.status === 'missing')
      .map((source) => source.sourceId),
    ambiguousSourceIds: sources
      .filter((source) => source.status === 'ambiguous')
      .map((source) => source.sourceId),
  };
}

function matchingInfoIndexes(
  entries: readonly RuleLogEntry[],
  ruleId: string,
  sourceId: string,
  fromIndex: number,
): number[] {
  const indexes: number[] = [];
  for (let index = fromIndex; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry?.graphId === ruleId && entry.rawType === 'i' && entry.nodeId === sourceId) {
      indexes.push(index);
    }
  }
  return indexes;
}

function isEnabledRuleConfig(value: unknown): boolean {
  return isRecord(value) && value.enable === true;
}

function parseInfoPayload(info: string): HabitLearningObservationValue {
  try {
    const value: unknown = JSON.parse(info);
    return normalizeObservationValue(value);
  } catch {
    return info;
  }
}

function normalizeObservationValue(value: unknown): HabitLearningObservationValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (Array.isArray(value)) return value;
  throw new TypeError('habit-learning info payload must be a scalar or JSON array');
}

function selectInfoValue(
  parsed: HabitLearningObservationValue,
  valueIndex: number | undefined,
  sourceId: string,
): HabitLearningObservationValue {
  if (valueIndex !== undefined) {
    if (!Array.isArray(parsed) || valueIndex >= parsed.length) {
      throw new TypeError(
        `habit-learning source ${sourceId} expected JSON-array info value at index ${valueIndex}`,
      );
    }
    return normalizeObservationValue(parsed[valueIndex]);
  }
  if (Array.isArray(parsed) && parsed.length === 1) {
    return normalizeObservationValue(parsed[0]);
  }
  return parsed;
}

function appendSegmentIntervals<Value extends HabitLearningPersistentStateValue>(
  output: HabitLearningPersistentStateInterval<Value>[],
  sourceId: string,
  observations: readonly HabitLearningPersistentStateObservation<Value>[],
  segment: CoverageSegment,
): void {
  const first = observations[0];
  if (first === undefined) return;
  let current = {
    value: first.value,
    start: first.observedAt,
    firstObservedAt: first.observedAt,
    lastObservedAt: first.observedAt,
    observationCount: 1,
    leftCensored: first.evidence === 'preload-snapshot',
  };

  for (let index = 1; index < observations.length; index += 1) {
    const observation = observations[index];
    if (observation === undefined) continue;
    if (Object.is(observation.value, current.value)) {
      current.lastObservedAt = observation.observedAt;
      current.observationCount += 1;
      continue;
    }
    output.push({
      sourceId,
      value: current.value,
      start: current.start,
      end: observation.observedAt,
      firstObservedAt: current.firstObservedAt,
      lastObservedAt: current.lastObservedAt,
      observationCount: current.observationCount,
      leftCensored: current.leftCensored,
      rightCensored: false,
      endedBy: 'change',
    });
    current = {
      value: observation.value,
      start: observation.observedAt,
      firstObservedAt: observation.observedAt,
      lastObservedAt: observation.observedAt,
      observationCount: 1,
      leftCensored: observation.evidence === 'preload-snapshot',
    };
  }

  output.push({
    sourceId,
    value: current.value,
    start: current.start,
    end: segment.end,
    firstObservedAt: current.firstObservedAt,
    lastObservedAt: current.lastObservedAt,
    observationCount: current.observationCount,
    leftCensored: current.leftCensored,
    rightCensored: true,
    endedBy: segment.endedBy,
  });
}

interface CoverageSegment {
  start: number;
  end: number;
  endedBy: 'gap' | 'window-end';
}

function coverageSegments(
  range: HabitLearningPersistentStateRange,
  gaps: readonly HabitLearningObservationGap[],
): CoverageSegment[] {
  const segments: CoverageSegment[] = [];
  let cursor = range.start;
  for (const gap of gaps) {
    if (cursor < gap.start) {
      segments.push({ start: cursor, end: gap.start, endedBy: 'gap' });
    }
    cursor = gap.end;
  }
  if (cursor < range.end) {
    segments.push({ start: cursor, end: range.end, endedBy: 'window-end' });
  }
  return segments;
}

function normalizeGaps(
  gaps: readonly HabitLearningObservationGap[],
  range: HabitLearningPersistentStateRange,
): HabitLearningObservationGap[] {
  const normalized = normalizeUnboundedGaps(gaps);
  for (const [index, gap] of normalized.entries()) {
    if (gap.start < range.start || gap.end > range.end) {
      throw new RangeError(`gaps[${index}] must be contained by range`);
    }
  }
  return normalized;
}

function normalizeUnboundedGaps(
  gaps: readonly HabitLearningObservationGap[],
): HabitLearningObservationGap[] {
  const normalized = gaps.map((gap, index) => {
    assertRange(gap, `gaps[${index}]`);
    return { start: gap.start, end: gap.end };
  });
  normalized.sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 1; index < normalized.length; index += 1) {
    const previous = normalized[index - 1];
    const current = normalized[index];
    if (previous !== undefined && current !== undefined && current.start < previous.end) {
      throw new RangeError('declared habit-learning gaps must not overlap');
    }
  }
  return normalized;
}

function gapContaining(
  gaps: readonly HabitLearningObservationGap[],
  timestamp: number,
): HabitLearningObservationGap | undefined {
  return gaps.find((gap) => timestamp >= gap.start && timestamp < gap.end);
}

function validateStateObservation<Value extends HabitLearningPersistentStateValue>(
  observation: HabitLearningPersistentStateObservation<Value>,
): void {
  assertNonEmptyString(observation.sourceId, 'observation.sourceId');
  assertFiniteTimestamp(observation.observedAt, 'observation.observedAt');
  if (observation.evidence !== 'preload-snapshot' && observation.evidence !== 'change') {
    throw new TypeError('observation.evidence must be preload-snapshot or change');
  }
  if (
    observation.value !== null &&
    typeof observation.value !== 'string' &&
    typeof observation.value !== 'number' &&
    typeof observation.value !== 'boolean'
  ) {
    throw new TypeError('persistent-state observation value must be a scalar');
  }
  if (typeof observation.value === 'number' && !Number.isFinite(observation.value)) {
    throw new TypeError('persistent-state observation number must be finite');
  }
}

function assertOrderedRuleLogEntries(entries: readonly RuleLogEntry[]): void {
  let previous = Number.NEGATIVE_INFINITY;
  entries.forEach((entry, index) => {
    assertFiniteTimestamp(entry.timestamp, `entries[${index}].timestamp`);
    if (entry.timestamp < previous) {
      throw new RangeError('RuleLogEntry records must be ordered oldest first');
    }
    previous = entry.timestamp;
  });
}

function assertOrderedStateObservations(
  observations: readonly HabitLearningPersistentStateObservation[],
): void {
  let previous = Number.NEGATIVE_INFINITY;
  observations.forEach((observation, index) => {
    assertFiniteTimestamp(observation.observedAt, `observations[${index}].observedAt`);
    if (observation.observedAt < previous) {
      throw new RangeError('persistent-state observations must be ordered oldest first');
    }
    previous = observation.observedAt;
  });
}

function assertFrozenSourceMap(sourceMap: HabitLearningSourceMap): void {
  if (!Object.isFrozen(sourceMap) || !Object.isFrozen(sourceMap.sources)) {
    throw new TypeError(
      'habit-learning source map must be created by freezeHabitLearningSourceMap',
    );
  }
  for (const source of sourceMap.sources) {
    if (!Object.isFrozen(source)) {
      throw new TypeError(
        'habit-learning source map must be created by freezeHabitLearningSourceMap',
      );
    }
    if (source.kind === 'zero-argument-event' && !Object.isFrozen(source.firstHop)) {
      throw new TypeError(
        'habit-learning source map must be created by freezeHabitLearningSourceMap',
      );
    }
  }
}

function uniqueStrings(values: readonly string[], name: string): string[] {
  const unique = new Set<string>();
  values.forEach((value, index) => {
    assertNonEmptyString(value, `${name}[${index}]`);
    if (unique.has(value)) {
      throw new TypeError(`${name} must not contain duplicate value ${value}`);
    }
    unique.add(value);
  });
  return [...unique];
}

function assertRange(range: { start: number; end: number }, name: string): void {
  assertFiniteTimestamp(range.start, `${name}.start`);
  assertFiniteTimestamp(range.end, `${name}.end`);
  if (range.end <= range.start) {
    throw new RangeError(`${name}.end must be greater than ${name}.start`);
  }
}

function assertEndpoint(value: string, name: string): void {
  const separator = value.lastIndexOf('.');
  if (separator <= 0 || separator === value.length - 1) {
    throw new TypeError(`${name} must be a node.pin endpoint`);
  }
}

function assertFiniteTimestamp(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite timestamp`);
  }
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

function assertNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
}

function assertNonEmptyString(value: string, name: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function safeTimestampAdd(timestamp: number, duration: number, name: string): number {
  const result = timestamp + duration;
  if (!Number.isSafeInteger(result)) {
    throw new RangeError(`timestamp + ${name} must be a safe integer`);
  }
  return result;
}

function linkTransportKey(src: string, dst: string): string {
  return `${src}\0${dst}`;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
