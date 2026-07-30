import { createHash } from 'node:crypto';
import {
  type HabitLearningAnonymousDeviceKey,
  HabitLearningAnonymousDeviceKeySchema,
} from '../schemas/habit-learning-profile.js';

export type HabitLearningParameterEventPhase = 'start' | 'end';
export type HabitLearningParameterValue = string | number | boolean;

export interface HabitLearningParameterEvent {
  eventId: string;
  sourceId: string;
  deviceKey: HabitLearningAnonymousDeviceKey;
  channelKey: string;
  parameterValue: HabitLearningParameterValue;
  phase: HabitLearningParameterEventPhase;
  observedAt: number;
  rawRefs: readonly string[];
}

export interface HabitLearningAnalysisRange {
  /** Inclusive lower bound. */
  start: number;
  /** Exclusive upper bound. */
  end: number;
}

export interface HabitLearningAnalysisGap {
  gapId: string;
  /** Inclusive lower bound. */
  start: number;
  /** Exclusive upper bound. */
  end: number;
}

export interface PairHabitLearningParameterEventsInput {
  events: readonly HabitLearningParameterEvent[];
  range: HabitLearningAnalysisRange;
  gaps?: readonly HabitLearningAnalysisGap[];
}

export interface HabitLearningRawParameterInterval {
  intervalId: string;
  deviceKey: HabitLearningAnonymousDeviceKey;
  channelKey: string;
  parameterValue: HabitLearningParameterValue;
  /** Half-open interval [start, end). */
  start: number;
  end: number;
  startEventIds: string[];
  endEventId?: string;
  eventIds: string[];
  rawRefs: string[];
  leftCensored: boolean;
  rightCensored: boolean;
  ambiguous: boolean;
  ambiguityReasons: Array<'duplicate-start' | 'missing-start'>;
  endedBy: 'end-event' | 'gap' | 'window-end';
}

export interface HabitLearningUnpairedParameterEvent {
  eventId: string;
  reason: 'outside-range' | 'inside-gap' | 'duplicate-end';
  gapId?: string;
}

export interface PairHabitLearningParameterEventsResult {
  intervals: HabitLearningRawParameterInterval[];
  unpairedEvents: HabitLearningUnpairedParameterEvent[];
}

/**
 * Pair generic start/end events by anonymous device, channel, and parameter.
 *
 * Pairing never crosses a declared gap. An end event at the beginning of a
 * continuous segment creates a left-censored interval; an open start at the
 * segment boundary creates a right-censored interval. Duplicate starts remain
 * visible as ambiguity instead of being silently de-duplicated, while a second
 * end after an already closed interval is reported as unpaired.
 */
