import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { GcmStream } from '../dist/crypto/gcm.js';
import {
  NetworkError,
  NotConfirmedError,
  agentCall,
  canonicalGatewayKey,
  createFileMutationLeaseCoordinator,
  createIpcClient,
  createIpcServer,
  logout,
  runAgent,
  withMutationWorkflow,
} from '../dist/index.js';
import { makeFakeTransportPair } from '../dist/transport/fake.js';

const host = 'http://mutation-lease.test';
const startedAt = '2026-07-19T00:00:00.000Z';

function endpoint(dir, name) {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\xgg-mutation-${process.pid}-${name}-${randomUUID()}`
    : join(dir, `${name}.sock`);
}

function sessionStore(socketPath, selectedHost = host) {
  let reads = 0;
  return {
    get reads() {
      return reads;
    },
    async read() {
      reads += 1;
      return {
        host: selectedHost,
        pid: process.pid,
        socketPath,
        agentStartedAt: startedAt,
        agentVersion: 'test',
        lastValidatedAt: startedAt,
      };
    },
  };
}

function call(deps, method, params, kind = 'read', timeoutMs = 1_000) {
  return agentCall({ ...deps, method, params, kind, timeoutMs });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function handshakeFixture() {
  const key = Buffer.alloc(16, 1);
  const clientSalt = Buffer.alloc(8, 2);
  const serverSalt = Buffer.alloc(8, 3);
  return {
    clientKey: key,
    clientRecv: new GcmStream({ key, salt: serverSalt, direction: 'recv' }),
    clientSalt,
    clientSend: new GcmStream({ key, salt: clientSalt, direction: 'send' }),
    serverKey: key,
    serverSalt,
  };
}

function ticketDirectory(dir, selectedHost = host) {
  const key = canonicalGatewayKey(selectedHost);
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 32);
  return { key, path: join(dir, `mutation-${hash}.tickets`) };
}

test('no-snapshot graph mutations serialize the full read/modify/write/readback workflow', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'xgg-mutation-rmw-'));
  const socketPath = endpoint(dir, 'agent');
  const state = { nodes: [] };
  const trace = [];
  let firstRead;
  const firstReadSeen = new Promise((resolve) => {
    firstRead = resolve;
  });
  const connectionByActor = new Map();
  const server = await createIpcServer({
    path: socketPath,
    handler: async (request, context) => {
      if (request.method === '$ping') return { host, agentStartedAt: startedAt };
      const actor = request.params?.actor;
      if (actor) connectionByActor.set(actor, context.connectionId);
      if (request.method === '/api/getGraph') {
        trace.push(`${actor}:read`);
        if (actor === 'A') firstRead();
        return structuredClone(state);
      }
      if (request.method === '/api/setGraph') {
        trace.push(`${actor}:write`);
        state.nodes = structuredClone(request.params.nodes);
        return { ok: true };
      }
      throw new Error(`unexpected method ${request.method}`);
    },
  });
  t.after(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });
  const store = sessionStore(socketPath);
  const deps = { baseUrl: host, store };

  const mutate = (actor) =>
    withMutationWorkflow({ ...deps, operation: `no-snapshot-${actor}` }, async () => {
      // Deliberately no rollback snapshot: serialization must not depend on it.
      const before = await call(deps, '/api/getGraph', { actor });
      await delay(25);
      await call(deps, '/api/setGraph', { actor, nodes: [...before.nodes, actor] }, 'write');
      const after = await call(deps, '/api/getGraph', { actor });
      assert.equal(after.nodes.at(-1), actor);
    });

  const first = mutate('A');
  await firstReadSeen;
  const second = mutate('B');
  await Promise.all([first, second]);

  assert.deepEqual(state.nodes, ['A', 'B'], 'later writer must retain the first update');
  assert.deepEqual(trace, ['A:read', 'A:write', 'A:read', 'B:read', 'B:write', 'B:read']);
  assert.equal(store.reads, 2, 'one pinned session lookup per workflow');
  assert.notEqual(connectionByActor.get('A'), connectionByActor.get('B'));
});

test('lease prevents torn snapshots, enable TOCTOU, and delete/recreate ABA', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'xgg-mutation-races-'));
  const socketPath = endpoint(dir, 'agent');
  const state = {
    generation: 1,
    cfgVersion: 1,
    nodeVersion: 1,
    variableExists: true,
    enabled: false,
  };
  const trace = [];
  const server = await createIpcServer({
    path: socketPath,
    handler: async (request) => {
      if (request.method === '$ping') return { host, agentStartedAt: startedAt };
      const { actor } = request.params ?? {};
      trace.push(`${actor}:${request.method}`);
      switch (request.method) {
        case '/test/getCfg':
          return { version: state.cfgVersion, generation: state.generation };
        case '/test/getNodes':
          return { version: state.nodeVersion, generation: state.generation };
        case '/test/getVariable':
          return { exists: state.variableExists };
        case '/api/changeGraphConfig':
          state.enabled = request.params.enable;
          return { ok: true };
        case '/api/deleteVar':
          state.variableExists = false;
          return { ok: true };
        case '/api/deleteGraph':
          state.generation = 0;
          return { ok: true };
        case '/api/setGraph':
          state.generation = request.params.generation;
          state.cfgVersion = request.params.version;
          state.nodeVersion = request.params.version;
          return { ok: true };
        default:
          throw new Error(`unexpected method ${request.method}`);
      }
    },
  });
  t.after(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });
  const deps = { baseUrl: host, store: sessionStore(socketPath) };

  let cfgRead;
  const cfgSeen = new Promise((resolve) => {
    cfgRead = resolve;
  });
  let snapshot;
  const snapshotter = withMutationWorkflow({ ...deps, operation: 'snapshot' }, async () => {
    const cfg = await call(deps, '/test/getCfg', { actor: 'snapshot' });
    cfgRead();
    await delay(20);
    const nodes = await call(deps, '/test/getNodes', { actor: 'snapshot' });
    snapshot = { cfg, nodes };
  });
  await cfgSeen;
  const updater = withMutationWorkflow({ ...deps, operation: 'update' }, async () => {
    await call(deps, '/api/setGraph', { actor: 'update', generation: 1, version: 2 }, 'write');
  });
  await Promise.all([snapshotter, updater]);
  assert.equal(snapshot.cfg.version, snapshot.nodes.version, 'snapshot must describe one epoch');

  trace.length = 0;
  let validationRead;
  const validationSeen = new Promise((resolve) => {
    validationRead = resolve;
  });
  const enable = withMutationWorkflow({ ...deps, operation: 'enable' }, async () => {
    const variable = await call(deps, '/test/getVariable', { actor: 'enable' });
    assert.equal(variable.exists, true);
    validationRead();
    await delay(20);
    await call(deps, '/api/changeGraphConfig', { actor: 'enable', enable: true }, 'write');
  });
  await validationSeen;
  const deleteVariable = withMutationWorkflow({ ...deps, operation: 'delete-var' }, async () => {
    await call(deps, '/api/deleteVar', { actor: 'delete-var' }, 'write');
  });
  await Promise.all([enable, deleteVariable]);
  assert.deepEqual(trace, [
    'enable:/test/getVariable',
    'enable:/api/changeGraphConfig',
    'delete-var:/api/deleteVar',
  ]);

  state.generation = 1;
  trace.length = 0;
  let precheckRead;
  const precheckSeen = new Promise((resolve) => {
    precheckRead = resolve;
  });
  const deleteOld = withMutationWorkflow({ ...deps, operation: 'delete-old' }, async () => {
    const cfg = await call(deps, '/test/getCfg', { actor: 'delete-old' });
    assert.equal(cfg.generation, 1);
    precheckRead();
    await delay(20);
    await call(deps, '/api/deleteGraph', { actor: 'delete-old' }, 'write');
  });
  await precheckSeen;
  const recreate = withMutationWorkflow({ ...deps, operation: 'recreate' }, async () => {
    await call(deps, '/api/deleteGraph', { actor: 'recreate' }, 'write');
    await call(deps, '/api/setGraph', { actor: 'recreate', generation: 2, version: 2 }, 'write');
  });
  await Promise.all([deleteOld, recreate]);
  assert.equal(state.generation, 2, 'old deleter must not delete the recreated generation');
});

test('replacement daemons share one canonical-host filesystem lease', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'xgg-mutation-replacement-'));
  const firstSocket = endpoint(dir, 'first');
  const secondSocket = endpoint(dir, 'second');
  const firstLease = createFileMutationLeaseCoordinator({
    host: 'http://MUTATION-LEASE.test/path?a=1',
    baseDir: dir,
    retryMs: 5,
  });
  const secondLease = createFileMutationLeaseCoordinator({
    host: 'http://mutation-lease.test/',
    baseDir: dir,
    retryMs: 5,
  });
  const handler = async (request) => {
    if (request.method === '$ping') return { host, agentStartedAt: startedAt };
    return { ok: true };
  };
  const first = await createIpcServer({
    path: firstSocket,
    handler,
    mutationLeases: firstLease,
  });
  const second = await createIpcServer({
    path: secondSocket,
    handler,
    mutationLeases: secondLease,
  });
  t.after(async () => {
    await Promise.all([first.close(), second.close()]);
    await rm(dir, { recursive: true, force: true });
  });
  const c1 = createIpcClient({ path: firstSocket });
  const c2 = createIpcClient({ path: secondSocket });
  t.after(() => {
    c1.close();
    c2.close();
  });
  const one = await c1.request('$mutation.acquire', {
    operation: 'old-daemon',
    waitTimeoutMs: 1_000,
  });
  let secondSettled = false;
  const twoPending = c2
    .request('$mutation.acquire', { operation: 'replacement-daemon', waitTimeoutMs: 1_000 })
    .finally(() => {
      secondSettled = true;
    });
  await delay(40);
  assert.equal(secondSettled, false);
  await c1.request('$mutation.release', { leaseId: one.leaseId });
  const two = await twoPending;
  assert.equal(typeof two.leaseId, 'string');
  await c2.request('$mutation.release', { leaseId: two.leaseId });

  const blocker = await c1.request('$mutation.acquire', {
    operation: 'block-abandoned-waiter',
    waitTimeoutMs: 1_000,
  });
  const abandoned = createIpcClient({ path: secondSocket });
  const abandonedAcquire = abandoned.request('$mutation.acquire', {
    operation: 'abandoned-waiter',
    waitTimeoutMs: 1_000,
  });
  const abandonedRejected = assert.rejects(abandonedAcquire, NetworkError);
  await delay(30);
  abandoned.close();
  await abandonedRejected;
  await c1.request('$mutation.release', { leaseId: blocker.leaseId });
  const survivor = createIpcClient({ path: secondSocket });
  const survivorLease = await survivor.request('$mutation.acquire', {
    operation: 'after-abandoned-waiter',
    waitTimeoutMs: 1_000,
  });
  await survivor.request('$mutation.release', { leaseId: survivorLease.leaseId });
  survivor.close();

  await c1.request('$shutdown.prepare', { waitTimeoutMs: 1_000 });
  let postPrepareSettled = false;
  const postPrepare = c2
    .request('$mutation.acquire', { operation: 'after-shutdown-prepare', waitTimeoutMs: 1_000 })
    .finally(() => {
      postPrepareSettled = true;
    });
  await delay(40);
  assert.equal(postPrepareSettled, false, 'shutdown preparation must fence replacement daemon');
  c1.close();
  const afterPrepare = await postPrepare;
  await c2.request('$mutation.release', { leaseId: afterPrepare.leaseId });
});

test('logout retains the cross-daemon lease until the old IPC server has stopped', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'xgg-mutation-logout-'));
  const firstSocket = endpoint(dir, 'logout-old');
  const secondSocket = endpoint(dir, 'logout-replacement');
  const firstLease = createFileMutationLeaseCoordinator({ host, baseDir: dir, retryMs: 5 });
  const secondLease = createFileMutationLeaseCoordinator({ host, baseDir: dir, retryMs: 5 });
  const handler = async (request) => {
    if (request.method === '$ping') {
      return { host, agentStartedAt: startedAt, shutdownViaIpc: true };
    }
    return { ok: true };
  };
  let signalObserved;
  const signalSeen = new Promise((resolve) => {
    signalObserved = resolve;
  });
  let first = null;
  first = await createIpcServer({
    path: firstSocket,
    handler,
    mutationLeases: firstLease,
    onShutdown: () => {
      signalObserved();
      setTimeout(() => {
        void first.close();
      }, 80);
    },
  });
  const second = await createIpcServer({
    path: secondSocket,
    handler,
    mutationLeases: secondLease,
  });
  const replacementClient = createIpcClient({ path: secondSocket });
  t.after(async () => {
    replacementClient.close();
    await Promise.all([first.close(), second.close()]);
    await rm(dir, { recursive: true, force: true });
  });

  const session = {
    host,
    pid: process.pid,
    socketPath: firstSocket,
    agentStartedAt: startedAt,
    agentVersion: 'test',
    lastValidatedAt: startedAt,
  };
  let deleted = false;
  const logoutPending = logout({
    baseUrl: host,
    store: {
      async read() {
        return session;
      },
      async deleteIfMatch() {
        deleted = true;
      },
    },
    mutationWaitMs: 1_000,
  });

  await signalSeen;
  let replacementSettled = false;
  const replacementPending = replacementClient
    .request('$mutation.acquire', { operation: 'replacement-during-logout', waitTimeoutMs: 1_000 })
    .finally(() => {
      replacementSettled = true;
    });
  await delay(30);
  assert.equal(replacementSettled, false, 'replacement must wait for old server shutdown');
  assert.equal(deleted, false, 'session removal must wait for old server shutdown');

  const replacementCompletion = replacementPending.then(async (replacement) => {
    await replacementClient.request('$mutation.release', { leaseId: replacement.leaseId });
  });
  assert.deepEqual(await logoutPending, { ok: true, host, wasRunning: true });
  assert.equal(deleted, true);
  await replacementCompletion;
});

test('logout keeps legacy daemon compatibility without sending unsupported shutdown meta', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'xgg-legacy-'));
  const socketPath = endpoint(dir, 'a');
  const base = createFileMutationLeaseCoordinator({ host, baseDir: dir, retryMs: 5 });
  let prepareCalls = 0;
  const leases = new Proxy(base, {
    get(target, property) {
      if (property === 'prepareShutdown') {
        return (...args) => {
          prepareCalls += 1;
          return target.prepareShutdown(...args);
        };
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  let server = null;
  server = await createIpcServer({
    path: socketPath,
    mutationLeases: leases,
    handler: async (request) =>
      request.method === '$ping' ? { host, agentStartedAt: startedAt } : { ok: true },
  });
  t.after(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });
  const session = {
    host,
    pid: process.pid,
    socketPath,
    agentStartedAt: startedAt,
    agentVersion: 'legacy',
    lastValidatedAt: startedAt,
  };
  const signals = [];
  assert.deepEqual(
    await logout({
      baseUrl: host,
      store: {
        async read() {
          return session;
        },
        async deleteIfMatch() {
          return true;
        },
      },
      mutationLockDir: dir,
      mutationWaitMs: 1_000,
      signal: (pid, signal) => {
        signals.push([pid, signal]);
        void server.close();
        return true;
      },
    }),
    { ok: true, host, wasRunning: true },
  );
  assert.deepEqual(signals, [[process.pid, 'SIGTERM']]);
  assert.equal(prepareCalls, 0);
});

test('ambiguous IPC shutdown waits for a briefly-live daemon to exit before recovery', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'xgg-commit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let resolveClose;
  const closed = new Promise((resolve) => {
    resolveClose = resolve;
  });
  let pidChecks = 0;
  let deleted = false;
  assert.deepEqual(
    await logout({
      baseUrl: host,
      store: {
        async read() {
          return {
            host,
            pid: 424_242,
            socketPath: endpoint(dir, 'a'),
            agentStartedAt: startedAt,
            agentVersion: 'commit-loss',
            lastValidatedAt: startedAt,
          };
        },
        async deleteIfMatch() {
          deleted = true;
          return true;
        },
      },
      mutationLockDir: dir,
      mutationWaitMs: 500,
      probe: async () => ({
        agentStartedAt: startedAt,
        identityMatches: true,
        requestShutdown: async () => {
          setTimeout(resolveClose, 5);
          throw new NetworkError('injected lost shutdown commit response');
        },
        waitForClose: () => closed,
      }),
      signal: (pid, signal) => {
        assert.equal(pid, 424_242);
        assert.equal(signal, 0);
        pidChecks += 1;
        return pidChecks < 3;
      },
    }),
    { ok: true, host, wasRunning: true },
  );
  assert.equal(pidChecks, 3);
  assert.equal(deleted, true);
});

test('shutdown preparation serializes behind a normal backend acquisition in progress', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'xgg-mutation-shutdown-order-'));
  const socketPath = endpoint(dir, 'shutdown-order');
  let releaseFirstAcquire;
  const firstAcquireGate = new Promise((resolve) => {
    releaseFirstAcquire = resolve;
  });
  let firstAcquirePublished;
  const firstAcquireSeen = new Promise((resolve) => {
    firstAcquirePublished = resolve;
  });
  let backendAcquires = 0;
  let concurrentBackendAcquires = 0;
  let maximumBackendAcquires = 0;
  const coordinator = createFileMutationLeaseCoordinator({
    host,
    baseDir: dir,
    retryMs: 2,
    _afterTicketPublished: async () => {
      backendAcquires += 1;
      concurrentBackendAcquires += 1;
      maximumBackendAcquires = Math.max(maximumBackendAcquires, concurrentBackendAcquires);
      if (backendAcquires === 1) {
        firstAcquirePublished();
        await firstAcquireGate;
      }
      concurrentBackendAcquires -= 1;
    },
  });
  const server = await createIpcServer({
    path: socketPath,
    mutationLeases: coordinator,
    handler: async (request) => {
      if (request.method === '$ping') return { host, agentStartedAt: startedAt };
      return { ok: true };
    },
  });
  const normalClient = createIpcClient({ path: socketPath });
  const shutdownClient = createIpcClient({ path: socketPath });
  t.after(async () => {
    releaseFirstAcquire?.();
    normalClient.close();
    shutdownClient.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  const normalPending = normalClient.request('$mutation.acquire', {
    operation: 'normal-before-shutdown',
    waitTimeoutMs: 1_000,
  });
  await firstAcquireSeen;
  let shutdownSettled = false;
  const shutdownPending = shutdownClient
    .request('$shutdown.prepare', { waitTimeoutMs: 1_000 })
    .finally(() => {
      shutdownSettled = true;
    });
  await delay(30);
  assert.equal(backendAcquires, 1, 'shutdown must not enter the backend concurrently');
  assert.equal(shutdownSettled, false);

  releaseFirstAcquire();
  const normal = await normalPending;
  await delay(30);
  assert.equal(shutdownSettled, false, 'shutdown must wait for the normal holder to release');
  await normalClient.request('$mutation.release', { leaseId: normal.leaseId });
  await shutdownPending;

  assert.equal(backendAcquires, 2, 'shutdown acquires the backend only after normal release');
  assert.equal(maximumBackendAcquires, 1, 'one coordinator must never overlap backend acquires');
});

test('shutdown takes priority when the in-progress normal acquisition is abandoned', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'xgg-ms-priority-'));
  const socketPath = endpoint(dir, 'p');
  let releaseFirstAcquire;
  const firstAcquireGate = new Promise((resolve) => {
    releaseFirstAcquire = resolve;
  });
  let firstAcquirePublished;
  const firstAcquireSeen = new Promise((resolve) => {
    firstAcquirePublished = resolve;
  });
  let backendAcquires = 0;
  const coordinator = createFileMutationLeaseCoordinator({
    host,
    baseDir: dir,
    retryMs: 2,
    _afterTicketPublished: async () => {
      backendAcquires += 1;
      if (backendAcquires === 1) {
        firstAcquirePublished();
        await firstAcquireGate;
      }
    },
  });
  const server = await createIpcServer({
    path: socketPath,
    mutationLeases: coordinator,
    handler: async () => ({ ok: true }),
  });
  const abandonedClient = createIpcClient({ path: socketPath });
  const queuedNormalClient = createIpcClient({ path: socketPath });
  const shutdownClient = createIpcClient({ path: socketPath });
  t.after(async () => {
    releaseFirstAcquire?.();
    abandonedClient.close();
    queuedNormalClient.close();
    shutdownClient.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  const abandonedPending = abandonedClient.request('$mutation.acquire', {
    operation: 'abandoned-normal',
    waitTimeoutMs: 1_500,
  });
  const abandonedRejected = assert.rejects(abandonedPending, NetworkError);
  await firstAcquireSeen;
  let queuedNormalSettled = false;
  const queuedNormalPending = queuedNormalClient
    .request('$mutation.acquire', { operation: 'queued-normal', waitTimeoutMs: 1_500 })
    .finally(() => {
      queuedNormalSettled = true;
    });
  const shutdownPending = shutdownClient.request('$shutdown.prepare', { waitTimeoutMs: 1_500 });
  abandonedClient.close();
  await abandonedRejected;
  releaseFirstAcquire();

  await shutdownPending;
  assert.equal(backendAcquires, 2, 'shutdown must acquire before the queued normal waiter');
  assert.equal(queuedNormalSettled, false);
  shutdownClient.close();

  const queuedNormal = await queuedNormalPending;
  assert.equal(backendAcquires, 3);
  await queuedNormalClient.request('$mutation.release', { leaseId: queuedNormal.leaseId });
});

test('an abandoned shifted shutdown waiter wakes the next shutdown waiter', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'xgg-ms-abandon-'));
  const socketPath = endpoint(dir, 'a');
  let releaseFirstAcquire;
  const firstAcquireGate = new Promise((resolve) => {
    releaseFirstAcquire = resolve;
  });
  let firstAcquirePublished;
  const firstAcquireSeen = new Promise((resolve) => {
    firstAcquirePublished = resolve;
  });
  let backendAcquires = 0;
  const coordinator = createFileMutationLeaseCoordinator({
    host,
    baseDir: dir,
    retryMs: 2,
    _afterTicketPublished: async () => {
      backendAcquires += 1;
      if (backendAcquires === 1) {
        firstAcquirePublished();
        await firstAcquireGate;
      }
    },
  });
  const server = await createIpcServer({
    path: socketPath,
    mutationLeases: coordinator,
    handler: async () => ({ ok: true }),
  });
  const abandonedClient = createIpcClient({ path: socketPath });
  const survivingClient = createIpcClient({ path: socketPath });
  t.after(async () => {
    releaseFirstAcquire?.();
    abandonedClient.close();
    survivingClient.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  const abandonedPending = abandonedClient.request('$shutdown.prepare', { waitTimeoutMs: 1_500 });
  const abandonedRejected = assert.rejects(abandonedPending, NetworkError);
  await firstAcquireSeen;
  const survivingPending = survivingClient.request('$shutdown.prepare', { waitTimeoutMs: 1_500 });
  abandonedClient.close();
  await abandonedRejected;
  releaseFirstAcquire();

  await survivingPending;
  assert.equal(backendAcquires, 2, 'the surviving shutdown waiter must be pumped immediately');
});

test('three concurrent stale-ticket cleaners retain one bakery-lease holder', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'xgg-mutation-ticket-aba-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tickets = ticketDirectory(dir);
  const staleToken = randomUUID();
  await mkdir(tickets.path, { recursive: true, mode: 0o700 });
  await writeFile(
    join(tickets.path, `owner-${staleToken}.json`),
    `${JSON.stringify({
      version: 3,
      host: tickets.key,
      pid: process.pid,
      processStartId: 'stale-process-birth',
      token: staleToken,
      createdAt: new Date().toISOString(),
    })}\n`,
  );
  await writeFile(
    join(tickets.path, `number-${staleToken}.json`),
    `${JSON.stringify({ version: 1, token: staleToken, number: 1 })}\n`,
  );

  const arrived = new Set();
  let releaseCleanup;
  const cleanupBarrier = new Promise((resolve) => {
    releaseCleanup = resolve;
  });
  const coordinators = Array.from({ length: 3 }, (_, index) =>
    createFileMutationLeaseCoordinator({
      host,
      baseDir: dir,
      retryMs: 2,
      _processStartIdentity: async () => 'current-process-birth',
      _beforeStaleTicketCleanup: async (token) => {
        assert.equal(token, staleToken);
        arrived.add(index);
        if (arrived.size === 3) releaseCleanup();
        await cleanupBarrier;
      },
    }),
  );
  t.after(() => Promise.all(coordinators.map((coordinator) => coordinator.close())));

  let holders = 0;
  let maximumHolders = 0;
  await Promise.all(
    coordinators.map(async (coordinator, index) => {
      const leaseId = await coordinator.acquire(`contender-${index}`, `contender-${index}`, 2_000);
      holders += 1;
      maximumHolders = Math.max(maximumHolders, holders);
      await delay(25);
      holders -= 1;
      await coordinator.release(`contender-${index}`, leaseId);
    }),
  );
  assert.equal(arrived.size, 3, 'all three contenders must race the same stale ticket cleanup');
  assert.equal(maximumHolders, 1, 'at most one contender may hold the lease');
});

test('holder crash is reclaimed and a mismatched process birth identity defeats PID reuse ABA', async (t) => {
  if (process.platform === 'win32') {
    t.skip('SIGKILL crash fixture is POSIX-only');
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), 'xgg-mutation-crash-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const coreUrl = pathToFileURL(join(process.cwd(), 'packages/core/dist/index.js')).href;
  const childCode = `
    import { createFileMutationLeaseCoordinator } from ${JSON.stringify(coreUrl)};
    const lease = createFileMutationLeaseCoordinator({host:${JSON.stringify(host)},baseDir:${JSON.stringify(dir)},retryMs:5});
    await lease.acquire('child','holder',1000);
    process.stdout.write('READY\\n');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', childCode], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.once('data', (chunk) => {
      assert.match(String(chunk), /READY/);
      resolve();
    });
  });
  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('exit', resolve));

  const afterCrash = createFileMutationLeaseCoordinator({ host, baseDir: dir, retryMs: 5 });
  const crashLease = await afterCrash.acquire('parent', 'after-crash', 2_000);
  await afterCrash.release('parent', crashLease);
  await afterCrash.close();

  const tickets = ticketDirectory(dir);
  const staleToken = randomUUID();
  await mkdir(tickets.path, { recursive: true, mode: 0o700 });
  await writeFile(
    join(tickets.path, `owner-${staleToken}.json`),
    `${JSON.stringify({
      version: 3,
      host: tickets.key,
      pid: process.pid,
      processStartId: 'definitely-not-this-process-birth',
      token: staleToken,
      createdAt: new Date().toISOString(),
    })}\n`,
  );
  await writeFile(
    join(tickets.path, `number-${staleToken}.json`),
    `${JSON.stringify({ version: 1, token: staleToken, number: 1 })}\n`,
  );
  const afterPidReuse = createFileMutationLeaseCoordinator({
    host,
    baseDir: dir,
    retryMs: 5,
    _processStartIdentity: async () => 'test:observed-new-process-birth',
  });
  const reusedLease = await afterPidReuse.acquire('parent-2', 'pid-reuse', 2_000);
  await afterPidReuse.release('parent-2', reusedLease);
  await afterPidReuse.close();

  const fallbackOwner = createFileMutationLeaseCoordinator({
    host,
    baseDir: dir,
    retryMs: 5,
    _processStartIdentity: async () => 'unavailable',
  });
  const fallbackLease = await fallbackOwner.acquire('fallback-owner', 'fallback-owner', 1_000);
  const fallbackContender = createFileMutationLeaseCoordinator({
    host,
    baseDir: dir,
    retryMs: 5,
    _processStartIdentity: async () => 'test:later-observable-birth',
  });
  await assert.rejects(
    fallbackContender.acquire('fallback-contender', 'fallback-contender', 30),
    NetworkError,
    'an unavailable birth identity must never allow stealing from a live PID',
  );
  await fallbackOwner.release('fallback-owner', fallbackLease);
  await Promise.all([fallbackOwner.close(), fallbackContender.close()]);
});

