import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { HabitLearningCaptureSupervisor } from '../dist/usecases/habit-learning-capture.js';
import { HabitLearningStudyStore } from '../dist/usecases/habit-learning-store.js';

function info(ruleId, timestamp, nodeId, value) {
  return `3|${timestamp}|i|${ruleId}|${nodeId}|${JSON.stringify([value])}`;
}

async function createStudy(t, prefix = 'xgg-habit-capture-') {
  const parent = await fs.mkdtemp(join(tmpdir(), prefix));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const store = new HabitLearningStudyStore({ path: join(parent, 'study') });
  return { parent, store };
}

function fixedClock(...values) {
  let index = 0;
  return () => {
    const value = values[Math.min(index, values.length - 1)];
    index += 1;
    return new Date(value);
  };
}

async function readGaps(store) {
  const raw = await fs.readFile(join(store.paths.study, 'gaps.ndjson'), 'utf8');
  assert.ok(raw.endsWith('\n'));
  return raw
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));
}

test('requires exactly one observation graph per durable capture supervisor', async (t) => {
  const { store } = await createStudy(t, 'xgg-habit-capture-one-rule-');
  const options = {
    store,
    fetch: async () => ({ rawLines: [], blocksRead: 0, stopReason: 'empty-block' }),
  };
  assert.throws(
    () => new HabitLearningCaptureSupervisor({ ...options, studyRuleIds: [] }),
    /exactly one observation rule id/,
  );
  const valid = new HabitLearningCaptureSupervisor({
    ...options,
    studyRuleIds: ['study-a'],
  });
  await assert.rejects(valid.readBatches({ limit: 1_025 }), /less than or equal to 1024/);
  await assert.rejects(valid.readGaps({ limit: 1_025 }), /less than or equal to 1024/);
  assert.throws(
    () =>
      new HabitLearningCaptureSupervisor({
        ...options,
        studyRuleIds: ['study-a', 'study-b'],
      }),
    /exactly one observation rule id/,
  );
});

