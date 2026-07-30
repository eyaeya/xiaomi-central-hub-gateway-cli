import assert from 'node:assert/strict';
import test from 'node:test';

import { advanceRuleLogWindow, fingerprintRuleLogLine } from '../dist/index.js';

const KEY = 'deterministic-test-only-key';

function info(ruleId, timestamp, value) {
  return `3|${timestamp}|i|${ruleId}|source|${value}`;
}

test('initial scan is an unclassified visible window and persists no unrelated raw content', () => {
  const studyLine = info('study-rule', 1000, 'study-value');
  const unrelatedLine = info('private-other-rule', 1001, 'private-other-value');
  const unparsedLine = 'unparsed-private-content';
  const result = advanceRuleLogWindow({
    currentRawLines: [studyLine, unrelatedLine, unparsedLine],
    studyRuleIds: new Set(['study-rule']),
    hmacKey: KEY,
    maxCheckpointEntries: 2,
    scanStopReason: 'max-blocks',
  });

  assert.equal(result.phase, 'initial-window');
  assert.deepEqual(
    result.initialEntries.map((entry) => entry.raw),
    [studyLine],
  );
  assert.deepEqual(result.incrementalEntries, []);
  assert.deepEqual(result.scanCounts, {
    rawLines: 3,
    retainedPrefixLines: 0,
    overlappedLines: 0,
    newLines: 3,
    studyEntries: 1,
    ignoredParsedLines: 1,
    unparsedLines: 1,
  });
  assert.deepEqual(result.completenessReasons, ['scan-hit-max-blocks', 'unparsed-log-lines']);
  assert.equal(result.checkpoint.fingerprints.length, 2);
  assert.deepEqual(result.checkpoint.counts, {
    scans: 1,
    observedLines: 3,
    initialVisibleLines: 3,
    incrementalLines: 0,
    studyInitialEntries: 1,
    studyIncrementalEntries: 0,
    ignoredParsedLines: 1,
    unparsedLines: 1,
  });

  const durableJson = JSON.stringify(result.checkpoint);
  assert.equal(durableJson.includes('private-other-rule'), false);
  assert.equal(durableJson.includes('private-other-value'), false);
  assert.equal(durableJson.includes('unparsed-private-content'), false);
});

test('longest overlap retains a valid duplicate occurrence and reports ambiguous alignment', () => {
  const repeated = info('study-rule', 2000, 'same');
  const initial = advanceRuleLogWindow({
    currentRawLines: [info('study-rule', 1999, 'older'), repeated, repeated],
    studyRuleIds: new Set(['study-rule']),
    hmacKey: KEY,
    maxCheckpointEntries: 2,
  });
  const incremental = advanceRuleLogWindow({
    currentRawLines: [
      info('study-rule', 1998, 'still-retained'),
      info('study-rule', 1999, 'older'),
      repeated,
      repeated,
      repeated,
    ],
    studyRuleIds: new Set(['study-rule']),
    hmacKey: KEY,
    maxCheckpointEntries: 2,
    previous: initial.checkpoint,
    scanStopReason: 'duplicate-block',
  });

  assert.equal(incremental.phase, 'incremental');
  assert.deepEqual(incremental.initialEntries, []);
  assert.equal(incremental.overlap.length, 1);
  assert.equal(incremental.overlap.candidateCount, 3);
  assert.deepEqual(
    incremental.incrementalEntries.map((entry) => entry.raw),
    [repeated, repeated],
  );
  assert.deepEqual(incremental.completenessReasons, ['identical-line-overlap-ambiguous']);
  assert.deepEqual(incremental.checkpoint.counts, {
    scans: 2,
    observedLines: 5,
    initialVisibleLines: 3,
    incrementalLines: 2,
    studyInitialEntries: 3,
    studyIncrementalEntries: 2,
    ignoredParsedLines: 0,
    unparsedLines: 0,
  });
});

test('a shorter earlier boundary wins over a later longer anchor to avoid silent loss', () => {
  const firstA = info('study-rule', 2100, 'A');
  const firstB = info('study-rule', 2101, 'B');
  const initial = advanceRuleLogWindow({
    currentRawLines: [firstA, firstB],
    studyRuleIds: new Set(['study-rule']),
    hmacKey: KEY,
    maxCheckpointEntries: 2,
  });
  const repeatedA = firstA;
  const repeatedB = firstB;
  const incremental = advanceRuleLogWindow({
    // The first B may be the retained old tail while the following A,B are
    // legitimate new repeats. A global-longest strategy would select the later
    // A,B and silently return no increment.
    currentRawLines: [firstB, repeatedA, repeatedB],
    studyRuleIds: new Set(['study-rule']),
    hmacKey: KEY,
    maxCheckpointEntries: 2,
    previous: initial.checkpoint,
  });

  assert.deepEqual(incremental.overlap, {
    length: 1,
    candidateCount: 2,
  });
  assert.deepEqual(
    incremental.incrementalEntries.map((entry) => entry.raw),
    [repeatedA, repeatedB],
  );
  assert.deepEqual(incremental.completenessReasons, ['identical-line-overlap-ambiguous']);
});

