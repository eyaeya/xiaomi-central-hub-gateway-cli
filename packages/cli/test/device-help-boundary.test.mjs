import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

test('device help bounds the live-property claim to the audited client surface', () => {
  const result = spawnSync(process.execPath, [cliPath, 'device', '--help'], {
    cwd: packageRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /audited client\/bundle surface/);
  assert.match(result.stdout, /not a claim about every firmware-private API/);
  assert.doesNotMatch(result.stdout, /gateway exposes\s+no realtime device-property/i);
});

test('variable watch help uses modeled set-var cards without a firmware-global claim', () => {
  const result = spawnSync(process.execPath, [cliPath, 'variable', 'watch', '--help'], {
    cwd: packageRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /audited client\/bundle surface/);
  assert.match(result.stdout, /deviceInputSetVar \(on change\)/);
  assert.match(result.stdout, /deviceGetSetVar \(on demand\)/);
  assert.match(result.stdout, /does not rule out firmware-private APIs/);
  assert.doesNotMatch(result.stdout, /gateway has no read-device-property RPC/i);
});