test('captures only selected study evidence, persists private key, gaps, then checkpoint', async (t) => {
  const { store } = await createStudy(t);
  const studyLine = info('study-rule', 1000, 'presence', true);
  const unrelatedLine = info('other-rule', 1001, 'private-node', 'private-value');
  const supervisor = new HabitLearningCaptureSupervisor({
    store,
    studyRuleIds: ['study-rule'],
    initialMaxBlocks: 2,
    maxBlocksCeiling: 2,
    maxFetchAttempts: 1,
    now: fixedClock('2026-07-30T01:00:00.000Z'),
    fetch: async ({ maxBlocks }) => {
      assert.equal(maxBlocks, 2);
      return {
        rawLines: [studyLine, unrelatedLine, 'not-a-complete-gateway-record'],
        blocksRead: 2,
        stopReason: 'max-blocks',
      };
    },
  });

  const result = await supervisor.captureOnce();
  assert.deepEqual(
    {
      outcome: result.outcome,
      sequence: result.outcome === 'captured' ? result.sequence : undefined,
      phase: result.outcome === 'captured' ? result.phase : undefined,
      studyEntries: result.outcome === 'captured' ? result.studyEntries : undefined,
      nextMaxBlocks: result.outcome === 'captured' ? result.nextMaxBlocks : undefined,
      reasons: result.outcome === 'captured' ? result.completenessReasons : undefined,
      gapsAdded: result.outcome === 'captured' ? result.gapsAdded : undefined,
    },
    {
      outcome: 'captured',
      sequence: 1,
      phase: 'initial-window',
      studyEntries: 1,
      nextMaxBlocks: 2,
      reasons: ['scan-hit-max-blocks', 'unparsed-log-lines'],
      gapsAdded: 2,
    },
  );

  const journal = await store.readJournal();
  assert.equal(journal.length, 1);
  assert.equal(journal[0].recordType, 'habit-learning-capture-batch');
  assert.equal(journal[0].entries.length, 1);
  assert.equal(journal[0].entries[0].raw, studyLine);
  const durableJournal = JSON.stringify(journal);
  assert.equal(durableJournal.includes('other-rule'), false);
  assert.equal(durableJournal.includes('private-value'), false);
  assert.equal(durableJournal.includes('not-a-complete-gateway-record'), false);

  const gaps = await readGaps(store);
  assert.deepEqual(
    gaps.map(({ kind }) => kind),
    ['pagination-ceiling', 'unparsed-log-lines'],
  );
  assert.equal(JSON.stringify(gaps).includes('not-a-complete-gateway-record'), false);

  const state = await store.readState();
  assert.equal(state.committedBatchSequence, 1);
  assert.equal(state.lastBatch.batchId, journal[0].batchId);
  assert.equal(state.pagination.nextMaxBlocks, 2);
  assert.equal(state.ruleLogWindow.counts.observedLines, 3);
  assert.equal(JSON.stringify(state).includes('private-value'), false);

  const keyPath = join(store.paths.study, '.capture-hmac.key');
  const keyRaw = await fs.readFile(keyPath, 'utf8');
  assert.equal(Buffer.from(keyRaw.trim(), 'base64').byteLength, 32);
  assert.equal((await fs.stat(store.paths.study)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(keyPath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(join(store.paths.study, 'gaps.ndjson'))).mode & 0o777, 0o600);

  const status = await supervisor.status();
  assert.equal(status.health, 'degraded');
  assert.equal(status.keyId, state.keyId);
  assert.equal(status.committedBatchSequence, 1);
  assert.equal(status.currentMaxBlocks, 2);
  assert.equal(status.gapCount, 2);
});

test('recovers a journaled batch before fetching again and never duplicates its entries', async (t) => {
  const { store } = await createStudy(t, 'xgg-habit-capture-crash-');
  const firstLine = info('study-rule', 2000, 'presence', true);
  const secondLine = info('study-rule', 3000, 'presence', false);
  let failNextStateWrite = true;
  const crashStore = {
    paths: store.paths,
    initialize: () => store.initialize(),
    readJournal: () => store.readJournal(),
    withLock: (operation) =>
      store.withLock((transaction) =>
        operation({
          ...transaction,
          writeState: async (state) => {
            if (failNextStateWrite) {
              failNextStateWrite = false;
              throw Object.assign(new Error('synthetic checkpoint crash'), { code: 'EIO' });
            }
            await transaction.writeState(state);
          },
        }),
      ),
  };
  const crashing = new HabitLearningCaptureSupervisor({
    store: crashStore,
    studyRuleIds: ['study-rule'],
    initialMaxBlocks: 2,
    maxBlocksCeiling: 8,
    maxFetchAttempts: 1,
    now: fixedClock('2026-07-30T02:00:00.000Z'),
    fetch: async () => ({
      rawLines: [firstLine],
      blocksRead: 1,
      stopReason: 'empty-block',
    }),
  });

  const interrupted = await crashing.captureOnce();
  assert.equal(interrupted.outcome, 'failed');
  assert.equal(interrupted.kind, 'persistence');
  assert.equal(interrupted.code, 'EIO');
  assert.equal(interrupted.recoveryRequired, true);
  assert.equal(interrupted.gapPersisted, true);
  assert.equal((await store.readJournal()).length, 1);
  assert.equal(await store.readState(), undefined);
  const keyBefore = await fs.readFile(join(store.paths.study, '.capture-hmac.key'), 'utf8');

  const resumed = new HabitLearningCaptureSupervisor({
    store,
    studyRuleIds: ['study-rule'],
    initialMaxBlocks: 2,
    maxBlocksCeiling: 8,
    maxFetchAttempts: 1,
    now: fixedClock('2026-07-30T02:05:00.000Z'),
    fetch: async () => ({
      rawLines: [firstLine, secondLine],
      blocksRead: 1,
      stopReason: 'empty-block',
    }),
  });
  const result = await resumed.captureOnce();
  assert.equal(result.outcome, 'captured');
  assert.equal(result.sequence, 2);
  assert.equal(result.recoveredBatchIds.length, 1);

  const journal = await store.readJournal();
  assert.equal(journal.length, 2);
  assert.deepEqual(
    journal.map((batch) => batch.entries.map((entry) => entry.raw)),
    [[firstLine], [secondLine]],
  );
  assert.deepEqual(
    journal.map(({ sequence }) => sequence),
    [1, 2],
  );
  assert.equal(await fs.readFile(join(store.paths.study, '.capture-hmac.key'), 'utf8'), keyBefore);
  assert.equal((await store.readState()).committedBatchSequence, 2);
});

test('uses bounded exponential fetch retry and records no network gap after recovery', async (t) => {
  const { store } = await createStudy(t, 'xgg-habit-capture-retry-');
  const sleeps = [];
  let calls = 0;
  const supervisor = new HabitLearningCaptureSupervisor({
    store,
    studyRuleIds: ['study-rule'],
    initialMaxBlocks: 2,
    maxFetchAttempts: 3,
    initialBackoffMs: 10,
    maxBackoffMs: 15,
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    now: fixedClock('2026-07-30T03:00:00.000Z'),
    fetch: async ({ attempt, maxBlocks }) => {
      calls += 1;
      assert.equal(attempt, calls);
      assert.equal(maxBlocks, 2);
      if (attempt < 3) {
        throw Object.assign(new Error('synthetic secret transport message'), {
          code: 'ECONNRESET',
        });
      }
      return {
        rawLines: [info('study-rule', 4000, 'presence', true)],
        blocksRead: 1,
        stopReason: 'empty-block',
      };
    },
  });

  const result = await supervisor.captureOnce();
  assert.equal(result.outcome, 'captured');
  assert.equal(result.attempts, 3);
  assert.deepEqual(sleeps, [10, 15]);
  await assert.rejects(fs.readFile(join(store.paths.study, 'gaps.ndjson'), 'utf8'), {
    code: 'ENOENT',
  });
  assert.equal((await supervisor.status()).consecutiveFailures, 0);
});

test('persists exhausted network failure without leaking the thrown message', async (t) => {
  const { store } = await createStudy(t, 'xgg-habit-capture-network-');
  const sleeps = [];
  const supervisor = new HabitLearningCaptureSupervisor({
    store,
    studyRuleIds: ['study-rule'],
    maxFetchAttempts: 3,
    initialBackoffMs: 5,
    maxBackoffMs: 20,
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    now: fixedClock('2026-07-30T04:00:00.000Z'),
    fetch: async () => {
      throw Object.assign(new Error('must-not-enter-private-state'), { code: 'ETIMEDOUT' });
    },
  });

  const result = await supervisor.captureOnce();
  assert.deepEqual(
    {
      outcome: result.outcome,
      kind: result.kind,
      code: result.code,
      attempts: result.attempts,
      gapPersisted: result.gapPersisted,
      stateUpdated: result.stateUpdated,
    },
    {
      outcome: 'failed',
      kind: 'network',
      code: 'ETIMEDOUT',
      attempts: 3,
      gapPersisted: true,
      stateUpdated: true,
    },
  );
  assert.deepEqual(sleeps, [5, 10]);
  const gaps = await readGaps(store);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].kind, 'network-error');
  assert.equal(JSON.stringify(gaps).includes('must-not-enter-private-state'), false);
  const status = await supervisor.status();
  assert.equal(status.health, 'degraded');
  assert.equal(status.consecutiveFailures, 1);
  assert.equal(status.lastFailure.code, 'ETIMEDOUT');
  assert.equal(status.journalBatchCount, 0);

  const repeated = await supervisor.captureOnce();
  assert.equal(repeated.outcome, 'failed');
  assert.equal(repeated.code, 'ETIMEDOUT');
  assert.deepEqual(sleeps, [5, 10, 5, 10]);
  assert.equal((await readGaps(store)).length, 1);
  assert.equal((await supervisor.status()).consecutiveFailures, 2);
});

