import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AuthExpiredError, agentCall, resolveAgentEndpoint, status } from '../dist/index.js';

const collisionA = 'http://gateway-a.invalid:8086/?nonce=24592';
const collisionB = 'http://gateway-b.invalid:8086/?nonce=53162';
const startedAt = '2026-07-18T00:00:00.000Z';

function endpoint(host) {
  return resolveAgentEndpoint({ host, baseDir: '/tmp/xgg-test', platform: 'darwin' }).path;
}

function storedSession(host = collisionA) {
  return {
    host,
    pid: 123,
    socketPath: endpoint(host),
    agentStartedAt: startedAt,
    agentVersion: '0.1.4',
    lastValidatedAt: startedAt,
  };
}

test('fixed 32-bit collision pair resolves to distinct 128-bit endpoints', () => {
  assert.notEqual(endpoint(collisionA), endpoint(collisionB));
  assert.match(endpoint(collisionA), /agent-[0-9a-f]{32}\.sock$/);
});

test('equivalent gateway URLs share a canonical endpoint', () => {
  assert.equal(
    endpoint('http://GATEWAY-A.invalid:8086/ignored/path?nonce=1#fragment'),
    endpoint('http://gateway-a.invalid:8086/'),
  );
});

test('status rejects a ping from the wrong gateway identity', async () => {
  const session = storedSession();
  await assert.rejects(
    status({
      baseUrl: collisionA,
      store: { read: async () => session },
      probe: async () => ({ host: collisionB, agentStartedAt: startedAt, idleMs: 1 }),
    }),
    (error) => error instanceof AuthExpiredError && /identity/.test(error.message),
  );
});

test('agentCall verifies daemon instance before forwarding the gateway method', async () => {
  const session = storedSession();
  const methods = [];
  const client = {
    request: async (method) => {
      methods.push(method);
      if (method === '$ping') {
        return { host: collisionA, agentStartedAt: '2026-07-18T01:00:00.000Z' };
      }
      throw new Error('gateway method must not be called');
    },
    close: () => {},
  };

  await assert.rejects(
    agentCall({
      baseUrl: collisionA,
      method: 'device.list',
      params: null,
      store: { read: async () => session },
      ipcClient: () => client,
    }),
    AuthExpiredError,
  );
  assert.deepEqual(methods, ['$ping']);
});

test('agentCall forwards only after matching host and daemon start time', async () => {
  const session = storedSession();
  const methods = [];
  const client = {
    request: async (method) => {
      methods.push(method);
      if (method === '$ping') return { host: collisionA, agentStartedAt: startedAt };
      return { devices: [] };
    },
    close: () => {},
  };

  const result = await agentCall({
    baseUrl: collisionA,
    method: 'device.list',
    params: null,
    store: { read: async () => session },
    ipcClient: () => client,
  });

  assert.deepEqual(result, { devices: [] });
  assert.deepEqual(methods, ['$ping', 'device.list']);
});
