import { createHmac } from 'node:crypto';
import { type RuleLogEntry, parseLogLine } from './rule-logs.js';

export const RULE_LOG_WINDOW_CHECKPOINT_VERSION = 1 as const;

export const RULE_LOG_WINDOW_COMPLETENESS_REASONS = [
  'scan-overlap-lost',
  'scan-hit-max-blocks',
  'identical-line-overlap-ambiguous',
  'unparsed-log-lines',
] as const;

export type RuleLogWindowCompletenessReason = (typeof RULE_LOG_WINDOW_COMPLETENESS_REASONS)[number];

/**
 * Cumulative, privacy-safe counters carried between scans. `observedLines`
 * counts only lines accepted as new by the overlap calculation, rather than
 * lines re-read in a later scan.
 */
export interface RuleLogWindowCounts {
  scans: number;
  observedLines: number;
  initialVisibleLines: number;
  incrementalLines: number;
  studyInitialEntries: number;
  studyIncrementalEntries: number;
  ignoredParsedLines: number;
  unparsedLines: number;
}

/**
 * The only durable state needed for the next scan. Fingerprints cover the
 * gateway-wide stream so continuity can be established without retaining raw
 * content from rules outside the study.
 */
export interface RuleLogWindowCheckpoint {
  version: typeof RULE_LOG_WINDOW_CHECKPOINT_VERSION;
  fingerprints: string[];
  counts: RuleLogWindowCounts;
}

export type RuleLogWindowScanStopReason = 'empty-block' | 'duplicate-block' | 'max-blocks';

export interface AdvanceRuleLogWindowInput {
  /** Gateway-wide raw log lines, ordered oldest to newest. */
  currentRawLines: readonly string[];
  /** Only parsed entries for these rules may leave this privacy boundary. */
  studyRuleIds: ReadonlySet<string>;
  /** Secret used to HMAC raw lines. It is never included in the result. */
  hmacKey: string | Uint8Array;
  /** Maximum fingerprint suffix retained for the next scan. */
  maxCheckpointEntries: number;
  /**
   * Omit on the first scan. Its accepted entries are the gateway's initially
   * visible retained window, not preload baselines. Baseline classification
   * requires a separate enable-boundary protocol.
   */
  previous?: RuleLogWindowCheckpoint;
  /** Pagination outcome from the gateway-wide scan, when available. */
  scanStopReason?: RuleLogWindowScanStopReason;
}

export interface RuleLogWindowScanCounts {
  rawLines: number;
  /** Older lines re-read before the selected checkpoint anchor. */
  retainedPrefixLines: number;
  /** Lines in the selected checkpoint anchor itself. */
  overlappedLines: number;
  newLines: number;
  studyEntries: number;
  ignoredParsedLines: number;
  unparsedLines: number;
}

export interface RuleLogWindowOverlap {
  /**
   * Longest suffix(previous checkpoint) ending at the selected conservative
   * boundary in the current scan. The current gateway window can retain older
   * lines before the checkpoint, so the match is deliberately not restricted
   * to the prefix.
   */
  length: number;
  /**
   * Number of possible boundaries (occurrences of the checkpoint's last
   * fingerprint). More than one is ambiguous; the earliest boundary is used so
   * possible new repeated occurrences are retained instead of silently dropped.
   */
  candidateCount: number;
}

export interface AdvanceRuleLogWindowResult {
  phase: 'initial-window' | 'incremental';
  /**
   * Study entries visible in the first scan. They may contain preload,
   * behavior, or history from an earlier enable epoch; callers must classify
   * them against a frozen graph and enable boundary before interpretation.
   */
  initialEntries: RuleLogEntry[];
  /** Newly observed study entries from every later scan. */
  incrementalEntries: RuleLogEntry[];
  overlap: RuleLogWindowOverlap;
  scanCounts: RuleLogWindowScanCounts;
  completenessReasons: RuleLogWindowCompletenessReason[];
  checkpoint: RuleLogWindowCheckpoint;
}

const HMAC_DOMAIN = 'xgg-rule-log-window-v1\0';

const ZERO_COUNTS: RuleLogWindowCounts = {
  scans: 0,
  observedLines: 0,
  initialVisibleLines: 0,
  incrementalLines: 0,
  studyInitialEntries: 0,
  studyIncrementalEntries: 0,
  ignoredParsedLines: 0,
  unparsedLines: 0,
};