test('fails closed on partial fetch records and persists an explicit gap', async (t) => {
  const { store } = await createStudy(t, 'xgg-habit-capture-invalid-fetch-');
  const supervisor = new HabitLearningCaptureSupervisor({
    store,
    studyRuleIds: ['study-rule'],
    maxFetchAttempts: 1,
    now: fixedClock('2026-07-30T05:00:00.000Z'),
    fetch: async () => ({
      rawLines: [`${info('study-rule', 5000, 'presence', true)}\npartial`],
      blocksRead: 1,
      stopReason: 'empty-block',
    }),
  });

  const result = await supervisor.captureOnce();
  assert.equal(result.outcome, 'failed');
  assert.equal(result.kind, 'invalid-fetch-result');
  assert.equal(result.code, 'INVALID_FETCH_RESULT');
  assert.equal((await store.readJournal()).length, 0);
  const gaps = await readGaps(store);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].kind, 'invalid-fetch-result');
  assert.equal((await store.readState()).committedBatchSequence, 0);
});

test('records a durable disk gap when journal append fails and state remains writable', async (t) => {
  const { store } = await createStudy(t, 'xgg-habit-capture-disk-');
  const appendFailingStore = {
    paths: store.paths,
    initialize: () => store.initialize(),
    readJournal: () => store.readJournal(),
    withLock: (operation) =>
      store.withLock((transaction) =>
        operation({
          ...transaction,
          appendJournal: async () => {
            throw Object.assign(new Error('synthetic disk full'), { code: 'ENOSPC' });
          },
        }),
      ),
  };
  const supervisor = new HabitLearningCaptureSupervisor({
    store: appendFailingStore,
    studyRuleIds: ['study-rule'],
    maxFetchAttempts: 1,
    now: fixedClock('2026-07-30T06:00:00.000Z'),
    fetch: async () => ({
      rawLines: [info('study-rule', 6000, 'presence', true)],
      blocksRead: 1,
      stopReason: 'empty-block',
    }),
  });

  const result = await supervisor.captureOnce();
  assert.equal(result.outcome, 'failed');
  assert.equal(result.kind, 'persistence');
  assert.equal(result.code, 'ENOSPC');
  assert.equal(result.gapPersisted, true);
  assert.equal(result.stateUpdated, true);
  assert.equal(result.recoveryRequired, true);
  assert.equal((await store.readJournal()).length, 0);
  const gaps = await readGaps(store);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].kind, 'disk-error');
  assert.equal(gaps[0].detail.phase, 'journal-append');
  assert.equal(gaps[0].detail.code, 'ENOSPC');
  assert.equal((await store.readState()).lastFailure.code, 'ENOSPC');
  assert.equal((await supervisor.captureOnce()).code, 'ENOSPC');
  assert.equal((await readGaps(store)).length, 1);
});