test('daemon crash after write-start leaves a persistent replacement fence until logout', async (t) => {
  if (process.platform === 'win32') {
    t.skip('SIGKILL crash fixture is POSIX-only');
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), 'xgg-mutation-write-crash-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const coreUrl = pathToFileURL(join(process.cwd(), 'packages/core/dist/index.js')).href;
  const childCode = `
    import { createFileMutationLeaseCoordinator } from ${JSON.stringify(coreUrl)};
    const lease = createFileMutationLeaseCoordinator({host:${JSON.stringify(host)},baseDir:${JSON.stringify(dir)},retryMs:5});
    const leaseId = await lease.acquire('child','crash-after-write',1000);
    await lease.enter('child', leaseId, true);
    process.stdout.write('WRITE_FENCED\\n');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', childCode], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.once('data', (chunk) => {
      assert.match(String(chunk), /WRITE_FENCED/);
      resolve();
    });
  });
  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('exit', resolve));

  const replacement = createFileMutationLeaseCoordinator({ host, baseDir: dir, retryMs: 5 });
  await assert.rejects(
    replacement.acquire('replacement', 'must-not-pass-crash-fence', 1_000),
    (error) =>
      error instanceof NetworkError &&
      /fenced after an unconfirmed daemon write/.test(error.message),
  );
  await replacement.close();

  let deleted = false;
  const crashedSession = {
    host,
    pid: child.pid,
    socketPath: endpoint(dir, 'dead-daemon'),
    agentStartedAt: startedAt,
    agentVersion: 'crashed-test-daemon',
    lastValidatedAt: startedAt,
  };
  assert.deepEqual(
    await logout({
      baseUrl: host,
      store: {
        async read() {
          return crashedSession;
        },
        async deleteIfMatch(expected) {
          assert.deepEqual(expected, crashedSession);
          deleted = true;
          return true;
        },
      },
      mutationLockDir: dir,
      mutationWaitMs: 1_000,
      probeTimeoutMs: 50,
    }),
    { ok: true, host, wasRunning: false },
  );
  assert.equal(deleted, true, 'one offline logout must remove the crashed session');

  const afterLogout = createFileMutationLeaseCoordinator({ host, baseDir: dir, retryMs: 5 });
  const leaseId = await afterLogout.acquire('after-logout', 'after-logout', 1_000);
  await afterLogout.release('after-logout', leaseId);
  await afterLogout.close();
});

test('one logout recovers when the daemon crashes after shutdown preparation', async (t) => {
  if (process.platform === 'win32') {
    t.skip('SIGKILL crash fixture is POSIX-only');
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), 'xgg-mutation-live-crash-'));
  const socketPath = endpoint(dir, 'live-before-crash');
  const coreUrl = pathToFileURL(join(process.cwd(), 'packages/core/dist/index.js')).href;
  const childCode = `
    import { createFileMutationLeaseCoordinator, createIpcServer } from ${JSON.stringify(coreUrl)};
    const lease = createFileMutationLeaseCoordinator({host:${JSON.stringify(host)},baseDir:${JSON.stringify(dir)},retryMs:5});
    const leaseId = await lease.acquire('child','prepared-crash',1000);
    const exitWrite = await lease.enter('child', leaseId, true);
    exitWrite();
    lease.fence('child', leaseId, 'prepared crash');
    await lease.release('child', leaseId);
    await createIpcServer({
      path:${JSON.stringify(socketPath)},
      mutationLeases:lease,
      onShutdown:() => process.kill(process.pid, 'SIGKILL'),
      handler:async (request) => request.method === '$ping'
        ? {host:${JSON.stringify(host)},agentStartedAt:${JSON.stringify(startedAt)},shutdownViaIpc:true}
        : {ok:true},
    });
    process.stdout.write('READY\\n');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', childCode], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.once('data', (chunk) => {
      assert.match(String(chunk), /READY/);
      resolve();
    });
  });
  const childExit = new Promise((resolve) => child.once('exit', resolve));

  const session = {
    host,
    pid: child.pid,
    socketPath,
    agentStartedAt: startedAt,
    agentVersion: 'prepared-crash-daemon',
    lastValidatedAt: startedAt,
  };
  let deleted = false;
  assert.deepEqual(
    await logout({
      baseUrl: host,
      store: {
        async read() {
          return session;
        },
        async deleteIfMatch(expected) {
          assert.deepEqual(expected, session);
          deleted = true;
          return true;
        },
      },
      mutationLockDir: dir,
      mutationWaitMs: 2_000,
    }),
    { ok: true, host, wasRunning: true },
  );
  await childExit;
  assert.equal(deleted, true);

  const afterCrash = createFileMutationLeaseCoordinator({ host, baseDir: dir, retryMs: 5 });
  const leaseId = await afterCrash.acquire('after-prepared-crash', 'after-prepared-crash', 1_000);
  await afterCrash.release('after-prepared-crash', leaseId);
  await afterCrash.close();
});

