import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const baseArgs = ['brightness', '--latitude', '23.129', '--min', '10', '--max', '100'];
// Exit immediately rather than throwing: the updater intentionally catches network errors.
// A hidden request must fail this test even if the caller would otherwise suppress it.
const noNetworkHook = `data:text/javascript,${encodeURIComponent(`
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
const forbidden = () => { process.stderr.write('Unexpected network access'); process.exit(89); };
globalThis.fetch = forbidden;
http.request = http.get = https.request = https.get = forbidden;
net.connect = net.createConnection = forbidden;
syncBuiltinESMExports();
`)}`;

function run(args) {
  return spawnSync(
    process.execPath,
    ['--import', noNetworkHook, cliPath, 'light', 'formula', ...args],
    {
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        XGG_AGENT_MODE: '1',
        XGG_BASE_URL: 'http://gateway.invalid:8086',
        XGG_AUTO_UPDATE: '1',
        XGG_UPDATE_HANDOFF: '0',
        CI: 'false',
      },
    },
  );
}

function success(args) {
  const result = run(args);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout;
}

test('packaged CLI calculates all modes offline in agent mode without snapshots', () => {
  for (const [mode, min, max, unit] of [
    ['temperature', '3200', '5400', 'kelvin'],
    ['brightness', '0', '100', 'percent'],
    ['brightness-beta', '0', '100', 'percent'],
  ]) {
    const output = success([mode, '--latitude', '23.129', '--min', min, '--max', max]);
    const result = JSON.parse(output);
    assert.equal(result.ok, true);
    assert.equal(result.mode, mode);
    assert.equal(result.unit, unit);
    assert.equal(result.recommendedIntervalSeconds, 30);
    assert.match(result.expression, /floor\(/);
    assert.equal(result.preview, undefined);
    assert.equal(output.split('\n').length, 2);
  }
});

test('preview uses explicit local calendar samples and source-derived values', () => {
  const result = JSON.parse(
    success([...baseArgs, '--date', '2026-10-15', '--sample-minutes', '360']),
  );
  assert.deepEqual(result.preview.samples, [
    { time: '00:00', value: 10 },
    { time: '06:00', value: 45 },
    { time: '12:00', value: 99 },
    { time: '18:00', value: 45 },
  ]);
  assert.equal(result.preview.minimum, 10);
  assert.equal(result.preview.maximum, 99);
  assert.equal(result.preview.date, '2026-10-15');
});

test('beta controls are normalized and expression-only is exactly one line', () => {
  const args = [
    'brightness-beta',
    '--latitude',
    '-23.129',
    '--min',
    '0',
    '--max',
    '100',
    '--speed',
    '.5',
    '--smoothness',
    '1.2',
    '--offset-minutes',
    '-30',
    '--invert',
  ];
  const result = JSON.parse(success(args));
  assert.deepEqual(result.parameters, {
    latitude: -23.129,
    min: 0,
    max: 100,
    speed: 0.5,
    smoothness: 1.2,
    offsetMinutes: -30,
    invert: true,
  });
  assert.equal(success([...args, '--expression-only']), `${result.expression}\n`);
});

test('pretty output and help explain the calculation boundary and units', () => {
  const pretty = success([
    ...baseArgs,
    '--date',
    '2026-10-15',
    '--sample-minutes',
    '360',
    '--pretty',
  ]);
  assert.match(pretty, /Range: 10–100 %/);
  assert.match(pretty, /Warnings:/);
  assert.match(pretty, /12:00\t99/);
  const help = success(['--help']).replace(/\s+/g, ' ');
  assert.match(help, /no login, network, automatic update, device write/);
  assert.match(help, /larger is steeper/);
  assert.match(help, /positive shifts earlier/);
  assert.match(help, /Brightness output is percent/);
});

test('invalid calculation input emits only CONFIG error JSON with actionable offline help', () => {
  for (const args of [
    ['unknown', ...baseArgs.slice(1)],
    [...baseArgs, '--latitude', '23north'],
    [...baseArgs, '--latitude', '0x10'],
    [...baseArgs, '--latitude', 'NaN'],
    [...baseArgs, '--min', '10.2'],
    [...baseArgs, '--speed', '0.3'],
    [...baseArgs, '--invert'],
    [...baseArgs, '--sample-minutes', '30'],
    [...baseArgs, '--date', '2026-02-30'],
    [...baseArgs, '--date', '2026-10-15', '--sample-minutes', '17'],
    [...baseArgs, '--expression-only', '--pretty'],
  ]) {
    const result = run(args);
    assert.equal(result.status, 5, `${args.join(' ')}: ${result.stderr}`);
    assert.equal(result.stdout, '');
    const error = JSON.parse(result.stderr);
    assert.equal(error.ok, false);
    assert.equal(error.error.code, 'CONFIG');
    assert.match(error.error.hint, /xgg light formula --help/);
    assert.doesNotMatch(error.error.hint, /Check --base-url/);
  }
});

test('boolean invert and required input options cannot silently accept extra values', () => {
  for (const args of [
    ['brightness-beta', ...baseArgs.slice(1), '--invert', 'false'],
    ['brightness', '--min', '10', '--max', '100'],
  ]) {
    const result = run(args);
    assert.equal(result.status, 5, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error.code, 'CONFIG');
  }
});
