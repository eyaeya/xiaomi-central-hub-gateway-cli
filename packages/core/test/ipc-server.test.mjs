import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';

import { NetworkError, agentCall, createIpcClient, createIpcServer } from '../dist/index.js';

const testHost = 'http://unit.test';
const agentStartedAt = '2026-07-19T00:00:00.000Z';

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function endpointPath(dir, label) {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\xgg-${process.pid}-${label}-${randomUUID()}`;
  }
  return join(dir, `${label}.sock`);
}

async function startServer(t, label, handler) {
  const dir = await mkdtemp(join(tmpdir(), 'xgg-ipc-server-test-'));
  const path = endpointPath(dir, label);
  const server = await createIpcServer({ path, handler });
  t.after(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });
  return path;
}

async function assertServerResponds(path) {
  const client = createIpcClient({ path });
  try {
    assert.deepEqual(await client.request('$ping', {}), { host: testHost, agentStartedAt });
  } finally {
    client.close();
  }
}

test('IPC server survives a client disconnect before the delayed response', async (t) => {
  const handlerStarted = deferred();
  const releaseHandler = deferred();
  const handlerCompleted = deferred();
  const path = await startServer(t, 'disconnect', async ({ method }) => {
    if (method === '$ping') return { host: testHost, agentStartedAt };
    assert.equal(method, '/slow');
    handlerStarted.resolve();
    await releaseHandler.promise;
    handlerCompleted.resolve();
    return { completed: true };
  });

  const client = createConnection(path);
  client.on('error', () => {
    // The test intentionally aborts this peer while a response is in flight.
  });
  await once(client, 'connect');
  await new Promise((resolve, reject) => {
    client.write(`${JSON.stringify({ id: 1, method: '/slow', params: {} })}\n`, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  await handlerStarted.promise;

  const closed = once(client, 'close');
  client.destroy();
  await closed;
  releaseHandler.resolve();
  await handlerCompleted.promise;
  await nextTurn();

  await assertServerResponds(path);
});

test('IPC server survives agentCall closing the client after a local timeout', async (t) => {
  const handlerStarted = deferred();
  const releaseHandler = deferred();
  const handlerCompleted = deferred();
  const path = await startServer(t, 'timeout', async ({ method }) => {
    if (method === '$ping') return { host: testHost, agentStartedAt };
    assert.equal(method, '/slow');
    handlerStarted.resolve();
    await releaseHandler.promise;
    handlerCompleted.resolve();
    return { completed: true };
  });
  const store = {
    read: async () => ({
      host: testHost,
      pid: process.pid,
      socketPath: path,
      agentStartedAt,
      agentVersion: 'test',
      lastValidatedAt: agentStartedAt,
    }),
  };

  const timedOut = agentCall({
    baseUrl: testHost,
    method: '/slow',
    params: {},
    store,
    timeoutMs: 50,
  });
  const timeoutObserved = assert.rejects(
    timedOut,
    (error) => error instanceof NetworkError && /timed out after 50ms/.test(error.message),
  );
  await handlerStarted.promise;
  await timeoutObserved;

  releaseHandler.resolve();
  await handlerCompleted.promise;
  await nextTurn();

  await assertServerResponds(path);
});
