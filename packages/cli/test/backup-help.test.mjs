import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

test('backup config set help shows the retention flag in the guarded write example', () => {
  const result = spawnSync(process.execPath, [cliPath, 'backup', 'config', 'set', '--help'], {
    cwd: packageRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const help = result.stdout.replace(/\s+/g, ' ');

  assert.match(help, /--auto-backup-limit <n>/);
  assert.match(
    help,
    /Example: \$ xgg backup config set --from fds --auto-backup true --auto-backup-limit <N> --snapshots-dir \.\/snapshots\//,
  );
  assert.match(help, /Set backup configuration \(writes snapshot first\)/);
});
