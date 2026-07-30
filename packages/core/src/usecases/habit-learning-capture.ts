import { createHash, createHmac, randomBytes } from 'node:crypto';
import { promises as fs, constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import type {
  HabitLearningStudyStorePaths,
  HabitLearningStudyTransaction,
} from './habit-learning-store.js';
import {
  type RuleLogWindowCheckpoint,
  type RuleLogWindowCompletenessReason,
  type RuleLogWindowScanStopReason,
  advanceRuleLogWindow,
} from './rule-log-window.js';
import type { RuleLogEntry } from './rule-logs.js';

export const HABIT_LEARNING_CAPTURE_STATE_VERSION = 1 as const;
export const HABIT_LEARNING_CAPTURE_RECORD_VERSION = 1 as const;

const CAPTURE_BATCH_RECORD_TYPE = 'habit-learning-capture-batch';
const CAPTURE_GAP_RECORD_TYPE = 'habit-learning-capture-gap';
const TAIL_RECOVERY_INTENT_RECORD_TYPE = 'habit-learning-tail-recovery-intent';
const HMAC_KEY_FILE = '.capture-hmac.key';
const GAP_FILE = 'gaps.ndjson';
const TAIL_RECOVERY_INTENT_FILE = '.capture-tail-recovery.intent.json';
const TAIL_RECOVERY_INTENT_TEMP_FILE = '.capture-tail-recovery.intent.tmp';
const KEY_BYTES = 32;
const DEFAULT_MAX_CHECKPOINT_ENTRIES = 64;
const DEFAULT_INITIAL_MAX_BLOCKS = 8;
const DEFAULT_MAX_BLOCKS_CEILING = 128;
const DEFAULT_MAX_FETCH_ATTEMPTS = 3;
const DEFAULT_INITIAL_BACKOFF_MS = 250;
const DEFAULT_MAX_BACKOFF_MS = 5_000;
const DEFAULT_JOURNAL_SEGMENT_BATCH_LIMIT = 128;
const DEFAULT_MAX_CAPTURE_BYTES = 512 * 1024 * 1024;
const MAX_JOURNAL_SEGMENT_BATCH_LIMIT = 4_096;
const MAX_READ_PAGE_SIZE = 1_024;
const JOURNAL_ARCHIVE_PATTERN = /^journal\.capture\.(\d+)-(\d+)\.ndjson$/;
const BATCH_PAYLOAD_DOMAIN = 'xgg-habit-capture-batch-payload-v1\0';
const BATCH_ID_DOMAIN = 'xgg-habit-capture-batch-id-v1\0';
const GAP_ID_DOMAIN = 'xgg-habit-capture-gap-id-v1\0';
const KEY_ID_DOMAIN = 'xgg-habit-capture-key-id-v1\0';
const CHECKPOINT_DIGEST_DOMAIN = 'xgg-habit-capture-checkpoint-v1\0';
const TAIL_RECOVERY_INTENT_DOMAIN = 'xgg-habit-capture-tail-recovery-intent-v1\0';

export type HabitLearningCaptureGapKind =
  | 'scan-overlap-lost'
  | 'identical-line-overlap-ambiguous'
  | 'pagination-ceiling'
  | 'unparsed-log-lines'
  | 'network-error'
  | 'invalid-fetch-result'
  | 'disk-error'
  | 'journal-recovered-truncated-tail'
  | 'gap-ledger-recovered-truncated-tail'
  | 'disk-budget-exhausted';

export type HabitLearningCaptureFailureKind = 'network' | 'invalid-fetch-result' | 'persistence';

export interface HabitLearningCaptureFetchInput {
  /** One-based attempt number within this bounded capture call. */
  attempt: number;
  /** Effective pagination bound selected by the durable coordinator. */
  maxBlocks: number;
}

export interface HabitLearningCaptureFetchResult {
  /** Complete gateway-wide lines in oldest-to-newest order. */
  rawLines: readonly string[];
  blocksRead: number;
  stopReason: RuleLogWindowScanStopReason;
}

export type HabitLearningCaptureFetch = (
  input: HabitLearningCaptureFetchInput,
) => Promise<HabitLearningCaptureFetchResult>;

export interface HabitLearningCaptureStore {
  readonly paths: Readonly<Pick<HabitLearningStudyStorePaths, 'study' | 'journal'>>;
  initialize(): Promise<void>;
  readJournal<T = unknown>(): Promise<T[]>;
  withLock<T>(operation: (transaction: HabitLearningStudyTransaction) => Promise<T>): Promise<T>;
}

export interface HabitLearningCaptureSupervisorOptions {
  store: HabitLearningCaptureStore;
  studyRuleIds: readonly string[];
  fetch: HabitLearningCaptureFetch;
  maxCheckpointEntries?: number;
  initialMaxBlocks?: number;
  maxBlocksCeiling?: number;
  maxFetchAttempts?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  /** Rotate the active journal after this many committed batch envelopes. */
  journalSegmentBatchLimit?: number;
  /** Refuse a new evidence batch once capture-managed files would exceed this budget. */
  maxCaptureBytes?: number;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Optional observability/fault-injection hook around durable tail recovery. */
  onTailRecoveryStep?: (step: HabitLearningCaptureTailRecoveryStep) => Promise<void>;
}

export type HabitLearningCaptureTailRecoveryStep =
  | 'intent-durable'
  | 'journal-applied'
  | 'gaps-applied'
  | 'recovery-gaps-durable';

export interface HabitLearningCapturePaginationState {
  initialMaxBlocks: number;
  maxBlocksCeiling: number;
  nextMaxBlocks: number;
}

export interface HabitLearningCaptureFailureState {
  kind: HabitLearningCaptureFailureKind;
  at: string;
  code: string;
  gapId?: string;
}

export interface HabitLearningCaptureState {
  version: typeof HABIT_LEARNING_CAPTURE_STATE_VERSION;
  studyRuleIds: string[];
  keyId: string;
  maxCheckpointEntries: number;
  journalSegmentBatchLimit: number;
  maxCaptureBytes: number;
  pagination: HabitLearningCapturePaginationState;
  committedBatchSequence: number;
  ruleLogWindow?: RuleLogWindowCheckpoint;
  lastBatch?: {
    batchId: string;
    sequence: number;
    capturedAt: string;
    studyEntries: number;
  };
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  consecutiveFailures: number;
  lastFailure?: HabitLearningCaptureFailureState;
}

export interface HabitLearningCaptureGapRecord {
  recordType: typeof CAPTURE_GAP_RECORD_TYPE;
  recordVersion: typeof HABIT_LEARNING_CAPTURE_RECORD_VERSION;
  gapId: string;
  occurredAt: string;
  kind: HabitLearningCaptureGapKind;
  batchId?: string;
  sequence: number;
  detail: Readonly<Record<string, string | number | boolean>>;
}

export interface HabitLearningCaptureBatchRecord {
  recordType: typeof CAPTURE_BATCH_RECORD_TYPE;
  recordVersion: typeof HABIT_LEARNING_CAPTURE_RECORD_VERSION;
  batchId: string;
  payloadDigest: string;
  keyId: string;
  sequence: number;
  capturedAt: string;
  studyRuleIds: string[];
  previousCheckpointDigest: string;
  phase: 'initial-window' | 'incremental';
  entries: RuleLogEntry[];
  scan: {
    requestedMaxBlocks: number;
    nextMaxBlocks: number;
    attempts: number;
    blocksRead: number;
    stopReason: RuleLogWindowScanStopReason;
    rawLines: number;
    retainedPrefixLines: number;
    overlappedLines: number;
    newLines: number;
    ignoredParsedLines: number;
    unparsedLines: number;
    overlapCandidates: number;
  };
  completenessReasons: RuleLogWindowCompletenessReason[];
  gaps: HabitLearningCaptureGapRecord[];
  nextCheckpoint: RuleLogWindowCheckpoint;
}

export interface HabitLearningCaptureSuccess {
  outcome: 'captured';
  batchId: string;
  sequence: number;
  capturedAt: string;
  phase: 'initial-window' | 'incremental';
  studyEntries: number;
  attempts: number;
  requestedMaxBlocks: number;
  nextMaxBlocks: number;
  completenessReasons: RuleLogWindowCompletenessReason[];
  gapsAdded: number;
  recoveredBatchIds: string[];
}

export interface HabitLearningCaptureFailure {
  outcome: 'failed';
  kind: HabitLearningCaptureFailureKind;
  code: string;
  attempts: number;
  occurredAt: string;
  gapPersisted: boolean;
  stateUpdated: boolean;
  recoveryRequired: boolean;
  recoveredBatchIds: string[];
}

export type HabitLearningCaptureResult = HabitLearningCaptureSuccess | HabitLearningCaptureFailure;

export interface HabitLearningCaptureStatus {
  health: 'uninitialized' | 'ready' | 'degraded' | 'recovery-needed';
  initialized: boolean;
  keyId?: string;
  committedBatchSequence: number;
  journalBatchCount: number;
  captureBytes: number;
  maxCaptureBytes: number;
  pendingBatchId?: string;
  currentMaxBlocks: number;
  consecutiveFailures: number;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastFailure?: HabitLearningCaptureFailureState;
  gapCount: number;
  lastGap?: HabitLearningCaptureGapRecord;
  counts?: RuleLogWindowCheckpoint['counts'];
}

export interface HabitLearningCaptureReadBatchesOptions {
  /** Return committed batches strictly after this sequence. */
  afterSequence?: number;
  /** Bounded page size. Defaults to 256. */
  limit?: number;
}

export interface HabitLearningCaptureBatchPage {
  batches: HabitLearningCaptureBatchRecord[];
  nextAfterSequence: number;
  complete: boolean;
  committedBatchSequence: number;
}

export interface HabitLearningCaptureReadGapsOptions {
  /** Zero-based append offset after which to continue reading. */
  offset?: number;
  /** Bounded page size. Defaults to 256. */
  limit?: number;
}

export interface HabitLearningCaptureGapPage {
  gaps: HabitLearningCaptureGapRecord[];
  nextOffset: number;
  complete: boolean;
  totalGapCount: number;
}

export interface HabitLearningCaptureTailRecoveryResult {
  journal: 'unchanged' | 'terminated-valid-record' | 'truncated-partial-record';
  gaps: 'unchanged' | 'terminated-valid-record' | 'truncated-partial-record';
  journalBytesRemoved: number;
  gapBytesRemoved: number;
  recoveryGapIds: string[];
}

export interface HabitLearningCaptureIntegrityReport {
  committedBatchSequence: number;
  verifiedBatchCount: number;
  archiveSegmentCount: number;
  activeBatchCount: number;
}

interface CaptureConfiguration {
  studyRuleIds: string[];
  maxCheckpointEntries: number;
  initialMaxBlocks: number;
  maxBlocksCeiling: number;
  maxFetchAttempts: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
  journalSegmentBatchLimit: number;
  maxCaptureBytes: number;
}

interface LoadedCaptureData {
  state: HabitLearningCaptureState;
  archivedThroughSequence: number;
  batches: HabitLearningCaptureBatchRecord[];
  gaps: HabitLearningCaptureGapRecord[];
}

interface JournalArchiveSegment {
  path: string;
  startSequence: number;
  endSequence: number;
}

interface JournalArchiveInspection {
  archivedThroughSequence: number;
  segments: JournalArchiveSegment[];
  lastArchivedBatch?: HabitLearningCaptureBatchRecord;
}

interface FetchSuccess {
  ok: true;
  attempts: number;
  fetched: HabitLearningCaptureFetchResult;
}

interface FetchFailure {
  ok: false;
  attempts: number;
  code: string;
}

interface PreparedCaptureScan {
  ok: true;
  attempts: number;
  requestedMaxBlocks: number;
  fetched: HabitLearningCaptureFetchResult;
  advanced: ReturnType<typeof advanceRuleLogWindow>;
}

interface PreparedCaptureFailure {
  ok: false;
  kind: Exclude<HabitLearningCaptureFailureKind, 'persistence'>;
  attempts: number;
  code: string;
}

interface TailRepairPlan<RecordType> {
  action: 'unchanged' | 'terminated-valid-record' | 'truncated-partial-record';
  bytesRemoved: number;
  records: RecordType[];
  sourceBytes: number;
  sourceDigest: string;
  targetBytes: number;
  targetDigest: string;
}

type DurableTailRepairPlan = Omit<TailRepairPlan<unknown>, 'records'>;

interface HabitLearningCaptureTailRecoveryIntent {
  recordType: typeof TAIL_RECOVERY_INTENT_RECORD_TYPE;
  recordVersion: typeof HABIT_LEARNING_CAPTURE_RECORD_VERSION;
  intentId: string;
  keyId: string;
  createdAt: string;
  committedBatchSequence: number;
  journal: DurableTailRepairPlan;
  gaps: DurableTailRepairPlan;
  recoveryGaps: HabitLearningCaptureGapRecord[];
}

/**
 * Crash-recoverable, one-poll-at-a-time capture coordinator.
 *
 * A long-lived CLI process can safely loop over captureOnce(). Every mutation
 * holds the study store's cross-process writer lock. Successful poll batches
 * are fsynced to journal.ndjson before the window checkpoint is atomically
 * replaced. A batch found one sequence ahead after restart is committed before
 * another fetch, so a changing gateway window cannot duplicate the pending
 * batch.
 */
export class HabitLearningCaptureSupervisor {
  private readonly store: HabitLearningCaptureStore;
  private readonly fetch: HabitLearningCaptureFetch;
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly onTailRecoveryStep: (
    step: HabitLearningCaptureTailRecoveryStep,
  ) => Promise<void>;
  private readonly configuration: Readonly<CaptureConfiguration>;

  constructor(options: HabitLearningCaptureSupervisorOptions) {
    this.store = options.store;
    this.fetch = options.fetch;
    this.now = options.now ?? (() => new Date());
    this.sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.onTailRecoveryStep = options.onTailRecoveryStep ?? (async () => {});

    const studyRuleIds = uniqueNonEmptyStrings(options.studyRuleIds, 'studyRuleIds');
    if (studyRuleIds.length !== 1) {
      throw new TypeError('studyRuleIds must contain exactly one observation rule id');
    }
    const initialMaxBlocks = positiveSafeInteger(
      options.initialMaxBlocks ?? DEFAULT_INITIAL_MAX_BLOCKS,
      'initialMaxBlocks',
    );
    const maxBlocksCeiling = positiveSafeInteger(
      options.maxBlocksCeiling ?? DEFAULT_MAX_BLOCKS_CEILING,
      'maxBlocksCeiling',
    );
    if (maxBlocksCeiling < initialMaxBlocks) {
      throw new RangeError('maxBlocksCeiling must be greater than or equal to initialMaxBlocks');
    }
    const initialBackoffMs = nonNegativeSafeInteger(
      options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS,
      'initialBackoffMs',
    );
    const maxBackoffMs = nonNegativeSafeInteger(
      options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
      'maxBackoffMs',
    );
    if (maxBackoffMs < initialBackoffMs) {
      throw new RangeError('maxBackoffMs must be greater than or equal to initialBackoffMs');
    }

    this.configuration = Object.freeze({
      studyRuleIds,
      maxCheckpointEntries: positiveSafeInteger(
        options.maxCheckpointEntries ?? DEFAULT_MAX_CHECKPOINT_ENTRIES,
        'maxCheckpointEntries',
      ),
      initialMaxBlocks,
      maxBlocksCeiling,
      maxFetchAttempts: positiveSafeInteger(
        options.maxFetchAttempts ?? DEFAULT_MAX_FETCH_ATTEMPTS,
        'maxFetchAttempts',
      ),
      initialBackoffMs,
      maxBackoffMs,
      journalSegmentBatchLimit: boundedPositiveSafeInteger(
        options.journalSegmentBatchLimit ?? DEFAULT_JOURNAL_SEGMENT_BATCH_LIMIT,
        MAX_JOURNAL_SEGMENT_BATCH_LIMIT,
        'journalSegmentBatchLimit',
      ),
      maxCaptureBytes: positiveSafeInteger(
        options.maxCaptureBytes ?? DEFAULT_MAX_CAPTURE_BYTES,
        'maxCaptureBytes',
      ),
    });
  }

  async captureOnce(): Promise<HabitLearningCaptureResult> {
    await this.store.initialize();
    return this.store.withLock(async (transaction) => {
      const rawState = await transaction.readState<unknown>();
      const durableArtifactsExist =
        rawState !== undefined ||
        (await hasNonEmptyRegularFile(this.store.paths.journal, 'habit-learning journal')) ||
        (await hasNonEmptyRegularFile(this.gapPath, 'habit-learning gap ledger')) ||
        (await hasCaptureJournalArchives(this.store.paths.study)) ||
        (await hasPrivateRegularFile(
          this.tailRecoveryIntentPath,
          'habit-learning tail recovery intent',
        ));
      const key = await loadCaptureKey(
        this.keyPath,
        this.store.paths.study,
        !durableArtifactsExist,
      );
      if (key === undefined) {
        throw new Error('Habit-learning capture key is missing for existing durable state');
      }
      await this.assertNoPendingTailRecovery();
      const keyId = captureKeyId(key);
      let data = await this.loadCaptureData(rawState, key, keyId, 'latest');
      const recoveredBatchIds: string[] = [];

      const pending = pendingBatch(data);
      if (pending !== undefined) {
        const recovery = await this.commitPendingBatch(
          transaction,
          data.state,
          pending,
          data.gaps,
          key,
          recoveredBatchIds,
        );
        if ('failure' in recovery) return recovery.failure;
        data = {
          state: recovery.state,
          archivedThroughSequence: data.archivedThroughSequence,
          batches: data.batches,
          gaps: recovery.gaps,
        };
      }

      const recoveredRotation = await this.rotateJournalIfNeeded(data);
      if ('failure' in recoveredRotation) {
        return this.persistDiskFailure({
          transaction,
          state: data.state,
          existingGaps: data.gaps,
          key,
          occurredAt: recoveredRotation.failure.occurredAt,
          code: recoveredRotation.code,
          phase: 'journal-rotation',
          attempts: 0,
          recoveredBatchIds,
          recoveryRequired: true,
        });
      }
      data = recoveredRotation.data;

      const occurredAt = this.currentIso();
      const prepared = await this.prepareAdaptiveScan(data.state, key);
      if (!prepared.ok) {
        return this.persistOperationalFailure({
          transaction,
          state: data.state,
          existingGaps: data.gaps,
          key,
          occurredAt,
          kind: prepared.kind,
          code: prepared.code,
          attempts: prepared.attempts,
          recoveredBatchIds,
        });
      }

      const { advanced, fetched, requestedMaxBlocks } = prepared;
      const sequence = data.state.committedBatchSequence + 1;
      const nextMaxBlocks = nextPaginationBound(requestedMaxBlocks, fetched, data.state.pagination);
      const entries =
        advanced.phase === 'initial-window' ? advanced.initialEntries : advanced.incrementalEntries;
      const unsignedBatch = {
        keyId,
        sequence,
        capturedAt: occurredAt,
        studyRuleIds: [...this.configuration.studyRuleIds],
        previousCheckpointDigest: checkpointDigest(data.state.ruleLogWindow),
        phase: advanced.phase,
        entries,
        scan: {
          requestedMaxBlocks,
          nextMaxBlocks,
          attempts: prepared.attempts,
          blocksRead: fetched.blocksRead,
          stopReason: fetched.stopReason,
          rawLines: advanced.scanCounts.rawLines,
          retainedPrefixLines: advanced.scanCounts.retainedPrefixLines,
          overlappedLines: advanced.scanCounts.overlappedLines,
          newLines: advanced.scanCounts.newLines,
          ignoredParsedLines: advanced.scanCounts.ignoredParsedLines,
          unparsedLines: advanced.scanCounts.unparsedLines,
          overlapCandidates: advanced.overlap.candidateCount,
        },
        completenessReasons: [...advanced.completenessReasons],
        nextCheckpoint: advanced.checkpoint,
      } satisfies HabitLearningCaptureBatchUnsigned;
      const payloadDigest = keyedDigest(key, BATCH_PAYLOAD_DOMAIN, unsignedBatch);
      const batchId = keyedDigest(key, BATCH_ID_DOMAIN, {
        sequence,
        previousCheckpointDigest: unsignedBatch.previousCheckpointDigest,
        payloadDigest,
      });
      const gaps = gapsForBatch(batchId, unsignedBatch, key);
      const batch: HabitLearningCaptureBatchRecord = {
        recordType: CAPTURE_BATCH_RECORD_TYPE,
        recordVersion: HABIT_LEARNING_CAPTURE_RECORD_VERSION,
        batchId,
        payloadDigest,
        ...unsignedBatch,
        gaps,
      };

      const nextState = stateAfterBatch(data.state, batch);
      const currentCaptureBytes = await captureStorageBytes(this.store.paths.study);
      const currentStateBytes =
        (await privateRegularFileSizeIfPresent(
          join(this.store.paths.study, 'state.json'),
          'habit-learning state',
        )) ?? 0;
      const batchBytes = Buffer.byteLength(`${JSON.stringify(batch)}\n`);
      const existingGapIds = new Set(data.gaps.map((gap) => gap.gapId));
      const gapBytes = gaps
        .filter((gap) => !existingGapIds.has(gap.gapId))
        .reduce((total, gap) => total + Buffer.byteLength(`${JSON.stringify(gap)}\n`), 0);
      const nextStateBytes = Buffer.byteLength(`${JSON.stringify(nextState, null, 2)}\n`);
      const projectedCaptureBytes =
        currentCaptureBytes - currentStateBytes + batchBytes + gapBytes + nextStateBytes;
      if (projectedCaptureBytes > this.configuration.maxCaptureBytes) {
        return this.persistCaptureBudgetFailure({
          transaction,
          state: data.state,
          existingGaps: data.gaps,
          key,
          occurredAt,
          attempts: prepared.attempts,
          recoveredBatchIds,
          currentCaptureBytes,
          batchBytes,
          gapBytes,
          nextStateBytes,
          projectedCaptureBytes,
        });
      }

      try {
        await transaction.appendJournal([{ ...batch }]);
      } catch (error) {
        return this.persistDiskFailure({
          transaction,
          state: data.state,
          existingGaps: data.gaps,
          key,
          occurredAt,
          code: persistenceCode(error),
          phase: 'journal-append',
          attempts: prepared.attempts,
          recoveredBatchIds,
          // An append error may mean "nothing written", "complete line written
          // but fsync failed", or "partial line written". The caller must
          // always inspect/retry rather than assume the old checkpoint is safe.
          recoveryRequired: true,
        });
      }

      let updatedGaps = data.gaps;
      try {
        updatedGaps = await appendMissingGaps(this.gapPath, gaps, data.gaps);
      } catch (error) {
        return this.persistDiskFailure({
          transaction,
          state: data.state,
          existingGaps: data.gaps,
          key,
          occurredAt,
          code: persistenceCode(error),
          phase: 'gap-append',
          attempts: prepared.attempts,
          recoveredBatchIds,
          recoveryRequired: true,
        });
      }

      try {
        await transaction.writeState(nextState);
      } catch (error) {
        const diskFailure = await bestEffortAppendDiskGap({
          path: this.gapPath,
          existingGaps: updatedGaps,
          key,
          occurredAt,
          sequence,
          batchId,
          code: persistenceCode(error),
          phase: 'checkpoint-write',
        });
        return {
          outcome: 'failed',
          kind: 'persistence',
          code: persistenceCode(error),
          attempts: prepared.attempts,
          occurredAt,
          gapPersisted: diskFailure.persisted,
          stateUpdated: false,
          recoveryRequired: true,
          recoveredBatchIds,
        };
      }

      const rotation = await this.rotateJournalIfNeeded({
        state: nextState,
        archivedThroughSequence: data.archivedThroughSequence,
        batches: [...data.batches, batch],
        gaps: updatedGaps,
      });
      if ('failure' in rotation) {
        const diskFailure = await bestEffortAppendDiskGap({
          path: this.gapPath,
          existingGaps: updatedGaps,
          key,
          occurredAt,
          sequence,
          batchId,
          code: rotation.code,
          phase: 'journal-rotation',
        });
        const failureState = stateAfterFailure(
          nextState,
          occurredAt,
          'persistence',
          rotation.code,
          diskFailure.gap?.gapId,
        );
        let stateUpdated = false;
        try {
          await transaction.writeState(failureState);
          stateUpdated = true;
        } catch {
          // The committed checkpoint remains valid even if the diagnostic
          // failure state cannot be replaced.
        }
        return {
          outcome: 'failed',
          kind: 'persistence',
          code: rotation.code,
          attempts: prepared.attempts,
          occurredAt,
          gapPersisted: diskFailure.persisted,
          stateUpdated,
          recoveryRequired: true,
          recoveredBatchIds,
        };
      }

      return {
        outcome: 'captured',
        batchId,
        sequence,
        capturedAt: occurredAt,
        phase: advanced.phase,
        studyEntries: entries.length,
        attempts: prepared.attempts,
        requestedMaxBlocks,
        nextMaxBlocks,
        completenessReasons: [...advanced.completenessReasons],
        gapsAdded: updatedGaps.length - data.gaps.length,
        recoveredBatchIds,
      };
    });
  }

  async status(): Promise<HabitLearningCaptureStatus> {
    await this.store.initialize();
    return this.store.withLock(async (transaction) => {
      const rawState = await transaction.readState<unknown>();
      const key = await loadCaptureKey(this.keyPath, this.store.paths.study, false);
      if (key === undefined) {
        if (
          rawState !== undefined ||
          (await hasNonEmptyRegularFile(this.store.paths.journal, 'habit-learning journal')) ||
          (await hasNonEmptyRegularFile(this.gapPath, 'habit-learning gap ledger')) ||
          (await hasCaptureJournalArchives(this.store.paths.study)) ||
          (await hasPrivateRegularFile(
            this.tailRecoveryIntentPath,
            'habit-learning tail recovery intent',
          ))
        ) {
          throw new Error('Habit-learning capture key is missing for existing durable state');
        }
        return {
          health: 'uninitialized',
          initialized: false,
          committedBatchSequence: 0,
          journalBatchCount: 0,
          captureBytes: 0,
          maxCaptureBytes: this.configuration.maxCaptureBytes,
          currentMaxBlocks: this.configuration.initialMaxBlocks,
          consecutiveFailures: 0,
          gapCount: 0,
        };
      }

      await this.assertNoPendingTailRecovery();
      const keyId = captureKeyId(key);
      const data = await this.loadCaptureData(rawState, key, keyId, 'latest');
      const captureBytes = await captureStorageBytes(this.store.paths.study);
      const pending = pendingBatch(data);
      const lastGap = data.gaps.at(-1);
      const health =
        pending !== undefined
          ? 'recovery-needed'
          : data.state.consecutiveFailures > 0 || data.gaps.length > 0
            ? 'degraded'
            : data.state.committedBatchSequence === 0
              ? 'uninitialized'
              : 'ready';
      return {
        health,
        initialized: data.state.committedBatchSequence > 0 || rawState !== undefined,
        keyId,
        committedBatchSequence: data.state.committedBatchSequence,
        journalBatchCount: data.archivedThroughSequence + data.batches.length,
        captureBytes,
        maxCaptureBytes: this.configuration.maxCaptureBytes,
        ...(pending !== undefined && { pendingBatchId: pending.batchId }),
        currentMaxBlocks: data.state.pagination.nextMaxBlocks,
        consecutiveFailures: data.state.consecutiveFailures,
        ...(data.state.lastAttemptAt !== undefined && {
          lastAttemptAt: data.state.lastAttemptAt,
        }),
        ...(data.state.lastSuccessAt !== undefined && {
          lastSuccessAt: data.state.lastSuccessAt,
        }),
        ...(data.state.lastFailure !== undefined && {
          lastFailure: data.state.lastFailure,
        }),
        gapCount: data.gaps.length,
        ...(lastGap !== undefined && { lastGap }),
        ...(data.state.ruleLogWindow !== undefined && {
          counts: data.state.ruleLogWindow.counts,
        }),
      };
    });
  }

  /**
   * Read one bounded page across every immutable archive and the active
   * journal. Unlike HabitLearningStudyStore.readJournal(), this method never
   * hides rotated evidence and authenticates every returned batch.
   */
  async readBatches(
    options: HabitLearningCaptureReadBatchesOptions = {},
  ): Promise<HabitLearningCaptureBatchPage> {
    const afterSequence = nonNegativeSafeInteger(options.afterSequence ?? 0, 'afterSequence');
    const limit = boundedPositiveSafeInteger(options.limit ?? 256, MAX_READ_PAGE_SIZE, 'limit');
    await this.store.initialize();
    return this.store.withLock(async (transaction) => {
      const rawState = await transaction.readState<unknown>();
      const key = await loadCaptureKey(this.keyPath, this.store.paths.study, false);
      if (key === undefined) {
        if (
          rawState !== undefined ||
          (await hasNonEmptyRegularFile(this.store.paths.journal, 'habit-learning journal')) ||
          (await hasNonEmptyRegularFile(this.gapPath, 'habit-learning gap ledger')) ||
          (await hasCaptureJournalArchives(this.store.paths.study)) ||
          (await hasPrivateRegularFile(
            this.tailRecoveryIntentPath,
            'habit-learning tail recovery intent',
          ))
        ) {
          throw new Error('Habit-learning capture key is missing for existing durable state');
        }
        return {
          batches: [],
          nextAfterSequence: afterSequence,
          complete: true,
          committedBatchSequence: 0,
        };
      }
      await this.assertNoPendingTailRecovery();
      const keyId = captureKeyId(key);
      const data = await this.loadCaptureData(rawState, key, keyId, 'latest');
      const archives = await inspectJournalArchives(
        this.store.paths.study,
        this.configuration,
        keyId,
        key,
        'latest',
      );
      const batches: HabitLearningCaptureBatchRecord[] = [];
      for (const segment of archives.segments) {
        if (segment.endSequence <= afterSequence || batches.length >= limit) continue;
        const records = await readAndValidateArchiveSegment(
          segment,
          this.configuration,
          keyId,
          key,
        );
        for (const batch of records) {
          if (batch.sequence > afterSequence && batches.length < limit) batches.push(batch);
        }
      }
      if (batches.length < limit) {
        for (const batch of data.batches) {
          if (
            batch.sequence > afterSequence &&
            batch.sequence <= data.state.committedBatchSequence &&
            batches.length < limit
          ) {
            batches.push(batch);
          }
        }
      }
      batches.forEach((batch, index) => {
        const previous = batches[index - 1];
        if (
          (index === 0 && batch.sequence !== afterSequence + 1) ||
          (previous !== undefined &&
            (batch.sequence !== previous.sequence + 1 ||
              batch.previousCheckpointDigest !== checkpointDigest(previous.nextCheckpoint)))
        ) {
          throw new Error(`Capture evidence page is not contiguous at ${batch.sequence}`);
        }
      });
      const nextAfterSequence = batches.at(-1)?.sequence ?? afterSequence;
      return {
        batches,
        nextAfterSequence,
        complete: nextAfterSequence >= data.state.committedBatchSequence,
        committedBatchSequence: data.state.committedBatchSequence,
      };
    });
  }

  /**
   * Perform an explicit full authenticated traversal. Normal capture/status
   * validate the active journal and newest archive only so their historical
   * I/O stays bounded; lifecycle finish should call this before analysis.
   */
  async verifyEvidenceIntegrity(): Promise<HabitLearningCaptureIntegrityReport> {
    await this.store.initialize();
    return this.store.withLock(async (transaction) => {
      const rawState = await transaction.readState<unknown>();
      const key = await loadCaptureKey(this.keyPath, this.store.paths.study, false);
      if (key === undefined) {
        if (
          rawState === undefined &&
          !(await hasNonEmptyRegularFile(this.store.paths.journal, 'habit-learning journal')) &&
          !(await hasNonEmptyRegularFile(this.gapPath, 'habit-learning gap ledger')) &&
          !(await hasCaptureJournalArchives(this.store.paths.study)) &&
          !(await hasPrivateRegularFile(
            this.tailRecoveryIntentPath,
            'habit-learning tail recovery intent',
          ))
        ) {
          return {
            committedBatchSequence: 0,
            verifiedBatchCount: 0,
            archiveSegmentCount: 0,
            activeBatchCount: 0,
          };
        }
        throw new Error('Habit-learning capture key is missing for existing durable state');
      }
      await this.assertNoPendingTailRecovery();
      const keyId = captureKeyId(key);
      const data = await this.loadCaptureData(rawState, key, keyId, 'latest');
      const archives = await inspectJournalArchives(
        this.store.paths.study,
        this.configuration,
        keyId,
        key,
        'latest',
      );
      let previousCheckpointDigest = checkpointDigest(undefined);
      let verifiedBatchCount = 0;
      for (const segment of archives.segments) {
        const records = await readAndValidateArchiveSegment(
          segment,
          this.configuration,
          keyId,
          key,
        );
        for (const batch of records) {
          if (
            batch.sequence !== verifiedBatchCount + 1 ||
            batch.previousCheckpointDigest !== previousCheckpointDigest
          ) {
            throw new Error(`Capture evidence chain is broken at batch ${batch.sequence}`);
          }
          previousCheckpointDigest = checkpointDigest(batch.nextCheckpoint);
          verifiedBatchCount += 1;
        }
      }
      for (const batch of data.batches) {
        if (batch.sequence > data.state.committedBatchSequence) break;
        if (
          batch.sequence !== verifiedBatchCount + 1 ||
          batch.previousCheckpointDigest !== previousCheckpointDigest
        ) {
          throw new Error(`Capture evidence chain is broken at batch ${batch.sequence}`);
        }
        previousCheckpointDigest = checkpointDigest(batch.nextCheckpoint);
        verifiedBatchCount += 1;
      }
      if (verifiedBatchCount !== data.state.committedBatchSequence) {
        throw new Error('Capture integrity traversal did not cover every committed batch');
      }
      if (previousCheckpointDigest !== checkpointDigest(data.state.ruleLogWindow)) {
        throw new Error('Capture durable checkpoint does not match the evidence chain');
      }
      return {
        committedBatchSequence: data.state.committedBatchSequence,
        verifiedBatchCount,
        archiveSegmentCount: archives.segments.length,
        activeBatchCount: data.batches.filter(
          (batch) => batch.sequence <= data.state.committedBatchSequence,
        ).length,
      };
    });
  }

  /** Read a bounded authenticated page from the append-only completeness ledger. */
  async readGaps(
    options: HabitLearningCaptureReadGapsOptions = {},
  ): Promise<HabitLearningCaptureGapPage> {
    const offset = nonNegativeSafeInteger(options.offset ?? 0, 'offset');
    const limit = boundedPositiveSafeInteger(options.limit ?? 256, MAX_READ_PAGE_SIZE, 'limit');
    await this.store.initialize();
    return this.store.withLock(async (transaction) => {
      const rawState = await transaction.readState<unknown>();
      const key = await loadCaptureKey(this.keyPath, this.store.paths.study, false);
      if (key === undefined) {
        if (
          rawState !== undefined ||
          (await hasNonEmptyRegularFile(this.store.paths.journal, 'habit-learning journal')) ||
          (await hasNonEmptyRegularFile(this.gapPath, 'habit-learning gap ledger')) ||
          (await hasCaptureJournalArchives(this.store.paths.study)) ||
          (await hasPrivateRegularFile(
            this.tailRecoveryIntentPath,
            'habit-learning tail recovery intent',
          ))
        ) {
          throw new Error('Habit-learning capture key is missing for existing durable state');
        }
        return { gaps: [], nextOffset: offset, complete: true, totalGapCount: 0 };
      }
      await this.assertNoPendingTailRecovery();
      const data = await this.loadCaptureData(rawState, key, captureKeyId(key), 'latest');
      const gaps = data.gaps.slice(offset, offset + limit);
      const nextOffset = offset + gaps.length;
      return {
        gaps,
        nextOffset,
        complete: nextOffset >= data.gaps.length,
        totalGapCount: data.gaps.length,
      };
    });
  }

  /**
   * Explicitly repair only an interrupted final write. Authenticated complete
   * records missing their final LF are terminated; an unauthenticated suffix
   * is truncated only when the durable checkpoint is fully covered by the
   * preceding complete records. Interior corruption and immutable archives
   * remain hard failures.
   */
  async recoverPartialTails(): Promise<HabitLearningCaptureTailRecoveryResult> {
    await this.store.initialize();
    return this.store.withLock(async (transaction) => {
      const rawState = await transaction.readState<unknown>();
      const key = await loadCaptureKey(this.keyPath, this.store.paths.study, false);
      if (key === undefined) {
        if (
          rawState !== undefined ||
          (await hasNonEmptyRegularFile(this.store.paths.journal, 'habit-learning journal')) ||
          (await hasNonEmptyRegularFile(this.gapPath, 'habit-learning gap ledger')) ||
          (await hasCaptureJournalArchives(this.store.paths.study)) ||
          (await hasPrivateRegularFile(
            this.tailRecoveryIntentPath,
            'habit-learning tail recovery intent',
          ))
        ) {
          throw new Error('Habit-learning capture key is missing for existing durable state');
        }
        return {
          journal: 'unchanged',
          gaps: 'unchanged',
          journalBytesRemoved: 0,
          gapBytesRemoved: 0,
          recoveryGapIds: [],
        };
      }

      const keyId = captureKeyId(key);
      const state =
        rawState === undefined
          ? initialState(this.configuration, keyId)
          : parseCaptureState(rawState, this.configuration, keyId, key);
      let intent = await readTailRecoveryIntentIfPresent(this.tailRecoveryIntentPath, keyId, key);
      if (intent === undefined) {
        await removePrivateFileIfPresent(
          this.tailRecoveryIntentTempPath,
          'habit-learning tail recovery intent temporary file',
          this.store.paths.study,
        );
        const archives = await inspectJournalArchives(
          this.store.paths.study,
          this.configuration,
          keyId,
          key,
          'latest',
        );
        const journalPlan = await planCaptureJournalTailRepair(
          this.store.paths.journal,
          this.configuration,
          keyId,
          key,
          state,
          archives,
        );
        const gapPlan = await planGapLedgerTailRepair(this.gapPath, key);
        if (journalPlan.action === 'unchanged' && gapPlan.action === 'unchanged') {
          return {
            journal: 'unchanged',
            gaps: 'unchanged',
            journalBytesRemoved: 0,
            gapBytesRemoved: 0,
            recoveryGapIds: [],
          };
        }

        const occurredAt = this.currentIso();
        const recoveryGaps: HabitLearningCaptureGapRecord[] = [];
        if (journalPlan.action === 'truncated-partial-record') {
          recoveryGaps.push(
            createGapRecord(key, {
              occurredAt,
              kind: 'journal-recovered-truncated-tail',
              sequence: state.committedBatchSequence + 1,
              detail: {
                file: 'journal.ndjson',
                bytesRemoved: journalPlan.bytesRemoved,
                action: journalPlan.action,
              },
            }),
          );
        }
        if (gapPlan.action === 'truncated-partial-record') {
          recoveryGaps.push(
            createGapRecord(key, {
              occurredAt,
              kind: 'gap-ledger-recovered-truncated-tail',
              sequence: state.committedBatchSequence + 1,
              detail: {
                file: GAP_FILE,
                bytesRemoved: gapPlan.bytesRemoved,
                action: gapPlan.action,
              },
            }),
          );
        }
        intent = createTailRecoveryIntent(key, {
          keyId,
          createdAt: occurredAt,
          committedBatchSequence: state.committedBatchSequence,
          journal: durableTailRepairPlan(journalPlan),
          gaps: durableTailRepairPlan(gapPlan),
          recoveryGaps,
        });
        await writeTailRecoveryIntent(
          this.tailRecoveryIntentPath,
          this.tailRecoveryIntentTempPath,
          this.store.paths.study,
          intent,
        );
        await this.onTailRecoveryStep('intent-durable');
      }
      if (intent.committedBatchSequence !== state.committedBatchSequence) {
        throw new Error('Habit-learning tail recovery intent does not match durable state');
      }

      await applyDurableTailRepairPlan(
        this.store.paths.journal,
        'habit-learning journal',
        intent.journal,
      );
      await this.onTailRecoveryStep('journal-applied');
      await applyGapTailRepairWithRecovery(this.gapPath, intent.gaps, intent.recoveryGaps, key);
      await this.onTailRecoveryStep('gaps-applied');

      // Re-read both files after the physical repair before recording any loss.
      // This keeps the repair fail-closed if a concurrent/tampered path changed
      // despite the study writer lock.
      const repaired = await this.loadCaptureData(rawState, key, keyId);
      const gaps = await appendMissingGaps(this.gapPath, intent.recoveryGaps, repaired.gaps);
      if (
        !intent.recoveryGaps.every((recoveryGap) =>
          gaps.some((gap) => gap.gapId === recoveryGap.gapId),
        )
      ) {
        throw new Error('Habit-learning tail recovery gap append was not durable');
      }
      await this.onTailRecoveryStep('recovery-gaps-durable');
      await removePrivateFileIfPresent(
        this.tailRecoveryIntentPath,
        'habit-learning tail recovery intent',
        this.store.paths.study,
      );
      await removePrivateFileIfPresent(
        this.tailRecoveryIntentTempPath,
        'habit-learning tail recovery intent temporary file',
        this.store.paths.study,
      );

      return {
        journal: intent.journal.action,
        gaps: intent.gaps.action,
        journalBytesRemoved: intent.journal.bytesRemoved,
        gapBytesRemoved: intent.gaps.bytesRemoved,
        recoveryGapIds: intent.recoveryGaps.map((gap) => gap.gapId),
      };
    });
  }

  private get keyPath(): string {
    return join(this.store.paths.study, HMAC_KEY_FILE);
  }

  private get gapPath(): string {
    return join(this.store.paths.study, GAP_FILE);
  }

  private get tailRecoveryIntentPath(): string {
    return join(this.store.paths.study, TAIL_RECOVERY_INTENT_FILE);
  }

  private get tailRecoveryIntentTempPath(): string {
    return join(this.store.paths.study, TAIL_RECOVERY_INTENT_TEMP_FILE);
  }

  private async assertNoPendingTailRecovery(): Promise<void> {
    if (
      await hasPrivateRegularFile(
        this.tailRecoveryIntentPath,
        'habit-learning tail recovery intent',
      )
    ) {
      throw new Error(
        'Habit-learning tail recovery intent is pending; call recoverPartialTails() first',
      );
    }
  }

  private currentIso(): string {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new TypeError('now() must return a valid Date');
    }
    return value.toISOString();
  }

  private async fetchWithRetry(maxBlocks: number): Promise<FetchSuccess | FetchFailure> {
    let lastCode = 'FETCH_FAILED';
    for (let attempt = 1; attempt <= this.configuration.maxFetchAttempts; attempt += 1) {
      try {
        return {
          ok: true,
          attempts: attempt,
          fetched: await this.fetch({ attempt, maxBlocks }),
        };
      } catch (error) {
        lastCode = fetchFailureCode(error);
        if (attempt < this.configuration.maxFetchAttempts) {
          await this.sleep(this.backoffDelay(attempt));
        }
      }
    }
    return {
      ok: false,
      attempts: this.configuration.maxFetchAttempts,
      code: lastCode,
    };
  }

  private async prepareAdaptiveScan(
    state: HabitLearningCaptureState,
    key: Buffer,
  ): Promise<PreparedCaptureScan | PreparedCaptureFailure> {
    let maxBlocks = state.pagination.nextMaxBlocks;
    let totalAttempts = 0;

    while (true) {
      const fetched = await this.fetchWithRetry(maxBlocks);
      totalAttempts += fetched.attempts;
      if (!fetched.ok) {
        return {
          ok: false,
          kind: 'network',
          attempts: totalAttempts,
          code: fetched.code,
        };
      }

      let normalized: HabitLearningCaptureFetchResult;
      try {
        normalized = validateFetchResult(fetched.fetched, maxBlocks);
      } catch {
        return {
          ok: false,
          kind: 'invalid-fetch-result',
          attempts: totalAttempts,
          code: 'INVALID_FETCH_RESULT',
        };
      }

      // First calculate overlap without treating a temporary pagination bound
      // as a durable gap. A unique checkpoint anchor proves every possible new
      // line is already in this scan; otherwise a max-blocks result must be
      // re-fetched at a larger bound before any journal/checkpoint mutation.
      const provisional = this.advanceCaptureWindow(state, key, normalized, undefined);
      const trustworthyOverlap =
        state.ruleLogWindow !== undefined &&
        provisional.overlap.length > 0 &&
        provisional.overlap.candidateCount === 1;
      const shouldExpand =
        normalized.stopReason === 'max-blocks' &&
        !trustworthyOverlap &&
        maxBlocks < state.pagination.maxBlocksCeiling;
      if (shouldExpand) {
        maxBlocks = Math.min(
          state.pagination.maxBlocksCeiling,
          Math.max(maxBlocks + 1, maxBlocks * 2),
        );
        continue;
      }

      const durableStopReason =
        normalized.stopReason === 'max-blocks' && trustworthyOverlap
          ? undefined
          : normalized.stopReason;
      return {
        ok: true,
        attempts: totalAttempts,
        requestedMaxBlocks: maxBlocks,
        fetched: normalized,
        advanced: this.advanceCaptureWindow(state, key, normalized, durableStopReason),
      };
    }
  }

  private advanceCaptureWindow(
    state: HabitLearningCaptureState,
    key: Buffer,
    fetched: HabitLearningCaptureFetchResult,
    scanStopReason: RuleLogWindowScanStopReason | undefined,
  ): ReturnType<typeof advanceRuleLogWindow> {
    return advanceRuleLogWindow({
      currentRawLines: fetched.rawLines,
      studyRuleIds: new Set(this.configuration.studyRuleIds),
      hmacKey: key,
      maxCheckpointEntries: this.configuration.maxCheckpointEntries,
      ...(state.ruleLogWindow !== undefined && {
        previous: state.ruleLogWindow,
      }),
      ...(scanStopReason !== undefined && { scanStopReason }),
    });
  }

  private backoffDelay(failedAttempt: number): number {
    if (this.configuration.initialBackoffMs === 0) return 0;
    const exponent = Math.min(failedAttempt - 1, 52);
    const candidate = this.configuration.initialBackoffMs * 2 ** exponent;
    return Math.min(this.configuration.maxBackoffMs, candidate);
  }

  private async loadCaptureData(
    rawState: unknown,
    key: Buffer,
    keyId: string,
    archiveValidation: 'all' | 'latest' = 'all',
  ): Promise<LoadedCaptureData> {
    const state =
      rawState === undefined
        ? initialState(this.configuration, keyId)
        : parseCaptureState(rawState, this.configuration, keyId, key);
    await assertTerminatedNdjsonIfPresent(this.store.paths.journal, 'habit-learning journal');
    const records = await this.store.readJournal<unknown>();
    if (!records.every(isCaptureBatchCandidate)) {
      throw new Error('Habit-learning capture journal contains a non-capture record');
    }
    const batches = records.map((record) =>
      parseCaptureBatch(record, this.configuration, keyId, key),
    );
    const archives = await inspectJournalArchives(
      this.store.paths.study,
      this.configuration,
      keyId,
      key,
      archiveValidation,
    );
    validateJournalSequence(batches, state, archives);
    const gaps = await readGapLedger(this.gapPath, key);
    return {
      state,
      archivedThroughSequence: archives.archivedThroughSequence,
      batches,
      gaps,
    };
  }

  private async rotateJournalIfNeeded(
    data: LoadedCaptureData,
  ): Promise<{ data: LoadedCaptureData } | { failure: HabitLearningCaptureFailure; code: string }> {
    if (data.batches.length < this.configuration.journalSegmentBatchLimit) {
      return { data };
    }
    const pending = pendingBatch(data);
    if (pending !== undefined) return { data };
    const first = data.batches[0];
    const last = data.batches.at(-1);
    if (first === undefined || last === undefined) return { data };
    if (
      first.sequence !== data.archivedThroughSequence + 1 ||
      last.sequence !== data.state.committedBatchSequence
    ) {
      throw new Error('Habit-learning active journal is not a complete committed segment');
    }
    const archivePath = journalArchivePath(this.store.paths.study, first.sequence, last.sequence);
    try {
      await assertPathMissing(archivePath, 'habit-learning journal archive');
      await fs.chmod(this.store.paths.journal, 0o600);
      await fs.rename(this.store.paths.journal, archivePath);
      await syncDirectory(this.store.paths.study);
      return {
        data: {
          state: data.state,
          archivedThroughSequence: last.sequence,
          batches: [],
          gaps: data.gaps,
        },
      };
    } catch (error) {
      const occurredAt = this.currentIso();
      return {
        code: persistenceCode(error),
        failure: {
          outcome: 'failed',
          kind: 'persistence',
          code: persistenceCode(error),
          attempts: 0,
          occurredAt,
          gapPersisted: false,
          stateUpdated: false,
          recoveryRequired: true,
          recoveredBatchIds: [],
        },
      };
    }
  }

  private async commitPendingBatch(
    transaction: HabitLearningStudyTransaction,
    state: HabitLearningCaptureState,
    batch: HabitLearningCaptureBatchRecord,
    existingGaps: HabitLearningCaptureGapRecord[],
    key: Buffer,
    recoveredBatchIds: string[],
  ): Promise<
    | {
        state: HabitLearningCaptureState;
        gaps: HabitLearningCaptureGapRecord[];
      }
    | { failure: HabitLearningCaptureFailure }
  > {
    if (batch.previousCheckpointDigest !== checkpointDigest(state.ruleLogWindow)) {
      throw new Error(
        `Pending capture batch ${batch.batchId} does not continue the durable checkpoint`,
      );
    }

    let gaps = existingGaps;
    try {
      gaps = await appendMissingGaps(this.gapPath, batch.gaps, existingGaps);
    } catch (error) {
      return {
        failure: {
          outcome: 'failed',
          kind: 'persistence',
          code: persistenceCode(error),
          attempts: 0,
          occurredAt: this.currentIso(),
          gapPersisted: false,
          stateUpdated: false,
          recoveryRequired: true,
          recoveredBatchIds,
        },
      };
    }

    const recoveredState = stateAfterBatch(state, batch);
    try {
      await transaction.writeState(recoveredState);
    } catch (error) {
      const occurredAt = this.currentIso();
      const diskGap = await bestEffortAppendDiskGap({
        path: this.gapPath,
        existingGaps: gaps,
        key,
        occurredAt,
        sequence: batch.sequence,
        batchId: batch.batchId,
        code: persistenceCode(error),
        phase: 'recovery-checkpoint-write',
      });
      return {
        failure: {
          outcome: 'failed',
          kind: 'persistence',
          code: persistenceCode(error),
          attempts: 0,
          occurredAt,
          gapPersisted: diskGap.persisted,
          stateUpdated: false,
          recoveryRequired: true,
          recoveredBatchIds,
        },
      };
    }
    recoveredBatchIds.push(batch.batchId);
    return { state: recoveredState, gaps };
  }

  private async persistOperationalFailure(input: {
    transaction: HabitLearningStudyTransaction;
    state: HabitLearningCaptureState;
    existingGaps: HabitLearningCaptureGapRecord[];
    key: Buffer;
    occurredAt: string;
    kind: Exclude<HabitLearningCaptureFailureKind, 'persistence'>;
    code: string;
    attempts: number;
    recoveredBatchIds: string[];
  }): Promise<HabitLearningCaptureFailure> {
    const gapKind = input.kind === 'network' ? 'network-error' : 'invalid-fetch-result';
    const sequence = input.state.committedBatchSequence + 1;
    const gap =
      [...input.existingGaps]
        .reverse()
        .find((candidate) => candidate.kind === gapKind && candidate.sequence === sequence) ??
      createGapRecord(input.key, {
        occurredAt: input.occurredAt,
        kind: gapKind,
        sequence,
        detail: {
          attempts: input.attempts,
          code: input.code,
        },
      });
    let gapPersisted = input.existingGaps.some((candidate) => candidate.gapId === gap.gapId);
    try {
      if (!gapPersisted) {
        await appendMissingGaps(this.gapPath, [gap], input.existingGaps);
        gapPersisted = true;
      }
    } catch (error) {
      return {
        outcome: 'failed',
        kind: 'persistence',
        code: persistenceCode(error),
        attempts: input.attempts,
        occurredAt: input.occurredAt,
        gapPersisted: false,
        stateUpdated: false,
        recoveryRequired: true,
        recoveredBatchIds: input.recoveredBatchIds,
      };
    }

    const nextState = stateAfterFailure(
      input.state,
      input.occurredAt,
      input.kind,
      input.code,
      gap.gapId,
    );
    try {
      await input.transaction.writeState(nextState);
      return {
        outcome: 'failed',
        kind: input.kind,
        code: input.code,
        attempts: input.attempts,
        occurredAt: input.occurredAt,
        gapPersisted,
        stateUpdated: true,
        recoveryRequired: false,
        recoveredBatchIds: input.recoveredBatchIds,
      };
    } catch (error) {
      return {
        outcome: 'failed',
        kind: 'persistence',
        code: persistenceCode(error),
        attempts: input.attempts,
        occurredAt: input.occurredAt,
        gapPersisted,
        stateUpdated: false,
        recoveryRequired: false,
        recoveredBatchIds: input.recoveredBatchIds,
      };
    }
  }

  private async persistCaptureBudgetFailure(input: {
    transaction: HabitLearningStudyTransaction;
    state: HabitLearningCaptureState;
    existingGaps: HabitLearningCaptureGapRecord[];
    key: Buffer;
    occurredAt: string;
    attempts: number;
    recoveredBatchIds: string[];
    currentCaptureBytes: number;
    batchBytes: number;
    gapBytes: number;
    nextStateBytes: number;
    projectedCaptureBytes: number;
  }): Promise<HabitLearningCaptureFailure> {
    const code = 'DISK_BUDGET_EXHAUSTED';
    const sequence = input.state.committedBatchSequence + 1;
    const gap =
      [...input.existingGaps]
        .reverse()
        .find(
          (candidate) =>
            candidate.kind === 'disk-budget-exhausted' &&
            candidate.sequence === sequence &&
            candidate.detail.maxCaptureBytes === this.configuration.maxCaptureBytes,
        ) ??
      createGapRecord(input.key, {
        occurredAt: input.occurredAt,
        kind: 'disk-budget-exhausted',
        sequence,
        detail: {
          code,
          currentCaptureBytes: input.currentCaptureBytes,
          batchBytes: input.batchBytes,
          gapBytes: input.gapBytes,
          nextStateBytes: input.nextStateBytes,
          projectedCaptureBytes: input.projectedCaptureBytes,
          maxCaptureBytes: this.configuration.maxCaptureBytes,
        },
      });
    let gapPersisted = input.existingGaps.some((candidate) => candidate.gapId === gap.gapId);
    try {
      if (!gapPersisted) {
        await appendMissingGaps(this.gapPath, [gap], input.existingGaps);
        gapPersisted = true;
      }
    } catch (error) {
      return {
        outcome: 'failed',
        kind: 'persistence',
        code: persistenceCode(error),
        attempts: input.attempts,
        occurredAt: input.occurredAt,
        gapPersisted: false,
        stateUpdated: false,
        recoveryRequired: true,
        recoveredBatchIds: input.recoveredBatchIds,
      };
    }

    const nextState = stateAfterFailure(
      input.state,
      input.occurredAt,
      'persistence',
      code,
      gap.gapId,
    );
    try {
      await input.transaction.writeState(nextState);
      return {
        outcome: 'failed',
        kind: 'persistence',
        code,
        attempts: input.attempts,
        occurredAt: input.occurredAt,
        gapPersisted,
        stateUpdated: true,
        recoveryRequired: false,
        recoveredBatchIds: input.recoveredBatchIds,
      };
    } catch (error) {
      return {
        outcome: 'failed',
        kind: 'persistence',
        code: persistenceCode(error),
        attempts: input.attempts,
        occurredAt: input.occurredAt,
        gapPersisted,
        stateUpdated: false,
        recoveryRequired: false,
        recoveredBatchIds: input.recoveredBatchIds,
      };
    }
  }

  private async persistDiskFailure(input: {
    transaction: HabitLearningStudyTransaction;
    state: HabitLearningCaptureState;
    existingGaps: HabitLearningCaptureGapRecord[];
    key: Buffer;
    occurredAt: string;
    code: string;
    phase: string;
    attempts: number;
    recoveredBatchIds: string[];
    recoveryRequired: boolean;
  }): Promise<HabitLearningCaptureFailure> {
    const diskGap = await bestEffortAppendDiskGap({
      path: this.gapPath,
      existingGaps: input.existingGaps,
      key: input.key,
      occurredAt: input.occurredAt,
      sequence: input.state.committedBatchSequence + 1,
      code: input.code,
      phase: input.phase,
    });
    const nextState = stateAfterFailure(
      input.state,
      input.occurredAt,
      'persistence',
      input.code,
      diskGap.gap?.gapId,
    );
    let stateUpdated = false;
    try {
      await input.transaction.writeState(nextState);
      stateUpdated = true;
    } catch {
      // The durable gap is the remaining recovery signal when state replacement
      // fails. If the filesystem cannot persist either artifact, the result
      // explicitly reports that no durable status was written.
    }
    return {
      outcome: 'failed',
      kind: 'persistence',
      code: input.code,
      attempts: input.attempts,
      occurredAt: input.occurredAt,
      gapPersisted: diskGap.persisted,
      stateUpdated,
      recoveryRequired: input.recoveryRequired,
      recoveredBatchIds: input.recoveredBatchIds,
    };
  }
}

