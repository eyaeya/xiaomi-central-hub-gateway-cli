import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractHabitLearningDebouncedEpisodes,
  pairHabitLearningParameterEvents,
} from '../dist/usecases/habit-learning-episodes.js';

const DEVICE = `device_${'a'.repeat(32)}`;

function event(eventId, phase, observedAt, parameterValue = 'Zone-1') {
  return {
    eventId,
    sourceId: `synthetic.${phase}`,
    deviceKey: DEVICE,
    channelKey: 'occupancy-region',
    parameterValue,
    phase,
    observedAt,
    rawRefs: [`journal:${eventId}`],
  };
}

test('parameter-event pairing is deterministic, censored, and gap-aware', () => {
  const result = pairHabitLearningParameterEvents({
    range: { start: 100, end: 1_000 },
    gaps: [{ gapId: 'network-gap', start: 400, end: 500 }],
    events: [
      event('outside', 'start', 50),
      event('start-1', 'start', 120),
      event('start-duplicate', 'start', 125),
      event('end-1', 'end', 200),
      event('start-2', 'start', 220),
      event('end-2', 'end', 230),
      event('start-before-gap', 'start', 390),
      event('inside-gap', 'end', 450),
      event('end-after-gap', 'end', 520),
      event('duplicate-end', 'end', 521),
      event('start-open', 'start', 600),
      event('zone-2-start', 'start', 700, 'Zone-2'),
      event('zone-2-end', 'end', 750, 'Zone-2'),
    ],
  });

  const zone1 = result.intervals.filter((interval) => interval.parameterValue === 'Zone-1');
  assert.deepEqual(
    zone1.map(
      ({
        start,
        end,
        startEventIds,
        endEventId,
        leftCensored,
        rightCensored,
        ambiguous,
        ambiguityReasons,
        endedBy,
      }) => ({
        start,
        end,
        startEventIds,
        endEventId,
        leftCensored,
        rightCensored,
        ambiguous,
        ambiguityReasons,
        endedBy,
      }),
    ),
    [
      {
        start: 120,
        end: 200,
        startEventIds: ['start-1', 'start-duplicate'],
        endEventId: 'end-1',
        leftCensored: false,
        rightCensored: false,
        ambiguous: true,
        ambiguityReasons: ['duplicate-start'],
        endedBy: 'end-event',
      },
      {
        start: 220,
        end: 230,
        startEventIds: ['start-2'],
        endEventId: 'end-2',
        leftCensored: false,
        rightCensored: false,
        ambiguous: false,
        ambiguityReasons: [],
        endedBy: 'end-event',
      },
      {
        start: 390,
        end: 400,
        startEventIds: ['start-before-gap'],
        endEventId: undefined,
        leftCensored: false,
        rightCensored: true,
        ambiguous: false,
        ambiguityReasons: [],
        endedBy: 'gap',
      },
      {
        start: 500,
        end: 520,
        startEventIds: [],
        endEventId: 'end-after-gap',
        leftCensored: true,
        rightCensored: false,
        ambiguous: true,
        ambiguityReasons: ['missing-start'],
        endedBy: 'end-event',
      },
      {
        start: 600,
        end: 1_000,
        startEventIds: ['start-open'],
        endEventId: undefined,
        leftCensored: false,
        rightCensored: true,
        ambiguous: false,
        ambiguityReasons: [],
        endedBy: 'window-end',
      },
    ],
  );
  assert.deepEqual(result.unpairedEvents, [
    { eventId: 'duplicate-end', reason: 'duplicate-end' },
    { eventId: 'inside-gap', reason: 'inside-gap', gapId: 'network-gap' },
    { eventId: 'outside', reason: 'outside-range' },
  ]);
  assert.match(zone1[0].intervalId, /^[a-f0-9]{64}$/);
  assert.deepEqual(zone1[0].rawRefs, [
    'journal:end-1',
    'journal:start-1',
    'journal:start-duplicate',
  ]);

  const repeated = pairHabitLearningParameterEvents({
    range: { start: 100, end: 1_000 },
    gaps: [{ gapId: 'network-gap', start: 400, end: 500 }],
    events: [
      event('outside', 'start', 50),
      event('start-1', 'start', 120),
      event('start-duplicate', 'start', 125),
      event('end-1', 'end', 200),
      event('start-2', 'start', 220),
      event('end-2', 'end', 230),
      event('start-before-gap', 'start', 390),
      event('inside-gap', 'end', 450),
      event('end-after-gap', 'end', 520),
      event('duplicate-end', 'end', 521),
      event('start-open', 'start', 600),
      event('zone-2-start', 'start', 700, 'Zone-2'),
      event('zone-2-end', 'end', 750, 'Zone-2'),
    ],
  });
  assert.deepEqual(repeated, result);
});

