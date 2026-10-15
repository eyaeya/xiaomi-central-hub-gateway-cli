import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ConfigError,
  checkVarSetNumberExprString,
  generateLightingFormula,
} from '../dist/index.js';

const modes = ['temperature', 'brightness', 'brightness-beta'];
const optionsFor = (mode) => ({
  mode,
  latitude: 23.129,
  min: mode === 'temperature' ? 3200 : mode === 'brightness' ? 10 : 60,
  max: mode === 'temperature' ? 5400 : 100,
});

// Independent evaluation of generated trusted expressions; never a runtime API.
function expressionAt(expression, date, seconds) {
  const context = {
    abs: Math.abs,
    acos: Math.acos,
    tan: Math.tan,
    sin: Math.sin,
    min: Math.min,
    max: Math.max,
    floor: Math.floor,
    pow: Math.pow,
    e: () => Math.E,
    pi: () => Math.PI,
    month: () => Number(date.slice(5, 7)),
    date: () => Number(date.slice(8, 10)),
    hours: () => Math.floor(seconds / 3600),
    minutes: () => Math.floor((seconds % 3600) / 60),
    seconds: () => seconds % 60,
  };
  return new Function(...Object.keys(context), `"use strict";return (${expression});`)(
    ...Object.values(context),
  );
}

function originalSourceValue(p, date, seconds) {
  const day = Number(date.slice(5, 7)) * 30 + Number(date.slice(8, 10));
  const declination = (23.44 * Math.sin((2 * Math.PI * (day - 81)) / 365) * Math.PI) / 180;
  const halfDay =
    (43200 / Math.PI) * Math.acos(-Math.tan((p.latitude * Math.PI) / 180) * Math.tan(declination));
  const span = Math.min(Math.abs(43200 - halfDay), halfDay);
  const t = seconds - 43200 + (p.offsetMinutes ?? 0) * 60;
  const k =
    p.mode === 'brightness-beta'
      ? ((p.speed ?? 0.3) * (p.smoothness ?? 0.9)) / span ** 0.7
      : 4.5 / span;
  const rising = (t - Math.abs(t)) / (2 * t) / (1 + Math.exp(-k * (t + halfDay)));
  const falling = (t + Math.abs(t)) / (2 * t) / (1 + Math.exp(k * (t - halfDay)));
  const weight = p.invert ? 1 - rising - falling : rising + falling;
  return Math.floor(p.min + (p.max - p.min) * weight);
}

test('packaged lighting calculations match source-derived golden values, including corrected noon', () => {
  const vectors = {
    'temperature:2026-06-21': [3224, 4577, 5297, 5391, 4577],
    'temperature:2026-10-15': [3210, 4060, 5144, 5375, 4060],
    'temperature:2026-12-21': [3208, 4015, 5134, 5375, 4015],
    'brightness:2026-06-21': [10, 66, 95, 99, 66],
    'brightness:2026-10-15': [10, 45, 89, 99, 45],
    'brightness:2026-12-21': [10, 43, 89, 99, 43],
    'brightness-beta:2026-06-21': [60, 85, 98, 99, 85],
    'brightness-beta:2026-10-15': [60, 74, 96, 99, 74],
    'brightness-beta:2026-12-21': [60, 74, 96, 99, 74],
  };
  for (const mode of modes) {
    for (const date of ['2026-06-21', '2026-10-15', '2026-12-21']) {
      const result = generateLightingFormula({ ...optionsFor(mode), date, sampleMinutes: 180 });
      const byTime = new Map(result.preview.samples.map((sample) => [sample.time, sample.value]));
      assert.deepEqual(
        ['00:00', '06:00', '09:00', '12:00', '18:00'].map((time) => byTime.get(time)),
        vectors[`${mode}:${date}`],
      );
      assert.equal(checkVarSetNumberExprString(result.expression).ok, true);
    }
  }
});

