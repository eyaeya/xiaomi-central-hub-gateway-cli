import assert from 'node:assert/strict';
import { promises as fs, constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const coreModuleUrl = new URL('../dist/index.js', import.meta.url).href;
const storeModuleUrl = new URL('../dist/session/store.js', import.meta.url).href;
const testHost = 'http://192.0.2.10:8086';
const secretSentinel = 'SESSION_FILE_SECRET_SENTINEL_7e8b6e';

test('preserves unknown, future, non-session, and near-v1 JSON bytes', async (t) => {
  const secondHost = 'http://192.0.2.11:8086';
  const fixtures = [
    {
      label: 'non-session JSON',
      raw: `{"version":"0.1.4","keep":"${secretSentinel}"}\n`,
    },
    {
      label: 'future-version JSON',
      raw: `{"version":3,"sessions":{},"keep":"${secretSentinel}"}\n`,
    },
    {
      label: 'v2 envelope with unknown data',
      raw: jsonBytes({
        version: 2,
        sessions: {},
        keep: secretSentinel,
      }),
    },
    {
      label: 'v2 entry with unknown data',
      raw: jsonBytes({
        version: 2,
        sessions: {
          [testHost]: { ...makeSession(), passcode: '123456' },
        },
      }),
    },
    {
      label: 'mismatched v2 record key',
      raw: jsonBytes({
        version: 2,
        sessions: { [secondHost]: makeSession() },
      }),
    },
    {
      label: 'string v1 version',
      raw: jsonBytes({
        version: '1',
        sessions: { [testHost]: makeLegacySession() },
      }),
    },
    {
      label: 'missing v1 sessions',
      raw: jsonBytes({ version: 1 }),
    },
    {
      label: 'missing v1 entry field',
      raw: jsonBytes({
        version: 1,
        sessions: {
          [testHost]: {
            host: testHost,
            passcode: '123456',
            createdAt: '2026-07-19T00:00:00.000Z',
          },
        },
      }),
    },
    {
      label: 'numeric v1 passcode',
      raw: jsonBytes({
        version: 1,
        sessions: { [testHost]: makeLegacySession(testHost, { passcode: 123456 }) },
      }),
    },
    {
      label: 'short v1 passcode',
      raw: jsonBytes({
        version: 1,
        sessions: { [testHost]: makeLegacySession(testHost, { passcode: '12345' }) },
      }),
    },
    {
      label: 'long v1 passcode',
      raw: jsonBytes({
        version: 1,
        sessions: { [testHost]: makeLegacySession(testHost, { passcode: '123456789' }) },
      }),
    },
    {
      label: 'invalid v1 datetime',
      raw: jsonBytes({
        version: 1,
        sessions: { [testHost]: makeLegacySession(testHost, { createdAt: 'not-a-date' }) },
      }),
    },
    {
      label: 'extra v1 envelope field',
      raw: jsonBytes({
        version: 1,
        sessions: { [testHost]: makeLegacySession() },
        keep: secretSentinel,
      }),
    },
    {
      label: 'extra v1 entry field',
      raw: jsonBytes({
        version: 1,
        sessions: {
          [testHost]: { ...makeLegacySession(), keep: secretSentinel },
        },
      }),
    },
    {
      label: 'mismatched v1 record key',
      raw: jsonBytes({
        version: 1,
        sessions: { [secondHost]: makeLegacySession() },
      }),
    },
    {
      label: 'mixed valid and invalid v1 entries',
      raw: jsonBytes({
        version: 1,
        sessions: {
          [testHost]: makeLegacySession(),
          [secondHost]: makeLegacySession(secondHost, { lastValidatedAt: 'not-a-date' }),
        },
      }),
    },
  ];

  for (const fixture of fixtures) {
    await assertSchemaFailurePreservesBytes(t, fixture, 'schema_mismatch');
  }
});

// These fixtures come from the original v1 schema (commit e499290a) and the
// v2 migration that retired it (commit 28535f6). Cleanup deliberately accepts
// only this strict envelope; the near-v1 cases above prove the deletion boundary.
test('cleans only exact verified legacy v1 envelopes under the mutation lock', async (t) => {
  const secondHost = 'http://192.0.2.11:8086';
  const fixtures = [
    { label: 'empty', raw: jsonBytes({ version: 1, sessions: {} }) },
    {
      label: 'single host with six-digit passcode',
      raw: jsonBytes({
        version: 1,
        sessions: { [testHost]: makeLegacySession() },
      }),
    },
    {
      label: 'multiple hosts with six-to-eight-digit passcodes',
      raw: jsonBytes({
        version: 1,
        sessions: {
          [testHost]: makeLegacySession(),
          [secondHost]: makeLegacySession(secondHost, { passcode: '12345678' }),
        },
      }),
    },
  ];

  for (const fixture of fixtures) {
    await assertExactLegacyCleanup(t, fixture);
  }
});

test('re-reads under lock before cleaning a detected legacy file', async (t) => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'xgg-session-v1-reread-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sessionPath = join(directory, 'session.json');
  const mutationSessionPath = join(await fs.realpath(directory), 'session.json');
  const lockPath = `${mutationSessionPath}.lock`;
  await fs.writeFile(
    sessionPath,
    jsonBytes({ version: 1, sessions: { [testHost]: makeLegacySession() } }),
    { mode: 0o600 },
  );

  const { SessionStore } = await import(storeModuleUrl);
  const replacement = makeSession();
  const replacementBytes = jsonBytes({
    version: 2,
    sessions: { [testHost]: replacement },
  });
  const originalMkdir = fs.mkdir;
  let replacedBeforeLock = false;

  fs.mkdir = async (path, options) => {
    if (!replacedBeforeLock && path === lockPath) {
      replacedBeforeLock = true;
      await fs.writeFile(mutationSessionPath, replacementBytes, { mode: 0o600 });
    }
    return originalMkdir.call(fs, path, options);
  };

  try {
    assert.deepEqual(await new SessionStore({ path: sessionPath }).read(testHost), replacement);
  } finally {
    fs.mkdir = originalMkdir;
  }

  assert.equal(replacedBeforeLock, true);
  assert.equal(await fs.readFile(sessionPath, 'utf8'), replacementBytes);
  await assertNoMutationArtifacts(directory, sessionPath);
});