test('one logout recovers a dead prepared owner when its shutdown response was lost', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'xgg-mutation-prepare-response-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tickets = ticketDirectory(dir);
  const staleToken = randomUUID();
  await mkdir(tickets.path, { recursive: true, mode: 0o700 });
  await writeFile(
    join(tickets.path, `owner-${staleToken}.json`),
    `${JSON.stringify({
      version: 3,
      host: tickets.key,
      pid: process.pid,
      processStartId: 'dead-prepared-daemon-birth',
      token: staleToken,
      createdAt: startedAt,
    })}\n`,
  );
  await writeFile(
    join(tickets.path, `number-${staleToken}.json`),
    `${JSON.stringify({ version: 1, token: staleToken, number: 1 })}\n`,
  );
  await writeFile(
    join(tickets.path, `fence-${staleToken}.json`),
    `${JSON.stringify({ version: 1, token: staleToken })}\n`,
  );
  const session = {
    host,
    pid: process.pid,
    socketPath: endpoint(dir, 'dead-prepared-daemon'),
    agentStartedAt: startedAt,
    agentVersion: 'prepare-response-crash',
    lastValidatedAt: startedAt,
  };
  let deleted = false;
  assert.deepEqual(
    await logout({
      baseUrl: host,
      store: {
        async read() {
          return session;
        },
        async deleteIfMatch() {
          deleted = true;
          return true;
        },
      },
      mutationLockDir: dir,
      mutationWaitMs: 1_000,
      probe: async () => ({
        agentStartedAt: startedAt,
        identityMatches: true,
        prepareError: new NetworkError('injected lost shutdown prepare response'),
      }),
      signal: (pid, signal) => {
        assert.equal(pid, process.pid);
        assert.equal(signal, 0);
        return false;
      },
    }),
    { ok: true, host, wasRunning: false },
  );
  assert.equal(deleted, true);
  const afterCrash = createFileMutationLeaseCoordinator({ host, baseDir: dir, retryMs: 5 });
  const leaseId = await afterCrash.acquire(
    'after-prepare-response',
    'after-prepare-response',
    1_000,
  );
  await afterCrash.release('after-prepare-response', leaseId);
  await afterCrash.close();
});