export function pairHabitLearningParameterEvents(
  input: PairHabitLearningParameterEventsInput,
): PairHabitLearningParameterEventsResult {
  assertRange(input.range);
  const gaps = normalizeGaps(input.gaps ?? [], input.range);
  assertOrderedEvents(input.events);

  const eventIds = new Set<string>();
  const eligible: HabitLearningParameterEvent[] = [];
  const unpairedEvents: HabitLearningUnpairedParameterEvent[] = [];
  for (const event of input.events) {
    validateParameterEvent(event);
    if (eventIds.has(event.eventId)) {
      throw new TypeError(`duplicate parameter eventId: ${event.eventId}`);
    }
    eventIds.add(event.eventId);

    if (event.observedAt < input.range.start || event.observedAt >= input.range.end) {
      unpairedEvents.push({ eventId: event.eventId, reason: 'outside-range' });
      continue;
    }
    const gap = gapContaining(gaps, event.observedAt);
    if (gap !== undefined) {
      unpairedEvents.push({
        eventId: event.eventId,
        reason: 'inside-gap',
        gapId: gap.gapId,
      });
      continue;
    }
    eligible.push(event);
  }

  const intervals: HabitLearningRawParameterInterval[] = [];
  for (const segment of coverageSegments(input.range, gaps)) {
    const segmentEvents = eligible.filter(
      (event) => event.observedAt >= segment.start && event.observedAt < segment.end,
    );
    const byPairingKey = new Map<string, HabitLearningParameterEvent[]>();
    for (const event of segmentEvents) {
      const key = parameterPairingKey(event);
      const events = byPairingKey.get(key) ?? [];
      events.push(event);
      byPairingKey.set(key, events);
    }

    for (const events of byPairingKey.values()) {
      let state: 'unknown' | 'active' | 'inactive' = 'unknown';
      let starts: HabitLearningParameterEvent[] = [];

      for (const event of events) {
        if (event.phase === 'start') {
          if (state !== 'active') starts = [];
          starts.push(event);
          state = 'active';
          continue;
        }

        if (state === 'active') {
          intervals.push(
            makeRawInterval({
              starts,
              end: event,
              start: starts[0]?.observedAt ?? segment.start,
              endAt: event.observedAt,
              leftCensored: starts.length === 0,
              rightCensored: false,
              endedBy: 'end-event',
            }),
          );
          starts = [];
          state = 'inactive';
          continue;
        }

        if (state === 'unknown') {
          intervals.push(
            makeRawInterval({
              starts: [],
              end: event,
              start: segment.start,
              endAt: event.observedAt,
              leftCensored: true,
              rightCensored: false,
              endedBy: 'end-event',
            }),
          );
          state = 'inactive';
          continue;
        }

        unpairedEvents.push({ eventId: event.eventId, reason: 'duplicate-end' });
      }

      if (state === 'active') {
        intervals.push(
          makeRawInterval({
            starts,
            start: starts[0]?.observedAt ?? segment.start,
            endAt: segment.end,
            leftCensored: starts.length === 0,
            rightCensored: true,
            endedBy: segment.endedBy,
          }),
        );
      }
    }
  }

  intervals.sort(
    (left, right) =>
      left.start - right.start ||
      compareStrings(left.deviceKey, right.deviceKey) ||
      compareStrings(left.channelKey, right.channelKey) ||
      compareParameterValues(left.parameterValue, right.parameterValue) ||
      left.end - right.end,
  );
  unpairedEvents.sort((left, right) => compareStrings(left.eventId, right.eventId));
  return { intervals, unpairedEvents };
}

export interface ExtractHabitLearningEpisodesInput {
  intervals: readonly HabitLearningRawParameterInterval[];
  debounceMs: number;
  gaps?: readonly HabitLearningAnalysisGap[];
}

export interface HabitLearningDebouncedEpisode {
  episodeId: string;
  deviceKey: HabitLearningAnonymousDeviceKey;
  channelKey: string;
  parameterValue: HabitLearningParameterValue;
  start: number;
  end: number;
  spanMs: number;
  /** Union of raw active intervals; overlapping evidence is counted once. */
  observedActiveMs: number;
  /** Short inactive periods absorbed by the configured debounce. */
  debouncedInactiveMs: number;
  debounceMs: number;
  intervalIds: string[];
  eventIds: string[];
  rawRefs: string[];
  leftCensored: boolean;
  rightCensored: boolean;
  ambiguous: boolean;
}

/**
 * Merge same-parameter raw intervals separated by at most `debounceMs`.
 *
 * A declared evidence gap is an absolute barrier even when it is shorter than
 * the debounce window. The result describes a sensor episode, not a person,
 * household member, or unique physical route.
 */