test('classifies malformed JSON consistently without exposing or changing its bytes', async (t) => {
  await assertSchemaFailurePreservesBytes(
    t,
    {
      label: 'malformed JSON',
      raw: `{"version":2,"sessions":{"keep":"${secretSentinel}"`,
    },
    'invalid_json',
  );
});

test('classifies invalid UTF-8 consistently without replacing or changing its bytes', async (t) => {
  await assertSchemaFailurePreservesBytes(
    t,
    {
      label: 'invalid UTF-8 inside an otherwise valid v2 session',
      raw: invalidUtf8SessionBytes(),
    },
    'invalid_utf8',
  );
});

test('classifies invalid v2 session data consistently without changing its bytes', async (t) => {
  await assertSchemaFailurePreservesBytes(
    t,
    {
      label: 'v2 schema mismatch',
      raw: `${JSON.stringify({
        version: 2,
        sessions: {
          [testHost]: {
            host: testHost,
            pid: secretSentinel,
          },
        },
      })}\n`,
    },
    'schema_mismatch',
  );
});

test('preserves native directory I/O errors across every store operation', async (t) => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'xgg-session-directory-error-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sessionPath = join(directory, 'session-as-directory');
  const sentinelPath = join(sessionPath, 'keep-me.txt');
  await fs.mkdir(sessionPath);
  await fs.writeFile(sentinelPath, secretSentinel);

  const { AuthRequiredError, SchemaError } = await import(coreModuleUrl);
  const { SessionStore } = await import(storeModuleUrl);
  const store = new SessionStore({ path: sessionPath });

  for (const [operation, invoke] of storeOperations(store)) {
    const error = await getRejection(invoke(), operation);
    assert.ok(!(error instanceof AuthRequiredError), `${operation} must not map EISDIR to auth`);
    assert.ok(!(error instanceof SchemaError), `${operation} must retain the native I/O error`);
    assert.equal(error.code, 'EISDIR', `${operation} must retain EISDIR`);
    assert.equal(error.syscall, 'read', `${operation} must retain the failing syscall`);
    assert.equal(await fs.readFile(sentinelPath, 'utf8'), secretSentinel);
    await assertNoMutationArtifacts(directory, sessionPath);
  }
});