test('offline logout never clears a persistent fence while the recorded pid is alive', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'xgg-mutation-live-offline-'));
  const owner = createFileMutationLeaseCoordinator({ host, baseDir: dir, retryMs: 5 });
  const contender = createFileMutationLeaseCoordinator({ host, baseDir: dir, retryMs: 5 });
  t.after(async () => {
    await Promise.all([owner.close(), contender.close()]);
    await rm(dir, { recursive: true, force: true });
  });

  const leaseId = await owner.acquire('live-owner', 'live-owner', 1_000);
  const exitWrite = await owner.enter('live-owner', leaseId, true);
  exitWrite();
  owner.fence('live-owner', leaseId, 'unconfirmed write');
  await owner.release('live-owner', leaseId);

  let deleted = false;
  await assert.rejects(
    logout({
      baseUrl: host,
      store: {
        async read() {
          return {
            host,
            pid: process.pid,
            socketPath: endpoint(dir, 'unreachable-live-daemon'),
            agentStartedAt: startedAt,
            agentVersion: 'live-test-daemon',
            lastValidatedAt: startedAt,
          };
        },
        async deleteIfMatch() {
          deleted = true;
          return true;
        },
      },
      mutationLockDir: dir,
      probeTimeoutMs: 50,
    }),
    (error) => error instanceof NetworkError && /pid is still alive/.test(error.message),
  );
  assert.equal(deleted, false);
  await assert.rejects(
    contender.acquire('contender', 'must-wait-for-live-owner', 40),
    NetworkError,
  );

  await owner.prepareShutdown('test-cleanup', 1_000);
  owner.commitShutdown('test-cleanup');
  owner.beginDaemonShutdown();
  await owner.close();
});