test('adapts pagination upward at the ceiling boundary and back down after a short scan', async (t) => {
  const { store } = await createStudy(t, 'xgg-habit-capture-pagination-');
  const observedBounds = [];
  let call = 0;
  const olderLine = info('study-rule', 6999, 'presence', false);
  const line = info('study-rule', 7000, 'presence', true);
  const supervisor = new HabitLearningCaptureSupervisor({
    store,
    studyRuleIds: ['study-rule'],
    initialMaxBlocks: 2,
    maxBlocksCeiling: 8,
    maxFetchAttempts: 1,
    now: fixedClock('2026-07-30T07:00:00.000Z', '2026-07-30T07:05:00.000Z'),
    fetch: async ({ maxBlocks }) => {
      observedBounds.push(maxBlocks);
      call += 1;
      if (call === 1) {
        return {
          rawLines: [line],
          blocksRead: 2,
          stopReason: 'max-blocks',
        };
      }
      if (call === 2) {
        return {
          rawLines: [olderLine, line],
          blocksRead: 3,
          stopReason: 'empty-block',
        };
      }
      return {
        rawLines: [olderLine, line],
        blocksRead: 1,
        stopReason: 'empty-block',
      };
    },
  });

  const first = await supervisor.captureOnce();
  const second = await supervisor.captureOnce();
  assert.equal(first.outcome, 'captured');
  assert.equal(first.nextMaxBlocks, 4);
  assert.equal(first.studyEntries, 2);
  assert.equal(second.outcome, 'captured');
  assert.equal(second.nextMaxBlocks, 2);
  assert.deepEqual(observedBounds, [2, 4, 4]);
  assert.deepEqual(
    (await store.readJournal())[0].entries.map(({ raw }) => raw),
    [olderLine, line],
  );
});

test('expands a lost incremental overlap in the same batch and stops at a unique anchor', async (t) => {
  const { store } = await createStudy(t, 'xgg-habit-capture-overlap-expansion-');
  const anchor = info('study-rule', 7100, 'presence', false);
  const appended = info('study-rule', 7200, 'presence', true);
  const observedBounds = [];
  let call = 0;
  const supervisor = new HabitLearningCaptureSupervisor({
    store,
    studyRuleIds: ['study-rule'],
    initialMaxBlocks: 2,
    maxBlocksCeiling: 8,
    maxFetchAttempts: 1,
    now: fixedClock('2026-07-30T07:10:00.000Z', '2026-07-30T07:20:00.000Z'),
    fetch: async ({ maxBlocks }) => {
      observedBounds.push(maxBlocks);
      call += 1;
      if (call === 1) {
        return {
          rawLines: [anchor],
          blocksRead: 1,
          stopReason: 'empty-block',
        };
      }
      if (maxBlocks === 2) {
        return {
          rawLines: [appended],
          blocksRead: 2,
          stopReason: 'max-blocks',
        };
      }
      return {
        rawLines: [anchor, appended],
        blocksRead: 4,
        stopReason: 'max-blocks',
      };
    },
  });

  assert.equal((await supervisor.captureOnce()).outcome, 'captured');
  const result = await supervisor.captureOnce();
  assert.equal(result.outcome, 'captured');
  assert.equal(result.studyEntries, 1);
  assert.equal(result.requestedMaxBlocks, 4);
  assert.deepEqual(result.completenessReasons, []);
  assert.deepEqual(observedBounds, [2, 2, 4]);
  assert.deepEqual(
    (await store.readJournal())[1].entries.map(({ raw }) => raw),
    [appended],
  );
});

