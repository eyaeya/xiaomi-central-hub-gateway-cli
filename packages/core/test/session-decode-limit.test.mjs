import assert from 'node:assert/strict';
import test from 'node:test';

import { packInnerJson } from '../dist/crypto/deflate.js';
import { JsonRpcRouter, NetworkError, SessionChannel } from '../dist/index.js';
import { DATA_TYPE, encodeRawFrame } from '../dist/transport/frames.js';

test('SessionChannel forwards receive limits to inner DATA decoding', () => {
  const inner = packInnerJson('A'.repeat(4096));
  const channel = new SessionChannel({
    send: { encrypt: () => assert.fail('send stream should not be used') },
    recv: { decrypt: () => inner },
    receiveLimits: { maxJsonBytes: 1024 },
  });

  assert.throws(
    () => channel.recvJson(encodeRawFrame(DATA_TYPE.DATA, Buffer.alloc(1))),
    /inner declared length 4098 exceeds limit 1024/,
  );
});

test('JsonRpcRouter maps an oversized DATA response to NetworkError and closes the session', async () => {
  const inner = packInnerJson('A'.repeat(4096));
  const frame = encodeRawFrame(DATA_TYPE.DATA, Buffer.alloc(1));
  let closed = false;
  let delivered = false;
  const transport = {
    send: () => {},
    receive: () => {
      if (delivered) return new Promise(() => {});
      delivered = true;
      return Promise.resolve(frame);
    },
    close: () => {
      closed = true;
    },
  };
  const channel = new SessionChannel({
    send: { encrypt: (innerPayload) => innerPayload },
    recv: { decrypt: () => inner },
    receiveLimits: { maxJsonBytes: 1024 },
  });
  const router = new JsonRpcRouter({ transport, channel });
  router.start();

  await assert.rejects(router.request('/api/test', {}), (error) => {
    assert.ok(error instanceof NetworkError);
    assert.match(
      error.message,
      /session decode failed: inner declared length 4098 exceeds limit 1024/,
    );
    return true;
  });
  await router.done;
  assert.equal(closed, true);
});