type HabitLearningCaptureBatchUnsigned = Omit<
  HabitLearningCaptureBatchRecord,
  'recordType' | 'recordVersion' | 'batchId' | 'payloadDigest' | 'gaps'
>;

function initialState(
  configuration: CaptureConfiguration,
  keyId: string,
): HabitLearningCaptureState {
  return {
    version: HABIT_LEARNING_CAPTURE_STATE_VERSION,
    studyRuleIds: [...configuration.studyRuleIds],
    keyId,
    maxCheckpointEntries: configuration.maxCheckpointEntries,
    journalSegmentBatchLimit: configuration.journalSegmentBatchLimit,
    maxCaptureBytes: configuration.maxCaptureBytes,
    pagination: {
      initialMaxBlocks: configuration.initialMaxBlocks,
      maxBlocksCeiling: configuration.maxBlocksCeiling,
      nextMaxBlocks: configuration.initialMaxBlocks,
    },
    committedBatchSequence: 0,
    consecutiveFailures: 0,
  };
}

function parseCaptureState(
  raw: unknown,
  configuration: CaptureConfiguration,
  keyId: string,
  key: Buffer,
): HabitLearningCaptureState {
  if (!isRecord(raw)) throw new TypeError('Habit-learning capture state must be an object');
  if (raw.version !== HABIT_LEARNING_CAPTURE_STATE_VERSION) {
    throw new TypeError(`Unsupported habit-learning capture state version: ${String(raw.version)}`);
  }
  const studyRuleIds = stringArray(raw.studyRuleIds, 'state.studyRuleIds');
  if (!sameStrings(studyRuleIds, configuration.studyRuleIds)) {
    throw new Error('Habit-learning capture studyRuleIds do not match the durable state');
  }
  if (raw.keyId !== keyId) {
    throw new Error('Habit-learning capture HMAC key does not match the durable state');
  }
  if (raw.maxCheckpointEntries !== configuration.maxCheckpointEntries) {
    throw new Error('Habit-learning maxCheckpointEntries does not match the durable state');
  }
  if (raw.journalSegmentBatchLimit !== configuration.journalSegmentBatchLimit) {
    throw new Error('Habit-learning journalSegmentBatchLimit does not match the durable state');
  }
  if (raw.maxCaptureBytes !== configuration.maxCaptureBytes) {
    throw new Error('Habit-learning maxCaptureBytes does not match the durable state');
  }
  if (!isRecord(raw.pagination)) {
    throw new TypeError('Habit-learning capture pagination state must be an object');
  }
  const pagination: HabitLearningCapturePaginationState = {
    initialMaxBlocks: positiveSafeInteger(
      raw.pagination.initialMaxBlocks,
      'state.pagination.initialMaxBlocks',
    ),
    maxBlocksCeiling: positiveSafeInteger(
      raw.pagination.maxBlocksCeiling,
      'state.pagination.maxBlocksCeiling',
    ),
    nextMaxBlocks: positiveSafeInteger(
      raw.pagination.nextMaxBlocks,
      'state.pagination.nextMaxBlocks',
    ),
  };
  if (
    pagination.initialMaxBlocks !== configuration.initialMaxBlocks ||
    pagination.maxBlocksCeiling !== configuration.maxBlocksCeiling
  ) {
    throw new Error('Habit-learning pagination configuration does not match the durable state');
  }
  if (
    pagination.nextMaxBlocks < pagination.initialMaxBlocks ||
    pagination.nextMaxBlocks > pagination.maxBlocksCeiling
  ) {
    throw new RangeError('state.pagination.nextMaxBlocks is outside the configured bounds');
  }
  const committedBatchSequence = nonNegativeSafeInteger(
    raw.committedBatchSequence,
    'state.committedBatchSequence',
  );
  const consecutiveFailures = nonNegativeSafeInteger(
    raw.consecutiveFailures,
    'state.consecutiveFailures',
  );

  let ruleLogWindow: RuleLogWindowCheckpoint | undefined;
  if (raw.ruleLogWindow !== undefined) {
    assertRuleLogWindowCheckpoint(raw.ruleLogWindow, configuration, key);
    ruleLogWindow = raw.ruleLogWindow;
  }
  const lastBatch = parseLastBatch(raw.lastBatch);
  if (committedBatchSequence === 0 && lastBatch !== undefined) {
    throw new Error('Capture state cannot have lastBatch before the first committed batch');
  }
  if (
    committedBatchSequence > 0 &&
    (lastBatch === undefined || lastBatch.sequence !== committedBatchSequence)
  ) {
    throw new Error('Capture state lastBatch does not match committedBatchSequence');
  }
  const lastAttemptAt = optionalIso(raw.lastAttemptAt, 'state.lastAttemptAt');
  const lastSuccessAt = optionalIso(raw.lastSuccessAt, 'state.lastSuccessAt');
  const lastFailure = parseLastFailure(raw.lastFailure);

  return {
    version: HABIT_LEARNING_CAPTURE_STATE_VERSION,
    studyRuleIds,
    keyId,
    maxCheckpointEntries: configuration.maxCheckpointEntries,
    journalSegmentBatchLimit: configuration.journalSegmentBatchLimit,
    maxCaptureBytes: configuration.maxCaptureBytes,
    pagination,
    committedBatchSequence,
    ...(ruleLogWindow !== undefined && { ruleLogWindow }),
    ...(lastBatch !== undefined && { lastBatch }),
    ...(lastAttemptAt !== undefined && { lastAttemptAt }),
    ...(lastSuccessAt !== undefined && { lastSuccessAt }),
    consecutiveFailures,
    ...(lastFailure !== undefined && { lastFailure }),
  };
}