test('holds the study single-writer lease across fetch and serializes supervisors', async (t) => {
  const { store } = await createStudy(t, 'xgg-habit-capture-single-writer-');
  let releaseFirstFetch;
  const firstFetchGate = new Promise((resolve) => {
    releaseFirstFetch = resolve;
  });
  let announceFirstFetch;
  const firstFetchStarted = new Promise((resolve) => {
    announceFirstFetch = resolve;
  });
  let fetchCalls = 0;
  let activeFetches = 0;
  let maximumActiveFetches = 0;
  const fetch = async () => {
    fetchCalls += 1;
    activeFetches += 1;
    maximumActiveFetches = Math.max(maximumActiveFetches, activeFetches);
    if (fetchCalls === 1) {
      announceFirstFetch();
      await firstFetchGate;
    }
    activeFetches -= 1;
    return {
      rawLines: [info('study-rule', 7500, 'presence', true)],
      blocksRead: 1,
      stopReason: 'empty-block',
    };
  };
  const first = new HabitLearningCaptureSupervisor({
    store,
    studyRuleIds: ['study-rule'],
    maxFetchAttempts: 1,
    now: fixedClock('2026-07-30T07:30:00.000Z'),
    fetch,
  });
  const second = new HabitLearningCaptureSupervisor({
    store,
    studyRuleIds: ['study-rule'],
    maxFetchAttempts: 1,
    now: fixedClock('2026-07-30T07:31:00.000Z'),
    fetch,
  });

  const firstCapture = first.captureOnce();
  await firstFetchStarted;
  const secondCapture = second.captureOnce();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchCalls, 1);
  releaseFirstFetch();

  const results = await Promise.all([firstCapture, secondCapture]);
  assert.deepEqual(
    results.map(({ outcome }) => outcome),
    ['captured', 'captured'],
  );
  assert.equal(maximumActiveFetches, 1);
  assert.deepEqual(
    (await store.readJournal()).map(({ sequence }) => sequence),
    [1, 2],
  );
});

test('rotates committed journal batches into bounded authenticated segments', async (t) => {
  const { store } = await createStudy(t, 'xgg-habit-capture-rotation-');
  const lines = [
    info('study-rule', 7600, 'presence', false),
    info('study-rule', 7700, 'presence', true),
    info('study-rule', 7800, 'presence', false),
    info('study-rule', 7900, 'presence', true),
    info('study-rule', 8000, 'presence', false),
  ];
  let call = 0;
  const supervisor = new HabitLearningCaptureSupervisor({
    store,
    studyRuleIds: ['study-rule'],
    maxCheckpointEntries: 8,
    maxFetchAttempts: 1,
    journalSegmentBatchLimit: 2,
    now: fixedClock(
      '2026-07-30T07:40:00.000Z',
      '2026-07-30T07:50:00.000Z',
      '2026-07-30T08:00:00.000Z',
      '2026-07-30T08:10:00.000Z',
      '2026-07-30T08:20:00.000Z',
    ),
    fetch: async () => {
      call += 1;
      return {
        rawLines: lines.slice(0, call),
        blocksRead: 1,
        stopReason: 'empty-block',
      };
    },
  });

  assert.equal((await supervisor.captureOnce()).outcome, 'captured');
  assert.equal((await supervisor.captureOnce()).outcome, 'captured');
  await assert.rejects(fs.access(store.paths.journal), { code: 'ENOENT' });
  const archivePath = join(store.paths.study, 'journal.capture.1-2.ndjson');
  const archiveRaw = await fs.readFile(archivePath, 'utf8');
  assert.equal(archiveRaw.trimEnd().split('\n').length, 2);
  assert.equal((await fs.stat(archivePath)).mode & 0o777, 0o600);
  const rotatedStatus = await supervisor.status();
  assert.equal(rotatedStatus.health, 'ready');
  assert.equal(rotatedStatus.committedBatchSequence, 2);
  assert.equal(rotatedStatus.journalBatchCount, 2);

  for (let sequence = 3; sequence <= 5; sequence += 1) {
    const result = await supervisor.captureOnce();
    assert.equal(result.outcome, 'captured');
    assert.equal(result.sequence, sequence);
    assert.equal(result.studyEntries, 1);
  }
  assert.deepEqual(
    (await store.readJournal()).map(({ sequence }) => sequence),
    [5],
  );
  assert.equal((await supervisor.status()).journalBatchCount, 5);
  await fs.access(join(store.paths.study, 'journal.capture.3-4.ndjson'));

  const firstPage = await supervisor.readBatches({ limit: 2 });
  assert.deepEqual(
    firstPage.batches.map(({ sequence }) => sequence),
    [1, 2],
  );
  assert.equal(firstPage.complete, false);
  const secondPage = await supervisor.readBatches({
    afterSequence: firstPage.nextAfterSequence,
    limit: 2,
  });
  assert.deepEqual(
    secondPage.batches.map(({ sequence }) => sequence),
    [3, 4],
  );
  assert.equal(secondPage.complete, false);
  const thirdPage = await supervisor.readBatches({
    afterSequence: secondPage.nextAfterSequence,
    limit: 2,
  });
  assert.deepEqual(
    thirdPage.batches.map(({ sequence }) => sequence),
    [5],
  );
  assert.equal(thirdPage.complete, true);

  assert.deepEqual(await supervisor.verifyEvidenceIntegrity(), {
    committedBatchSequence: 5,
    verifiedBatchCount: 5,
    archiveSegmentCount: 2,
    activeBatchCount: 1,
  });

  const tampered = archiveRaw.replace('"sequence":1', '"sequence":9');
  assert.notEqual(tampered, archiveRaw);
  await fs.writeFile(archivePath, tampered);
  // The hot status path authenticates only the newest archive; full traversal
  // and a page touching the damaged segment must both fail closed.
  assert.equal((await supervisor.status()).committedBatchSequence, 5);
  await assert.rejects(supervisor.readBatches({ limit: 2 }), /authentication failed|range|chain/);
  await assert.rejects(supervisor.verifyEvidenceIntegrity(), /authentication failed|range|chain/);
});