test('shutdown prepare without same-connection commit preserves a durable fence', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'xgg-mutation-prepare-only-'));
  const coordinator = createFileMutationLeaseCoordinator({ host, baseDir: dir, retryMs: 5 });
  t.after(async () => {
    await coordinator.close();
    await rm(dir, { recursive: true, force: true });
  });
  const leaseId = await coordinator.acquire('holder', 'prepare-only', 1_000);
  const exitWrite = await coordinator.enter('holder', leaseId, true);
  exitWrite();
  coordinator.fence('holder', leaseId, 'unconfirmed');
  await coordinator.release('holder', leaseId);
  await coordinator.prepareShutdown('uncommitted-probe', 1_000);
  coordinator.beginDaemonShutdown();
  await coordinator.close();

  assert.equal(
    (await readdir(ticketDirectory(dir).path)).some((name) => name.startsWith('fence-')),
    true,
  );
  const recovery = createFileMutationLeaseCoordinator({ host, baseDir: dir, retryMs: 5 });
  await assert.rejects(
    recovery.acquire('normal', 'normal', 100),
    (error) => error instanceof NetworkError && /fenced after/.test(error.message),
  );
  await recovery.prepareShutdown('explicit-cleanup', 1_000);
  recovery.commitShutdown('explicit-cleanup');
  recovery.beginDaemonShutdown();
  await recovery.close();
});