export function extractHabitLearningDebouncedEpisodes(
  input: ExtractHabitLearningEpisodesInput,
): HabitLearningDebouncedEpisode[] {
  assertNonNegativeSafeInteger(input.debounceMs, 'debounceMs');
  const gaps = normalizeUnboundedGaps(input.gaps ?? []);
  const intervalIds = new Set<string>();
  const grouped = new Map<string, HabitLearningRawParameterInterval[]>();

  for (const interval of input.intervals) {
    validateRawInterval(interval, gaps);
    if (intervalIds.has(interval.intervalId)) {
      throw new TypeError(`duplicate raw intervalId: ${interval.intervalId}`);
    }
    intervalIds.add(interval.intervalId);
    const key = intervalPairingKey(interval);
    const intervals = grouped.get(key) ?? [];
    intervals.push(interval);
    grouped.set(key, intervals);
  }

  const episodes: HabitLearningDebouncedEpisode[] = [];
  for (const intervals of grouped.values()) {
    intervals.sort(
      (left, right) =>
        left.start - right.start ||
        left.end - right.end ||
        compareStrings(left.intervalId, right.intervalId),
    );
    let current: HabitLearningRawParameterInterval[] = [];
    for (const interval of intervals) {
      const previous = current.at(-1);
      if (
        previous === undefined ||
        (interval.start - maxIntervalEnd(current) <= input.debounceMs &&
          !hasGapBetween(gaps, maxIntervalEnd(current), interval.start))
      ) {
        current.push(interval);
        continue;
      }
      episodes.push(makeEpisode(current, input.debounceMs));
      current = [interval];
    }
    if (current.length > 0) episodes.push(makeEpisode(current, input.debounceMs));
  }

  episodes.sort(
    (left, right) =>
      left.start - right.start ||
      compareStrings(left.deviceKey, right.deviceKey) ||
      compareStrings(left.channelKey, right.channelKey) ||
      compareParameterValues(left.parameterValue, right.parameterValue) ||
      left.end - right.end,
  );
  return episodes;
}

interface CoverageSegment {
  start: number;
  end: number;
  endedBy: 'gap' | 'window-end';
}

interface MakeRawIntervalInput {
  starts: readonly HabitLearningParameterEvent[];
  end?: HabitLearningParameterEvent;
  start: number;
  endAt: number;
  leftCensored: boolean;
  rightCensored: boolean;
  endedBy: HabitLearningRawParameterInterval['endedBy'];
}

function makeRawInterval(input: MakeRawIntervalInput): HabitLearningRawParameterInterval {
  const exemplar = input.starts[0] ?? input.end;
  if (exemplar === undefined) throw new Error('raw interval requires at least one event');
  const startEventIds = input.starts.map((event) => event.eventId);
  const eventIds = [...startEventIds, ...(input.end === undefined ? [] : [input.end.eventId])];
  const rawRefs = uniqueSortedStrings([
    ...input.starts.flatMap((event) => event.rawRefs),
    ...(input.end?.rawRefs ?? []),
  ]);
  const ambiguityReasons: HabitLearningRawParameterInterval['ambiguityReasons'] = [];
  if (input.starts.length > 1) ambiguityReasons.push('duplicate-start');
  if (input.leftCensored) ambiguityReasons.push('missing-start');
  const material = {
    deviceKey: exemplar.deviceKey,
    channelKey: exemplar.channelKey,
    parameterValue: exemplar.parameterValue,
    start: input.start,
    end: input.endAt,
    eventIds,
    leftCensored: input.leftCensored,
    rightCensored: input.rightCensored,
    endedBy: input.endedBy,
  };
  return {
    intervalId: digestStable(material),
    deviceKey: exemplar.deviceKey,
    channelKey: exemplar.channelKey,
    parameterValue: exemplar.parameterValue,
    start: input.start,
    end: input.endAt,
    startEventIds,
    ...(input.end !== undefined && { endEventId: input.end.eventId }),
    eventIds,
    rawRefs,
    leftCensored: input.leftCensored,
    rightCensored: input.rightCensored,
    ambiguous: ambiguityReasons.length > 0,
    ambiguityReasons,
    endedBy: input.endedBy,
  };
}