function parseLastBatch(raw: unknown): HabitLearningCaptureState['lastBatch'] {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new TypeError('state.lastBatch must be an object');
  return {
    batchId: hexDigest(raw.batchId, 'state.lastBatch.batchId'),
    sequence: positiveSafeInteger(raw.sequence, 'state.lastBatch.sequence'),
    capturedAt: isoString(raw.capturedAt, 'state.lastBatch.capturedAt'),
    studyEntries: nonNegativeSafeInteger(raw.studyEntries, 'state.lastBatch.studyEntries'),
  };
}

function parseLastFailure(raw: unknown): HabitLearningCaptureFailureState | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new TypeError('state.lastFailure must be an object');
  if (raw.kind !== 'network' && raw.kind !== 'invalid-fetch-result' && raw.kind !== 'persistence') {
    throw new TypeError('state.lastFailure.kind is invalid');
  }
  if (typeof raw.code !== 'string' || !SAFE_CODE_PATTERN.test(raw.code)) {
    throw new TypeError('state.lastFailure.code is invalid');
  }
  const gapId =
    raw.gapId === undefined ? undefined : hexDigest(raw.gapId, 'state.lastFailure.gapId');
  return {
    kind: raw.kind,
    at: isoString(raw.at, 'state.lastFailure.at'),
    code: raw.code,
    ...(gapId !== undefined && { gapId }),
  };
}

