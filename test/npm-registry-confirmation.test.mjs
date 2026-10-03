import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const workflow = await readFile(
  new URL('../.github/workflows/publish-npm.yml', import.meta.url),
  'utf8',
);
const embedded = workflow.match(
  /cat > "\$RUNNER_TEMP\/xgg-confirm-npm\.mjs" <<'NODE'\n([\s\S]*?)\n {10}NODE/,
);
assert.ok(embedded, 'confirmation must be self-contained for dispatching older release tags');
const source = embedded[1].replace(/^ {10}/gm, '');
const { confirmPackages, readPackage } = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
);
const version = '2.1.1';

function fakeClock() {
  let elapsed = 0;
  return {
    now: () => elapsed,
    sleep: async (milliseconds) => {
      elapsed += milliseconds;
    },
  };
}

function metadata(name) {
  return {
    version,
    ...(name === '@eyaeya/xgg-cli' ? { dependencies: { '@eyaeya/xgg-core': `^${version}` } } : {}),
  };
}

test('confirmation allows npm processing longer than the old one-minute window', async () => {
  const clock = fakeClock();
  const messages = [];
  let attempts = 0;
  await confirmPackages(version, {
    ...clock,
    log: (message) => messages.push(message),
    lookup: async (name) => {
      attempts += 1;
      return clock.now() < 130_000
        ? { error: 'version not visible' }
        : { metadata: metadata(name) };
    },
  });
  assert.equal(clock.now(), 130_000);
  assert.equal(attempts, 14);
  assert.match(messages.at(-1), /Confirmed/);
});

test('both packages and the exact core dependency must become visible', async () => {
  const clock = fakeClock();
  const visited = [];
  await confirmPackages(version, {
    ...clock,
    includeCli: true,
    log: () => {},
    lookup: async (name) => {
      visited.push(name);
      if (name === '@eyaeya/xgg-core' && clock.now() < 10_000) {
        return { metadata: { version: '2.1.0' } };
      }
      if (name === '@eyaeya/xgg-cli' && clock.now() < 20_000) {
        return { metadata: { version, dependencies: { '@eyaeya/xgg-core': '^2.1.0' } } };
      }
      return { metadata: metadata(name) };
    },
  });
  assert.equal(clock.now(), 20_000);
  assert.deepEqual(visited, Array(3).fill(['@eyaeya/xgg-core', '@eyaeya/xgg-cli']).flat());
});

test('invisible releases fail at the ten-minute wall deadline', async () => {
  const clock = fakeClock();
  await assert.rejects(
    confirmPackages(version, {
      ...clock,
      log: () => {},
      lookup: async () => ({ error: 'version not visible' }),
    }),
    /timed out after 600s.*version not visible/,
  );
  assert.equal(clock.now(), 600_000);
});

test('slow requests share the wall deadline and each receives a bounded timeout', async () => {
  const clock = fakeClock();
  const budgets = [];
  await assert.rejects(
    confirmPackages(version, {
      ...clock,
      includeCli: true,
      timeoutMs: 25_000,
      log: () => {},
      lookup: async (_name, _version, timeoutMs) => {
        budgets.push(timeoutMs);
        await clock.sleep(timeoutMs);
        return { error: 'registry request timed out' };
      },
    }),
    /timed out after 25s.*registry request timed out/,
  );
  assert.deepEqual(budgets, [15_000, 10_000]);
  assert.equal(clock.now(), 25_000);
});

test('npm failures retain useful categories without exposing raw stdout or stderr', () => {
  for (const [code, expected] of [
    ['E404', 'version not visible'],
    ['E401', 'registry authentication failed'],
    ['E403', 'registry access denied'],
    ['E429', 'registry rate limited'],
    ['ETIMEDOUT', 'registry request timed out'],
    ['PRIVATE_TOKEN', 'registry request failed'],
  ]) {
    const result = readPackage('@eyaeya/xgg-core', version, 15_000, () => ({
      status: 1,
      stdout: JSON.stringify({ error: { code, summary: 'SECRET_TOKEN' } }),
      stderr: 'SECRET_TOKEN',
    }));
    assert.deepEqual(result, { error: expected });
  }
  assert.deepEqual(
    readPackage('@eyaeya/xgg-core', version, 15_000, () => ({
      status: 0,
      stdout: 'SECRET_TOKEN is not valid JSON',
    })),
    { error: 'invalid registry metadata' },
  );
});

test('embedded helper runs through a symlink independently of release source files', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'xgg-registry-confirmation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const helperPath = join(directory, 'xgg-confirm-npm.mjs');
  await writeFile(helperPath, source);
  const helperLink = join(directory, 'helper-link.mjs');
  await symlink(helperPath, helperLink);
  await writeFile(
    join(directory, 'npm'),
    `#!/usr/bin/env node
const cli = process.argv[3].includes('xgg-cli');
console.log(JSON.stringify({ version: '${version}', ...(cli ? {
  dependencies: { '@eyaeya/xgg-core': '^${version}' }
} : {}) }));
`,
    { mode: 0o700 },
  );
  const result = spawnSync(process.execPath, [helperLink, version, 'all'], {
    cwd: directory,
    env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Confirmed @eyaeya\/xgg-core and @eyaeya\/xgg-cli@2\.1\.1/);
});

test('the npm subprocess is killed when its request timeout expires', () => {
  const result = readPackage('@eyaeya/xgg-core', version, 100, (_command, _args, options) =>
    spawnSync(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options),
  );
  assert.deepEqual(result, { error: 'registry request timed out' });
});