test('packaged expressions preserve the source double-branch curve off noon', () => {
  for (const mode of modes) {
    for (const latitude of [-50, 0, 23.129, 50]) {
      for (const date of ['2026-06-21', '2026-10-15', '2026-12-21']) {
        const options = { ...optionsFor(mode), latitude };
        const { expression } = generateLightingFormula(options);
        for (const seconds of [0, 21600, 32400, 43199, 43201, 64800, 86399]) {
          assert.equal(
            expressionAt(expression, date, seconds),
            originalSourceValue(options, date, seconds),
          );
        }
      }
    }
  }
});

test('packaged preview agrees with independent formula evaluation at polar and seasonal boundaries', () => {
  for (const mode of modes) {
    for (const latitude of [-75, -66.56, 0, 66.56, 75]) {
      for (const date of ['2026-03-21', '2026-06-21', '2026-09-21', '2026-12-21']) {
        const result = generateLightingFormula({
          ...optionsFor(mode),
          latitude,
          date,
          sampleMinutes: 60,
        });
        assert.equal(checkVarSetNumberExprString(result.expression).ok, true);
        for (const sample of result.preview.samples) {
          const value = expressionAt(
            result.expression,
            date,
            Number(sample.time.slice(0, 2)) * 3600,
          );
          assert.equal(value, sample.value);
          assert.ok(
            Number.isInteger(value) &&
              value >= result.parameters.min &&
              value <= result.parameters.max,
          );
        }
      }
    }
  }
  for (const [latitude, date, state] of [
    [75, '2026-06-21', 'polar-day'],
    [75, '2026-12-21', 'polar-night'],
    [-75, '2026-06-21', 'polar-night'],
    [-75, '2026-12-21', 'polar-day'],
  ]) {
    const result = generateLightingFormula({ ...optionsFor('brightness'), latitude, date });
    assert.equal(result.preview.solarDayState, state);
    assert.equal(result.preview.approximateSunrise, null);
    assert.equal(result.preview.approximateSunset, null);
  }
});

test('packaged beta controls preserve their offset direction and agree with preview', () => {
  const date = '2026-10-15';
  for (const speed of [0.1, 0.3, 20]) {
    for (const smoothness of [0.1, 0.9, 5]) {
      for (const offsetMinutes of [-180, 0, 180]) {
        for (const invert of [false, true]) {
          const result = generateLightingFormula({
            ...optionsFor('brightness-beta'),
            speed,
            smoothness,
            offsetMinutes,
            invert,
            date,
            sampleMinutes: 60,
          });
          for (const sample of result.preview.samples) {
            assert.equal(
              expressionAt(result.expression, date, Number(sample.time.slice(0, 2)) * 3600),
              sample.value,
            );
          }
        }
      }
    }
  }
  const base = generateLightingFormula(optionsFor('brightness-beta')).expression;
  const earlier = generateLightingFormula({
    ...optionsFor('brightness-beta'),
    offsetMinutes: 60,
  }).expression;
  const later = generateLightingFormula({
    ...optionsFor('brightness-beta'),
    offsetMinutes: -60,
  }).expression;
  assert.equal(expressionAt(earlier, date, 18000), expressionAt(base, date, 21600));
  assert.equal(expressionAt(later, date, 25200), expressionAt(base, date, 21600));
});

test('packaged calendar previews have stable endpoints and accept real leap days', () => {
  const base = optionsFor('brightness');
  const preview = generateLightingFormula({
    ...base,
    date: '2024-02-29',
    sampleMinutes: 1,
  }).preview;
  assert.equal(preview.samples.length, 1440);
  assert.equal(preview.samples[0].time, '00:00');
  assert.equal(preview.samples.at(-1).time, '23:59');
  assert.equal(preview.minimum, Math.min(...preview.samples.map((sample) => sample.value)));
  assert.equal(preview.maximum, Math.max(...preview.samples.map((sample) => sample.value)));
  assert.equal(
    generateLightingFormula({ ...base, date: '2000-02-29', sampleMinutes: 1440 }).preview.samples
      .length,
    1,
  );
  assert.equal(generateLightingFormula({ ...base, date: '2026-10-15' }).preview.samples.length, 48);
  assert.deepEqual(
    generateLightingFormula({ ...base, date: '2024-10-15' }).preview.samples,
    generateLightingFormula({ ...base, date: '2026-10-15' }).preview.samples,
  );
});

