import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { GcmStream } from '../dist/crypto/gcm.js';
import {
  AuthExpiredError,
  GatewayError,
  JsonRpcRouter,
  NetworkError,
  NotConfirmedError,
  SessionChannel,
  agentCall,
  createFileMutationLeaseCoordinator,
  makeFakeTransportPair,
  runAgent,
} from '../dist/index.js';

const host = 'http://write-interruption.test';
const agentStartedAt = '2026-10-03T00:00:00.000Z';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'xgg-write-interrupted-'));
  const socketPath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\xgg-interrupted-${randomUUID()}`
      : join(dir, 'agent.sock');
  const key = Buffer.alloc(16, 1);
  const clientSalt = Buffer.alloc(8, 2);
  const serverSalt = Buffer.alloc(8, 3);
  const [transport, peer] = makeFakeTransportPair();
  const agent = await runAgent({
    host,
    transport,
    socketPath,
    mutationLockDir: dir,
    idleMs: 10_000,
    meta: { agentStartedAt, agentVersion: 'test' },
    handshake: {
      clientKey: key,
      clientSalt,
      serverKey: key,
      serverSalt,
      clientSend: new GcmStream({ key, salt: clientSalt, direction: 'send' }),
      clientRecv: new GcmStream({ key, salt: serverSalt, direction: 'recv' }),
    },
  });
  t.after(async () => {
    await agent.stop();
    await rm(dir, { recursive: true, force: true });
  });
  const channel = new SessionChannel({
    send: new GcmStream({ key, salt: serverSalt, direction: 'send' }),
    recv: new GcmStream({ key, salt: clientSalt, direction: 'recv' }),
  });
  const deps = {
    baseUrl: host,
    timeoutMs: 1_000,
    store: {
      read: async () => ({
        host,
        pid: process.pid,
        socketPath,
        agentStartedAt,
        agentVersion: 'test',
        lastValidatedAt: agentStartedAt,
      }),
    },
  };
  return { agent, channel, deps, dir, peer };
}

for (const failure of ['connection close', 'malformed encrypted response']) {
  test(`sent gateway write reports NOT_CONFIRMED after ${failure}`, async (t) => {
    const { agent, channel, deps, dir, peer } = await fixture(t);
    const pending = agentCall({
      ...deps,
      method: '/api/setVarValue',
      params: { scope: 'global', id: 'marker', value: 7 },
      kind: 'write',
    });
    const rejected = assert.rejects(pending, (error) => {
      assert.ok(error instanceof NotConfirmedError);
      assert.equal(error.code, 'NOT_CONFIRMED');
      assert.match(error.message, /not confirmed/);
      return true;
    });
    // The simulated gateway has received and can apply the value before the
    // acknowledgement is lost. The public client must not say merely expired.
    const received = channel.recvJson(await peer.receive());
    assert.equal(received.method, '/api/setVarValue');
    assert.equal(received.params.value, 7);
    if (failure === 'connection close') await peer.close();
    else peer.send(channel.sendJson({ jsonrpc: '2.0', id: received.id }));
    await rejected;
    await agent.done;

    const replacement = createFileMutationLeaseCoordinator({ host, baseDir: dir, retryMs: 5 });
    t.after(() => replacement.close());
    await assert.rejects(
      replacement.acquire('retry', 'blind-retry', 100),
      (error) => error instanceof NetworkError && /fenced/.test(error.message),
    );
  });
}

test('an interrupted read keeps its ordinary network/authentication failure contract', async (t) => {
  const { channel, deps, peer } = await fixture(t);
  const pending = agentCall({ ...deps, method: '/api/getVarList', params: { scope: 'global' } });
  const rejected = assert.rejects(
    pending,
    (error) => error instanceof NetworkError || error instanceof AuthExpiredError,
  );
  assert.equal(channel.recvJson(await peer.receive()).method, '/api/getVarList');
  await peer.close();
  await rejected;
});

test('an explicit gateway rejection remains GATEWAY and permits the next workflow', async (t) => {
  const { channel, deps, peer } = await fixture(t);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const pending = agentCall({
      ...deps,
      method: '/api/setVarValue',
      params: { scope: 'global', id: 'missing', value: 7 },
      kind: 'write',
    });
    const rejected = assert.rejects(pending, GatewayError);
    const received = channel.recvJson(await peer.receive());
    peer.send(
      channel.sendJson({
        jsonrpc: '2.0',
        id: received.id,
        error: { code: -1, message: 'variable does not exist' },
      }),
    );
    await rejected;
  }
});

test('a synchronous failure before transport submission does not invoke onInterrupted', async () => {
  const [transport] = makeFakeTransportPair();
  const beforeSend = new NetworkError('not connected');
  let interrupted = false;
  const router = new JsonRpcRouter({
    transport: {
      receive: () => transport.receive(),
      close: () => transport.close(),
      send: () => {
        throw beforeSend;
      },
    },
    channel: { sendJson: () => Buffer.from('request'), recvJson: () => undefined },
  });
  router.start();
  await assert.rejects(
    router.request(
      '/write',
      {},
      {
        onInterrupted: () => {
          interrupted = true;
          return new NotConfirmedError('unexpected');
        },
      },
    ),
    (error) => error === beforeSend,
  );
  assert.equal(interrupted, false);
  await router.stop();
});