test('committed cleanup drains a pending fence publication before release', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'xgg-mutation-mark-drain-'));
  const socketPath = endpoint(dir, 'mark-drain');
  let releaseMark;
  const markGate = new Promise((resolve) => {
    releaseMark = resolve;
  });
  let observeMark;
  const markReached = new Promise((resolve) => {
    observeMark = resolve;
  });
  const coordinator = createFileMutationLeaseCoordinator({
    host,
    baseDir: dir,
    retryMs: 5,
    _beforeWriteFencePublished: async () => {
      observeMark();
      await markGate;
    },
  });
  let gatewayWrites = 0;
  let shutdownClose;
  let observeShutdown;
  const shutdownStarted = new Promise((resolve) => {
    observeShutdown = resolve;
  });
  const server = await createIpcServer({
    path: socketPath,
    mutationLeases: coordinator,
    onShutdown: () => {
      coordinator.beginDaemonShutdown();
      shutdownClose = coordinator.close();
      observeShutdown();
    },
    handler: async (request) => {
      if (request.method === '/api/setGraph') gatewayWrites += 1;
      return { ok: true };
    },
  });
  const holder = createIpcClient({ path: socketPath });
  const shutdown = createIpcClient({ path: socketPath });
  t.after(async () => {
    releaseMark();
    holder.close();
    shutdown.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  const acquired = await holder.request('$mutation.acquire', {
    operation: 'pending-mark',
    waitTimeoutMs: 1_000,
  });
  const writePending = holder.request(
    '/api/setGraph',
    { nodes: [] },
    { kind: 'write', leaseId: acquired.leaseId },
  );
  await markReached;
  await holder.request('$mutation.release', { leaseId: acquired.leaseId });
  await shutdown.request('$shutdown.prepare', { waitTimeoutMs: 1_000 });
  await shutdown.request('$shutdown.commit', null);
  await shutdownStarted;

  let closeSettled = false;
  void shutdownClose.finally(() => {
    closeSettled = true;
  });
  await delay(30);
  assert.equal(closeSettled, false, 'cleanup must drain the pending fence publication');
  assert.equal(
    (await readdir(ticketDirectory(dir).path)).some((name) => name.startsWith('owner-')),
    true,
  );
  const replacement = createFileMutationLeaseCoordinator({ host, baseDir: dir, retryMs: 5 });
  let replacementSettled = false;
  const replacementPending = replacement
    .acquire('replacement', 'replacement', 1_000)
    .finally(() => {
      replacementSettled = true;
    });
  await delay(30);
  assert.equal(replacementSettled, false);

  releaseMark();
  await assert.rejects(writePending, NetworkError);
  await shutdownClose;
  const replacementLease = await replacementPending;
  assert.equal(gatewayWrites, 0, 'the old handler must never reach the gateway after shutdown');
  await replacement.release('replacement', replacementLease);
  await replacement.close();
  const finalNames = await readdir(ticketDirectory(dir).path);
  assert.equal(
    finalNames.some((name) => name.startsWith('owner-')),
    false,
  );
  assert.equal(
    finalNames.some((name) => name.startsWith('fence-')),
    false,
  );
});