test('packaged metadata records normalized beta controls and permits zero/narrow brightness', () => {
  const result = generateLightingFormula(optionsFor('brightness-beta'));
  assert.deepEqual(result.parameters, {
    latitude: 23.129,
    min: 60,
    max: 100,
    speed: 0.3,
    smoothness: 0.9,
    offsetMinutes: 0,
    invert: false,
  });
  assert.equal(result.unit, 'percent');
  assert.equal(result.recommendedIntervalSeconds, 30);
  assert.equal(result.sourceUrl, 'https://lzj.ac.cn/tools/iot/miot-geek');
  assert.equal(result.preview, undefined);
  assert.match(result.warnings.join(' '), /not verified astronomy/);
  assert.equal(
    generateLightingFormula({ mode: 'temperature', latitude: 0, min: 2000, max: 2001 }).unit,
    'kelvin',
  );
  assert.equal(
    generateLightingFormula({ mode: 'brightness', latitude: -0, min: 0, max: 1 }).parameters
      .latitude,
    0,
  );
  assert.match(
    generateLightingFormula({ mode: 'brightness', latitude: -1e-10, min: 0, max: 100 }).expression,
    /\(0-1e-10\)/,
  );
});

test('packaged calculator rejects invalid options without returning stale formulas', () => {
  for (const invalid of [
    { mode: 'other' },
    { latitude: Number.NaN },
    { latitude: Number.POSITIVE_INFINITY },
    { latitude: -75.01 },
    { latitude: 75.01 },
    { latitude: '23.129oops' },
    { latitude: null },
    { min: -1 },
    { max: 101 },
    { min: 10.5 },
    { max: 90.5 },
    { min: 100 },
    { max: 10 },
    { speed: 0.3 },
    { smoothness: 0.9 },
    { offsetMinutes: 0 },
    { invert: false },
    { sampleMinutes: 30 },
    { date: '2026-10-15', sampleMinutes: 7 },
    { date: '2026-10-15', sampleMinutes: 0 },
    { date: '2026-10-15', sampleMinutes: 1441 },
    { date: '2026-10-15', sampleMinutes: 1.5 },
    { date: '2026-10-15', sampleMinutes: null },
    { date: '2026-02-29' },
    { date: '1900-02-29' },
    { date: '2026-04-31' },
    { date: '2026-13-01' },
    { date: '2026-00-01' },
    { date: '2026-01-00' },
    { date: '0000-01-01' },
    { date: '2026-1-1' },
    { date: '2026-10-15T00:00:00Z' },
    { date: null },
    { injected: 1 },
  ]) {
    assert.throws(
      () => generateLightingFormula({ ...optionsFor('brightness'), ...invalid }),
      ConfigError,
    );
  }
  for (const invalid of [
    { speed: 0.09 },
    { speed: 20.01 },
    { speed: null },
    { speed: Number.NaN },
    { smoothness: 0.09 },
    { smoothness: 5.01 },
    { smoothness: null },
    { offsetMinutes: -180.01 },
    { offsetMinutes: 180.01 },
    { offsetMinutes: null },
    { invert: 'false' },
    { invert: null },
  ]) {
    assert.throws(
      () => generateLightingFormula({ ...optionsFor('brightness-beta'), ...invalid }),
      ConfigError,
    );
  }
  for (const options of [
    null,
    undefined,
    [],
    'brightness',
    { mode: 'temperature', latitude: 0, min: 1999, max: 8000 },
    { mode: 'temperature', latitude: 0, min: 2000, max: 8001 },
  ]) {
    assert.throws(() => generateLightingFormula(options), ConfigError);
  }
});
