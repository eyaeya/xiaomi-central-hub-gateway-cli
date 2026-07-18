import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  NotConfirmedError,
  createIpcServer,
  waitForBackupProgress,
} from '../../core/dist/index.js';
import { errorToExit, formatErrorJson } from '../dist/errors.js';

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const testHost = 'http://backup-lifecycle.test';
const agentStartedAt = '2026-07-19T00:00:00.000Z';

function endpointPath(dir) {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\xgg-backup-lifecycle-${process.pid}-${randomUUID()}`;
  }
  return join(dir, 'agent.sock');
}

async function startFakeAgent(t) {
  const dir = await mkdtemp(join(tmpdir(), 'xgg-backup-lifecycle-'));
  const socketPath = endpointPath(dir);
  const sessionFile = join(dir, 'session.json');
  const snapshotsDir = join(dir, 'snapshots');
  const calls = [];
  await mkdir(snapshotsDir);

  const server = await createIpcServer({
    path: socketPath,
    handler: async (request) => {
      calls.push(request);
      switch (request.method) {
        case '$ping':
          return { host: testHost, agentStartedAt };
        case '/api/getDevList':
          return { devList: {} };
        case '/api/getGraphList':
          return [];
        case '/api/getVarScopeList':
          return { scopes: [] };
        case '/api/getBackupProgress':
          await new Promise((resolve) => setTimeout(resolve, 5));
          return { progress: 42 };
        default:
          return { progress_id: 7 };
      }
    },
  });

  await writeFile(
    sessionFile,
    JSON.stringify({
      version: 2,
      sessions: {
        [testHost]: {
          host: testHost,
          pid: process.pid,
          socketPath,
          agentStartedAt,
          agentVersion: 'test',
          lastValidatedAt: agentStartedAt,
        },
      },
    }),
  );

  t.after(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  return { calls, sessionFile, snapshotsDir };
}

function runCli(args, sessionFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: {
        ...process.env,
        XGG_AGENT_MODE: '0',
        XGG_BASE_URL: testHost,
        XGG_NO_NEXT_HINT: '1',
        XGG_NO_REFRESH_HINT: '1',
        XGG_SESSION_FILE: sessionFile,
        XGG_SNAPSHOTS_DIR: '',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function assertJsonFailure(result, code, status) {
  assert.equal(result.status, status);
  assert.equal(result.stdout, '');
  const lines = result.stderr.trimEnd().split('\n');
  assert.equal(lines.length, 1, `expected one stderr line, got ${result.stderr}`);
  const payload = JSON.parse(lines[0]);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, code);
  return payload;
}

test('backup poll flags reject non-canonical or out-of-range values before any RPC', async (t) => {
  const fake = await startFakeAgent(t);
  const invalidValues = ['nope', '0', '-1', '1.5', 'Infinity', '1e3', '0x10', '2147483648'];

  for (const flag of ['--poll-interval-ms', '--poll-timeout-ms']) {
    for (const value of invalidValues) {
      fake.calls.length = 0;
      const result = await runCli(
        ['backup', 'create', '--file-name', 'probe', '--wait', `${flag}=${value}`],
        fake.sessionFile,
      );
      const payload = assertJsonFailure(result, 'CONFIG', 5);
      assert.match(payload.error.message, /positive decimal integer/);
      assert.deepEqual(fake.calls, [], `${flag}=${value} made an RPC`);
    }
  }
});

test('create, download, and load validate wait options before gateway or snapshot work', async (t) => {
  const fake = await startFakeAgent(t);
  const commands = [
    ['backup', 'create', '--file-name', 'probe'],
    ['backup', 'download', '--did', 'd', '--ts', 't', '--file-name', 'f'],
    [
      'backup',
      'load',
      '--did',
      'd',
      '--ts',
      't',
      '--file-name',
      'f',
      '--snapshots-dir',
      fake.snapshotsDir,
    ],
  ];

  for (const command of commands) {
    fake.calls.length = 0;
    const result = await runCli([...command, '--wait', '--poll-timeout-ms=nope'], fake.sessionFile);
    assertJsonFailure(result, 'CONFIG', 5);
    assert.deepEqual(fake.calls, [], `${command.slice(0, 2).join(' ')} made an RPC`);
    assert.deepEqual(await readdir(fake.snapshotsDir), []);
  }

  fake.calls.length = 0;
  const withoutWait = await runCli(
    [
      'backup',
      'create',
      '--file-name',
      'probe',
      '--poll-interval-ms=1000',
      '--poll-timeout-ms=60000',
    ],
    fake.sessionFile,
  );
  const payload = assertJsonFailure(withoutWait, 'CONFIG', 5);
  assert.match(payload.error.message, /require --wait/);
  assert.deepEqual(fake.calls, []);
});

test('backup polling timeout is NotConfirmed with actionable details and exit 2', async (t) => {
  const fake = await startFakeAgent(t);
  const result = await runCli(
    [
      'backup',
      'create',
      '--file-name',
      'probe',
      '--wait',
      '--poll-interval-ms=1',
      '--poll-timeout-ms=1',
    ],
    fake.sessionFile,
  );
  const payload = assertJsonFailure(result, 'NOT_CONFIRMED', 2);
  assert.match(payload.error.hint, /backup progress/);
  assert.deepEqual(payload.error.details, {
    operation: 'backup.create',
    from: 'fds',
    progressId: 7,
    lastProgress: 42,
    pollTimeoutMs: 1,
  });
  assert.deepEqual(
    fake.calls.filter(({ method }) => method !== '$ping').map(({ method }) => method),
    ['/api/createBackup', '/api/getBackupProgress'],
  );
});

test('waitForBackupProgress exposes NotConfirmedError to the CLI exit mapper', async () => {
  await assert.rejects(
    waitForBackupProgress(
      { from: 'fds', progressId: 9, operation: 'backup.download' },
      { baseUrl: testHost, store: {} },
      {
        pollIntervalMs: 1,
        pollTimeoutMs: 1,
        _getBackupProgress: async () => {
          await new Promise((resolve) => setTimeout(resolve, 2));
          return { progress: 17 };
        },
      },
    ),
    (error) => {
      assert.ok(error instanceof NotConfirmedError);
      error.__xggCmd = 'backup.download';
      assert.equal(errorToExit(error).code, 2);
      const payload = formatErrorJson(error);
      assert.equal(payload.error.code, 'NOT_CONFIRMED');
      assert.match(payload.error.hint, /backup progress/);
      assert.deepEqual(payload.error.details, {
        operation: 'backup.download',
        from: 'fds',
        progressId: 9,
        lastProgress: 17,
        pollTimeoutMs: 1,
      });
      return true;
    },
  );
});