function stateAfterBatch(
  state: HabitLearningCaptureState,
  batch: HabitLearningCaptureBatchRecord,
): HabitLearningCaptureState {
  return {
    ...state,
    pagination: {
      ...state.pagination,
      nextMaxBlocks: batch.scan.nextMaxBlocks,
    },
    committedBatchSequence: batch.sequence,
    ruleLogWindow: batch.nextCheckpoint,
    lastBatch: {
      batchId: batch.batchId,
      sequence: batch.sequence,
      capturedAt: batch.capturedAt,
      studyEntries: batch.entries.length,
    },
    lastAttemptAt: batch.capturedAt,
    lastSuccessAt: batch.capturedAt,
    consecutiveFailures: 0,
  };
}

function stateAfterFailure(
  state: HabitLearningCaptureState,
  occurredAt: string,
  kind: HabitLearningCaptureFailureKind,
  code: string,
  gapId: string | undefined,
): HabitLearningCaptureState {
  return {
    ...state,
    lastAttemptAt: occurredAt,
    consecutiveFailures: state.consecutiveFailures + 1,
    lastFailure: {
      kind,
      at: occurredAt,
      code,
      ...(gapId !== undefined && { gapId }),
    },
  };
}

function parseCaptureBatch(
  raw: unknown,
  configuration: CaptureConfiguration,
  keyId: string,
  key: Buffer,
): HabitLearningCaptureBatchRecord {
  if (!isRecord(raw)) throw new TypeError('Capture batch journal record must be an object');
  if (
    raw.recordType !== CAPTURE_BATCH_RECORD_TYPE ||
    raw.recordVersion !== HABIT_LEARNING_CAPTURE_RECORD_VERSION
  ) {
    throw new TypeError('Capture batch journal record has an unsupported version');
  }
  const batchId = hexDigest(raw.batchId, 'capture batchId');
  const payloadDigest = hexDigest(raw.payloadDigest, 'capture payloadDigest');
  if (raw.keyId !== keyId) throw new Error(`Capture batch ${batchId} uses a different HMAC key`);
  const studyRuleIds = stringArray(raw.studyRuleIds, 'capture studyRuleIds');
  if (!sameStrings(studyRuleIds, configuration.studyRuleIds)) {
    throw new Error(`Capture batch ${batchId} targets different study rules`);
  }
  const sequence = positiveSafeInteger(raw.sequence, 'capture sequence');
  const capturedAt = isoString(raw.capturedAt, 'capture capturedAt');
  const previousCheckpointDigest = hexDigest(
    raw.previousCheckpointDigest,
    'capture previousCheckpointDigest',
  );
  if (raw.phase !== 'initial-window' && raw.phase !== 'incremental') {
    throw new TypeError('capture phase is invalid');
  }
  if (!Array.isArray(raw.entries) || !raw.entries.every(isRuleLogEntryRecord)) {
    throw new TypeError(`Capture batch ${batchId} contains an invalid entry`);
  }
  const entries = raw.entries as RuleLogEntry[];
  for (const entry of entries) {
    if (!configuration.studyRuleIds.includes(entry.graphId)) {
      throw new Error(`Capture batch ${batchId} contains an entry outside the study`);
    }
  }
  const scan = parseBatchScan(raw.scan, configuration);
  const completenessReasons = parseCompletenessReasons(raw.completenessReasons);
  assertRuleLogWindowCheckpoint(raw.nextCheckpoint, configuration, key);
  const nextCheckpoint = raw.nextCheckpoint;

  const unsigned: HabitLearningCaptureBatchUnsigned = {
    keyId,
    sequence,
    capturedAt,
    studyRuleIds,
    previousCheckpointDigest,
    phase: raw.phase,
    entries,
    scan,
    completenessReasons,
    nextCheckpoint,
  };
  const expectedPayload = keyedDigest(key, BATCH_PAYLOAD_DOMAIN, unsigned);
  if (payloadDigest !== expectedPayload) {
    throw new Error(`Capture batch ${batchId} payload authentication failed`);
  }
  const expectedBatchId = keyedDigest(key, BATCH_ID_DOMAIN, {
    sequence,
    previousCheckpointDigest,
    payloadDigest,
  });
  if (batchId !== expectedBatchId) {
    throw new Error(`Capture batch ${batchId} identity authentication failed`);
  }
  if (!Array.isArray(raw.gaps))
    throw new TypeError(`Capture batch ${batchId} gaps must be an array`);
  const gaps = raw.gaps.map((gap) => parseGapRecord(gap, key));
  const expectedGaps = gapsForBatch(batchId, unsigned, key);
  if (canonicalJson(gaps) !== canonicalJson(expectedGaps)) {
    throw new Error(`Capture batch ${batchId} gap projection does not match its scan`);
  }
  return {
    recordType: CAPTURE_BATCH_RECORD_TYPE,
    recordVersion: HABIT_LEARNING_CAPTURE_RECORD_VERSION,
    batchId,
    payloadDigest,
    ...unsigned,
    gaps,
  };
}

