import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { connectWs } from '../dist/transport/ws.js';

async function openLoopback(t, limits = {}) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');

  const address = wss.address();
  assert.equal(typeof address, 'object');
  assert.notEqual(address, null);

  const connected = once(wss, 'connection');
  const transportPromise = connectWs({
    url: `ws://127.0.0.1:${address.port}`,
    keepaliveMs: 0,
    ...limits,
  });
  const [[peer], transport] = await Promise.all([connected, transportPromise]);

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    transport.close();
    const clients = [...wss.clients];
    const clientClosed = clients.map((client) =>
      client.readyState === WebSocket.CLOSED ? Promise.resolve() : once(client, 'close'),
    );
    for (const client of clients) client.terminate();
    await Promise.all(clientClosed);
    if (wss.address() !== null) {
      await new Promise((resolve, reject) => {
        wss.close((error) => (error ? reject(error) : resolve()));
      });
    }
    assert.equal(wss.clients.size, 0);
  };
  t.after(close);

  return { close, peer, transport };
}

async function flushMessages(peer) {
  const pong = once(peer, 'pong');
  peer.ping();
  await pong;
}

async function waitForClose(peer) {
  if (peer.readyState === WebSocket.CLOSED) return;
  await once(peer, 'close');
}

function expectNetworkError(pattern) {
  return (error) => {
    assert.equal(error?.name, 'NetworkError');
    assert.equal(error?.code, 'NETWORK');
    assert.match(error.message, pattern);
    return true;
  };
}

test('connectWs preserves queued binary message order and releases the byte budget on receive', async (t) => {
  const { peer, transport } = await openLoopback(t, {
    maxFrameBytes: 8,
    maxQueuedBytes: 6,
    maxQueuedFrames: 3,
  });

  peer.send(Buffer.from([1]));
  peer.send(Buffer.from([2, 2]));
  peer.send(Buffer.from([3, 3, 3]));
  await flushMessages(peer);

  assert.deepEqual(await transport.receive(), Buffer.from([1]));
  assert.deepEqual(await transport.receive(), Buffer.from([2, 2]));
  assert.deepEqual(await transport.receive(), Buffer.from([3, 3, 3]));

  peer.send(Buffer.alloc(6, 4));
  await flushMessages(peer);
  assert.deepEqual(await transport.receive(), Buffer.alloc(6, 4));
});

test('connectWs rejects one binary message above maxFrameBytes and latches the error', async (t) => {
  const { peer, transport } = await openLoopback(t, {
    maxFrameBytes: 8,
    maxQueuedBytes: 32,
    maxQueuedFrames: 4,
  });

  const pending = transport.receive();
  peer.send(Buffer.alloc(9));

  await assert.rejects(pending, expectNetworkError(/maxFrameBytes \(8 bytes\)/));
  await waitForClose(peer);
  await assert.rejects(transport.receive(), expectNetworkError(/maxFrameBytes \(8 bytes\)/));
});

test('connectWs terminates and discards backlog above maxQueuedFrames', async (t) => {
  const { peer, transport } = await openLoopback(t, {
    maxFrameBytes: 8,
    maxQueuedBytes: 32,
    maxQueuedFrames: 2,
  });

  peer.send(Buffer.from([1]));
  peer.send(Buffer.from([2]));
  peer.send(Buffer.from([3]));

  await waitForClose(peer);
  await assert.rejects(transport.receive(), expectNetworkError(/maxQueuedFrames \(2\)/));
  await assert.rejects(transport.receive(), expectNetworkError(/maxQueuedFrames \(2\)/));
});

test('connectWs terminates and discards backlog above maxQueuedBytes', async (t) => {
  const { peer, transport } = await openLoopback(t, {
    maxFrameBytes: 8,
    maxQueuedBytes: 5,
    maxQueuedFrames: 4,
  });

  peer.send(Buffer.alloc(3, 1));
  peer.send(Buffer.alloc(3, 2));

  await waitForClose(peer);
  await assert.rejects(transport.receive(), expectNetworkError(/maxQueuedBytes \(5 bytes\)/));
  await assert.rejects(transport.receive(), expectNetworkError(/maxQueuedBytes \(5 bytes\)/));
});

test('connectWs rejects text protocol messages', async (t) => {
  const { peer, transport } = await openLoopback(t, {
    maxFrameBytes: 32,
    maxQueuedBytes: 64,
    maxQueuedFrames: 4,
  });

  const pending = transport.receive();
  peer.send('not binary');

  await assert.rejects(pending, expectNetworkError(/expected a binary message/));
  await waitForClose(peer);
});

test('connectWs discards queued messages when the peer closes', async (t) => {
  const { peer, transport } = await openLoopback(t, {
    maxFrameBytes: 32,
    maxQueuedBytes: 64,
    maxQueuedFrames: 4,
  });

  peer.send(Buffer.from([1, 2, 3]));
  await flushMessages(peer);
  peer.close();
  await waitForClose(peer);
  // Let the loopback client's corresponding close event run after the server
  // side completes its close handshake.
  await new Promise((resolve) => setTimeout(resolve, 0));

  await assert.rejects(transport.receive(), expectNetworkError(/ws closed by peer/));
});
