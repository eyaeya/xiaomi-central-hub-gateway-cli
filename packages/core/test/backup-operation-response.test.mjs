import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ConfigError,
  NotConfirmedError,
  SchemaError,
  createBackup,
  downloadBackup,
  extractBackupProgressId,
  loadBackup,
  waitForBackupProgress,
} from '../dist/index.js';
import { BackupOperationResponse } from '../dist/schemas/backup.js';

const baseUrl = 'http://192.0.2.10:8086';
const agentStartedAt = '2026-07-19T00:00:00.000Z';
const backup = {
  ts: '2026-07-19T00:00:00.000Z',
  did: 'backup-did',
  fileName: 'probe.bak',
};

const validVariants = [
  { name: 'snake-case progress id', value: { progress_id: 7 }, progressId: 7 },
  { name: 'camel-case progress id', value: { progressId: 8 }, progressId: 8 },
  {
    name: 'progress id with protocol metadata',
    value: { progress_id: 9, status: 'queued' },
    progressId: 9,
  },
  { name: 'exact empty object', value: {}, progressId: null },
  { name: 'true', value: true, progressId: null },
  { name: 'false', value: false, progressId: null },
  { name: 'zero', value: 0, progressId: 0 },
  { name: 'number', value: 12, progressId: 12 },
  { name: 'string', value: 'ok', progressId: null },
  { name: 'empty string', value: '', progressId: null },
  { name: 'null', value: null, progressId: null },
];

const malformedObjects = [
  { name: 'string snake-case progress id', value: { progress_id: 'oops' } },
  { name: 'null snake-case progress id', value: { progress_id: null } },
  { name: 'string camel-case progress id', value: { progressId: '7' } },
  { name: 'null camel-case progress id', value: { progressId: null } },
  { name: 'unknown nonempty object', value: { totally: 'unexpected' } },
  { name: 'unnamed progress object', value: { progress: 50 } },
];

const unconfirmableProgressHandles = [
  { name: 'negative bare progress id', value: -1 },
  { name: 'fractional bare progress id', value: 1.5 },
  { name: 'negative snake-case progress id', value: { progress_id: -1 } },
  { name: 'fractional camel-case progress id', value: { progressId: 1.5 } },
];

const ackOperations = [
  {
    name: 'createBackup',
    responseLabel: 'BackupCreateResponse',
    invoke: (deps) => createBackup({ from: 'fds', fileName: 'probe.bak' }, deps),
  },
  {
    name: 'downloadBackup',
    responseLabel: 'BackupDownloadResponse',
    invoke: (deps) => downloadBackup({ from: 'fds', backup }, deps),
  },
];

const loadOperation = {
  name: 'loadBackup',
  responseLabel: 'BackupLoadResponse',
  invoke: (deps) =>
    loadBackup({ from: 'fds', backup }, deps, { pollIntervalMs: 1, pollTimeoutMs: 100 }),
};

function depsReturning(response) {
  const session = {
    host: baseUrl,
    pid: 1234,
    socketPath: '/tmp/xgg-backup-schema-test.sock',
    agentStartedAt,
    agentVersion: 'test',
    lastValidatedAt: agentStartedAt,
  };
  const client = {
    request: async (method) => {
      if (method === '$ping') return { host: baseUrl, agentStartedAt };
      if (method === '$mutation.acquire') return { leaseId: 'test-lease' };
      if (method === '$mutation.release' || method === '$mutation.fence') return { ok: true };
      if (method === '/api/getBackupProgress') return { progress: 100 };
      return response;
    },
    close: () => {},
  };
  return {
    baseUrl,
    store: { read: async () => session },
    ipcClient: () => client,
  };
}

function depsReturningForLoad(response) {
  const deps = depsReturning(response);
  const makeClient = deps.ipcClient;
  return {
    ...deps,
    ipcClient: (...args) => {
      const client = makeClient(...args);
      const request = client.request;
      return {
        ...client,
        request: (method, params) =>
          method === '/api/downloadBackup' ? Promise.resolve(0) : request(method, params),
      };
    },
  };
}

test('BackupOperationResponse accepts every documented response variant', () => {
  for (const variant of validVariants) {
    const parsed = BackupOperationResponse.safeParse(variant.value);
    assert.equal(parsed.success, true, variant.name);
    assert.equal(extractBackupProgressId(parsed.data), variant.progressId, variant.name);
  }
});

test('BackupOperationResponse rejects malformed and unknown nonempty objects', () => {
  for (const variant of malformedObjects) {
    const parsed = BackupOperationResponse.safeParse(variant.value);
    assert.equal(parsed.success, false, variant.name);
  }
});

test('invalid numeric progress handles are parseable acknowledgements but not pollable ids', () => {
  for (const variant of unconfirmableProgressHandles) {
    const parsed = BackupOperationResponse.safeParse(variant.value);
    assert.equal(parsed.success, true, variant.name);
    assert.equal(extractBackupProgressId(parsed.data), null, variant.name);
  }
});

test('backup operation usecases preserve every documented response variant', async () => {
  for (const operation of ackOperations) {
    for (const variant of validVariants) {
      const result = await operation.invoke(depsReturning(variant.value));
      assert.deepEqual(result, variant.value, `${operation.name}: ${variant.name}`);
    }
  }
});

test('loadBackup preserves progress responses only after terminal confirmation', async () => {
  for (const variant of validVariants.filter((entry) => entry.progressId !== null)) {
    const result = await loadOperation.invoke(depsReturningForLoad(variant.value));
    assert.deepEqual(result, variant.value, variant.name);
  }
});

test('loadBackup fences acknowledgement variants without a progress handle', async () => {
  for (const variant of [
    ...validVariants.filter((entry) => entry.progressId === null),
    ...unconfirmableProgressHandles,
  ]) {
    await assert.rejects(
      loadOperation.invoke(depsReturningForLoad(variant.value)),
      NotConfirmedError,
    );
  }
});

test('backup create/download reject malformed progress before wait handling', async () => {
  for (const operation of ackOperations) {
    for (const variant of malformedObjects) {
      await assert.rejects(
        operation.invoke(depsReturning(variant.value)),
        (error) =>
          error instanceof SchemaError &&
          error.message === `${operation.responseLabel} parse failed`,
        `${operation.name}: ${variant.name}`,
      );
    }
  }
});

test('loadBackup classifies malformed acknowledged responses as NOT_CONFIRMED', async () => {
  for (const variant of malformedObjects) {
    await assert.rejects(
      loadOperation.invoke(depsReturningForLoad(variant.value)),
      (error) =>
        error instanceof NotConfirmedError &&
        error.details?.phase === 'ack-parse' &&
        error.details?.causeCode === 'SCHEMA' &&
        error.details?.causeMessage === `${loadOperation.responseLabel} parse failed`,
      variant.name,
    );
  }
});

test('waitForBackupProgress rejects unsafe timer values before polling', async () => {
  let polls = 0;
  for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
    await assert.rejects(
      waitForBackupProgress(
        { from: 'fds', progressId: 7 },
        { baseUrl, store: {} },
        {
          pollIntervalMs: value,
          _getBackupProgress: async () => {
            polls += 1;
            return { progress: 100 };
          },
        },
      ),
      ConfigError,
    );
  }
  assert.equal(polls, 0);
});