test('agent shutdown releases its fenced ticket only after the gateway transport stops', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'xgg-mutation-agent-stop-'));
  const socketPath = endpoint(dir, 'agent-stop');
  const [transport] = makeFakeTransportPair();
  const closeTransport = transport.close.bind(transport);
  let observeCloseRequest;
  const closeRequested = new Promise((resolve) => {
    observeCloseRequest = resolve;
  });
  let confirmPhysicalClose;
  const physicalClose = new Promise((resolve) => {
    confirmPhysicalClose = resolve;
  });
  transport.close = () => {
    observeCloseRequest();
    void closeTransport();
    return physicalClose;
  };

  let coordinator;
  let serverClosed = false;
  let agent = null;
  t.after(async () => {
    confirmPhysicalClose();
    await closeTransport();
    await agent?.stop().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  agent = await runAgent({
    createServer: async (options) => {
      coordinator = options.mutationLeases;
      assert.equal(options.closeMutationLeases, false);
      const server = await createIpcServer(options);
      return {
        close: async () => {
          serverClosed = true;
          await server.close();
        },
      };
    },
    handshake: handshakeFixture(),
    host,
    idleMs: 60_000,
    meta: { agentStartedAt: startedAt, agentVersion: 'run-agent-test' },
    mutationLockDir: dir,
    socketPath,
    transport,
  });
  assert.ok(coordinator);

  const leaseId = await coordinator.acquire('holder', 'late-write', 1_000);
  const exitWrite = await coordinator.enter('holder', leaseId, true);
  exitWrite();
  coordinator.fence('holder', leaseId, 'late acknowledgement');
  await coordinator.release('holder', leaseId);

  let deleted = false;
  let logoutSettled = false;
  const session = {
    host,
    pid: process.pid,
    socketPath,
    agentStartedAt: startedAt,
    agentVersion: 'run-agent-test',
    lastValidatedAt: startedAt,
  };
  const logoutPending = logout({
    baseUrl: host,
    store: {
      async read() {
        return session;
      },
      async deleteIfMatch(expected) {
        assert.deepEqual(expected, session);
        deleted = true;
        return true;
      },
    },
    mutationLockDir: dir,
    mutationWaitMs: 1_000,
  }).finally(() => {
    logoutSettled = true;
  });
  await closeRequested;
  assert.equal(serverClosed, true, 'IPC accept must stop before gateway transport shutdown');

  const ticketNames = await readdir(ticketDirectory(dir).path);
  assert.equal(
    ticketNames.some((name) => name.startsWith('owner-')),
    true,
  );
  assert.equal(
    ticketNames.some((name) => name.startsWith('fence-')),
    true,
  );
  await delay(30);
  assert.equal(logoutSettled, false, 'logout recovery must wait for the old transport');
  assert.equal(deleted, false, 'session removal must wait for the old transport');

  confirmPhysicalClose();
  assert.deepEqual(await logoutPending, { ok: true, host, wasRunning: true });
  assert.equal(deleted, true);
  await agent.stop();

  const afterStop = createFileMutationLeaseCoordinator({ host, baseDir: dir, retryMs: 5 });
  const afterStopLease = await afterStop.acquire('after-stop', 'after-stop', 1_000);
  await afterStop.release('after-stop', afterStopLease);
  await afterStop.close();
});

test('mismatched daemon identity cannot authorize concurrent cleanup to clear its fence', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'xgg-mm-'));
  const socketPath = endpoint(dir, 'a');
  const [transport] = makeFakeTransportPair();
  const replacementStartedAt = '2026-07-19T00:00:01.000Z';
  let coordinator;
  let agent = null;
  t.after(async () => {
    await agent?.stop().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  agent = await runAgent({
    createServer: async (options) => {
      coordinator = options.mutationLeases;
      return createIpcServer(options);
    },
    handshake: handshakeFixture(),
    host,
    idleMs: 60_000,
    meta: { agentStartedAt: replacementStartedAt, agentVersion: 'replacement' },
    mutationLockDir: dir,
    socketPath,
    transport,
  });
  const leaseId = await coordinator.acquire('replacement-holder', 'replacement-write', 1_000);
  const exitWrite = await coordinator.enter('replacement-holder', leaseId, true);
  exitWrite();
  coordinator.fence('replacement-holder', leaseId, 'replacement ambiguity');
  await coordinator.release('replacement-holder', leaseId);

  let reachDelete;
  const deleteReached = new Promise((resolve) => {
    reachDelete = resolve;
  });
  let releaseDelete;
  const deleteGate = new Promise((resolve) => {
    releaseDelete = resolve;
  });
  const staleSession = {
    host,
    pid: process.pid,
    socketPath,
    agentStartedAt: startedAt,
    agentVersion: 'stale',
    lastValidatedAt: startedAt,
  };
  const signals = [];
  const logoutPending = logout({
    baseUrl: host,
    store: {
      async read() {
        return staleSession;
      },
      async deleteIfMatch() {
        reachDelete();
        await deleteGate;
        return false;
      },
    },
    mutationLockDir: dir,
    mutationWaitMs: 1_000,
    signal: (pid, signal) => {
      signals.push([pid, signal]);
      return true;
    },
  });
  await deleteReached;
  const stopPending = agent.stop();
  releaseDelete();
  assert.deepEqual(await logoutPending, { ok: true, host, wasRunning: false });
  await stopPending;
  assert.deepEqual(signals, [], 'identity mismatch must not signal or prepare shutdown');

  const names = await readdir(ticketDirectory(dir).path);
  assert.equal(
    names.some((name) => name.startsWith('owner-')),
    false,
  );
  assert.equal(
    names.some((name) => name.startsWith('fence-')),
    true,
  );
  const contender = createFileMutationLeaseCoordinator({ host, baseDir: dir, retryMs: 5 });
  await assert.rejects(
    contender.acquire('after-mismatch', 'after-mismatch', 100),
    (error) => error instanceof NetworkError && /fenced after/.test(error.message),
  );
  await contender.prepareShutdown('cleanup', 1_000);
  contender.commitShutdown('cleanup');
  contender.beginDaemonShutdown();
  await contender.close();
});

