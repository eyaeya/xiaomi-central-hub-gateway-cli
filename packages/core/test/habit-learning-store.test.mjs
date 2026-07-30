import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs, constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

const storeModuleUrl = new URL('../dist/index.js', import.meta.url).href;

test('persists private atomic state and append-only NDJSON under a permissive umask', async (t) => {
  const parent = await fs.mkdtemp(join(tmpdir(), 'xgg-habit-store-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const studyPath = join(parent, 'study');
  const previousUmask = process.umask(0o000);

  try {
    const { HabitLearningStudyStore } = await import(storeModuleUrl);
    const store = new HabitLearningStudyStore({ path: studyPath });
    await store.initialize();
    await store.withLock(async (transaction) => {
      assert.equal(await transaction.readState(), undefined);
      assert.deepEqual(await transaction.appendJournal([{ type: 'poll-begin', poll: 1 }]), {
        records: 1,
        bytes: Buffer.byteLength('{"type":"poll-begin","poll":1}\n'),
      });
      await transaction.appendJournal([
        { type: 'study-entry', signalId: 'synthetic-signal' },
        { type: 'poll-end', poll: 1 },
      ]);
      await transaction.writeState({ version: 1, committedPoll: 1 });
    });
  } finally {
    process.umask(previousUmask);
  }

  const { HabitLearningStudyStore } = await import(storeModuleUrl);
  const reopened = new HabitLearningStudyStore({ path: studyPath });
  assert.deepEqual(await reopened.readState(), { version: 1, committedPoll: 1 });
  assert.deepEqual(await reopened.readJournal(), [
    { type: 'poll-begin', poll: 1 },
    { type: 'study-entry', signalId: 'synthetic-signal' },
    { type: 'poll-end', poll: 1 },
  ]);
  assert.equal((await fs.stat(studyPath)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(reopened.paths.state)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(reopened.paths.journal)).mode & 0o777, 0o600);
  await assert.rejects(fs.access(reopened.paths.lock, fsConstants.F_OK), { code: 'ENOENT' });
  assert.deepEqual(await mutationArtifacts(studyPath), []);
});

test('state replacement uses a synced same-directory private temporary file', async (t) => {
  const parent = await fs.mkdtemp(join(tmpdir(), 'xgg-habit-state-atomic-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const studyPath = join(parent, 'study');
  const { HabitLearningStudyStore } = await import(storeModuleUrl);
  const store = new HabitLearningStudyStore({ path: studyPath });
  await store.writeState({ version: 1, sequence: 1 });

  const originalRename = fs.rename;
  let inspected = false;
  fs.rename = async (from, to) => {
    if (to === store.paths.state) {
      inspected = true;
      assert.equal(dirname(from), studyPath);
      assert.match(from, /\.state\.json\.\d+\..+\.tmp$/);
      assert.equal((await fs.stat(from)).mode & 0o777, 0o600);
      assert.deepEqual(JSON.parse(await fs.readFile(from, 'utf8')), {
        version: 1,
        sequence: 2,
      });
      assert.deepEqual(JSON.parse(await fs.readFile(to, 'utf8')), {
        version: 1,
        sequence: 1,
      });
    }
    return originalRename.call(fs, from, to);
  };

  try {
    await store.writeState({ version: 1, sequence: 2 });
  } finally {
    fs.rename = originalRename;
  }

  assert.equal(inspected, true);
  assert.deepEqual(await store.readState(), { version: 1, sequence: 2 });
  assert.deepEqual(await mutationArtifacts(studyPath), []);
});

test('rejects symlink study roots and data files without touching their targets', async (t) => {
  const parent = await fs.mkdtemp(join(tmpdir(), 'xgg-habit-symlink-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const targetDirectory = join(parent, 'target-study');
  const linkedStudy = join(parent, 'linked-study');
  await fs.mkdir(targetDirectory);
  await fs.symlink(targetDirectory, linkedStudy);

  const { HabitLearningStudyStore } = await import(storeModuleUrl);
  await assert.rejects(
    new HabitLearningStudyStore({ path: linkedStudy }).initialize(),
    /symbolic-link study root/,
  );

  const studyPath = join(parent, 'study');
  const store = new HabitLearningStudyStore({ path: studyPath });
  await store.initialize();
  const stateTarget = join(parent, 'state-target.json');
  const journalTarget = join(parent, 'journal-target.ndjson');
  await fs.writeFile(stateTarget, '{"keep":"state"}\n', { mode: 0o600 });
  await fs.writeFile(journalTarget, '{"keep":"journal"}\n', { mode: 0o600 });
  await fs.symlink(stateTarget, store.paths.state);
  await fs.symlink(journalTarget, store.paths.journal);

  await assert.rejects(store.readState(), /symbolic-link habit-learning state/);
  await assert.rejects(store.writeState({ version: 1 }), /symbolic-link habit-learning state/);
  assert.equal(await fs.readFile(stateTarget, 'utf8'), '{"keep":"state"}\n');

  await fs.unlink(store.paths.state);
  await assert.rejects(store.readJournal(), /symbolic-link habit-learning journal/);
  await assert.rejects(
    store.appendJournal([{ type: 'synthetic' }]),
    /symbolic-link habit-learning journal/,
  );
  assert.equal(await fs.readFile(journalTarget, 'utf8'), '{"keep":"journal"}\n');
});

test('serializes writers across processes and never reclaims a lock owned by a live PID', async (t) => {
  const parent = await fs.mkdtemp(join(tmpdir(), 'xgg-habit-live-lock-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const studyPath = join(parent, 'study');
  const releasePath = join(parent, 'release');
  const { HabitLearningStudyStore } = await import(storeModuleUrl);
  const contender = new HabitLearningStudyStore({
    path: studyPath,
    lockTimeoutMs: 80,
    lockRetryMs: 5,
    orphanLockStaleMs: 0,
  });
  const holder = spawn(process.execPath, ['--input-type=module', '-e', lockHolderSource], {
    env: {
      ...process.env,
      XGG_HABIT_STORE_MODULE_URL: storeModuleUrl,
      XGG_HABIT_STUDY_PATH: studyPath,
      XGG_HABIT_RELEASE_PATH: releasePath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => holder.kill());
  await waitForReady(holder);

  const ownerFiles = await fs.readdir(contender.paths.lock);
  assert.equal(ownerFiles.length, 1);
  const ownerPath = join(contender.paths.lock, ownerFiles[0]);
  const owner = JSON.parse(await fs.readFile(ownerPath, 'utf8'));
  assert.equal(owner.pid, holder.pid);
  assert.match(owner.token, /^[0-9a-f-]{36}$/i);
  assert.equal((await fs.stat(contender.paths.lock)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(ownerPath)).mode & 0o777, 0o600);

  await assert.rejects(contender.appendJournal([{ type: 'must-not-write' }]), /Timed out waiting/);
  assert.deepEqual(await fs.readdir(contender.paths.lock), ownerFiles);

  await fs.writeFile(releasePath, '');
  await waitForSuccessfulExit(holder);
  await contender.appendJournal([{ type: 'written-after-release' }]);
  assert.deepEqual(await contender.readJournal(), [{ type: 'written-after-release' }]);
});

test('reclaims only an unchanged canonical owner whose PID is confirmed dead', async (t) => {
  const parent = await fs.mkdtemp(join(tmpdir(), 'xgg-habit-dead-lock-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const studyPath = join(parent, 'study');
  const { HabitLearningStudyStore } = await import(storeModuleUrl);
  const store = new HabitLearningStudyStore({
    path: studyPath,
    lockTimeoutMs: 500,
    lockRetryMs: 5,
  });
  const competingStore = new HabitLearningStudyStore({
    path: studyPath,
    lockTimeoutMs: 500,
    lockRetryMs: 5,
  });
  await store.initialize();

  const deadPid = await exitedChildPid();
  const token = '00000000-0000-4000-8000-000000000001';
  await fs.mkdir(store.paths.lock, { mode: 0o700 });
  await fs.writeFile(
    join(store.paths.lock, `owner-${token}.json`),
    JSON.stringify({
      token,
      pid: deadPid,
      createdAt: '2099-01-01T00:00:00.000Z',
    }),
    { mode: 0o600 },
  );

  await Promise.all([
    store.appendJournal([{ type: 'after-dead-owner-a' }]),
    competingStore.appendJournal([{ type: 'after-dead-owner-b' }]),
  ]);
  assert.deepEqual((await store.readJournal()).map(({ type }) => type).sort(), [
    'after-dead-owner-a',
    'after-dead-owner-b',
  ]);
  await assert.rejects(fs.access(store.paths.lock, fsConstants.F_OK), { code: 'ENOENT' });
});

test('does not reclaim malformed or unexpectedly populated lock directories', async (t) => {
  const parent = await fs.mkdtemp(join(tmpdir(), 'xgg-habit-unknown-lock-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const studyPath = join(parent, 'study');
  const { HabitLearningStudyStore } = await import(storeModuleUrl);
  const store = new HabitLearningStudyStore({
    path: studyPath,
    lockTimeoutMs: 60,
    lockRetryMs: 5,
    orphanLockStaleMs: 0,
  });
  await store.initialize();
  await fs.mkdir(store.paths.lock, { mode: 0o700 });
  const unknownPath = join(store.paths.lock, 'keep-me.txt');
  await fs.writeFile(unknownPath, 'not an owner', { mode: 0o600 });

  await assert.rejects(store.writeState({ version: 1 }), /Timed out waiting/);
  assert.equal(await fs.readFile(unknownPath, 'utf8'), 'not an owner');
  await assert.rejects(fs.access(store.paths.state, fsConstants.F_OK), { code: 'ENOENT' });
});

test('rejects non-object journal records and releases the writer lock after failures', async (t) => {
  const parent = await fs.mkdtemp(join(tmpdir(), 'xgg-habit-record-validation-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const studyPath = join(parent, 'study');
  const { HabitLearningStudyStore } = await import(storeModuleUrl);
  const store = new HabitLearningStudyStore({ path: studyPath });

  await assert.rejects(
    store.appendJournal([/** @type {any} */ ('not-an-object')]),
    /must be a JSON object/,
  );
  await assert.rejects(
    store.withLock(async (transaction) => {
      await transaction.writeState({ value: 1n });
    }),
    /must be JSON-serializable/,
  );
  await store.appendJournal([{ type: 'lock-was-released' }]);
  assert.deepEqual(await store.readJournal(), [{ type: 'lock-was-released' }]);
  await assert.rejects(fs.access(store.paths.lock, fsConstants.F_OK), { code: 'ENOENT' });
  assert.deepEqual(await mutationArtifacts(studyPath), []);
});

async function mutationArtifacts(studyPath) {
  return (await fs.readdir(studyPath)).filter(
    (entry) => entry.endsWith('.tmp') || entry === '.writer.lock',
  );
}

async function exitedChildPid() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  assert.equal(typeof child.pid, 'number');
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  return child.pid;
}

async function waitForReady(child) {
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  await new Promise((resolve, reject) => {
    const inspect = () => {
      if (stdout.includes('READY\n')) resolve();
    };
    child.stdout.on('data', inspect);
    child.once('error', reject);
    child.once('exit', (code) => {
      if (!stdout.includes('READY\n')) {
        reject(new Error(`lock holder exited ${code} before READY: ${stderr}`));
      }
    });
    inspect();
  });
}

async function waitForSuccessfulExit(child) {
  if (child.exitCode !== null) {
    assert.equal(child.exitCode, 0);
    return;
  }
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  assert.equal(code, 0);
}

const lockHolderSource = String.raw`
  import { constants as fsConstants, promises as fs } from 'node:fs';

  const { HabitLearningStudyStore } = await import(process.env.XGG_HABIT_STORE_MODULE_URL);
  const store = new HabitLearningStudyStore({ path: process.env.XGG_HABIT_STUDY_PATH });
  await store.withLock(async () => {
    process.stdout.write('READY\n');
    while (true) {
      try {
        await fs.access(process.env.XGG_HABIT_RELEASE_PATH, fsConstants.F_OK);
        break;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
  });
`;
