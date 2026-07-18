import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

test('package root import is side-effect free', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      "const api = await import('@eyaeya/xgg-cli'); console.log(typeof api.buildProgram);",
    ],
    { cwd: packageRoot, encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'function\n');
  assert.equal(result.stderr, '');
});
