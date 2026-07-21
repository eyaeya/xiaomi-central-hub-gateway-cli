import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

test('device help bounds the live-property claim to the current xgg surface', () => {
  const result = spawnSync(process.execPath, [cliPath, 'device', '--help'], {
    cwd: packageRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /current xgg modeled client surface/);
  assert.match(result.stdout, /not a claim about every\s+firmware-private API/);
  assert.doesNotMatch(result.stdout, /\b(?:GUIDE\.md|Bundle|ai-config[\w.-]*\.js)\b/i);
  assert.doesNotMatch(result.stdout, /gateway exposes\s+no realtime device-property/i);
});

test('device get help describes its human-readable type-semantic view accurately', () => {
  const result = spawnSync(process.execPath, [cliPath, 'device', 'get', '--help'], {
    cwd: packageRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const help = result.stdout.replace(/\s+/g, ' ');
  assert.match(
    help,
    /--pretty human-readable device metadata with stable type token and zh_cn description/,
  );
  assert.doesNotMatch(help, /pretty-print JSON output/);
});

test('variable watch help uses modeled set-var cards without a firmware-global claim', () => {
  const result = spawnSync(process.execPath, [cliPath, 'variable', 'watch', '--help'], {
    cwd: packageRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /current xgg modeled client surface/);
  assert.match(result.stdout, /deviceInputSetVar \(on change\)/);
  assert.match(result.stdout, /deviceGetSetVar \(on demand\)/);
  assert.match(result.stdout, /does not rule out firmware-private APIs/);
  assert.doesNotMatch(result.stdout, /\b(?:GUIDE\.md|Bundle|ai-config[\w.-]*\.js)\b/i);
  assert.doesNotMatch(result.stdout, /gateway has no read-device-property RPC/i);
});

test('rule logs help bounds parsed entries without claiming raw or complete output', () => {
  const result = spawnSync(process.execPath, [cliPath, 'rule', 'logs', '--help'], {
    cwd: packageRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const help = result.stdout.replace(/\s+/g, ' ');
  assert.match(help, /successfully parsed entries from a bounded gateway log fetch/);
  assert.match(help, /Empty output alone does not prove that a rule never triggered/);
  assert.match(help, /does not expose unparsed rows, cursor wrap, or scan completeness/);
  assert.match(
    help,
    /emit one JSON envelope; --follow then emits each new entry as one NDJSON line/,
  );
  assert.match(
    help,
    /first line is the initial envelope and each later line is one newly observed entry/,
  );
  assert.doesNotMatch(
    help,
    /RAW log rows|raw payload|raw parsed JSON array|richer\/looser output/i,
  );
});
