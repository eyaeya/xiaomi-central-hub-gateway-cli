import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { inflateRawSync } from 'node:zlib';

import {
  ConfigError,
  GatewayError,
  NotConfirmedError,
  SchemaError,
  decodeLocalBackup,
  encodeLocalBackup,
  exportLocalBackup,
  importLocalBackup,
  planLocalBackupImport,
  readLocalBackup,
  validateLocalBackupPayload,
} from '../dist/index.js';

const fixture = JSON.parse(
  await readFile(new URL('./fixtures/local-backup-v2.json', import.meta.url), 'utf8'),
);
const baseUrl = 'http://local-backup.test';
const startedAt = '2026-07-19T00:00:00.000Z';

function position() {
  return { x: 0, y: 0, width: 200, height: 120 };
}

function onLoad(id) {
  return {
    id,
    type: 'onLoad',
    cfg: { pos: position(), name: 'onLoad', version: 1 },
    inputs: {},
    outputs: { output: [] },
    props: {},
  };
}

function summary(id, name) {
  return {
    id,
    enable: false,
    uiType: 'rule',
    userData: {
      name,
      transform: { x: 0, y: 0, scale: 1, rotate: 0 },
      lastUpdateTime: 0,
      version: 0,
    },
  };
}

function currentPayload() {
  const cfg = summary('currentRule', 'Current rule');
  return {
    version: 2,
    rules: [{ id: cfg.id, cfg, nodes: [onLoad('currentSource')] }],
    variables: {
      global: {
        oldGlobal: {
          type: 'string',
          value: 'old',
          userData: { name: 'Old global' },
        },
      },
      RcurrentRule: {
        oldLocal: {
          type: 'number',
          value: 1,
          userData: { name: 'Old local' },
        },
      },
    },
  };
}

function fakeGateway(payload = currentPayload(), options = {}) {
  const calls = [];
  const controls = [];
  let storeReads = 0;
  const leaseId = 'local-backup-lease';
  const respond = (method, params) => {
    switch (method) {
      case '/api/getDevList':
        return { devList: {} };
      case '/api/getGraphList':
        return payload.rules.map((rule) => structuredClone(rule.cfg));
      case '/api/getGraph': {
        const rule = payload.rules.find((candidate) => candidate.id === params.id);
        if (rule === undefined) throw new Error(`unexpected graph: ${params.id}`);
        return { id: rule.id, nodes: structuredClone(rule.nodes) };
      }
      case '/api/getVarScopeList':
        return { scopes: Object.keys(payload.variables) };
      case '/api/getVarList':
        return structuredClone(payload.variables[params.scope] ?? {});
      case '/api/deleteGraph':
      case '/api/deleteVar':
      case '/api/createVar':
      case '/api/setVarValue':
      case '/api/setGraph':
        if (options.failMethod === method) {
          throw new GatewayError(`injected failure at ${method}`, { gatewayCode: -1 });
        }
        return null;
      default:
        throw new Error(`unexpected method: ${method}`);
    }
  };
  const deps = {
    baseUrl,
    timeoutMs: 1_000,
    store: {
      async read() {
        storeReads += 1;
        return {
          host: baseUrl,
          pid: process.pid,
          socketPath: '/tmp/xgg-local-backup-unused.sock',
          agentStartedAt: startedAt,
          agentVersion: 'test',
          lastValidatedAt: startedAt,
        };
      },
    },
    ipcClient: () => ({
      async request(method, params, requestOptions) {
        if (method === '$ping') {
          controls.push({ method, params, requestOptions });
          return { host: baseUrl, agentStartedAt: startedAt };
        }
        if (method === '$mutation.acquire') {
          controls.push({ method, params, requestOptions });
          return { leaseId };
        }
        if (method === '$mutation.release' || method === '$mutation.fence') {
          controls.push({ method, params, requestOptions });
          return { ok: true };
        }
        calls.push({ method, params, requestOptions });
        return respond(method, params);
      },
      close() {},
    }),
  };
  return {
    calls,
    controls,
    deps,
    leaseId,
    get storeReads() {
      return storeReads;
    },
  };
}