function parseBatchScan(
  raw: unknown,
  configuration: CaptureConfiguration,
): HabitLearningCaptureBatchRecord['scan'] {
  if (!isRecord(raw)) throw new TypeError('capture scan must be an object');
  const stopReason = raw.stopReason;
  if (
    stopReason !== 'empty-block' &&
    stopReason !== 'duplicate-block' &&
    stopReason !== 'max-blocks'
  ) {
    throw new TypeError('capture scan stopReason is invalid');
  }
  const normalizedStopReason: RuleLogWindowScanStopReason = stopReason;
  const scan = {
    requestedMaxBlocks: positiveSafeInteger(
      raw.requestedMaxBlocks,
      'capture scan.requestedMaxBlocks',
    ),
    nextMaxBlocks: positiveSafeInteger(raw.nextMaxBlocks, 'capture scan.nextMaxBlocks'),
    attempts: positiveSafeInteger(raw.attempts, 'capture scan.attempts'),
    blocksRead: nonNegativeSafeInteger(raw.blocksRead, 'capture scan.blocksRead'),
    stopReason: normalizedStopReason,
    rawLines: nonNegativeSafeInteger(raw.rawLines, 'capture scan.rawLines'),
    retainedPrefixLines: nonNegativeSafeInteger(
      raw.retainedPrefixLines,
      'capture scan.retainedPrefixLines',
    ),
    overlappedLines: nonNegativeSafeInteger(raw.overlappedLines, 'capture scan.overlappedLines'),
    newLines: nonNegativeSafeInteger(raw.newLines, 'capture scan.newLines'),
    ignoredParsedLines: nonNegativeSafeInteger(
      raw.ignoredParsedLines,
      'capture scan.ignoredParsedLines',
    ),
    unparsedLines: nonNegativeSafeInteger(raw.unparsedLines, 'capture scan.unparsedLines'),
    overlapCandidates: nonNegativeSafeInteger(
      raw.overlapCandidates,
      'capture scan.overlapCandidates',
    ),
  };
  if (
    scan.requestedMaxBlocks < configuration.initialMaxBlocks ||
    scan.requestedMaxBlocks > configuration.maxBlocksCeiling ||
    scan.nextMaxBlocks < configuration.initialMaxBlocks ||
    scan.nextMaxBlocks > configuration.maxBlocksCeiling
  ) {
    throw new RangeError('capture scan pagination is outside configured bounds');
  }
  return scan;
}

function parseCompletenessReasons(raw: unknown): RuleLogWindowCompletenessReason[] {
  if (!Array.isArray(raw)) throw new TypeError('capture completenessReasons must be an array');
  const allowed = new Set<RuleLogWindowCompletenessReason>([
    'scan-overlap-lost',
    'scan-hit-max-blocks',
    'identical-line-overlap-ambiguous',
    'unparsed-log-lines',
  ]);
  const reasons: RuleLogWindowCompletenessReason[] = [];
  for (const reason of raw) {
    if (typeof reason !== 'string' || !allowed.has(reason as RuleLogWindowCompletenessReason)) {
      throw new TypeError(`capture completeness reason is invalid: ${String(reason)}`);
    }
    reasons.push(reason as RuleLogWindowCompletenessReason);
  }
  if (new Set(reasons).size !== reasons.length) {
    throw new TypeError('capture completenessReasons contains duplicates');
  }
  return reasons;
}