test('preserves native permission errors and file bytes across every store operation', async (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) {
    t.skip('mode 000 does not reliably produce EACCES on this platform/user');
    return;
  }

  const directory = await fs.mkdtemp(join(tmpdir(), 'xgg-session-permission-error-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sessionPath = join(directory, 'session.json');
  const raw = `${JSON.stringify({ version: 2, sessions: {} })}\n`;
  await fs.writeFile(sessionPath, raw, { mode: 0o600 });
  await fs.chmod(sessionPath, 0o000);

  const { AuthRequiredError, SchemaError } = await import(coreModuleUrl);
  const { SessionStore } = await import(storeModuleUrl);
  const store = new SessionStore({ path: sessionPath });

  try {
    for (const [operation, invoke] of storeOperations(store)) {
      const error = await getRejection(invoke(), operation);
      assert.ok(!(error instanceof AuthRequiredError), `${operation} must not map EACCES to auth`);
      assert.ok(!(error instanceof SchemaError), `${operation} must retain the native I/O error`);
      assert.equal(error.code, 'EACCES', `${operation} must retain EACCES`);
      assert.equal(error.syscall, 'open', `${operation} must retain the failing syscall`);
      assert.equal(typeof error.path, 'string', `${operation} must retain the failing path`);
      assert.equal((await fs.stat(sessionPath)).mode & 0o777, 0o000);
      await assertNoMutationArtifacts(directory, sessionPath);
    }
  } finally {
    await fs.chmod(sessionPath, 0o600);
  }

  assert.equal(await fs.readFile(sessionPath, 'utf8'), raw);
});

test('uses missing-file semantics only for ENOENT', async (t) => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'xgg-session-missing-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const { AuthRequiredError } = await import(coreModuleUrl);
  const { SessionStore } = await import(storeModuleUrl);

  const readPath = join(directory, 'read.json');
  const readStore = new SessionStore({ path: readPath });
  const readError = await getRejection(readStore.read(testHost), 'read');
  assert.ok(readError instanceof AuthRequiredError);
  assert.equal(readError.code, 'AUTH_REQUIRED');

  const hostsPath = join(directory, 'hosts.json');
  assert.deepEqual(await new SessionStore({ path: hostsPath }).hosts(), []);

  const deletePath = join(directory, 'delete.json');
  await new SessionStore({ path: deletePath }).delete(testHost);
  await assert.rejects(fs.access(deletePath, fsConstants.F_OK), { code: 'ENOENT' });
  await assertNoMutationArtifacts(directory, deletePath);

  const writePath = join(directory, 'write.json');
  await new SessionStore({ path: writePath }).write(makeSession());
  const written = JSON.parse(await fs.readFile(writePath, 'utf8'));
  assert.equal(written.version, 2);
  assert.deepEqual(Object.keys(written.sessions), [testHost]);
});

test('write persists the validated session rather than undeclared caller data', async (t) => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'xgg-session-write-validation-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sessionPath = join(directory, 'session.json');
  const { SessionStore } = await import(storeModuleUrl);

  await new SessionStore({ path: sessionPath }).write({
    ...makeSession(),
    passcode: '123456',
    keep: secretSentinel,
  });

  const written = JSON.parse(await fs.readFile(sessionPath, 'utf8'));
  assert.deepEqual(written, {
    version: 2,
    sessions: { [testHost]: makeSession() },
  });
});