test('partial journal and gap tails fail closed until explicit authenticated recovery', async (t) => {
  const { store } = await createStudy(t, 'xgg-habit-capture-partial-journal-');
  const supervisor = new HabitLearningCaptureSupervisor({
    store,
    studyRuleIds: ['study-rule'],
    maxFetchAttempts: 1,
    now: fixedClock(
      '2026-07-30T09:00:00.000Z',
      '2026-07-30T09:05:00.000Z',
      '2026-07-30T09:10:00.000Z',
    ),
    fetch: async () => ({
      rawLines: [info('study-rule', 8000, 'presence', true)],
      blocksRead: 1,
      stopReason: 'empty-block',
    }),
  });
  assert.equal((await supervisor.captureOnce()).outcome, 'captured');
  await fs.appendFile(store.paths.journal, '{"recordType":');
  await fs.appendFile(join(store.paths.study, 'gaps.ndjson'), '{"recordType":');

  await assert.rejects(supervisor.status(), /partial final record/);
  await assert.rejects(supervisor.captureOnce(), /partial final record/);

  const recovery = await supervisor.recoverPartialTails();
  assert.equal(recovery.journal, 'truncated-partial-record');
  assert.equal(recovery.gaps, 'truncated-partial-record');
  assert.ok(recovery.journalBytesRemoved > 0);
  assert.ok(recovery.gapBytesRemoved > 0);
  assert.equal(recovery.recoveryGapIds.length, 2);
  const firstGapPage = await supervisor.readGaps({ limit: 1 });
  assert.deepEqual(
    firstGapPage.gaps.map(({ kind }) => kind),
    ['journal-recovered-truncated-tail'],
  );
  assert.equal(firstGapPage.complete, false);
  const secondGapPage = await supervisor.readGaps({
    offset: firstGapPage.nextOffset,
    limit: 1,
  });
  assert.deepEqual(
    secondGapPage.gaps.map(({ kind }) => kind),
    ['gap-ledger-recovered-truncated-tail'],
  );
  assert.equal(secondGapPage.complete, true);
  assert.equal((await supervisor.status()).health, 'degraded');
  const resumed = await supervisor.captureOnce();
  assert.equal(resumed.outcome, 'captured');
  assert.equal(resumed.sequence, 2);
});

