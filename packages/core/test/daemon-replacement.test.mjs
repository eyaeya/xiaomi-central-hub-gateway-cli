import assert from 'node:assert/strict';
import { access, lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';
import {
  SessionStore,
  createIpcClient,
  createIpcServer,
  logout,
  runAgentMain,
} from '../dist/index.js';
import { StubGatewayServer, makeFakeTransportPair } from '../dist/transport/fake.js';

function shortTempRoot() {
  return process.platform === 'win32' ? tmpdir() : '/tmp';
}

function readySink() {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

function startGateway(passcode) {
  const [transport, peer] = makeFakeTransportPair();
  const gateway = new StubGatewayServer({ passcode, transport: peer });
  gateway.start();
  return { gateway, transport };
}

async function assertMissing(path) {
  await assert.rejects(access(path), (error) => error?.code === 'ENOENT');
}

test('IPC server refuses to clobber an already-owned socket path', async (t) => {
  if (process.platform === 'win32') {
    t.skip('same-path replacement fencing is specific to Unix domain sockets');
    return;
  }

  const directory = await mkdtemp(join(shortTempRoot(), 'xgg-dr-low-'));
  const path = join(directory, 'agent.sock');
  let first;
  t.after(async () => {
    await first?.close().catch(() => {});
    await rm(directory, { force: true, recursive: true });
  });

  first = await createIpcServer({
    path,
    handler: async () => ({ instance: 'first' }),
  });
  await assert.rejects(
    createIpcServer({
      path,
      handler: async () => ({ instance: 'second' }),
    }),
    (error) => error?.code === 'EADDRINUSE',
  );
  const client = createIpcClient({ path });
  try {
    assert.deepEqual(await client.request('$ping', {}), { instance: 'first' });
  } finally {
    client.close();
  }

  await Promise.all([first.close(), first.close()]);
  first = undefined;
  await assertMissing(path);
});

test('an old runAgentMain instance cannot remove its replacement socket or session', async (t) => {
  if (process.platform === 'win32') {
    t.skip('same-path replacement fencing is specific to Unix domain sockets');
    return;
  }

  const directory = await mkdtemp(join(shortTempRoot(), 'xgg-dr-main-'));
  const sessionFile = join(directory, 'session.json');
  const host = 'http://127.0.0.1:8086';
  const firstStartedAt = '2026-07-19T01:00:00.000Z';
  const secondStartedAt = '2026-07-19T01:00:01.000Z';
  const firstGateway = startGateway('123456');
  const secondGateway = startGateway('654321');
  let first;
  let second;
  t.after(async () => {
    await first?.stop().catch(() => {});
    await second?.stop().catch(() => {});
    await firstGateway.gateway.stop();
    await secondGateway.gateway.stop();
    await rm(directory, { force: true, recursive: true });
  });

  first = await runAgentMain({
    agentVersion: 'first',
    connect: async () => firstGateway.transport,
    host,
    idleMs: 60_000,
    instanceId: 'first-daemon',
    now: () => new Date(firstStartedAt),
    out: readySink(),
    passcode: '123456',
    sessionFile,
    socketBaseDir: directory,
  });
  second = await runAgentMain({
    agentVersion: 'second',
    connect: async () => secondGateway.transport,
    host,
    idleMs: 60_000,
    instanceId: 'second-daemon',
    now: () => new Date(secondStartedAt),
    out: readySink(),
    passcode: '654321',
    sessionFile,
    socketBaseDir: directory,
  });

  assert.notEqual(first.socketPath, second.socketPath);
  const firstSocketPath = first.socketPath;
  const socketPath = second.socketPath;
  const replacementIdentity = await lstat(socketPath, { bigint: true });
  const store = new SessionStore({ path: sessionFile });
  assert.equal((await store.read(host)).agentStartedAt, secondStartedAt);

  await first.stop();
  await first.done;
  first = undefined;
  await firstGateway.gateway.stop();

  await assertMissing(firstSocketPath);
  const afterOldStop = await lstat(socketPath, { bigint: true });
  assert.equal(afterOldStop.dev, replacementIdentity.dev);
  assert.equal(afterOldStop.ino, replacementIdentity.ino);
  assert.equal((await store.read(host)).agentStartedAt, secondStartedAt);

  const client = createIpcClient({ path: socketPath });
  try {
    const ping = await client.request('$ping', {});
    assert.equal(ping.host, host);
    assert.equal(ping.agentStartedAt, secondStartedAt);
    assert.equal(ping.agentVersion, 'second');
  } finally {
    client.close();
  }

  await second.stop();
  await second.done;
  second = undefined;
  await secondGateway.gateway.stop();

  await assertMissing(join(directory, 'session.json.lock'));
  await assertMissing(socketPath);
  await assert.rejects(store.read(host), (error) => error?.code === 'AUTH_REQUIRED');
});

test('an in-flight logout cannot delete a replacement session', async (t) => {
  const directory = await mkdtemp(join(shortTempRoot(), 'xgg-dr-logout-'));
  const sessionFile = join(directory, 'session.json');
  const host = 'http://127.0.0.1:8086';
  const store = new SessionStore({ path: sessionFile });
  const oldSession = {
    host,
    pid: 1001,
    socketPath: join(directory, 'old.sock'),
    agentStartedAt: '2026-07-19T01:00:00.000Z',
    agentVersion: 'old',
    lastValidatedAt: '2026-07-19T01:00:00.000Z',
  };
  const replacementSession = {
    host,
    pid: 1002,
    socketPath: join(directory, 'replacement.sock'),
    agentStartedAt: '2026-07-19T01:00:01.000Z',
    agentVersion: 'replacement',
    lastValidatedAt: '2026-07-19T01:00:01.000Z',
  };
  let releaseProbe;
  let markProbeStarted;
  const probeStarted = new Promise((resolve) => {
    markProbeStarted = resolve;
  });
  const probeGate = new Promise((resolve) => {
    releaseProbe = resolve;
  });
  const signals = [];
  t.after(async () => {
    releaseProbe?.();
    await rm(directory, { force: true, recursive: true });
  });

  await store.write(oldSession);
  const pendingLogout = logout({
    baseUrl: host,
    probe: async (socketPath) => {
      assert.equal(socketPath, oldSession.socketPath);
      markProbeStarted();
      await probeGate;
      return { agentStartedAt: oldSession.agentStartedAt };
    },
    signal: (pid, signal) => {
      signals.push([pid, signal]);
      return true;
    },
    store,
  });

  await probeStarted;
  await store.write(replacementSession);
  releaseProbe();

  assert.deepEqual(await pendingLogout, { ok: true, host, wasRunning: true });
  assert.deepEqual(signals, [[oldSession.pid, 'SIGTERM']]);
  assert.deepEqual(await store.read(host), replacementSession);
});