function validateJournalSequence(
  batches: HabitLearningCaptureBatchRecord[],
  state: HabitLearningCaptureState,
  archives: JournalArchiveInspection,
): void {
  const ordered = [...batches];
  const ids = new Set<string>();
  let previousCheckpointDigest = checkpointDigest(archives.lastArchivedBatch?.nextCheckpoint);
  ordered.forEach((batch, index) => {
    if (ids.has(batch.batchId)) throw new Error(`Duplicate capture batch id: ${batch.batchId}`);
    ids.add(batch.batchId);
    if (batch.sequence !== archives.archivedThroughSequence + index + 1) {
      throw new Error(`Capture journal sequence is not contiguous at ${batch.sequence}`);
    }
    if (batch.previousCheckpointDigest !== previousCheckpointDigest) {
      throw new Error(`Capture journal checkpoint chain is broken at ${batch.sequence}`);
    }
    previousCheckpointDigest = checkpointDigest(batch.nextCheckpoint);
  });
  if (state.committedBatchSequence < archives.archivedThroughSequence) {
    throw new Error('Capture state predates an immutable journal archive');
  }
  const activeCommittedCount = state.committedBatchSequence - archives.archivedThroughSequence;
  if (activeCommittedCount > ordered.length) {
    throw new Error('Capture journal is missing a batch referenced by durable state');
  }
  if (ordered.length > activeCommittedCount + 1) {
    throw new Error('Capture journal contains more than one uncommitted batch');
  }
  if (activeCommittedCount > 0) {
    const committed = ordered[activeCommittedCount - 1];
    if (committed === undefined || committed.batchId !== state.lastBatch?.batchId) {
      throw new Error('Capture journal does not match the last committed batch');
    }
    if (checkpointDigest(committed.nextCheckpoint) !== checkpointDigest(state.ruleLogWindow)) {
      throw new Error('Capture state checkpoint does not match the last committed batch');
    }
  } else if (
    state.committedBatchSequence > 0 &&
    archives.lastArchivedBatch?.batchId !== state.lastBatch?.batchId
  ) {
    throw new Error('Capture archive does not match the last committed batch');
  } else if (
    state.committedBatchSequence > 0 &&
    checkpointDigest(archives.lastArchivedBatch?.nextCheckpoint) !==
      checkpointDigest(state.ruleLogWindow)
  ) {
    throw new Error('Capture state checkpoint does not match the last archived batch');
  } else if (state.committedBatchSequence === 0 && state.ruleLogWindow !== undefined) {
    throw new Error('Capture state cannot have a checkpoint before the first committed batch');
  }
  batches.splice(0, batches.length, ...ordered);
}

function pendingBatch(data: LoadedCaptureData): HabitLearningCaptureBatchRecord | undefined {
  const activeCommittedCount = data.state.committedBatchSequence - data.archivedThroughSequence;
  return data.batches[activeCommittedCount];
}

async function inspectJournalArchives(
  studyPath: string,
  configuration: CaptureConfiguration,
  keyId: string,
  key: Buffer,
  validation: 'all' | 'latest' = 'all',
): Promise<JournalArchiveInspection> {
  const names = await fs.readdir(studyPath);
  const segments: JournalArchiveSegment[] = [];
  for (const name of names) {
    const match = JOURNAL_ARCHIVE_PATTERN.exec(name);
    if (match === null) continue;
    const startSequence = positiveSafeInteger(
      Number(match[1]),
      `journal archive ${name} start sequence`,
    );
    const endSequence = positiveSafeInteger(
      Number(match[2]),
      `journal archive ${name} end sequence`,
    );
    if (endSequence < startSequence) {
      throw new Error(`Habit-learning journal archive has an inverted range: ${name}`);
    }
    if (endSequence - startSequence + 1 > configuration.journalSegmentBatchLimit) {
      throw new Error(`Habit-learning journal archive exceeds the segment limit: ${name}`);
    }
    const path = join(studyPath, name);
    await assertPrivateRegularFile(path, 'habit-learning journal archive');
    segments.push({ path, startSequence, endSequence });
  }
  segments.sort((left, right) => left.startSequence - right.startSequence);
  let expectedStart = 1;
  for (const segment of segments) {
    if (segment.startSequence !== expectedStart) {
      throw new Error(
        `Habit-learning journal archive sequence is not contiguous at ${segment.startSequence}`,
      );
    }
    expectedStart = segment.endSequence + 1;
  }
  const lastSegment = segments.at(-1);
  if (lastSegment === undefined) {
    return {
      archivedThroughSequence: 0,
      segments,
    };
  }
  if (validation === 'all') {
    let previousCheckpointDigest = checkpointDigest(undefined);
    let expectedSequence = 1;
    let lastArchivedBatch: HabitLearningCaptureBatchRecord | undefined;
    for (const segment of segments) {
      const records = await readAndValidateArchiveSegment(segment, configuration, keyId, key);
      for (const record of records) {
        if (
          record.sequence !== expectedSequence ||
          record.previousCheckpointDigest !== previousCheckpointDigest
        ) {
          throw new Error(`Habit-learning archive chain is broken at batch ${record.sequence}`);
        }
        previousCheckpointDigest = checkpointDigest(record.nextCheckpoint);
        expectedSequence += 1;
        lastArchivedBatch = record;
      }
    }
    if (lastArchivedBatch === undefined) {
      throw new Error(`Habit-learning journal archive is unexpectedly empty: ${lastSegment.path}`);
    }
    return {
      archivedThroughSequence: lastSegment.endSequence,
      segments,
      lastArchivedBatch,
    };
  }
  const lastRecords = await readAndValidateArchiveSegment(lastSegment, configuration, keyId, key);
  const lastArchivedBatch = lastRecords.at(-1);
  if (lastArchivedBatch === undefined) {
    throw new Error(`Habit-learning journal archive is unexpectedly empty: ${lastSegment.path}`);
  }
  return {
    archivedThroughSequence: lastSegment.endSequence,
    segments,
    lastArchivedBatch,
  };
}

async function readAndValidateArchiveSegment(
  segment: JournalArchiveSegment,
  configuration: CaptureConfiguration,
  keyId: string,
  key: Buffer,
): Promise<HabitLearningCaptureBatchRecord[]> {
  const records = await readCaptureBatchFile(segment.path, configuration, keyId, key);
  const expectedCount = segment.endSequence - segment.startSequence + 1;
  if (
    records.length !== expectedCount ||
    records[0]?.sequence !== segment.startSequence ||
    records.at(-1)?.sequence !== segment.endSequence
  ) {
    throw new Error(
      `Habit-learning journal archive content does not match its range: ${segment.path}`,
    );
  }
  records.forEach((record, index) => {
    const previous = records[index - 1];
    if (
      record.sequence !== segment.startSequence + index ||
      (previous !== undefined &&
        record.previousCheckpointDigest !== checkpointDigest(previous.nextCheckpoint))
    ) {
      throw new Error(`Habit-learning journal archive content is not contiguous: ${segment.path}`);
    }
  });
  return records;
}

async function readCaptureBatchFile(
  path: string,
  configuration: CaptureConfiguration,
  keyId: string,
  key: Buffer,
): Promise<HabitLearningCaptureBatchRecord[]> {
  const raw = await readPrivateRegularFileIfPresent(path, 'habit-learning journal archive');
  if (raw === undefined || raw.length === 0) {
    throw new Error(`Habit-learning journal archive is empty or partial: ${path}`);
  }
  return parseCaptureBatchNdjson(raw, path, configuration, keyId, key);
}

function parseCaptureBatchNdjson(
  raw: string,
  label: string,
  configuration: CaptureConfiguration,
  keyId: string,
  key: Buffer,
): HabitLearningCaptureBatchRecord[] {
  if (raw.length === 0) return [];
  if (!raw.endsWith('\n')) {
    throw new Error(`Habit-learning capture journal is partial: ${label}`);
  }
  return raw
    .slice(0, -1)
    .split('\n')
    .map((line, index) => {
      if (line.length === 0) {
        throw new Error(`Invalid empty capture record at line ${index + 1}: ${label}`);
      }
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid capture JSON at line ${index + 1}: ${label}`, {
          cause: error,
        });
      }
      if (!isCaptureBatchCandidate(value)) {
        throw new Error(`Capture journal contains a non-capture record at line ${index + 1}`);
      }
      return parseCaptureBatch(value, configuration, keyId, key);
    });
}

function journalArchivePath(studyPath: string, startSequence: number, endSequence: number): string {
  return join(studyPath, `journal.capture.${startSequence}-${endSequence}.ndjson`);
}

function validateFetchResult(
  raw: HabitLearningCaptureFetchResult,
  requestedMaxBlocks: number,
): HabitLearningCaptureFetchResult {
  if (!isRecord(raw)) throw new TypeError('fetch result must be an object');
  if (!Array.isArray(raw.rawLines)) throw new TypeError('fetch rawLines must be an array');
  const rawLines = raw.rawLines.map((line, index) => {
    if (typeof line !== 'string' || line.length === 0 || /[\r\n]/.test(line)) {
      throw new TypeError(`fetch rawLines[${index}] is not one complete non-empty log line`);
    }
    return line;
  });
  const blocksRead = nonNegativeSafeInteger(raw.blocksRead, 'fetch blocksRead');
  if (blocksRead > requestedMaxBlocks) {
    throw new RangeError('fetch blocksRead exceeds the requested maxBlocks');
  }
  if (
    raw.stopReason !== 'empty-block' &&
    raw.stopReason !== 'duplicate-block' &&
    raw.stopReason !== 'max-blocks'
  ) {
    throw new TypeError('fetch stopReason is invalid');
  }
  if (raw.stopReason === 'max-blocks' && blocksRead !== requestedMaxBlocks) {
    throw new Error('fetch max-blocks result must consume the requested pagination bound');
  }
  return {
    rawLines,
    blocksRead,
    stopReason: raw.stopReason,
  };
}

function nextPaginationBound(
  current: number,
  fetched: HabitLearningCaptureFetchResult,
  pagination: HabitLearningCapturePaginationState,
): number {
  if (fetched.stopReason === 'max-blocks') {
    // prepareAdaptiveScan already expanded this same poll until it found a
    // unique overlap or reached the configured ceiling.
    return current;
  }
  if (current > pagination.initialMaxBlocks && fetched.blocksRead <= Math.floor(current / 4)) {
    return Math.max(pagination.initialMaxBlocks, Math.ceil(current / 2));
  }
  return current;
}

function gapsForBatch(
  batchId: string,
  batch: HabitLearningCaptureBatchUnsigned,
  key: Buffer,
): HabitLearningCaptureGapRecord[] {
  const gaps: HabitLearningCaptureGapRecord[] = [];
  for (const reason of batch.completenessReasons) {
    const kind = reason === 'scan-hit-max-blocks' ? 'pagination-ceiling' : reason;
    const detail: Record<string, string | number | boolean> = {
      reason,
      requestedMaxBlocks: batch.scan.requestedMaxBlocks,
      blocksRead: batch.scan.blocksRead,
      newLines: batch.scan.newLines,
    };
    if (reason === 'identical-line-overlap-ambiguous') {
      detail.candidateCount = batch.scan.overlapCandidates;
    }
    if (reason === 'unparsed-log-lines') {
      detail.unparsedLines = batch.scan.unparsedLines;
    }
    gaps.push(
      createGapRecord(key, {
        occurredAt: batch.capturedAt,
        kind,
        batchId,
        sequence: batch.sequence,
        detail,
      }),
    );
  }
  return gaps;
}

function createGapRecord(
  key: Buffer,
  unsigned: Omit<HabitLearningCaptureGapRecord, 'recordType' | 'recordVersion' | 'gapId'>,
): HabitLearningCaptureGapRecord {
  return {
    recordType: CAPTURE_GAP_RECORD_TYPE,
    recordVersion: HABIT_LEARNING_CAPTURE_RECORD_VERSION,
    gapId: keyedDigest(key, GAP_ID_DOMAIN, unsigned),
    ...unsigned,
  };
}

async function readGapLedger(path: string, key: Buffer): Promise<HabitLearningCaptureGapRecord[]> {
  const raw = await readPrivateRegularFileIfPresent(path, 'habit-learning gap ledger');
  if (raw === undefined || raw.length === 0) return [];
  return parseGapLedgerNdjson(raw, path, key);
}

function parseGapLedgerNdjson(
  raw: string,
  label: string,
  key: Buffer,
): HabitLearningCaptureGapRecord[] {
  if (raw.length === 0) return [];
  if (!raw.endsWith('\n')) {
    throw new Error(`Habit-learning gap ledger has a partial final record: ${label}`);
  }
  const records: HabitLearningCaptureGapRecord[] = [];
  const ids = new Set<string>();
  const lines = raw.slice(0, -1).split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.length === 0) {
      throw new Error(`Invalid empty habit-learning gap record at line ${index + 1}: ${label}`);
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid habit-learning gap JSON at line ${index + 1}: ${label}`, {
        cause: error,
      });
    }
    const gap = parseGapRecord(value, key);
    if (ids.has(gap.gapId)) {
      throw new Error(`Duplicate habit-learning gap id: ${gap.gapId}`);
    }
    ids.add(gap.gapId);
    records.push(gap);
  }
  return records;
}

async function planCaptureJournalTailRepair(
  path: string,
  configuration: CaptureConfiguration,
  keyId: string,
  key: Buffer,
  state: HabitLearningCaptureState,
  archives: JournalArchiveInspection,
): Promise<TailRepairPlan<HabitLearningCaptureBatchRecord>> {
  const raw = await readPrivateRegularBufferIfPresent(path, 'habit-learning journal');
  if (raw === undefined || raw.byteLength === 0) {
    const records: HabitLearningCaptureBatchRecord[] = [];
    validateJournalSequence(records, state, archives);
    return createTailRepairPlan('unchanged', 0, records, raw ?? Buffer.alloc(0));
  }
  if (raw.at(-1) === 0x0a) {
    const records = parseCaptureBatchNdjson(raw.toString('utf8'), path, configuration, keyId, key);
    validateJournalSequence(records, state, archives);
    return createTailRepairPlan('unchanged', 0, records, raw);
  }

  const lastNewline = raw.lastIndexOf(0x0a);
  const prefixEnd = lastNewline + 1;
  const prefix = raw.subarray(0, prefixEnd).toString('utf8');
  const suffix = raw.subarray(prefixEnd);
  const prefixRecords = parseCaptureBatchNdjson(prefix, path, configuration, keyId, key);

  let candidate: HabitLearningCaptureBatchRecord;
  try {
    const value = JSON.parse(suffix.toString('utf8')) as unknown;
    if (!isCaptureBatchCandidate(value)) throw new TypeError('Partial suffix is not a batch');
    candidate = parseCaptureBatch(value, configuration, keyId, key);
  } catch {
    // An invalid suffix is safe to remove only if all batches named by the
    // durable state remain present before it.
    validateJournalSequence(prefixRecords, state, archives);
    return createTailRepairPlan('truncated-partial-record', suffix.byteLength, prefixRecords, raw);
  }
  // Once the suffix authenticates, an inconsistent sequence or checkpoint is
  // evidence tampering/semantic corruption rather than an interrupted write.
  // Never turn that into an implicit destructive truncate.
  const records = [...prefixRecords, candidate];
  validateJournalSequence(records, state, archives);
  return createTailRepairPlan('terminated-valid-record', 0, records, raw);
}