test('tail recovery terminates a complete authenticated record missing only its LF', async (t) => {
  const { store } = await createStudy(t, 'xgg-habit-capture-missing-lf-');
  const supervisor = new HabitLearningCaptureSupervisor({
    store,
    studyRuleIds: ['study-rule'],
    maxFetchAttempts: 1,
    now: fixedClock('2026-07-30T10:00:00.000Z', '2026-07-30T10:05:00.000Z'),
    fetch: async () => ({
      rawLines: [info('study-rule', 9000, 'presence', true)],
      blocksRead: 1,
      stopReason: 'empty-block',
    }),
  });
  assert.equal((await supervisor.captureOnce()).outcome, 'captured');
  const stat = await fs.stat(store.paths.journal);
  await fs.truncate(store.paths.journal, stat.size - 1);
  await assert.rejects(supervisor.status(), /partial final record/);

  const recovery = await supervisor.recoverPartialTails();
  assert.equal(recovery.journal, 'terminated-valid-record');
  assert.equal(recovery.journalBytesRemoved, 0);
  assert.deepEqual(recovery.recoveryGapIds, []);
  assert.equal((await supervisor.status()).committedBatchSequence, 1);
});

test('tail recovery intent survives a crash after truncate and preserves the loss gap', async (t) => {
  const { store } = await createStudy(t, 'xgg-habit-capture-recovery-intent-');
  const common = {
    store,
    studyRuleIds: ['study-rule'],
    maxFetchAttempts: 1,
    fetch: async () => ({
      rawLines: [info('study-rule', 9050, 'presence', true)],
      blocksRead: 1,
      stopReason: 'empty-block',
    }),
  };
  const initial = new HabitLearningCaptureSupervisor({
    ...common,
    now: fixedClock('2026-07-30T10:06:00.000Z'),
  });
  assert.equal((await initial.captureOnce()).outcome, 'captured');
  await fs.appendFile(store.paths.journal, '{"recordType":');

  const interrupted = new HabitLearningCaptureSupervisor({
    ...common,
    now: fixedClock('2026-07-30T10:07:00.000Z'),
    onTailRecoveryStep: async (step) => {
      if (step === 'journal-applied') throw new Error('synthetic recovery crash');
    },
  });
  await assert.rejects(interrupted.recoverPartialTails(), /synthetic recovery crash/);
  const intentPath = join(store.paths.study, '.capture-tail-recovery.intent.json');
  await fs.access(intentPath);
  assert.ok((await fs.readFile(store.paths.journal, 'utf8')).endsWith('\n'));
  await assert.rejects(initial.status(), /tail recovery intent is pending/);

  const resumed = new HabitLearningCaptureSupervisor({
    ...common,
    now: fixedClock('2026-07-30T10:08:00.000Z'),
  });
  const recovery = await resumed.recoverPartialTails();
  assert.equal(recovery.journal, 'truncated-partial-record');
  assert.equal(recovery.recoveryGapIds.length, 1);
  assert.deepEqual(
    (await resumed.readGaps()).gaps.map(({ kind }) => kind),
    ['journal-recovered-truncated-tail'],
  );
  await assert.rejects(fs.access(intentPath), { code: 'ENOENT' });
});

test('tail recovery intent resumes after recovery gaps are durable without duplicating them', async (t) => {
  const { store } = await createStudy(t, 'xgg-habit-capture-recovery-gap-intent-');
  const common = {
    store,
    studyRuleIds: ['study-rule'],
    maxFetchAttempts: 1,
    fetch: async () => ({
      rawLines: [info('study-rule', 9075, 'presence', true)],
      blocksRead: 1,
      stopReason: 'empty-block',
    }),
  };
  const initial = new HabitLearningCaptureSupervisor({
    ...common,
    now: fixedClock('2026-07-30T10:08:30.000Z'),
  });
  assert.equal((await initial.captureOnce()).outcome, 'captured');
  await fs.appendFile(store.paths.journal, '{"recordType":');

  const interrupted = new HabitLearningCaptureSupervisor({
    ...common,
    now: fixedClock('2026-07-30T10:09:00.000Z'),
    onTailRecoveryStep: async (step) => {
      if (step === 'recovery-gaps-durable') throw new Error('synthetic post-gap crash');
    },
  });
  await assert.rejects(interrupted.recoverPartialTails(), /synthetic post-gap crash/);
  const intentPath = join(store.paths.study, '.capture-tail-recovery.intent.json');
  await fs.access(intentPath);
  assert.equal((await readGaps(store)).length, 1);

  const resumed = new HabitLearningCaptureSupervisor({
    ...common,
    now: fixedClock('2026-07-30T10:09:30.000Z'),
  });
  const recovery = await resumed.recoverPartialTails();
  assert.equal(recovery.journal, 'truncated-partial-record');
  assert.equal(recovery.recoveryGapIds.length, 1);
  assert.equal((await resumed.readGaps()).totalGapCount, 1);
  await assert.rejects(fs.access(intentPath), { code: 'ENOENT' });
});

