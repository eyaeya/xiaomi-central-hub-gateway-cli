import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ConfigError, login } from '../dist/index.js';

const ready = {
  pid: 1234,
  socketPath: '/tmp/xgg-login-test.sock',
  agentStartedAt: '2026-07-18T00:00:00.000Z',
  agentVersion: 'test',
};

function loginInput(overrides = {}) {
  return {
    baseUrl: 'http://192.0.2.10:8086',
    passcode: '654321',
    agentBinary: { binary: 'node', args: ['cli.js'] },
    ...overrides,
  };
}

test('login rejects URL userinfo before spawning or writing a session file', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'xgg-login-userinfo-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sessionFile = join(dir, 'session.json');
  let spawnCalls = 0;

  await assert.rejects(
    login(
      loginInput({
        baseUrl: 'http://alice:placeholder-secret@192.0.2.10:8086',
        sessionFile,
        spawn: async () => {
          spawnCalls += 1;
          await writeFile(sessionFile, 'spawned');
          return ready;
        },
      }),
    ),
    (error) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.code, 'CONFIG');
      assert.equal(error.message, 'base-url must not include username or password');
      assert.doesNotMatch(error.message, /alice|placeholder-secret/);
      return true;
    },
  );

  assert.equal(spawnCalls, 0);
  await assert.rejects(access(sessionFile), (error) => error?.code === 'ENOENT');
});

test('login uses structured validation for malformed and non-http URLs', async () => {
  let spawnCalls = 0;
  const spawn = async () => {
    spawnCalls += 1;
    return ready;
  };

  for (const baseUrl of ['http://', 'not a URL', 'ftp://192.0.2.10:8086']) {
    await assert.rejects(
      login(loginInput({ baseUrl, spawn })),
      (error) =>
        error instanceof ConfigError &&
        error.code === 'CONFIG' &&
        /http\(s\) URL/.test(error.message),
    );
  }

  assert.equal(spawnCalls, 0);
});

test('login canonicalizes an allowed base URL before spawning and returning', async () => {
  let spawnOptions;
  const input = loginInput({
    baseUrl: 'http://192.0.2.10:8086/ignored/path?source=test',
    spawn: async (options) => {
      spawnOptions = options;
      return ready;
    },
  });

  const result = await login(input);

  assert.equal(result.host, 'http://192.0.2.10:8086');
  assert.deepEqual(spawnOptions.args.slice(-4), [
    'agent',
    'serve',
    '--host',
    'http://192.0.2.10:8086',
  ]);
});