/**
 * Produce a deterministic, keyed fingerprint for one complete raw log line.
 * The full SHA-256 HMAC is retained so checkpoints do not trade privacy or
 * collision resistance for storage.
 */
export function fingerprintRuleLogLine(rawLine: string, hmacKey: string | Uint8Array): string {
  const key = normalizeHmacKey(hmacKey);
  return createHmac('sha256', key).update(HMAC_DOMAIN).update(rawLine).digest('hex');
}

/**
 * Advance a bounded gateway-log window without persisting unrelated rule
 * content. Duplicate raw lines are positionally compared, never put in a
 * seen-set, so valid repeated occurrences after the chosen overlap survive.
 */
export function advanceRuleLogWindow(input: AdvanceRuleLogWindowInput): AdvanceRuleLogWindowResult {
  assertPositiveInteger(input.maxCheckpointEntries, 'maxCheckpointEntries');
  normalizeHmacKey(input.hmacKey);
  if (input.previous !== undefined) assertCheckpoint(input.previous);

  const isInitialScan = input.previous === undefined;
  const previousFingerprints =
    input.previous?.fingerprints.slice(-input.maxCheckpointEntries) ?? [];
  const currentFingerprints = input.currentRawLines.map((line) =>
    fingerprintRuleLogLine(line, input.hmacKey),
  );
  const overlap = isInitialScan
    ? EMPTY_OVERLAP_MATCH
    : findCheckpointOverlap(previousFingerprints, currentFingerprints);
  const newRawLines = input.currentRawLines.slice(overlap.endIndex);

  const studyEntries: RuleLogEntry[] = [];
  let ignoredParsedLines = 0;
  let unparsedLines = 0;
  for (const rawLine of newRawLines) {
    const parsed = parseLogLine(rawLine);
    if (parsed === null) {
      unparsedLines += 1;
    } else if (input.studyRuleIds.has(parsed.graphId)) {
      studyEntries.push(parsed);
    } else {
      ignoredParsedLines += 1;
    }
  }

  const completenessReasons: RuleLogWindowCompletenessReason[] = [];
  if (
    !isInitialScan &&
    overlap.length === 0 &&
    (previousFingerprints.length > 0 || currentFingerprints.length > 0)
  ) {
    completenessReasons.push('scan-overlap-lost');
  }
  if (input.scanStopReason === 'max-blocks') {
    completenessReasons.push('scan-hit-max-blocks');
  }
  if (overlap.candidateCount > 1) {
    completenessReasons.push('identical-line-overlap-ambiguous');
  }
  if (unparsedLines > 0) {
    completenessReasons.push('unparsed-log-lines');
  }

  const previousCounts = input.previous?.counts ?? ZERO_COUNTS;
  const newLineCount = newRawLines.length;
  const checkpointCounts: RuleLogWindowCounts = {
    scans: previousCounts.scans + 1,
    observedLines: previousCounts.observedLines + newLineCount,
    initialVisibleLines: previousCounts.initialVisibleLines + (isInitialScan ? newLineCount : 0),
    incrementalLines: previousCounts.incrementalLines + (isInitialScan ? 0 : newLineCount),
    studyInitialEntries:
      previousCounts.studyInitialEntries + (isInitialScan ? studyEntries.length : 0),
    studyIncrementalEntries:
      previousCounts.studyIncrementalEntries + (isInitialScan ? 0 : studyEntries.length),
    ignoredParsedLines: previousCounts.ignoredParsedLines + ignoredParsedLines,
    unparsedLines: previousCounts.unparsedLines + unparsedLines,
  };

  return {
    phase: isInitialScan ? 'initial-window' : 'incremental',
    initialEntries: isInitialScan ? studyEntries : [],
    incrementalEntries: isInitialScan ? [] : studyEntries,
    overlap: {
      length: overlap.length,
      candidateCount: overlap.candidateCount,
    },
    scanCounts: {
      rawLines: input.currentRawLines.length,
      retainedPrefixLines: overlap.endIndex - overlap.length,
      overlappedLines: overlap.length,
      newLines: newLineCount,
      studyEntries: studyEntries.length,
      ignoredParsedLines,
      unparsedLines,
    },
    completenessReasons,
    checkpoint: {
      version: RULE_LOG_WINDOW_CHECKPOINT_VERSION,
      fingerprints: currentFingerprints.slice(-input.maxCheckpointEntries),
      counts: checkpointCounts,
    },
  };
}