async function planGapLedgerTailRepair(
  path: string,
  key: Buffer,
): Promise<TailRepairPlan<HabitLearningCaptureGapRecord>> {
  const raw = await readPrivateRegularBufferIfPresent(path, 'habit-learning gap ledger');
  if (raw === undefined || raw.byteLength === 0) {
    return createTailRepairPlan('unchanged', 0, [], raw ?? Buffer.alloc(0));
  }
  if (raw.at(-1) === 0x0a) {
    return createTailRepairPlan(
      'unchanged',
      0,
      parseGapLedgerNdjson(raw.toString('utf8'), path, key),
      raw,
    );
  }

  const lastNewline = raw.lastIndexOf(0x0a);
  const prefixEnd = lastNewline + 1;
  const prefix = raw.subarray(0, prefixEnd).toString('utf8');
  const suffix = raw.subarray(prefixEnd);
  const prefixRecords = parseGapLedgerNdjson(prefix, path, key);
  let candidate: HabitLearningCaptureGapRecord;
  try {
    candidate = parseGapRecord(JSON.parse(suffix.toString('utf8')) as unknown, key);
  } catch {
    assertUniqueGapIds(prefixRecords);
    return createTailRepairPlan('truncated-partial-record', suffix.byteLength, prefixRecords, raw);
  }
  const records = [...prefixRecords, candidate];
  assertUniqueGapIds(records);
  return createTailRepairPlan('terminated-valid-record', 0, records, raw);
}

async function applyDurableTailRepairPlan(
  path: string,
  label: string,
  plan: DurableTailRepairPlan,
): Promise<void> {
  const current = (await readPrivateRegularBufferIfPresent(path, label)) ?? Buffer.alloc(0);
  if (matchesTailFile(current, plan.targetBytes, plan.targetDigest)) return;
  if (!matchesTailFile(current, plan.sourceBytes, plan.sourceDigest)) {
    throw new Error(`${label} changed while planning partial-tail recovery`);
  }
  if (plan.action === 'unchanged') return;
  if (plan.action === 'terminated-valid-record') {
    await appendPrivateFile(path, '\n', label);
  } else {
    await truncatePrivateFile(path, plan.targetBytes, label);
  }
  const repaired = (await readPrivateRegularBufferIfPresent(path, label)) ?? Buffer.alloc(0);
  if (!matchesTailFile(repaired, plan.targetBytes, plan.targetDigest)) {
    throw new Error(`${label} tail recovery was not durable`);
  }
}

async function applyGapTailRepairWithRecovery(
  path: string,
  plan: DurableTailRepairPlan,
  recoveryGaps: readonly HabitLearningCaptureGapRecord[],
  key: Buffer,
): Promise<void> {
  const label = 'habit-learning gap ledger';
  const current = (await readPrivateRegularBufferIfPresent(path, label)) ?? Buffer.alloc(0);
  const currentMatchesSource = matchesTailFile(current, plan.sourceBytes, plan.sourceDigest);
  const hasTargetPrefix =
    current.byteLength >= plan.targetBytes &&
    matchesTailFile(current.subarray(0, plan.targetBytes), plan.targetBytes, plan.targetDigest);
  if (currentMatchesSource || !hasTargetPrefix) {
    await applyDurableTailRepairPlan(path, label, plan);
  }

  const afterPlan = (await readPrivateRegularBufferIfPresent(path, label)) ?? Buffer.alloc(0);
  if (
    afterPlan.byteLength < plan.targetBytes ||
    !matchesTailFile(afterPlan.subarray(0, plan.targetBytes), plan.targetBytes, plan.targetDigest)
  ) {
    throw new Error(`${label} does not contain the intended recovered prefix`);
  }
  const base = afterPlan.subarray(0, plan.targetBytes);
  const baseGaps =
    base.byteLength === 0 ? [] : parseGapLedgerNdjson(base.toString('utf8'), path, key);
  const baseIds = new Set(baseGaps.map((gap) => gap.gapId));
  const missing = recoveryGaps.filter((gap) => !baseIds.has(gap.gapId));
  const expectedSuffix = Buffer.from(
    missing.map((gap) => `${JSON.stringify(gap)}\n`).join(''),
    'utf8',
  );
  const actualSuffix = afterPlan.subarray(plan.targetBytes);
  if (
    actualSuffix.byteLength > expectedSuffix.byteLength ||
    !expectedSuffix.subarray(0, actualSuffix.byteLength).equals(actualSuffix)
  ) {
    throw new Error(`${label} contains unexpected bytes after the intended recovered prefix`);
  }
  if (actualSuffix.byteLength < expectedSuffix.byteLength) {
    await appendPrivateFile(path, expectedSuffix.subarray(actualSuffix.byteLength), label);
  }
  const completed = await readGapLedger(path, key);
  if (
    !recoveryGaps.every((recoveryGap) => completed.some((gap) => gap.gapId === recoveryGap.gapId))
  ) {
    throw new Error('Habit-learning tail recovery gaps were not durably completed');
  }
}

function createTailRepairPlan<RecordType>(
  action: TailRepairPlan<RecordType>['action'],
  bytesRemoved: number,
  records: RecordType[],
  source: Buffer,
): TailRepairPlan<RecordType> {
  const target =
    action === 'terminated-valid-record'
      ? Buffer.concat([source, Buffer.from('\n')])
      : action === 'truncated-partial-record'
        ? source.subarray(0, source.byteLength - bytesRemoved)
        : source;
  return {
    action,
    bytesRemoved,
    records,
    sourceBytes: source.byteLength,
    sourceDigest: createHash('sha256').update(source).digest('hex'),
    targetBytes: target.byteLength,
    targetDigest: createHash('sha256').update(target).digest('hex'),
  };
}

function durableTailRepairPlan(plan: TailRepairPlan<unknown>): DurableTailRepairPlan {
  return {
    action: plan.action,
    bytesRemoved: plan.bytesRemoved,
    sourceBytes: plan.sourceBytes,
    sourceDigest: plan.sourceDigest,
    targetBytes: plan.targetBytes,
    targetDigest: plan.targetDigest,
  };
}

function matchesTailFile(raw: Buffer, expectedBytes: number, expectedDigest: string): boolean {
  return (
    raw.byteLength === expectedBytes &&
    createHash('sha256').update(raw).digest('hex') === expectedDigest
  );
}

type HabitLearningCaptureTailRecoveryIntentUnsigned = Omit<
  HabitLearningCaptureTailRecoveryIntent,
  'recordType' | 'recordVersion' | 'intentId'
>;

function createTailRecoveryIntent(
  key: Buffer,
  unsigned: HabitLearningCaptureTailRecoveryIntentUnsigned,
): HabitLearningCaptureTailRecoveryIntent {
  return {
    recordType: TAIL_RECOVERY_INTENT_RECORD_TYPE,
    recordVersion: HABIT_LEARNING_CAPTURE_RECORD_VERSION,
    intentId: keyedDigest(key, TAIL_RECOVERY_INTENT_DOMAIN, unsigned),
    ...unsigned,
  };
}

async function readTailRecoveryIntentIfPresent(
  path: string,
  keyId: string,
  key: Buffer,
): Promise<HabitLearningCaptureTailRecoveryIntent | undefined> {
  const raw = await readPrivateRegularFileIfPresent(path, 'habit-learning tail recovery intent');
  if (raw === undefined) return undefined;
  if (!raw.endsWith('\n') || raw.indexOf('\n') !== raw.length - 1) {
    throw new Error('Habit-learning tail recovery intent is malformed or partial');
  }
  let value: unknown;
  try {
    value = JSON.parse(raw.slice(0, -1)) as unknown;
  } catch (error) {
    throw new Error('Habit-learning tail recovery intent contains invalid JSON', {
      cause: error,
    });
  }
  if (!isRecord(value)) {
    throw new TypeError('Habit-learning tail recovery intent must be an object');
  }
  if (
    value.recordType !== TAIL_RECOVERY_INTENT_RECORD_TYPE ||
    value.recordVersion !== HABIT_LEARNING_CAPTURE_RECORD_VERSION
  ) {
    throw new TypeError('Habit-learning tail recovery intent has an unsupported version');
  }
  if (value.keyId !== keyId) {
    throw new Error('Habit-learning tail recovery intent uses a different HMAC key');
  }
  const intentId = hexDigest(value.intentId, 'tail recovery intentId');
  const journal = parseDurableTailRepairPlan(value.journal, 'tail recovery journal plan');
  const gaps = parseDurableTailRepairPlan(value.gaps, 'tail recovery gap plan');
  if (!Array.isArray(value.recoveryGaps)) {
    throw new TypeError('tail recovery recoveryGaps must be an array');
  }
  const recoveryGaps = value.recoveryGaps.map((gap) => parseGapRecord(gap, key));
  assertUniqueGapIds(recoveryGaps);
  const committedBatchSequence = nonNegativeSafeInteger(
    value.committedBatchSequence,
    'tail recovery committedBatchSequence',
  );
  for (const gap of recoveryGaps) {
    if (
      gap.sequence !== committedBatchSequence + 1 ||
      (gap.kind !== 'journal-recovered-truncated-tail' &&
        gap.kind !== 'gap-ledger-recovered-truncated-tail')
    ) {
      throw new Error(`Tail recovery intent contains an unrelated gap: ${gap.gapId}`);
    }
  }
  const unsigned: HabitLearningCaptureTailRecoveryIntentUnsigned = {
    keyId,
    createdAt: isoString(value.createdAt, 'tail recovery createdAt'),
    committedBatchSequence,
    journal,
    gaps,
    recoveryGaps,
  };
  if (intentId !== keyedDigest(key, TAIL_RECOVERY_INTENT_DOMAIN, unsigned)) {
    throw new Error('Habit-learning tail recovery intent authentication failed');
  }
  return {
    recordType: TAIL_RECOVERY_INTENT_RECORD_TYPE,
    recordVersion: HABIT_LEARNING_CAPTURE_RECORD_VERSION,
    intentId,
    ...unsigned,
  };
}

function parseDurableTailRepairPlan(raw: unknown, label: string): DurableTailRepairPlan {
  if (!isRecord(raw)) throw new TypeError(`${label} must be an object`);
  if (
    raw.action !== 'unchanged' &&
    raw.action !== 'terminated-valid-record' &&
    raw.action !== 'truncated-partial-record'
  ) {
    throw new TypeError(`${label}.action is invalid`);
  }
  const bytesRemoved = nonNegativeSafeInteger(raw.bytesRemoved, `${label}.bytesRemoved`);
  const sourceBytes = nonNegativeSafeInteger(raw.sourceBytes, `${label}.sourceBytes`);
  const targetBytes = nonNegativeSafeInteger(raw.targetBytes, `${label}.targetBytes`);
  const sourceDigest = hexDigest(raw.sourceDigest, `${label}.sourceDigest`);
  const targetDigest = hexDigest(raw.targetDigest, `${label}.targetDigest`);
  if (
    (raw.action === 'unchanged' &&
      (bytesRemoved !== 0 || targetBytes !== sourceBytes || targetDigest !== sourceDigest)) ||
    (raw.action === 'terminated-valid-record' &&
      (bytesRemoved !== 0 || targetBytes !== sourceBytes + 1)) ||
    (raw.action === 'truncated-partial-record' &&
      (bytesRemoved === 0 || targetBytes !== sourceBytes - bytesRemoved))
  ) {
    throw new Error(`${label} size transition is invalid`);
  }
  return {
    action: raw.action,
    bytesRemoved,
    sourceBytes,
    sourceDigest,
    targetBytes,
    targetDigest,
  };
}

