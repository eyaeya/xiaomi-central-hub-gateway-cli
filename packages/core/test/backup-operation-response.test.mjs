import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SchemaError,
  createBackup,
  downloadBackup,
  extractBackupProgressId,
  loadBackup,
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

const operations = [
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
  {
    name: 'loadBackup',
    responseLabel: 'BackupLoadResponse',
    invoke: (deps) => loadBackup({ from: 'fds', backup }, deps),
  },
];

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

test('backup operation usecases preserve every documented response variant', async () => {
  for (const operation of operations) {
    for (const variant of validVariants) {
      const result = await operation.invoke(depsReturning(variant.value));
      assert.deepEqual(result, variant.value, `${operation.name}: ${variant.name}`);
    }
  }
});

test('backup operation usecases reject malformed progress before wait handling', async () => {
  for (const operation of operations) {
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