test('debounced episodes merge short inactive periods but never cross evidence gaps', () => {
  const paired = pairHabitLearningParameterEvents({
    range: { start: 100, end: 1_000 },
    gaps: [{ gapId: 'network-gap', start: 400, end: 500 }],
    events: [
      event('start-1', 'start', 120),
      event('end-1', 'end', 200),
      event('start-2', 'start', 220),
      event('end-2', 'end', 230),
      event('start-before-gap', 'start', 390),
      event('end-after-gap', 'end', 520),
      event('start-open', 'start', 600),
    ],
  });
  const episodes = extractHabitLearningDebouncedEpisodes({
    intervals: paired.intervals,
    debounceMs: 30,
    gaps: [{ gapId: 'network-gap', start: 400, end: 500 }],
  });

  assert.deepEqual(
    episodes.map(
      ({
        start,
        end,
        spanMs,
        observedActiveMs,
        debouncedInactiveMs,
        leftCensored,
        rightCensored,
        ambiguous,
        intervalIds,
      }) => ({
        start,
        end,
        spanMs,
        observedActiveMs,
        debouncedInactiveMs,
        leftCensored,
        rightCensored,
        ambiguous,
        intervalCount: intervalIds.length,
      }),
    ),
    [
      {
        start: 120,
        end: 230,
        spanMs: 110,
        observedActiveMs: 90,
        debouncedInactiveMs: 20,
        leftCensored: false,
        rightCensored: false,
        ambiguous: false,
        intervalCount: 2,
      },
      {
        start: 390,
        end: 400,
        spanMs: 10,
        observedActiveMs: 10,
        debouncedInactiveMs: 0,
        leftCensored: false,
        rightCensored: true,
        ambiguous: false,
        intervalCount: 1,
      },
      {
        start: 500,
        end: 520,
        spanMs: 20,
        observedActiveMs: 20,
        debouncedInactiveMs: 0,
        leftCensored: true,
        rightCensored: false,
        ambiguous: true,
        intervalCount: 1,
      },
      {
        start: 600,
        end: 1_000,
        spanMs: 400,
        observedActiveMs: 400,
        debouncedInactiveMs: 0,
        leftCensored: false,
        rightCensored: true,
        ambiguous: false,
        intervalCount: 1,
      },
    ],
  );
  assert.ok(episodes.every((episode) => /^[a-f0-9]{64}$/.test(episode.episodeId)));
});

test('pairing and episode extraction reject ambiguous ordering, ids, and gap crossings', () => {
  assert.throws(
    () =>
      pairHabitLearningParameterEvents({
        range: { start: 0, end: 100 },
        events: [event('later', 'start', 20), event('earlier', 'end', 10)],
      }),
    /ordered oldest first/,
  );
  assert.throws(
    () =>
      pairHabitLearningParameterEvents({
        range: { start: 0, end: 100 },
        events: [event('same', 'start', 10), event('same', 'end', 20)],
      }),
    /duplicate parameter eventId/,
  );
  assert.throws(
    () =>
      extractHabitLearningDebouncedEpisodes({
        intervals: [
          {
            intervalId: 'crossing',
            deviceKey: DEVICE,
            channelKey: 'occupancy-region',
            parameterValue: 'Zone-1',
            start: 10,
            end: 30,
            startEventIds: ['start'],
            endEventId: 'end',
            eventIds: ['start', 'end'],
            rawRefs: ['journal:start', 'journal:end'],
            leftCensored: false,
            rightCensored: false,
            ambiguous: false,
            ambiguityReasons: [],
            endedBy: 'end-event',
          },
        ],
        debounceMs: 5,
        gaps: [{ gapId: 'gap', start: 20, end: 25 }],
      }),
    /crosses gap/,
  );
});
