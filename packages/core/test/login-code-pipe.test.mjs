import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { AuthRequiredError, ConfigError, NetworkError, login, spawnAgent } from '../dist/index.js';

const loginCode = '739251';
const ready = {
  pid: 1234,
  socketPath: '/tmp/xgg-login-code-test.sock',
  agentStartedAt: '2026-07-19T00:00:00.000Z',
  agentVersion: 'test',
};

const holdingChildSource = String.raw`
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  const payload = Buffer.concat(chunks);
  const valid = /^\d{6,8}$/.test(payload.toString('utf8'));
  payload.fill(0);
  for (const chunk of chunks) chunk.fill(0);
  if (!valid) process.exit(9);
  process.stdout.write('READY ' + JSON.stringify({
    socketPath: '/tmp/xgg-login-code-test.sock',
    agentStartedAt: '2026-07-19T00:00:00.000Z',
    agentVersion: 'test',
  }) + '\n');
  setInterval(() => {}, 1000);
});
`;

function stopChild(pid) {
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

async function spawnHoldingChild(t) {
  const result = await spawnAgent({
    binary: process.execPath,
    args: ['--eval', holdingChildSource],
    passcode: loginCode,
    env: { ...process.env, xgg_login_code: loginCode },
    readyTimeoutMs: 2_000,
  });
  t.after(() => stopChild(result.pid));
  return result;
}

test('login keeps the code out of detached child args and env options', async () => {
  let spawnOptions;

  const result = await login({
    baseUrl: 'http://192.0.2.10:8086',
    passcode: loginCode,
    agentBinary: { binary: 'node', args: ['cli.js'] },
    spawn: async (options) => {
      spawnOptions = options;
      return ready;
    },
  });

  assert.equal(result.pid, ready.pid);
  assert.equal(spawnOptions.passcode, loginCode);
  assert.equal(spawnOptions.env, undefined);
  assert.equal(
    spawnOptions.args.some((arg) => arg.includes(loginCode)),
    false,
  );
});

test('spawnAgent delivers the login code through the one-shot stdin pipe', async (t) => {
  const result = await spawnHoldingChild(t);
  assert.equal(result.socketPath, ready.socketPath);
});

test('spawnAgent strips launch injection keys while preserving runtime environment', async (t) => {
  const expectedPath = process.env.PATH ?? '';
  const childSource = String.raw`
const forbidden = new Set([
  'XGG_LOGIN_CODE',
  'XGG_AGENT_BINARY',
  'XGG_AGENT_ARGS',
  'NODE_OPTIONS',
  'NODE_PATH',
  'LD_PRELOAD',
  'LD_AUDIT',
  'LD_LIBRARY_PATH',
]);
const leaked = Object.keys(process.env)
  .map((key) => key.toUpperCase())
  .filter((key) => key.startsWith('DYLD_') || forbidden.has(key));
if (leaked.length > 0) {
  process.stderr.write('forbidden detached Agent environment key leaked\n');
  process.exit(10);
}
if ((process.env.PATH ?? '') !== ${JSON.stringify(expectedPath)}) process.exit(11);
if (process.env.XGG_SESSION_FILE !== 'preserved-session.json') process.exit(12);
if (process.env.XDG_RUNTIME_DIR !== 'preserved-runtime') process.exit(13);
if (process.env.HOME !== 'preserved-home') process.exit(14);
if (process.env.USERPROFILE !== 'preserved-profile') process.exit(15);
if (process.env.TMPDIR !== 'preserved-tmpdir') process.exit(16);
if (process.env.TEMP !== 'preserved-temp') process.exit(17);
if (process.env.TMP !== 'preserved-tmp') process.exit(18);
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  const payload = Buffer.concat(chunks);
  const valid = /^\d{6,8}$/.test(payload.toString('utf8'));
  payload.fill(0);
  for (const chunk of chunks) chunk.fill(0);
  if (!valid) process.exit(19);
  process.stdout.write('READY ' + JSON.stringify({
    socketPath: '/tmp/xgg-agent-env-test.sock',
    agentStartedAt: '2026-07-19T00:00:00.000Z',
    agentVersion: 'test',
  }) + '\n');
  setInterval(() => {}, 1000);
});
`;

  const result = await spawnAgent({
    binary: process.execPath,
    args: ['--eval', childSource],
    passcode: loginCode,
    env: {
      ...process.env,
      xgg_login_code: loginCode,
      xgg_agent_binary: '/poison/agent',
      XgG_AgEnT_aRgS: '--poison',
      NODE_OPTIONS: `--require=xgg-node-options-must-not-load-${process.pid}`,
      nOdE_pAtH: '/poison/modules',
      DYLD_INSERT_LIBRARIES: '',
      dYlD_FaLlBaCk_LiBrArY_pAtH: '/poison/libraries',
      LD_PRELOAD: '',
      lD_aUdIt: '',
      LD_LIBRARY_PATH: '/poison/libraries',
      PATH: expectedPath,
      XGG_SESSION_FILE: 'preserved-session.json',
      XDG_RUNTIME_DIR: 'preserved-runtime',
      HOME: 'preserved-home',
      USERPROFILE: 'preserved-profile',
      TMPDIR: 'preserved-tmpdir',
      TEMP: 'preserved-temp',
      TMP: 'preserved-tmp',
    },
    readyTimeoutMs: 2_000,
  });
  t.after(() => stopChild(result.pid));

  assert.equal(result.socketPath, '/tmp/xgg-agent-env-test.sock');
});

test('spawnAgent rejects malformed direct-call passcodes before spawning', async () => {
  for (const passcode of ['', '12345', '123456789', '12a456']) {
    await assert.rejects(
      spawnAgent({
        binary: '/definitely/not/a/real/binary',
        args: [],
        passcode,
      }),
      (error) =>
        error instanceof ConfigError &&
        error.message === 'agent login code must contain 6–8 digits',
    );
  }
});

test(
  'detached child process listings do not expose the piped login code',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const result = await spawnHoldingChild(t);
    const processListing = execFileSync(
      '/bin/ps',
      ['eww', '-p', String(result.pid), '-o', 'command='],
      { encoding: 'utf8' },
    );

    assert.doesNotMatch(processListing, new RegExp(loginCode));
  },
);

test('spawnAgent preserves authentication error mapping with piped input', async () => {
  const childSource = String.raw`
process.stdin.resume();
process.stdin.on('end', () => {
  process.stderr.write(JSON.stringify({
    ok: false,
    error: { code: 'AUTH_REQUIRED', message: 'fresh code required' },
  }) + '\n');
  process.exit(3);
});
`;

  await assert.rejects(
    spawnAgent({
      binary: process.execPath,
      args: ['--eval', childSource],
      passcode: loginCode,
      readyTimeoutMs: 2_000,
    }),
    (error) => error instanceof AuthRequiredError && error.message === 'fresh code required',
  );
});

test('spawnAgent preserves the READY timeout with piped input', async () => {
  const childSource = String.raw`
process.stdin.resume();
process.stdin.on('end', () => setInterval(() => {}, 1000));
`;

  await assert.rejects(
    spawnAgent({
      binary: process.execPath,
      args: ['--eval', childSource],
      passcode: loginCode,
      readyTimeoutMs: 200,
    }),
    (error) =>
      error instanceof NetworkError && error.message === 'agent did not signal READY within 200ms',
  );
});