test('bundle-derived fixture has the exact length-prefix, raw-deflate, and SHA-256 layout', () => {
  const bytes = Buffer.from(fixture.backupBase64, 'base64');
  const envelope = bytes.subarray(0, -32);
  const digest = bytes.subarray(-32);
  const json = inflateRawSync(envelope.subarray(4));

  assert.equal(envelope.readUInt32LE(0), Buffer.byteLength(JSON.stringify(fixture.payload)));
  assert.deepEqual(createHash('sha256').update(envelope).digest(), digest);
  assert.deepEqual(JSON.parse(json.toString('utf8')), fixture.payload);
  assert.deepEqual(decodeLocalBackup(bytes), fixture.payload);
  assert.deepEqual(decodeLocalBackup(encodeLocalBackup(fixture.payload)), fixture.payload);
});

test('local backup rejects digest tampering, forged lengths, and non-v2 payloads', () => {
  const bytes = Buffer.from(fixture.backupBase64, 'base64');
  const tampered = Buffer.from(bytes);
  tampered[10] ^= 0x01;
  assert.throws(() => decodeLocalBackup(tampered), /digest mismatch/);

  const forgedLength = Buffer.from(bytes);
  const envelope = forgedLength.subarray(0, -32);
  envelope.writeUInt32LE(envelope.readUInt32LE(0) + 1, 0);
  createHash('sha256')
    .update(envelope)
    .digest()
    .copy(forgedLength, forgedLength.length - 32);
  assert.throws(() => decodeLocalBackup(forgedLength), /deflate payload is invalid/);

  assert.throws(
    () => encodeLocalBackup({ ...fixture.payload, version: 1 }),
    (error) => error instanceof SchemaError && error.message.includes('LocalBackupPayload'),
  );
});

test('local export publishes atomically, preserves existing files, and supports explicit overwrite', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'xgg-local-export-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const gateway = fakeGateway(fixture.payload);
  const output = join(root, 'nested', 'export.bak');

  const exported = await exportLocalBackup(output, gateway.deps);
  assert.equal(exported.file, output);
  assert.equal(exported.rules, 1);
  assert.equal(exported.variables, 1);
  assert.deepEqual(await readLocalBackup(output), fixture.payload);
  assert.equal((await stat(output)).mode & 0o777, 0o600);

  const existing = join(root, 'existing.bak');
  await writeFile(existing, 'keep-me');
  await assert.rejects(exportLocalBackup(existing, gateway.deps), ConfigError);
  assert.equal(await readFile(existing, 'utf8'), 'keep-me');

  await exportLocalBackup(existing, gateway.deps, { overwrite: true });
  assert.deepEqual(await readLocalBackup(existing), fixture.payload);
  assert.deepEqual(
    (await readdir(root, { recursive: true })).filter((name) => name.includes('.tmp')),
    [],
  );
});

test('dry-run plan enumerates every live delete and backup create without writes', async () => {
  const gateway = fakeGateway();
  const plan = await planLocalBackupImport(fixture.payload, gateway.deps);

  assert.deepEqual(plan.totals, {
    deleteRules: 1,
    deleteVariableScopes: 2,
    deleteVariables: 2,
    createRules: 1,
    createVariableScopes: 1,
    createVariables: 1,
  });
  assert.deepEqual(
    plan.delete.rules.map((rule) => rule.id),
    ['currentRule'],
  );
  assert.deepEqual(
    plan.delete.variables.map((variable) => `${variable.scope}.${variable.id}`),
    ['global.oldGlobal', 'RcurrentRule.oldLocal'],
  );
  assert.deepEqual(
    plan.create.rules.map((rule) => rule.id),
    ['fixtureRule'],
  );
  assert.deepEqual(
    plan.create.variables.map((variable) => `${variable.scope}.${variable.id}`),
    ['global.fixtureVar'],
  );
  assert.equal(
    gateway.calls.some((call) => call.requestOptions?.kind === 'write'),
    false,
  );
});

