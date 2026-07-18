import assert from 'node:assert/strict';
import test from 'node:test';

import { GatewayError, JsonRpcRouter, NetworkError, makeFakeTransportPair } from '../dist/index.js';

function routerFor(responses) {
  const [transport, peer] = makeFakeTransportPair();
  const queue = [...responses];
  const channel = {
    sendJson: () => Buffer.from('request'),
    recvJson: () => queue.shift(),
  };
  const router = new JsonRpcRouter({ channel, defaultTimeoutMs: 500, transport });
  router.start();
  return { peer, router };
}

const malformedResponses = [
  ['null', null],
  ['array', []],
  ['missing envelope fields', {}],
  ['wrong protocol version', { jsonrpc: '1.0', id: 1, result: null }],
  ['missing id', { jsonrpc: '2.0', result: null }],
  ['string id', { jsonrpc: '2.0', id: '1', result: null }],
  ['non-integer id', { jsonrpc: '2.0', id: 1.5, result: null }],
  ['missing result and error', { jsonrpc: '2.0', id: 1 }],
  ['both result and error', { jsonrpc: '2.0', id: 1, result: null, error: null }],
  ['non-object error', { jsonrpc: '2.0', id: 1, error: 'failed' }],
  ['invalid error code', { jsonrpc: '2.0', id: 1, error: { code: 'E', message: 'failed' } }],
  ['invalid error message', { jsonrpc: '2.0', id: 1, error: { code: -1, message: 42 } }],
];

for (const [label, response] of malformedResponses) {
  test(`malformed JSON-RPC response (${label}) fails every pending request and ends cleanly`, async () => {
    const { peer, router } = routerFor([response]);
    const first = router.request('/first', {});
    const second = router.request('/second', {});

    peer.send(Buffer.from('response'));

    for (const pending of [first, second]) {
      await assert.rejects(
        pending,
        (error) =>
          error instanceof NetworkError &&
          error.code === 'NETWORK' &&
          /session decode failed: invalid JSON-RPC response/.test(error.message),
      );
    }
    await router.done;
    assert.throws(() => router.request('/after-end', {}), /router not started/);
    assert.throws(() => peer.send(Buffer.from('after-close')), /transport closed/);
  });
}

test('valid success response resolves the matching request', async () => {
  const result = { devices: [] };
  const { peer, router } = routerFor([{ jsonrpc: '2.0', id: 1, result }]);
  const pending = router.request('/success', {});

  peer.send(Buffer.from('response'));

  assert.deepEqual(await pending, result);
  await router.stop();
  await router.done;
});

test('valid error response rejects with GatewayError details', async () => {
  const { peer, router } = routerFor([
    {
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32_001, message: 'gateway rejected request', data: { reason: 'test' } },
    },
  ]);
  const pending = router.request('/failure', {});

  peer.send(Buffer.from('response'));

  await assert.rejects(pending, (error) => {
    assert.ok(error instanceof GatewayError);
    assert.equal(error.code, 'GATEWAY');
    assert.equal(error.details.gatewayCode, -32_001);
    assert.deepEqual(error.details.data, { reason: 'test' });
    return true;
  });
  await router.stop();
  await router.done;
});

test('valid unknown id is ignored before the matching response arrives', async () => {
  const { peer, router } = routerFor([
    { jsonrpc: '2.0', id: 999, result: 'ignored' },
    { jsonrpc: '2.0', id: 1, result: 'matched' },
  ]);
  const pending = router.request('/probe', {});

  peer.send(Buffer.from('unknown'));
  peer.send(Buffer.from('matching'));

  assert.equal(await pending, 'matched');
  await router.stop();
  await router.done;
});