/**
 * Locate the earliest possible boundary for the bounded previous checkpoint in
 * the current gateway window.
 *
 * A later scan commonly retains the old prefix and appends new lines:
 *
 *   previous full scan: [a,b,c,d,e]
 *   stored checkpoint:          [d,e]
 *   current full scan:  [a,b,c,d,e,f]
 *
 * Restricting the match to current[0] would lose continuity as soon as the
 * previous full scan exceeded the checkpoint bound. Every valid suffix anchor
 * must end with previous.at(-1), so finding that fingerprint in current yields
 * every possible cut point in O(previous + current) time.
 *
 * Always select the earliest possible boundary, then measure the longest suffix
 * ending exactly there. A later, longer match can be composed entirely of new
 * repeated events: for previous=[A,B] and current=[B,A,B], selecting the later
 * [A,B] would silently drop both new lines. The earlier B boundary retains them
 * and reports two candidates. This may duplicate an old line, but never silently
 * discards a possibly legitimate repeated occurrence.
 */
function findCheckpointOverlap(
  previous: readonly string[],
  current: readonly string[],
): OverlapMatch {
  if (previous.length === 0 || current.length === 0) return EMPTY_OVERLAP_MATCH;

  const lastPrevious = previous[previous.length - 1];
  let earliestEndIndex = 0;
  let candidateCount = 0;
  for (let index = 0; index < current.length; index += 1) {
    if (current[index] === lastPrevious) {
      if (candidateCount === 0) earliestEndIndex = index + 1;
      candidateCount += 1;
    }
  }
  if (candidateCount === 0) return EMPTY_OVERLAP_MATCH;

  const upperBound = Math.min(previous.length, earliestEndIndex);
  let length = 1;
  while (
    length < upperBound &&
    previous[previous.length - 1 - length] === current[earliestEndIndex - 1 - length]
  ) {
    length += 1;
  }
  return {
    length,
    candidateCount,
    endIndex: earliestEndIndex,
  };
}

interface OverlapMatch {
  length: number;
  candidateCount: number;
  /** Exclusive end of the chosen checkpoint anchor in current scan order. */
  endIndex: number;
}

const EMPTY_OVERLAP_MATCH: Readonly<OverlapMatch> = Object.freeze({
  length: 0,
  candidateCount: 0,
  endIndex: 0,
});

function normalizeHmacKey(hmacKey: string | Uint8Array): string | Buffer {
  if (typeof hmacKey === 'string') {
    if (Buffer.byteLength(hmacKey) === 0) {
      throw new TypeError('hmacKey must not be empty');
    }
    return hmacKey;
  }
  if (hmacKey.byteLength === 0) {
    throw new TypeError('hmacKey must not be empty');
  }
  return Buffer.from(hmacKey);
}

function assertCheckpoint(checkpoint: RuleLogWindowCheckpoint): void {
  if (typeof checkpoint !== 'object' || checkpoint === null || Array.isArray(checkpoint)) {
    throw new TypeError('checkpoint must be an object');
  }
  if (checkpoint.version !== RULE_LOG_WINDOW_CHECKPOINT_VERSION) {
    throw new TypeError(`unsupported rule log window checkpoint version: ${checkpoint.version}`);
  }
  if (!Array.isArray(checkpoint.fingerprints)) {
    throw new TypeError('checkpoint fingerprints must be an array');
  }
  for (const fingerprint of checkpoint.fingerprints) {
    if (typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint)) {
      throw new TypeError('checkpoint contains an invalid HMAC fingerprint');
    }
  }
  if (
    typeof checkpoint.counts !== 'object' ||
    checkpoint.counts === null ||
    Array.isArray(checkpoint.counts)
  ) {
    throw new TypeError('checkpoint counts must be an object');
  }
  const countNames = [
    'scans',
    'observedLines',
    'initialVisibleLines',
    'incrementalLines',
    'studyInitialEntries',
    'studyIncrementalEntries',
    'ignoredParsedLines',
    'unparsedLines',
  ] as const satisfies readonly (keyof RuleLogWindowCounts)[];
  for (const name of countNames) {
    if (!Object.hasOwn(checkpoint.counts, name)) {
      throw new TypeError(`checkpoint count ${name} is required`);
    }
    const value = checkpoint.counts[name];
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`checkpoint count ${name} must be a non-negative safe integer`);
    }
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}