test('deterministic import validation and confirmation fail before session access', async () => {
  const invalid = structuredClone(fixture.payload);
  invalid.variables.global = { 'bad-id': invalid.variables.global.fixtureVar };
  const invalidGateway = fakeGateway();

  await assert.rejects(planLocalBackupImport(invalid, invalidGateway.deps), SchemaError);
  assert.equal(invalidGateway.storeReads, 0);
  assert.deepEqual(invalidGateway.calls, []);

  const guardedGateway = fakeGateway();
  await assert.rejects(
    importLocalBackup(fixture.payload, guardedGateway.deps, { confirmReplaceAll: false }),
    ConfigError,
  );
  assert.equal(guardedGateway.storeReads, 0);
  assert.deepEqual(guardedGateway.calls, []);
  await validateLocalBackupPayload(fixture.payload);
});

test('schema preflight preserves disabled gateway-accepted drafts without authoring lint', async () => {
  const draft = structuredClone(fixture.payload);
  draft.rules[0].cfg.enable = false;
  draft.rules[0].nodes[0].outputs.output = ['fixtureSource.input'];

  assert.deepEqual(await validateLocalBackupPayload(draft), draft);
});

test('confirmed import snapshots, leases, and applies the exact bundle restore order', async (t) => {
  const snapshotsDir = await mkdtemp(join(tmpdir(), 'xgg-local-import-snapshot-'));
  t.after(() => rm(snapshotsDir, { recursive: true, force: true }));
  const gateway = fakeGateway();

  const result = await importLocalBackup(fixture.payload, gateway.deps, {
    confirmReplaceAll: true,
    snapshotsDir,
  });

  assert.deepEqual(result.applied, {
    deletedRules: 1,
    deletedVariableScopes: 2,
    createdVariables: 1,
    setVariableValues: 1,
    createdRules: 1,
  });
  const writeCalls = gateway.calls.filter((call) => call.requestOptions?.kind === 'write');
  assert.deepEqual(
    writeCalls.map((call) => call.method),
    [
      '/api/deleteGraph',
      '/api/deleteVar',
      '/api/deleteVar',
      '/api/createVar',
      '/api/setVarValue',
      '/api/setGraph',
    ],
  );
  assert.equal(
    writeCalls.every((call) => call.requestOptions.leaseId === gateway.leaseId),
    true,
  );
  assert.deepEqual(
    gateway.controls
      .filter((call) => call.method.startsWith('$mutation.'))
      .map((call) => call.method),
    ['$mutation.acquire', '$mutation.release'],
  );

  const snapshot = JSON.parse(await readFile(result.snapshot, 'utf8'));
  assert.equal(snapshot.kind, 'xgg-pre-write-rollback');
  assert.deepEqual(
    snapshot.rules.map((rule) => rule.id),
    ['currentRule'],
  );
  assert.deepEqual(Object.keys(snapshot.variables).sort(), ['RcurrentRule', 'global']);
  const firstWrite = gateway.calls.findIndex((call) => call.requestOptions?.kind === 'write');
  const snapshotReads = gateway.calls.slice(0, firstWrite).map((call) => call.method);
  assert.equal(snapshotReads.includes('/api/getDevList'), true);
  assert.equal(snapshotReads.includes('/api/getGraph'), true);
  assert.equal(snapshotReads.includes('/api/getVarList'), true);
});

test('partial import stops immediately, returns NOT_CONFIRMED, and fences the workflow', async (t) => {
  const snapshotsDir = await mkdtemp(join(tmpdir(), 'xgg-local-import-fence-'));
  t.after(() => rm(snapshotsDir, { recursive: true, force: true }));
  const gateway = fakeGateway(currentPayload(), { failMethod: '/api/createVar' });

  await assert.rejects(
    importLocalBackup(fixture.payload, gateway.deps, {
      confirmReplaceAll: true,
      snapshotsDir,
    }),
    (error) =>
      error instanceof NotConfirmedError &&
      error.details?.operation === 'backup.local-import' &&
      error.details?.phase === 'create-variables' &&
      error.details?.causeCode === 'GATEWAY',
  );

  const methods = gateway.calls.map((call) => call.method);
  assert.equal(methods.includes('/api/createVar'), true);
  assert.equal(methods.includes('/api/setVarValue'), false);
  assert.equal(methods.includes('/api/setGraph'), false);
  assert.deepEqual(
    gateway.controls
      .filter((call) => call.method.startsWith('$mutation.'))
      .map((call) => call.method),
    ['$mutation.acquire', '$mutation.fence', '$mutation.release'],
  );
  assert.equal((await readdir(snapshotsDir)).length, 1);
});