test('a retained tail followed by a complete repeated cycle preserves the new cycle', () => {
  const cycle = [
    info('study-rule', 2150, 'A'),
    info('study-rule', 2151, 'B'),
    info('study-rule', 2152, 'C'),
  ];
  const initial = advanceRuleLogWindow({
    currentRawLines: cycle,
    studyRuleIds: new Set(['study-rule']),
    hmacKey: KEY,
    maxCheckpointEntries: cycle.length,
  });
  const incremental = advanceRuleLogWindow({
    // The leading C is the retained old tail. The following A,B,C is one
    // complete, legitimate new cycle and must not be consumed by the longer
    // A,B,C match that ends later.
    currentRawLines: [cycle[2], ...cycle],
    studyRuleIds: new Set(['study-rule']),
    hmacKey: KEY,
    maxCheckpointEntries: cycle.length,
    previous: initial.checkpoint,
  });

  assert.deepEqual(incremental.overlap, {
    length: 1,
    candidateCount: 2,
  });
  assert.deepEqual(
    incremental.incrementalEntries.map((entry) => entry.raw),
    cycle,
  );
  assert.deepEqual(incremental.completenessReasons, ['identical-line-overlap-ambiguous']);
});

test('one retained repeated line does not consume a possible new identical occurrence', () => {
  const repeated = info('study-rule', 2200, 'repeat');
  const initial = advanceRuleLogWindow({
    currentRawLines: [repeated, repeated],
    studyRuleIds: new Set(['study-rule']),
    hmacKey: KEY,
    maxCheckpointEntries: 2,
  });
  const incremental = advanceRuleLogWindow({
    currentRawLines: [repeated, repeated],
    studyRuleIds: new Set(['study-rule']),
    hmacKey: KEY,
    maxCheckpointEntries: 2,
    previous: initial.checkpoint,
  });

  assert.deepEqual(incremental.overlap, {
    length: 1,
    candidateCount: 2,
  });
  assert.deepEqual(
    incremental.incrementalEntries.map((entry) => entry.raw),
    [repeated],
  );
  assert.deepEqual(incremental.completenessReasons, ['identical-line-overlap-ambiguous']);
});

test('a large retained window finds a truncated checkpoint in the middle and appends only new lines', () => {
  const previousRawLines = Array.from({ length: 20_000 }, (_, index) =>
    info('study-rule', 10_000 + index, `value-${index}`),
  );
  const initial = advanceRuleLogWindow({
    currentRawLines: previousRawLines,
    studyRuleIds: new Set(['study-rule']),
    hmacKey: KEY,
    maxCheckpointEntries: 64,
  });
  const appended = info('study-rule', 30_000, 'new-tail');
  const incremental = advanceRuleLogWindow({
    currentRawLines: [...previousRawLines, appended],
    studyRuleIds: new Set(['study-rule']),
    hmacKey: KEY,
    maxCheckpointEntries: 64,
    previous: initial.checkpoint,
    scanStopReason: 'empty-block',
  });

  assert.equal(initial.checkpoint.fingerprints.length, 64);
  assert.deepEqual(incremental.overlap, {
    length: 64,
    candidateCount: 1,
  });
  assert.equal(incremental.scanCounts.rawLines, 20_001);
  assert.equal(incremental.scanCounts.retainedPrefixLines, 19_936);
  assert.equal(incremental.scanCounts.overlappedLines, 64);
  assert.equal(incremental.scanCounts.newLines, 1);
  assert.deepEqual(
    incremental.incrementalEntries.map((entry) => entry.raw),
    [appended],
  );
  assert.deepEqual(incremental.completenessReasons, []);
});