test('tail recovery refuses an authenticated LF-less batch with an inconsistent sequence', async (t) => {
  const { store } = await createStudy(t, 'xgg-habit-capture-invalid-auth-tail-');
  let call = 0;
  const lines = [
    info('study-rule', 9100, 'presence', true),
    info('study-rule', 9200, 'presence', false),
  ];
  const supervisor = new HabitLearningCaptureSupervisor({
    store,
    studyRuleIds: ['study-rule'],
    maxFetchAttempts: 1,
    now: fixedClock('2026-07-30T10:10:00.000Z', '2026-07-30T10:15:00.000Z'),
    fetch: async () => {
      call += 1;
      return {
        rawLines: lines.slice(0, call),
        blocksRead: 1,
        stopReason: 'empty-block',
      };
    },
  });
  assert.equal((await supervisor.captureOnce()).outcome, 'captured');
  assert.equal((await supervisor.captureOnce()).outcome, 'captured');
  const raw = await fs.readFile(store.paths.journal, 'utf8');
  const duplicate = raw.trimEnd().split('\n').at(-1);
  await fs.appendFile(store.paths.journal, duplicate);
  const beforeRecovery = await fs.readFile(store.paths.journal, 'utf8');

  await assert.rejects(
    supervisor.recoverPartialTails(),
    /Duplicate capture batch id|sequence|checkpoint chain/,
  );
  assert.equal(await fs.readFile(store.paths.journal, 'utf8'), beforeRecovery);
});

test('tail recovery refuses an authenticated duplicate LF-less gap', async (t) => {
  const { store } = await createStudy(t, 'xgg-habit-capture-duplicate-gap-tail-');
  const supervisor = new HabitLearningCaptureSupervisor({
    store,
    studyRuleIds: ['study-rule'],
    maxFetchAttempts: 1,
    now: fixedClock('2026-07-30T10:20:00.000Z'),
    fetch: async () => {
      throw Object.assign(new Error('offline'), { code: 'ETIMEDOUT' });
    },
  });
  assert.equal((await supervisor.captureOnce()).outcome, 'failed');
  const gapPath = join(store.paths.study, 'gaps.ndjson');
  const raw = await fs.readFile(gapPath, 'utf8');
  await fs.appendFile(gapPath, raw.trimEnd());
  const beforeRecovery = await fs.readFile(gapPath, 'utf8');

  await assert.rejects(supervisor.recoverPartialTails(), /Duplicate habit-learning gap id/);
  assert.equal(await fs.readFile(gapPath, 'utf8'), beforeRecovery);
});

test('enforces a durable total capture byte budget without deleting prior evidence', async (t) => {
  const { store } = await createStudy(t, 'xgg-habit-capture-budget-');
  let rawLines = [info('study-rule', 10000, 'presence', true)];
  const options = {
    store,
    studyRuleIds: ['study-rule'],
    maxFetchAttempts: 1,
    maxCaptureBytes: 10_000,
    now: fixedClock('2026-07-30T11:00:00.000Z', '2026-07-30T11:05:00.000Z'),
    fetch: async () => ({
      rawLines,
      blocksRead: 1,
      stopReason: 'empty-block',
    }),
  };
  const supervisor = new HabitLearningCaptureSupervisor(options);
  assert.equal((await supervisor.captureOnce()).outcome, 'captured');
  const journalBefore = await fs.readFile(store.paths.journal, 'utf8');

  rawLines = [
    info('study-rule', 10000, 'presence', true),
    info('study-rule', 10100, 'payload', 'x'.repeat(20_000)),
  ];
  const result = await supervisor.captureOnce();
  assert.equal(result.outcome, 'failed');
  assert.equal(result.kind, 'persistence');
  assert.equal(result.code, 'DISK_BUDGET_EXHAUSTED');
  assert.equal(result.gapPersisted, true);
  assert.equal(result.recoveryRequired, false);
  assert.equal(await fs.readFile(store.paths.journal, 'utf8'), journalBefore);
  assert.equal((await readGaps(store)).at(-1).kind, 'disk-budget-exhausted');
  assert.equal((await supervisor.captureOnce()).code, 'DISK_BUDGET_EXHAUSTED');
  assert.equal((await readGaps(store)).length, 1);
  const status = await supervisor.status();
  assert.equal(status.maxCaptureBytes, 10_000);
  assert.ok(status.captureBytes > 0);

  const incompatible = new HabitLearningCaptureSupervisor({
    ...options,
    maxCaptureBytes: 20_000,
  });
  await assert.rejects(incompatible.status(), /maxCaptureBytes does not match/);
});