async function assertSchemaFailurePreservesBytes(t, fixture, reason) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'xgg-session-schema-error-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sessionPath = join(directory, 'session.json');
  await fs.writeFile(sessionPath, fixture.raw, { mode: 0o600 });
  const expectedBytes = Buffer.from(fixture.raw);

  const { AuthRequiredError, SchemaError } = await import(coreModuleUrl);
  const { SessionStore } = await import(storeModuleUrl);
  const store = new SessionStore({ path: sessionPath });
  let expectedSignature;

  for (const [operation, invoke] of storeOperations(store)) {
    const error = await getRejection(invoke(), `${fixture.label}: ${operation}`);
    assert.ok(error instanceof SchemaError, `${operation} must return SchemaError`);
    assert.ok(
      !(error instanceof AuthRequiredError),
      `${operation} must not return AuthRequiredError`,
    );
    assert.equal(error.code, 'SCHEMA');
    assert.deepEqual(error.details, { sessionPath, reason });
    assert.match(error.message, new RegExp(escapeRegExp(sessionPath)));
    assert.ok(!error.message.includes(secretSentinel), `${operation} message exposed file bytes`);
    assert.ok(!error.message.includes('123456'), `${operation} message exposed a passcode`);
    assert.ok(
      !JSON.stringify(error.details).includes(secretSentinel),
      `${operation} details exposed file bytes`,
    );
    assert.ok(
      !JSON.stringify(error.details).includes('123456'),
      `${operation} details exposed a passcode`,
    );

    const signature = {
      name: error.name,
      code: error.code,
      message: error.message,
      details: error.details,
    };
    expectedSignature ??= signature;
    assert.deepEqual(signature, expectedSignature, `${operation} error classification drifted`);
    assert.deepEqual(await fs.readFile(sessionPath), expectedBytes);
    await assertNoMutationArtifacts(directory, sessionPath);
  }
}

async function assertExactLegacyCleanup(t, fixture) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'xgg-session-exact-v1-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const { AuthRequiredError, SchemaError } = await import(coreModuleUrl);
  const { SessionStore } = await import(storeModuleUrl);

  for (const operation of ['read', 'hosts', 'write', 'delete']) {
    const sessionPath = join(directory, `${operation}.json`);
    await fs.writeFile(sessionPath, fixture.raw, { mode: 0o600 });
    const store = new SessionStore({ path: sessionPath });

    if (operation === 'read') {
      const error = await getRejection(store.read(testHost), `${fixture.label}: read`);
      assert.ok(error instanceof AuthRequiredError);
      assert.ok(!(error instanceof SchemaError));
      assert.equal(error.code, 'AUTH_REQUIRED');
      assert.match(error.message, /legacy v1 session file detected/);
    } else if (operation === 'hosts') {
      assert.deepEqual(await store.hosts(), []);
    } else if (operation === 'write') {
      await store.write(makeSession());
      const written = JSON.parse(await fs.readFile(sessionPath, 'utf8'));
      assert.equal(written.version, 2);
      assert.deepEqual(written.sessions, { [testHost]: makeSession() });
    } else {
      await store.delete(testHost);
    }

    if (operation !== 'write') {
      await assert.rejects(fs.access(sessionPath, fsConstants.F_OK), { code: 'ENOENT' });
    }
    await assertNoMutationArtifacts(directory, sessionPath);
  }
}

function storeOperations(store) {
  return [
    ['read', () => store.read(testHost)],
    ['hosts', () => store.hosts()],
    ['write', () => store.write(makeSession())],
    ['delete', () => store.delete(testHost)],
  ];
}

async function getRejection(promise, label) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail(`${label} unexpectedly succeeded`);
}

async function assertNoMutationArtifacts(directory, sessionPath) {
  await assert.rejects(fs.access(`${sessionPath}.lock`, fsConstants.F_OK), { code: 'ENOENT' });
  const names = await fs.readdir(directory);
  assert.ok(!names.some((name) => name.endsWith('.tmp')), 'temporary files must be cleaned up');
}

function makeSession() {
  const stamp = '2026-07-19T00:00:00.000Z';
  return {
    host: testHost,
    pid: 20_001,
    socketPath: '/tmp/xgg-session-safety.sock',
    agentStartedAt: stamp,
    agentVersion: 'test',
    lastValidatedAt: stamp,
  };
}

function makeLegacySession(host = testHost, overrides = {}) {
  const stamp = '2026-07-19T00:00:00.000Z';
  return {
    host,
    passcode: '123456',
    createdAt: stamp,
    lastValidatedAt: stamp,
    ...overrides,
  };
}

function jsonBytes(value) {
  return `${JSON.stringify(value)}\n`;
}

function invalidUtf8SessionBytes() {
  const marker = 'INVALID_UTF8_MARKER';
  const raw = jsonBytes({
    version: 2,
    sessions: {
      [testHost]: { ...makeSession(), agentVersion: marker },
    },
  });
  const [prefix, suffix] = raw.split(marker);
  assert.ok(prefix !== undefined && suffix !== undefined);
  return Buffer.concat([Buffer.from(prefix), Buffer.from([0xff]), Buffer.from(suffix)]);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