function makeEpisode(
  intervals: readonly HabitLearningRawParameterInterval[],
  debounceMs: number,
): HabitLearningDebouncedEpisode {
  const first = intervals[0];
  const last = intervals.at(-1);
  if (first === undefined || last === undefined) {
    throw new Error('episode requires at least one interval');
  }
  const start = Math.min(...intervals.map((interval) => interval.start));
  const end = Math.max(...intervals.map((interval) => interval.end));
  const observedActiveMs = unionDuration(intervals);
  const intervalIds = intervals.map((interval) => interval.intervalId);
  const eventIds = uniqueSortedStrings(intervals.flatMap((interval) => interval.eventIds));
  const rawRefs = uniqueSortedStrings(intervals.flatMap((interval) => interval.rawRefs));
  const material = {
    deviceKey: first.deviceKey,
    channelKey: first.channelKey,
    parameterValue: first.parameterValue,
    start,
    end,
    intervalIds,
    debounceMs,
  };
  return {
    episodeId: digestStable(material),
    deviceKey: first.deviceKey,
    channelKey: first.channelKey,
    parameterValue: first.parameterValue,
    start,
    end,
    spanMs: end - start,
    observedActiveMs,
    debouncedInactiveMs: Math.max(0, end - start - observedActiveMs),
    debounceMs,
    intervalIds,
    eventIds,
    rawRefs,
    leftCensored: intervals.some((interval) => interval.start === start && interval.leftCensored),
    rightCensored: intervals.some((interval) => interval.end === end && interval.rightCensored),
    ambiguous: intervals.some((interval) => interval.ambiguous),
  };
}

function unionDuration(intervals: readonly HabitLearningRawParameterInterval[]): number {
  const ordered = [...intervals].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  let total = 0;
  let cursorStart: number | undefined;
  let cursorEnd: number | undefined;
  for (const interval of ordered) {
    if (cursorStart === undefined || cursorEnd === undefined) {
      cursorStart = interval.start;
      cursorEnd = interval.end;
      continue;
    }
    if (interval.start <= cursorEnd) {
      cursorEnd = Math.max(cursorEnd, interval.end);
      continue;
    }
    total += cursorEnd - cursorStart;
    cursorStart = interval.start;
    cursorEnd = interval.end;
  }
  if (cursorStart !== undefined && cursorEnd !== undefined) total += cursorEnd - cursorStart;
  return total;
}

function maxIntervalEnd(intervals: readonly HabitLearningRawParameterInterval[]): number {
  return Math.max(...intervals.map((interval) => interval.end));
}

function validateParameterEvent(event: HabitLearningParameterEvent): void {
  assertNonEmptyString(event.eventId, 'event.eventId');
  assertNonEmptyString(event.sourceId, 'event.sourceId');
  HabitLearningAnonymousDeviceKeySchema.parse(event.deviceKey);
  assertNonEmptyString(event.channelKey, 'event.channelKey');
  if (
    typeof event.parameterValue !== 'string' &&
    typeof event.parameterValue !== 'number' &&
    typeof event.parameterValue !== 'boolean'
  ) {
    throw new TypeError('event.parameterValue must be a string, finite number, or boolean');
  }
  if (typeof event.parameterValue === 'number' && !Number.isFinite(event.parameterValue)) {
    throw new TypeError('event.parameterValue must be finite');
  }
  if (event.phase !== 'start' && event.phase !== 'end') {
    throw new TypeError('event.phase must be start or end');
  }
  assertNonNegativeSafeInteger(event.observedAt, 'event.observedAt');
  if (!Array.isArray(event.rawRefs) || event.rawRefs.length === 0) {
    throw new TypeError('event.rawRefs must contain at least one raw evidence reference');
  }
  event.rawRefs.forEach((reference, index) =>
    assertNonEmptyString(reference, `event.rawRefs[${index}]`),
  );
}

function validateRawInterval(
  interval: HabitLearningRawParameterInterval,
  gaps: readonly HabitLearningAnalysisGap[],
): void {
  assertNonEmptyString(interval.intervalId, 'interval.intervalId');
  HabitLearningAnonymousDeviceKeySchema.parse(interval.deviceKey);
  assertNonEmptyString(interval.channelKey, 'interval.channelKey');
  assertNonNegativeSafeInteger(interval.start, 'interval.start');
  assertNonNegativeSafeInteger(interval.end, 'interval.end');
  if (interval.end < interval.start) {
    throw new RangeError('interval.end must be greater than or equal to interval.start');
  }
  for (const gap of gaps) {
    if (gap.start < interval.end && gap.end > interval.start) {
      throw new RangeError(`raw interval ${interval.intervalId} crosses gap ${gap.gapId}`);
    }
  }
}

