import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs, constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const storeModuleUrl = new URL('../dist/session/store.js', import.meta.url).href;
const testTimeout = { timeout: 15_000 };
const workerSource = String.raw`
  import { constants as fsConstants, promises as fs } from 'node:fs';

  const { SessionStore } = await import(process.env.XGG_STORE_MODULE_URL);
  const action = JSON.parse(process.env.XGG_STORE_ACTION);
  process.stdout.write('READY\n');
  while (true) {
    try {
      await fs.access(process.env.XGG_STORE_START_FILE, fsConstants.F_OK);
      break;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }

  const store = new SessionStore({ path: process.env.XGG_SESSION_FILE });
  if (action.type === 'write') {
    await store.write(action.session);
  } else {
    await store.delete(action.host);
  }
`;

test(
  'serializes concurrent writes across processes and atomically preserves every host',
  testTimeout,
  async (t) => {
    const directory = await fs.mkdtemp(join(tmpdir(), 'xgg-session-write-race-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const sessionFile = join(directory, 'session.json');
    const sessions = Array.from({ length: 16 }, (_, index) => makeSession(index + 1));
    const parseErrors = [];
    let observe = true;
    const observer = observeJsonFile(sessionFile, parseErrors, () => observe);

    await runWorkers(
      directory,
      sessionFile,
      sessions.map((session) => ({ type: 'write', session })),
    );
    observe = false;
    await observer;

    const parsed = JSON.parse(await fs.readFile(sessionFile, 'utf8'));
    assert.equal(parsed.version, 2);
    assert.deepEqual(Object.keys(parsed.sessions).sort(), sessions.map(({ host }) => host).sort());
    assert.deepEqual(parseErrors, []);
    await assertPrivateAtomicResult(directory, sessionFile);
  },
);

test(
  'serializes concurrent writes and deletes without losing or resurrecting sessions',
  testTimeout,
  async (t) => {
    const directory = await fs.mkdtemp(join(tmpdir(), 'xgg-session-delete-race-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const sessionFile = join(directory, 'session.json');
    const oldSessions = Array.from({ length: 8 }, (_, index) => makeSession(index + 1));
    const newSessions = Array.from({ length: 8 }, (_, index) => makeSession(index + 101));
    await fs.writeFile(
      sessionFile,
      JSON.stringify({
        version: 2,
        sessions: Object.fromEntries(oldSessions.map((session) => [session.host, session])),
      }),
      { mode: 0o600 },
    );

    await runWorkers(directory, sessionFile, [
      ...oldSessions.map(({ host }) => ({ type: 'delete', host })),
      ...newSessions.map((session) => ({ type: 'write', session })),
    ]);

    const parsed = JSON.parse(await fs.readFile(sessionFile, 'utf8'));
    assert.deepEqual(
      Object.keys(parsed.sessions).sort(),
      newSessions.map(({ host }) => host).sort(),
    );
    await assertPrivateAtomicResult(directory, sessionFile);
  },
);

test(
  'coordinates competing recovery attempts for a dead owner despite clock skew',
  testTimeout,
  async (t) => {
    const directory = await fs.mkdtemp(join(tmpdir(), 'xgg-session-stale-lock-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const sessionFile = join(directory, 'session.json');
    const lockDirectory = `${sessionFile}.lock`;
    const expiredToken = '00000000-0000-4000-8000-000000000001';
    await fs.mkdir(lockDirectory, { mode: 0o700 });
    await fs.writeFile(
      join(lockDirectory, `owner-${expiredToken}.json`),
      JSON.stringify({
        token: expiredToken,
        pid: await exitedChildPid(),
        createdAt: '2099-01-01T00:00:00.000Z',
      }),
      { mode: 0o600 },
    );

    const sessions = Array.from({ length: 8 }, (_, index) => makeSession(index + 1));
    await runWorkers(
      directory,
      sessionFile,
      sessions.map((session) => ({ type: 'write', session })),
    );

    const parsed = JSON.parse(await fs.readFile(sessionFile, 'utf8'));
    assert.deepEqual(Object.keys(parsed.sessions).sort(), sessions.map(({ host }) => host).sort());
    await assert.rejects(fs.access(lockDirectory, fsConstants.F_OK), { code: 'ENOENT' });
  },
);

test('does not reclaim an old lock while its owner PID is still alive', testTimeout, async (t) => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'xgg-session-live-lock-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sessionFile = join(directory, 'session.json');
  const lockDirectory = `${sessionFile}.lock`;
  const liveToken = '00000000-0000-4000-8000-000000000002';
  const ownerFile = join(lockDirectory, `owner-${liveToken}.json`);
  await fs.mkdir(lockDirectory, { mode: 0o700 });
  await fs.writeFile(
    ownerFile,
    JSON.stringify({
      token: liveToken,
      pid: process.pid,
      createdAt: '2000-01-01T00:00:00.000Z',
    }),
    { mode: 0o600 },
  );

  const { SessionStore } = await import(storeModuleUrl);
  const pendingWrite = new SessionStore({ path: sessionFile }).write(makeSession(1));
  pendingWrite.catch(() => {});
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    await fs.access(ownerFile, fsConstants.F_OK);
    await assert.rejects(fs.access(sessionFile, fsConstants.F_OK), { code: 'ENOENT' });
  } finally {
    await fs.unlink(ownerFile).catch(() => {});
    await fs.rmdir(lockDirectory).catch(() => {});
  }
  await pendingWrite;
  await assertPrivateAtomicResult(directory, sessionFile);
});

test(
  'revalidates ownership after a stale reclaimer replaces the lock directory',
  testTimeout,
  async (t) => {
    const directory = await fs.mkdtemp(join(tmpdir(), 'xgg-session-lock-aba-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const sessionFile = join(directory, 'session.json');
    const mutationSessionFile = join(await fs.realpath(directory), 'session.json');
    const lockDirectory = `${mutationSessionFile}.lock`;
    const { SessionStore } = await import(storeModuleUrl);
    const originalRename = fs.rename;
    const firstOwnerReached = deferred();
    const resumeFirstOwner = deferred();
    const replacementRenameReached = deferred();
    const resumeReplacementRename = deferred();
    let ownerPublishCount = 0;
    let renameBlocked = false;
    let firstSettled = false;
    let firstWrite;
    let replacementWrite;

    fs.rename = async (from, to) => {
      if (String(to).startsWith(`${lockDirectory}/owner-`)) {
        ownerPublishCount += 1;
        if (ownerPublishCount === 1) {
          firstOwnerReached.resolve();
          await resumeFirstOwner.promise;
        }
      }
      if (!renameBlocked && to === mutationSessionFile) {
        renameBlocked = true;
        replacementRenameReached.resolve();
        await resumeReplacementRename.promise;
      }
      return originalRename.call(fs, from, to);
    };

    try {
      firstWrite = new SessionStore({ path: sessionFile }).write(makeSession(1));
      firstWrite.then(
        () => {
          firstSettled = true;
        },
        () => {
          firstSettled = true;
        },
      );
      firstWrite.catch(() => {});
      await firstOwnerReached.promise;
      const old = new Date('2000-01-01T00:00:00.000Z');
      await fs.utimes(lockDirectory, old, old);

      replacementWrite = new SessionStore({ path: sessionFile }).write(makeSession(2));
      replacementWrite.catch(() => {});
      await replacementRenameReached.promise;
      resumeFirstOwner.resolve();
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(
        firstSettled,
        false,
        'the displaced acquirer must not enter its critical section',
      );

      resumeReplacementRename.resolve();
      await Promise.all([firstWrite, replacementWrite]);
    } finally {
      resumeFirstOwner.resolve();
      resumeReplacementRename.resolve();
      fs.rename = originalRename;
      await Promise.allSettled([firstWrite, replacementWrite].filter(Boolean));
    }

    const parsed = JSON.parse(await fs.readFile(sessionFile, 'utf8'));
    assert.deepEqual(Object.keys(parsed.sessions).sort(), [
      makeSession(1).host,
      makeSession(2).host,
    ]);
    await assertPrivateAtomicResult(directory, sessionFile);
  },
);

test('lock recovery refuses to follow a lock-path symlink', async (t) => {
  if (process.platform === 'win32') {
    t.skip('creating symbolic links may require elevated privileges on Windows');
    return;
  }
  const directory = await fs.mkdtemp(join(tmpdir(), 'xgg-session-lock-safety-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sessionFile = join(directory, 'session.json');
  const externalDirectory = join(directory, 'external');
  const sentinel = join(externalDirectory, 'keep-me.txt');
  const lockPath = `${sessionFile}.lock`;
  await fs.mkdir(externalDirectory);
  await fs.writeFile(sentinel, 'preserve');
  await fs.symlink(externalDirectory, lockPath);

  const { SessionStore } = await import(storeModuleUrl);
  await assert.rejects(new SessionStore({ path: sessionFile }).write(makeSession(1)), {
    message: /Session lock path is not a directory:/,
  });
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'preserve');
});

test('orphan recovery does not delete unknown lock-directory entries', async (t) => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'xgg-session-lock-unknown-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sessionFile = join(directory, 'session.json');
  const lockPath = `${sessionFile}.lock`;
  const sentinel = join(lockPath, 'keep-me.txt');
  await fs.mkdir(lockPath);
  await fs.writeFile(sentinel, 'preserve');
  const old = new Date('2000-01-01T00:00:00.000Z');
  await fs.utimes(lockPath, old, old);

  const { SessionStore } = await import(storeModuleUrl);
  await new SessionStore({ path: sessionFile }).reclaimStaleLock(sessionFile);

  assert.equal(await fs.readFile(sentinel, 'utf8'), 'preserve');
});

test('atomic replacement preserves an existing session-file symlink', async (t) => {
  if (process.platform === 'win32') {
    t.skip('creating symbolic links may require elevated privileges on Windows');
    return;
  }
  const directory = await fs.mkdtemp(join(tmpdir(), 'xgg-session-file-symlink-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const actualFile = join(directory, 'actual.json');
  const sessionFile = join(directory, 'session.json');
  const first = makeSession(1);
  const second = makeSession(2);
  await fs.writeFile(
    actualFile,
    JSON.stringify({ version: 2, sessions: { [first.host]: first } }),
    { mode: 0o600 },
  );
  await fs.symlink('actual.json', sessionFile);

  const { SessionStore } = await import(storeModuleUrl);
  await new SessionStore({ path: sessionFile }).write(second);

  assert.equal((await fs.lstat(sessionFile)).isSymbolicLink(), true);
  const parsed = JSON.parse(await fs.readFile(actualFile, 'utf8'));
  assert.deepEqual(Object.keys(parsed.sessions).sort(), [first.host, second.host]);
  assert.equal((await fs.stat(actualFile)).mode & 0o777, 0o600);
  await assert.rejects(fs.access(`${actualFile}.lock`, fsConstants.F_OK), { code: 'ENOENT' });
});

test('read-only operations do not create a missing session parent directory', async (t) => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'xgg-session-read-only-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const parent = join(directory, 'missing');
  const sessionFile = join(parent, 'session.json');
  const { SessionStore } = await import(storeModuleUrl);
  const store = new SessionStore({ path: sessionFile });

  assert.deepEqual(await store.hosts(), []);
  await assert.rejects(store.read(makeSession(1).host));
  await assert.rejects(fs.access(parent, fsConstants.F_OK), { code: 'ENOENT' });
});

function makeSession(index) {
  const stamp = '2026-07-18T00:00:00.000Z';
  return {
    host: `http://192.0.2.${index}:8086`,
    pid: 10_000 + index,
    socketPath: `/tmp/xgg-session-${index}.sock`,
    agentStartedAt: stamp,
    agentVersion: 'test',
    lastValidatedAt: stamp,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

async function exitedChildPid() {
  const child = spawn(process.execPath, ['--eval', 'process.exit(0)'], {
    stdio: 'ignore',
  });
  const pid = child.pid;
  assert.ok(pid !== undefined);
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  return pid;
}

async function runWorkers(directory, sessionFile, actions) {
  const startFile = join(directory, `start-${crypto.randomUUID()}`);
  const workers = actions.map((action) => startWorker(sessionFile, startFile, action));
  try {
    await Promise.all(workers.map(({ ready }) => ready));
    await fs.writeFile(startFile, 'go');
    await Promise.all(workers.map(({ finished }) => finished));
  } finally {
    for (const { child } of workers) {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }
}

function startWorker(sessionFile, startFile, action) {
  const child = spawn(process.execPath, ['--input-type=module', '--eval', workerSource], {
    env: {
      ...process.env,
      XGG_SESSION_FILE: sessionFile,
      XGG_STORE_ACTION: JSON.stringify(action),
      XGG_STORE_MODULE_URL: storeModuleUrl,
      XGG_STORE_START_FILE: startFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let readyResolved = false;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const finished = new Promise((resolve, reject) => {
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (!readyResolved && stdout.includes('READY\n')) {
        readyResolved = true;
        resolveReady();
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      rejectReady(error);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const error = new Error(
        `session worker failed (code=${code}, signal=${signal})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      );
      rejectReady(error);
      reject(error);
    });
  });
  // A child can fail while the parent is still awaiting other READY messages.
  // Register handlers now so Node does not report a transient unhandled rejection.
  ready.catch(() => {});
  finished.catch(() => {});
  return { child, ready, finished };
}

async function observeJsonFile(sessionFile, parseErrors, isActive) {
  while (isActive()) {
    try {
      JSON.parse(await fs.readFile(sessionFile, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') parseErrors.push(error);
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function assertPrivateAtomicResult(directory, sessionFile) {
  if (process.platform !== 'win32') {
    const mode = (await fs.stat(sessionFile)).mode & 0o777;
    assert.equal(mode, 0o600);
  }
  const names = await fs.readdir(directory);
  assert.ok(!names.includes('session.json.lock'));
  assert.ok(!names.some((name) => name.endsWith('.tmp')));
}