async function writeTailRecoveryIntent(
  path: string,
  temporaryPath: string,
  studyPath: string,
  intent: HabitLearningCaptureTailRecoveryIntent,
): Promise<void> {
  await assertPathMissing(path, 'habit-learning tail recovery intent');
  await assertPathMissing(temporaryPath, 'habit-learning tail recovery intent temporary file');
  try {
    await writeExclusivePrivateFile(
      temporaryPath,
      `${JSON.stringify(intent)}\n`,
      'habit-learning tail recovery intent temporary file',
    );
    await assertPathMissing(path, 'habit-learning tail recovery intent');
    await fs.rename(temporaryPath, path);
    await syncDirectory(studyPath);
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

function assertUniqueGapIds(records: readonly HabitLearningCaptureGapRecord[]): void {
  const ids = new Set<string>();
  for (const gap of records) {
    if (ids.has(gap.gapId)) throw new Error(`Duplicate habit-learning gap id: ${gap.gapId}`);
    ids.add(gap.gapId);
  }
}

function parseGapRecord(raw: unknown, key: Buffer): HabitLearningCaptureGapRecord {
  if (!isRecord(raw)) throw new TypeError('Habit-learning gap record must be an object');
  if (
    raw.recordType !== CAPTURE_GAP_RECORD_TYPE ||
    raw.recordVersion !== HABIT_LEARNING_CAPTURE_RECORD_VERSION
  ) {
    throw new TypeError('Habit-learning gap record has an unsupported version');
  }
  const gapId = hexDigest(raw.gapId, 'gapId');
  const kind = raw.kind;
  if (
    kind !== 'scan-overlap-lost' &&
    kind !== 'identical-line-overlap-ambiguous' &&
    kind !== 'pagination-ceiling' &&
    kind !== 'unparsed-log-lines' &&
    kind !== 'network-error' &&
    kind !== 'invalid-fetch-result' &&
    kind !== 'disk-error' &&
    kind !== 'journal-recovered-truncated-tail' &&
    kind !== 'gap-ledger-recovered-truncated-tail' &&
    kind !== 'disk-budget-exhausted'
  ) {
    throw new TypeError('Habit-learning gap kind is invalid');
  }
  if (!isRecord(raw.detail)) throw new TypeError(`Habit-learning gap ${gapId} detail is invalid`);
  const detail: Record<string, string | number | boolean> = {};
  for (const [name, value] of Object.entries(raw.detail)) {
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new TypeError(`Habit-learning gap ${gapId} detail.${name} is invalid`);
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new TypeError(`Habit-learning gap ${gapId} detail.${name} is not finite`);
    }
    detail[name] = value;
  }
  const batchId = raw.batchId === undefined ? undefined : hexDigest(raw.batchId, 'gap batchId');
  const normalizedKind: HabitLearningCaptureGapKind = kind;
  const unsigned = {
    occurredAt: isoString(raw.occurredAt, 'gap occurredAt'),
    kind: normalizedKind,
    ...(batchId !== undefined && { batchId }),
    sequence: positiveSafeInteger(raw.sequence, 'gap sequence'),
    detail,
  };
  const expected = keyedDigest(key, GAP_ID_DOMAIN, unsigned);
  if (gapId !== expected) throw new Error(`Habit-learning gap ${gapId} authentication failed`);
  return {
    recordType: CAPTURE_GAP_RECORD_TYPE,
    recordVersion: HABIT_LEARNING_CAPTURE_RECORD_VERSION,
    gapId,
    ...unsigned,
  };
}

async function appendMissingGaps(
  path: string,
  candidates: readonly HabitLearningCaptureGapRecord[],
  existing: readonly HabitLearningCaptureGapRecord[],
): Promise<HabitLearningCaptureGapRecord[]> {
  const existingIds = new Set(existing.map((gap) => gap.gapId));
  const missing = candidates.filter((gap) => !existingIds.has(gap.gapId));
  if (missing.length === 0) return [...existing];
  const serialized = missing.map((gap) => `${JSON.stringify(gap)}\n`).join('');
  await appendPrivateFile(path, serialized, 'habit-learning gap ledger');
  return [...existing, ...missing];
}

async function bestEffortAppendDiskGap(input: {
  path: string;
  existingGaps: readonly HabitLearningCaptureGapRecord[];
  key: Buffer;
  occurredAt: string;
  sequence: number;
  batchId?: string;
  code: string;
  phase: string;
}): Promise<{
  persisted: boolean;
  gap?: HabitLearningCaptureGapRecord;
}> {
  const gap =
    [...input.existingGaps]
      .reverse()
      .find(
        (candidate) =>
          candidate.kind === 'disk-error' &&
          candidate.sequence === input.sequence &&
          candidate.detail.phase === input.phase,
      ) ??
    createGapRecord(input.key, {
      occurredAt: input.occurredAt,
      kind: 'disk-error',
      ...(input.batchId !== undefined && { batchId: input.batchId }),
      sequence: input.sequence,
      detail: {
        code: input.code,
        phase: input.phase,
      },
    });
  if (input.existingGaps.some((candidate) => candidate.gapId === gap.gapId)) {
    return { persisted: true, gap };
  }
  try {
    await appendMissingGaps(input.path, [gap], input.existingGaps);
    return { persisted: true, gap };
  } catch {
    return { persisted: false };
  }
}

async function loadCaptureKey(
  path: string,
  studyPath: string,
  allowCreate: boolean,
): Promise<Buffer | undefined> {
  let existing = await readPrivateRegularFileIfPresent(path, 'habit-learning capture key');
  if (existing === undefined && allowCreate) {
    const encoded = `${randomBytes(KEY_BYTES).toString('base64')}\n`;
    try {
      await writeExclusivePrivateFile(path, encoded, 'habit-learning capture key');
      await syncDirectory(studyPath);
    } catch (error) {
      if (!hasErrorCode(error, 'EEXIST')) throw error;
    }
    existing = await readPrivateRegularFileIfPresent(path, 'habit-learning capture key');
  }
  if (existing === undefined) {
    if (allowCreate) throw new Error('Habit-learning capture key creation was not confirmed');
    return undefined;
  }
  if (!existing.endsWith('\n') || existing.indexOf('\n') !== existing.length - 1) {
    throw new Error('Habit-learning capture key file is malformed or partial');
  }
  const encoded = existing.slice(0, -1);
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.byteLength !== KEY_BYTES || decoded.toString('base64') !== encoded) {
    throw new Error('Habit-learning capture key file is not canonical 256-bit base64');
  }
  return decoded;
}

function captureKeyId(key: Buffer): string {
  return createHash('sha256').update(KEY_ID_DOMAIN).update(key).digest('hex');
}

function checkpointDigest(checkpoint: RuleLogWindowCheckpoint | undefined): string {
  return createHash('sha256')
    .update(CHECKPOINT_DIGEST_DOMAIN)
    .update(canonicalJson(checkpoint ?? null))
    .digest('hex');
}

function keyedDigest(key: Buffer, domain: string, value: unknown): string {
  return createHmac('sha256', key).update(domain).update(canonicalJson(value)).digest('hex');
}

function assertRuleLogWindowCheckpoint(
  checkpoint: unknown,
  configuration: CaptureConfiguration,
  key: Buffer,
): asserts checkpoint is RuleLogWindowCheckpoint {
  // advanceRuleLogWindow owns the checkpoint schema. Supplying it as previous
  // validates every count and fingerprint without duplicating that contract.
  advanceRuleLogWindow({
    currentRawLines: [],
    studyRuleIds: new Set(configuration.studyRuleIds),
    hmacKey: key,
    maxCheckpointEntries: configuration.maxCheckpointEntries,
    previous: checkpoint as RuleLogWindowCheckpoint,
    scanStopReason: 'empty-block',
  });
}

async function assertTerminatedNdjsonIfPresent(path: string, label: string): Promise<void> {
  const raw = await readPrivateRegularFileIfPresent(path, label);
  if (raw !== undefined && raw.length > 0 && !raw.endsWith('\n')) {
    throw new Error(`${label} has a partial final record: ${path}`);
  }
}

async function hasNonEmptyRegularFile(path: string, label: string): Promise<boolean> {
  const raw = await readPrivateRegularFileIfPresent(path, label);
  return raw !== undefined && raw.length > 0;
}

async function hasPrivateRegularFile(path: string, label: string): Promise<boolean> {
  return (await readPrivateRegularBufferIfPresent(path, label)) !== undefined;
}

async function hasCaptureJournalArchives(studyPath: string): Promise<boolean> {
  return (await fs.readdir(studyPath)).some((name) => JOURNAL_ARCHIVE_PATTERN.test(name));
}

async function assertPrivateRegularFile(path: string, label: string): Promise<void> {
  const stat = await fs.lstat(path);
  if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic-link ${label}: ${path}`);
  if (!stat.isFile()) throw new Error(`${label} is not a regular file: ${path}`);
  assertOwnedSingleLink(stat, path, label);
  await fs.chmod(path, 0o600);
}

async function assertPathMissing(path: string, label: string): Promise<void> {
  try {
    await fs.lstat(path);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return;
    throw error;
  }
  throw new Error(`Refusing to replace existing ${label}: ${path}`);
}

async function removePrivateFileIfPresent(
  path: string,
  label: string,
  parentPath: string,
): Promise<void> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(path);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return;
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic-link ${label}: ${path}`);
  if (!stat.isFile()) throw new Error(`${label} is not a regular file: ${path}`);
  assertOwnedSingleLink(stat, path, label);
  await fs.unlink(path);
  await syncDirectory(parentPath);
}

async function readPrivateRegularFileIfPresent(
  path: string,
  label: string,
): Promise<string | undefined> {
  const raw = await readPrivateRegularBufferIfPresent(path, label);
  return raw?.toString('utf8');
}

async function readPrivateRegularBufferIfPresent(
  path: string,
  label: string,
): Promise<Buffer | undefined> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(path);
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return undefined;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic-link ${label}: ${path}`);
    if (!stat.isFile()) throw new Error(`${label} is not a regular file: ${path}`);
    assertOwnedSingleLink(stat, path, label);
    try {
      handle = await fs.open(path, fsConstants.O_RDONLY | noFollowFlag());
    } catch (error) {
      if (hasErrorCode(error, 'ELOOP')) {
        throw new Error(`Refusing symbolic-link ${label}: ${path}`, { cause: error });
      }
      throw error;
    }
    const openedStat = await handle.stat();
    if (!openedStat.isFile()) throw new Error(`${label} is not a regular file: ${path}`);
    assertOwnedSingleLink(openedStat, path, label);
    await handle.chmod(0o600);
    return await handle.readFile();
  } finally {
    await handle?.close();
  }
}

async function writeExclusivePrivateFile(
  path: string,
  value: string,
  label: string,
): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag(),
      0o600,
    );
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`${label} is not a regular file: ${path}`);
    assertOwnedSingleLink(stat, path, label);
    await handle.chmod(0o600);
    await handle.writeFile(value, 'utf8');
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

async function appendPrivateFile(
  path: string,
  value: string | Uint8Array,
  label: string,
): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    try {
      handle = await fs.open(
        path,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | noFollowFlag(),
        0o600,
      );
    } catch (error) {
      if (hasErrorCode(error, 'ELOOP')) {
        throw new Error(`Refusing symbolic-link ${label}: ${path}`, { cause: error });
      }
      throw error;
    }
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`${label} is not a regular file: ${path}`);
    assertOwnedSingleLink(stat, path, label);
    await handle.chmod(0o600);
    if (typeof value === 'string') {
      await handle.writeFile(value, 'utf8');
    } else {
      await handle.writeFile(value);
    }
    await handle.sync();
  } finally {
    await handle?.close();
  }
  await syncDirectory(join(path, '..'));
}

async function truncatePrivateFile(path: string, byteLength: number, label: string): Promise<void> {
  const length = nonNegativeSafeInteger(byteLength, `${label} truncate byteLength`);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    try {
      handle = await fs.open(path, fsConstants.O_WRONLY | noFollowFlag());
    } catch (error) {
      if (hasErrorCode(error, 'ELOOP')) {
        throw new Error(`Refusing symbolic-link ${label}: ${path}`, { cause: error });
      }
      throw error;
    }
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`${label} is not a regular file: ${path}`);
    assertOwnedSingleLink(stat, path, label);
    if (length > stat.size) throw new Error(`${label} became shorter during tail recovery`);
    await handle.chmod(0o600);
    await handle.truncate(length);
    await handle.sync();
  } finally {
    await handle?.close();
  }
  await syncDirectory(join(path, '..'));
}

async function captureStorageBytes(studyPath: string): Promise<number> {
  const names = await fs.readdir(studyPath);
  let total = 0;
  for (const name of names) {
    if (
      name !== HMAC_KEY_FILE &&
      name !== GAP_FILE &&
      name !== TAIL_RECOVERY_INTENT_FILE &&
      name !== TAIL_RECOVERY_INTENT_TEMP_FILE &&
      name !== 'journal.ndjson' &&
      name !== 'state.json' &&
      !JOURNAL_ARCHIVE_PATTERN.test(name)
    ) {
      continue;
    }
    const path = join(studyPath, name);
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(path);
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) continue;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic-link capture file: ${path}`);
    if (!stat.isFile()) throw new Error(`Capture storage path is not a regular file: ${path}`);
    assertOwnedSingleLink(stat, path, 'habit-learning capture file');
    total += stat.size;
    if (!Number.isSafeInteger(total)) {
      throw new RangeError('Habit-learning capture storage size exceeds safe integer range');
    }
  }
  return total;
}

async function privateRegularFileSizeIfPresent(
  path: string,
  label: string,
): Promise<number | undefined> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(path);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return undefined;
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic-link ${label}: ${path}`);
  if (!stat.isFile()) throw new Error(`${label} is not a regular file: ${path}`);
  assertOwnedSingleLink(stat, path, label);
  return stat.size;
}

async function syncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(path, 'r');
    await handle.sync();
  } catch (error) {
    if (
      !hasErrorCode(error, 'EINVAL') &&
      !hasErrorCode(error, 'EISDIR') &&
      !hasErrorCode(error, 'ENOTSUP') &&
      !hasErrorCode(error, 'EPERM')
    ) {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => {});
  }
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Capture records require finite JSON numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (isRecord(value)) {
    const fields = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, item]) => `${JSON.stringify(name)}:${canonicalJson(item)}`);
    return `{${fields.join(',')}}`;
  }
  throw new TypeError(`Capture record contains a non-JSON value: ${typeof value}`);
}

function isCaptureBatchCandidate(value: unknown): value is Readonly<Record<string, unknown>> {
  return isRecord(value) && value.recordType === CAPTURE_BATCH_RECORD_TYPE;
}

function isRuleLogEntryRecord(value: unknown): value is RuleLogEntry {
  return (
    isRecord(value) &&
    typeof value.timestamp === 'number' &&
    Number.isFinite(value.timestamp) &&
    typeof value.iso === 'string' &&
    Number.isFinite(Date.parse(value.iso)) &&
    typeof value.graphId === 'string' &&
    (value.rawType === 'r' ||
      value.rawType === 'l' ||
      value.rawType === 'i' ||
      value.rawType === 'e') &&
    (value.level === 'info' || value.level === 'error') &&
    typeof value.message === 'string' &&
    typeof value.raw === 'string'
  );
}

function uniqueNonEmptyStrings(values: readonly string[], label: string): string[] {
  if (!Array.isArray(values)) throw new TypeError(`${label} must be an array`);
  const normalized = values.map((value, index) => {
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError(`${label}[${index}] must be a non-empty string`);
    }
    return value;
  });
  return [...new Set(normalized)].sort();
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  const normalized = uniqueNonEmptyStrings(value as string[], label);
  if (normalized.length !== value.length) throw new TypeError(`${label} contains duplicates`);
  if (!sameStrings(normalized, value as string[])) {
    throw new TypeError(`${label} must be sorted`);
  }
  return normalized;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value as number;
}

function boundedPositiveSafeInteger(value: unknown, maximum: number, label: string): number {
  const normalized = positiveSafeInteger(value, label);
  if (normalized > maximum) {
    throw new RangeError(`${label} must be less than or equal to ${maximum}`);
  }
  return normalized;
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function isoString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${label} must be an ISO timestamp`);
  }
  return value;
}

function optionalIso(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : isoString(value, label);
}

function hexDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

const SAFE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

function fetchFailureCode(error: unknown): string {
  if (isRecord(error) && typeof error.code === 'string' && SAFE_CODE_PATTERN.test(error.code)) {
    return error.code;
  }
  return 'FETCH_FAILED';
}

function persistenceCode(error: unknown): string {
  if (isRecord(error) && typeof error.code === 'string' && SAFE_CODE_PATTERN.test(error.code)) {
    return error.code;
  }
  return 'PERSISTENCE_FAILED';
}

function noFollowFlag(): number {
  return fsConstants.O_NOFOLLOW ?? 0;
}

function assertOwnedSingleLink(
  stat: Awaited<ReturnType<typeof fs.lstat>>,
  path: string,
  label: string,
): void {
  if (stat.nlink !== 1) {
    throw new Error(`Refusing hard-linked ${label}: ${path}`);
  }
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && stat.uid !== currentUid) {
    throw new Error(`Refusing non-owner ${label}: ${path}`);
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