function assertOrderedEvents(events: readonly HabitLearningParameterEvent[]): void {
  let previous = Number.NEGATIVE_INFINITY;
  for (const [index, event] of events.entries()) {
    if (event.observedAt < previous) {
      throw new RangeError(`events must be ordered oldest first (index ${index})`);
    }
    previous = event.observedAt;
  }
}

function assertRange(range: HabitLearningAnalysisRange): void {
  assertNonNegativeSafeInteger(range.start, 'range.start');
  assertNonNegativeSafeInteger(range.end, 'range.end');
  if (range.end <= range.start) {
    throw new RangeError('range.end must be greater than range.start');
  }
}

function normalizeGaps(
  gaps: readonly HabitLearningAnalysisGap[],
  range: HabitLearningAnalysisRange,
): HabitLearningAnalysisGap[] {
  const normalized = normalizeUnboundedGaps(gaps);
  for (const [index, gap] of normalized.entries()) {
    if (gap.start < range.start || gap.end > range.end) {
      throw new RangeError(`gaps[${index}] must be contained by range`);
    }
  }
  return normalized;
}

function normalizeUnboundedGaps(
  gaps: readonly HabitLearningAnalysisGap[],
): HabitLearningAnalysisGap[] {
  const ids = new Set<string>();
  const normalized = gaps.map((gap, index) => {
    assertNonEmptyString(gap.gapId, `gaps[${index}].gapId`);
    if (ids.has(gap.gapId)) throw new TypeError(`duplicate gapId: ${gap.gapId}`);
    ids.add(gap.gapId);
    assertNonNegativeSafeInteger(gap.start, `gaps[${index}].start`);
    assertNonNegativeSafeInteger(gap.end, `gaps[${index}].end`);
    if (gap.end <= gap.start) {
      throw new RangeError(`gaps[${index}].end must be greater than start`);
    }
    return { gapId: gap.gapId, start: gap.start, end: gap.end };
  });
  normalized.sort(
    (left, right) =>
      left.start - right.start || left.end - right.end || compareStrings(left.gapId, right.gapId),
  );
  for (let index = 1; index < normalized.length; index += 1) {
    const previous = normalized[index - 1];
    const current = normalized[index];
    if (previous !== undefined && current !== undefined && current.start < previous.end) {
      throw new RangeError(`gaps overlap: ${previous.gapId} and ${current.gapId}`);
    }
  }
  return normalized;
}

function coverageSegments(
  range: HabitLearningAnalysisRange,
  gaps: readonly HabitLearningAnalysisGap[],
): CoverageSegment[] {
  const segments: CoverageSegment[] = [];
  let cursor = range.start;
  for (const gap of gaps) {
    if (cursor < gap.start) segments.push({ start: cursor, end: gap.start, endedBy: 'gap' });
    cursor = gap.end;
  }
  if (cursor < range.end) {
    segments.push({ start: cursor, end: range.end, endedBy: 'window-end' });
  }
  return segments;
}

function gapContaining(
  gaps: readonly HabitLearningAnalysisGap[],
  timestamp: number,
): HabitLearningAnalysisGap | undefined {
  return gaps.find((gap) => timestamp >= gap.start && timestamp < gap.end);
}

function hasGapBetween(
  gaps: readonly HabitLearningAnalysisGap[],
  left: number,
  right: number,
): boolean {
  return gaps.some((gap) => gap.start < right && gap.end > left);
}

function parameterPairingKey(event: HabitLearningParameterEvent): string {
  return JSON.stringify([
    event.deviceKey,
    event.channelKey,
    typeof event.parameterValue,
    event.parameterValue,
  ]);
}

function intervalPairingKey(interval: HabitLearningRawParameterInterval): string {
  return JSON.stringify([
    interval.deviceKey,
    interval.channelKey,
    typeof interval.parameterValue,
    interval.parameterValue,
  ]);
}

function stableScalar(value: HabitLearningParameterValue): string {
  return `${typeof value}:${JSON.stringify(value)}`;
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

function uniqueSortedStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}

function compareParameterValues(
  left: HabitLearningParameterValue,
  right: HabitLearningParameterValue,
): number {
  return compareStrings(stableScalar(left), stableScalar(right));
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
