import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import { resolveAgentEndpoint } from '../dist/agent/ipc-path.js';
import { runAgentMain } from '../dist/agent/main.js';
import { runAgent } from '../dist/agent/process.js';
import { GcmStream } from '../dist/crypto/gcm.js';
import { StubGatewayServer, makeFakeTransportPair } from '../dist/transport/fake.js';

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

async function captureRejection(operation) {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  assert.fail('operation unexpectedly resolved');
}

function assertTransportClosed(transport) {
  assert.throws(() => transport.send(Buffer.from([5])), /transport closed/);
}

async function assertSocketMissing(path) {
  await assert.rejects(access(path), (error) => error?.code === 'ENOENT');
}

function shortTempRoot() {
  return process.platform === 'win32' ? tmpdir() : '/tmp';
}

test('runAgent rolls back router and transport when IPC bind fails without masking the bind error', async () => {
  const [transport, peer] = makeFakeTransportPair();
  const bindError = Object.assign(new Error('injected IPC bind failure'), {
    code: 'EADDRINUSE',
  });
  const cleanupError = new Error('injected transport cleanup failure');
  const closeTransport = transport.close.bind(transport);
  transport.close = () => {
    closeTransport();
    throw cleanupError;
  };

  const caught = await captureRejection(() =>
    runAgent({
      createServer: async () => {
        throw bindError;
      },
      handshake: handshakeFixture(),
      host: 'http://127.0.0.1:8086',
      idleMs: 60_000,
      socketPath: '/unused/injected.sock',
      transport,
    }),
  );

  assert.strictEqual(caught, bindError);
  assert.equal(caught.code, 'EADDRINUSE');
  assertTransportClosed(peer);
});

test('runAgent cleanup is idempotent across concurrent stop calls', async () => {
  const [transport, peer] = makeFakeTransportPair();
  let serverCloseCalls = 0;
  const agent = await runAgent({
    createServer: async () => ({
      close: async () => {
        serverCloseCalls += 1;
      },
    }),
    handshake: handshakeFixture(),
    host: 'http://127.0.0.1:8086',
    idleMs: 60_000,
    socketPath: '/unused/injected.sock',
    transport,
  });

  await Promise.all([agent.stop(), agent.stop(), agent.stop(), agent.done]);

  assert.equal(serverCloseCalls, 1);
  assertTransportClosed(peer);
});

test('runAgentMain stops the live agent when session persistence fails', async (t) => {
  const baseDir = await mkdtemp(join(shortTempRoot(), 'xgg-as-'));
  const passcode = '123456';
  const host = 'http://127.0.0.1:8086';
  const [transport, peer] = makeFakeTransportPair();
  const gateway = new StubGatewayServer({ passcode, transport: peer });
  gateway.start();
  t.after(async () => {
    await gateway.stop();
    await rm(baseDir, { force: true, recursive: true });
  });

  const sessionError = Object.assign(new Error('injected session write failure'), {
    code: 'EACCES',
  });
  let deleteCalls = 0;
  const endpoint = resolveAgentEndpoint({
    baseDir,
    host,
    platform: process.platform,
  });

  const caught = await captureRejection(() =>
    runAgentMain({
      agentVersion: 'test',
      connect: async () => transport,
      host,
      idleMs: 60_000,
      passcode,
      sessionStore: {
        delete: async () => {
          deleteCalls += 1;
        },
        write: async () => {
          throw sessionError;
        },
      },
      socketBaseDir: baseDir,
    }),
  );

  assert.strictEqual(caught, sessionError);
  assert.equal(caught.code, 'EACCES');
  assert.equal(deleteCalls, 0);
  assertTransportClosed(peer);
  await assertSocketMissing(endpoint.path);
});

test('runAgentMain removes its session and stops the agent when READY output fails', async (t) => {
  const baseDir = await mkdtemp(join(shortTempRoot(), 'xgg-ar-'));
  const passcode = '123456';
  const host = 'http://127.0.0.1:8087';
  const [transport, peer] = makeFakeTransportPair();
  const gateway = new StubGatewayServer({ passcode, transport: peer });
  gateway.start();
  t.after(async () => {
    await gateway.stop();
    await rm(baseDir, { force: true, recursive: true });
  });

  const readyError = new Error('injected READY output failure');
  const sessionEvents = [];
  const out = new Writable({
    write(_chunk, _encoding, callback) {
      callback(readyError);
    },
  });
  const endpoint = resolveAgentEndpoint({
    baseDir,
    host,
    platform: process.platform,
  });

  const caught = await captureRejection(() =>
    runAgentMain({
      agentVersion: 'test',
      connect: async () => transport,
      host,
      idleMs: 60_000,
      out,
      passcode,
      sessionStore: {
        delete: async (deletedHost) => {
          sessionEvents.push(`delete:${deletedHost}`);
        },
        write: async (session) => {
          sessionEvents.push(`write:${session.host}`);
        },
      },
      socketBaseDir: baseDir,
    }),
  );

  assert.strictEqual(caught, readyError);
  assert.deepEqual(sessionEvents, [`write:${host}`, `delete:${host}`]);
  assertTransportClosed(peer);
  await assertSocketMissing(endpoint.path);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(out.listenerCount('error'), 0);
});