test('lost overlap accepts the visible window, filters other rules, and exposes the gap', () => {
  const initial = advanceRuleLogWindow({
    currentRawLines: [info('study-rule', 3000, 'old')],
    studyRuleIds: new Set(['study-rule']),
    hmacKey: KEY,
    maxCheckpointEntries: 4,
  });
  const currentStudy = info('study-rule', 4000, 'new');
  const currentOther = info('other-rule', 4001, 'not-for-study');
  const incremental = advanceRuleLogWindow({
    currentRawLines: [currentStudy, currentOther],
    studyRuleIds: new Set(['study-rule']),
    hmacKey: KEY,
    maxCheckpointEntries: 4,
    previous: initial.checkpoint,
    scanStopReason: 'max-blocks',
  });

  assert.equal(incremental.overlap.length, 0);
  assert.deepEqual(
    incremental.incrementalEntries.map((entry) => entry.raw),
    [currentStudy],
  );
  assert.equal(incremental.scanCounts.ignoredParsedLines, 1);
  assert.deepEqual(incremental.completenessReasons, ['scan-overlap-lost', 'scan-hit-max-blocks']);
});

test('checkpoint is a bounded suffix and fingerprints are deterministic and keyed', () => {
  const rawLines = [
    info('study-rule', 5000, 'a'),
    info('study-rule', 5001, 'b'),
    info('study-rule', 5002, 'c'),
    info('study-rule', 5003, 'd'),
  ];
  const result = advanceRuleLogWindow({
    currentRawLines: rawLines,
    studyRuleIds: new Set(['study-rule']),
    hmacKey: KEY,
    maxCheckpointEntries: 2,
  });

  assert.deepEqual(result.checkpoint.fingerprints, [
    fingerprintRuleLogLine(rawLines[2], KEY),
    fingerprintRuleLogLine(rawLines[3], KEY),
  ]);
  assert.equal(fingerprintRuleLogLine(rawLines[0], KEY), fingerprintRuleLogLine(rawLines[0], KEY));
  assert.notEqual(
    fingerprintRuleLogLine(rawLines[0], KEY),
    fingerprintRuleLogLine(rawLines[0], 'different-key'),
  );
});

test('invalid bounds, keys, and checkpoint fingerprints fail closed', () => {
  assert.throws(
    () =>
      advanceRuleLogWindow({
        currentRawLines: [],
        studyRuleIds: new Set(),
        hmacKey: KEY,
        maxCheckpointEntries: 0,
      }),
    /positive safe integer/,
  );
  assert.throws(() => fingerprintRuleLogLine('line', ''), /must not be empty/);
  assert.throws(
    () =>
      advanceRuleLogWindow({
        currentRawLines: [],
        studyRuleIds: new Set(),
        hmacKey: KEY,
        maxCheckpointEntries: 1,
        previous: {
          version: 1,
          fingerprints: ['raw-content-is-not-a-fingerprint'],
          counts: {
            scans: 1,
            observedLines: 0,
            initialVisibleLines: 0,
            incrementalLines: 0,
            studyInitialEntries: 0,
            studyIncrementalEntries: 0,
            ignoredParsedLines: 0,
            unparsedLines: 0,
          },
        },
      }),
    /invalid HMAC fingerprint/,
  );
  assert.throws(
    () =>
      advanceRuleLogWindow({
        currentRawLines: [],
        studyRuleIds: new Set(),
        hmacKey: KEY,
        maxCheckpointEntries: 1,
        previous: {
          version: 1,
          fingerprints: [],
          counts: {},
        },
      }),
    /checkpoint count scans is required/,
  );
});

test('checkpoint counts require every own field with a finite non-negative integer', () => {
  const validCounts = {
    scans: 1,
    observedLines: 2,
    initialVisibleLines: 2,
    incrementalLines: 0,
    studyInitialEntries: 1,
    studyIncrementalEntries: 0,
    ignoredParsedLines: 1,
    unparsedLines: 0,
  };
  const invokeWithCounts = (counts) =>
    advanceRuleLogWindow({
      currentRawLines: [],
      studyRuleIds: new Set(),
      hmacKey: KEY,
      maxCheckpointEntries: 1,
      previous: {
        version: 1,
        fingerprints: [],
        counts,
      },
    });

  for (const name of Object.keys(validCounts)) {
    const missing = { ...validCounts };
    delete missing[name];
    assert.throws(
      () => invokeWithCounts(missing),
      new RegExp(`checkpoint count ${name} is required`),
    );
  }

  const inheritedCounts = Object.create(validCounts);
  assert.throws(() => invokeWithCounts(inheritedCounts), /checkpoint count scans is required/);

  for (const invalidValue of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0.5]) {
    assert.throws(
      () => invokeWithCounts({ ...validCounts, observedLines: invalidValue }),
      /checkpoint count observedLines must be a non-negative safe integer/,
    );
  }
});