test('lost lease-release request after a confirmed write is NOT_CONFIRMED and fenced', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'xgg-mutation-release-ack-'));
  const socketPath = endpoint(dir, 'release-ack');
  const coordinator = createFileMutationLeaseCoordinator({ host, baseDir: dir, retryMs: 5 });
  let gatewayWrites = 0;
  const server = await createIpcServer({
    path: socketPath,
    mutationLeases: coordinator,
    handler: async (request) => {
      if (request.method === '$ping') return { host, agentStartedAt: startedAt };
      if (request.method === '/api/setGraph') {
        gatewayWrites += 1;
        return { ok: true };
      }
      throw new Error(`unexpected method ${request.method}`);
    },
  });
  t.after(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  let releaseAttempts = 0;
  let fenceAttempts = 0;
  let clientClosed = false;
  const ipcClient = (path) => {
    const actual = createIpcClient({ path });
    return {
      request(method, params, options) {
        if (method === '$mutation.release') {
          releaseAttempts += 1;
          return Promise.reject(new NetworkError('injected lost lease-release acknowledgement'));
        }
        if (method === '$mutation.fence') fenceAttempts += 1;
        return actual.request(method, params, options);
      },
      close() {
        clientClosed = true;
        actual.close();
      },
    };
  };
  const deps = { baseUrl: host, ipcClient, store: sessionStore(socketPath) };
  await assert.rejects(
    withMutationWorkflow({ ...deps, operation: 'lost-release-ack', timeoutMs: 100 }, async () => {
      await call(deps, '/api/setGraph', { nodes: [] }, 'write');
    }),
    (error) =>
      error instanceof NotConfirmedError &&
      error.details?.phase === 'lease-release' &&
      error.details?.acknowledgedWrites === 1,
  );
  assert.equal(gatewayWrites, 1);
  assert.equal(releaseAttempts, 1);
  assert.equal(fenceAttempts, 1);
  assert.equal(clientClosed, true);
  assert.equal(coordinator.status().fenced, true);
  assert.equal(
    (await readdir(ticketDirectory(dir).path)).some((name) => name.startsWith('fence-')),
    true,
  );

  const contender = createFileMutationLeaseCoordinator({ host, baseDir: dir, retryMs: 5 });
  await assert.rejects(contender.acquire('blind-retry', 'blind-retry', 40), NetworkError);
  await contender.close();

  await coordinator.prepareShutdown('test-cleanup', 1_000);
  coordinator.commitShutdown('test-cleanup');
  coordinator.beginDaemonShutdown();
});

test('lost response after daemon completed lease release is caller-uncertain but safe to proceed', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'xgg-mr-'));
  const socketPath = endpoint(dir, 'r');
  const coordinator = createFileMutationLeaseCoordinator({ host, baseDir: dir, retryMs: 5 });
  const server = await createIpcServer({
    path: socketPath,
    mutationLeases: coordinator,
    handler: async (request) => {
      if (request.method === '$ping') return { host, agentStartedAt: startedAt };
      if (request.method === '/api/setGraph') return { ok: true };
      throw new Error(`unexpected method ${request.method}`);
    },
  });
  t.after(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  const ipcClient = (path) => {
    const actual = createIpcClient({ path });
    return {
      async request(method, params, options) {
        const result = await actual.request(method, params, options);
        if (method === '$mutation.release') {
          throw new NetworkError('injected response loss after daemon release');
        }
        return result;
      },
      close() {
        actual.close();
      },
    };
  };
  const deps = { baseUrl: host, ipcClient, store: sessionStore(socketPath) };
  await assert.rejects(
    withMutationWorkflow(
      { ...deps, operation: 'release-response-loss', timeoutMs: 100 },
      async () => {
        await call(deps, '/api/setGraph', { nodes: [] }, 'write');
      },
    ),
    (error) => error instanceof NotConfirmedError && error.details?.phase === 'lease-release',
  );
  assert.deepEqual(coordinator.status(), {
    active: false,
    fenced: false,
    operation: null,
    acquiredAt: null,
  });
  assert.equal(
    (await readdir(ticketDirectory(dir).path)).some((name) => name.startsWith('fence-')),
    false,
  );
  const successor = createFileMutationLeaseCoordinator({ host, baseDir: dir, retryMs: 5 });
  const successorLease = await successor.acquire('successor', 'successor', 1_000);
  await successor.release('successor', successorLease);
  await successor.close();
});

test('late write acknowledgement fences mutations, while shutdown preparation remains available', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'xgg-mutation-fence-'));
  const socketPath = endpoint(dir, 'agent');
  let writeApplied = false;
  const server = await createIpcServer({
    path: socketPath,
    handler: async (request) => {
      if (request.method === '$ping') return { host, agentStartedAt: startedAt };
      if (request.method === '/api/setGraph') {
        await delay(80);
        writeApplied = true;
        return { ok: true };
      }
      return { ok: true };
    },
  });
  t.after(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });
  const deps = { baseUrl: host, store: sessionStore(socketPath) };
  await assert.rejects(
    withMutationWorkflow({ ...deps, operation: 'late-ack', timeoutMs: 10 }, async () => {
      await call(deps, '/api/setGraph', { nodes: [] }, 'write', 10);
    }),
    NotConfirmedError,
  );
  await delay(100);
  assert.equal(writeApplied, true, 'the timed-out write demonstrates a real late acknowledgement');
  await assert.rejects(
    withMutationWorkflow(
      { ...deps, operation: 'must-be-fenced', leaseTimeoutMs: 25 },
      async () => {},
    ),
    (error) => error instanceof NetworkError && /mutation lease/.test(error.message),
  );

  const shutdown = createIpcClient({ path: socketPath });
  await shutdown.request('$shutdown.prepare', { waitTimeoutMs: 100 });
  shutdown.close();
});
