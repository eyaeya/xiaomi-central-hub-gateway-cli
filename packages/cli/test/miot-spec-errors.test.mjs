import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { NetworkError, SchemaError } from '@eyaeya/xgg-core';
import {
  MiotSpecContentError,
  MiotSpecFetchError,
  __resetSpecCache,
  fetchMiotSpec,
} from '../../core/dist/http-client.js';
import { errorToExit, formatErrorJson } from '../dist/errors.js';

const urnPrefix = 'urn:miot-spec-v2:device:light:0000A001:issue33';
const cacheUrnPrefix = 'urn:miot-spec-v2:device:light:0000A001:issue77';

async function startRegistry(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
  return `http://127.0.0.1:${address.port}`;
}

async function closedPortRegistry() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return `http://127.0.0.1:${address.port}`;
}

async function captureRejection(operation) {
  let caught;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, 'operation unexpectedly resolved');
  return caught;
}

function assertRegistryUrl(error, baseUrl, urn) {
  const publicUrl = new URL(error.details.url);
  const expected = new URL(baseUrl);
  assert.equal(publicUrl.origin, expected.origin);
  assert.equal(publicUrl.pathname, expected.pathname);
  assert.equal(publicUrl.searchParams.get('type'), urn);
}

function assertPublicClassification(error, code, exitCode) {
  const payload = formatErrorJson(error);
  assert.equal(error.code, code);
  assert.equal(errorToExit(error).code, exitCode);
  assert.equal(payload.error.code, code);
  assert.match(payload.error.hint, /MIoT spec registry/i);
  assert.doesNotMatch(payload.error.hint, /gateway.*LAN/i);
  assert.deepEqual(payload.error.details, error.details);
  assert.equal(Object.hasOwn(payload.error.details, 'cause'), false);
}

function sendJsonAfter(response, payload, delayMs) {
  setTimeout(() => {
    if (response.destroyed) return;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(payload));
  }, delayMs);
}

function assertTimedOut(result, timeoutMs) {
  assert.equal(result.status, 'rejected');
  assert.ok(result.reason instanceof MiotSpecFetchError);
  assert.equal(result.reason.code, 'NETWORK');
  assert.equal(result.reason.details.timeoutMs, timeoutMs);
}

function assertRegistryResult(result, registry) {
  assert.equal(result.status, 'fulfilled');
  assert.equal(result.value.registry, registry);
}

test('connection-refused MIoT request is a NETWORK error with registry context', async () => {
  __resetSpecCache();
  const baseUrl = `${await closedPortRegistry()}/spec`;
  const urn = `${urnPrefix}:connection-refused`;
  const error = await captureRejection(() => fetchMiotSpec(urn, { baseUrl, timeoutMs: 500 }));

  assert.ok(error instanceof MiotSpecFetchError);
  assert.ok(error instanceof NetworkError);
  assert.equal(error.status, undefined);
  assert.ok(error.cause);
  assert.equal(error.details.dependency, 'miot-spec-registry');
  assertRegistryUrl(error, baseUrl, urn);
  assertPublicClassification(error, 'NETWORK', 1);
});

test('timed-out MIoT request is a NETWORK error and preserves its cause privately', async (t) => {
  const baseUrl = `${await startRegistry(t, () => {})}/spec`;
  const urn = `${urnPrefix}:timeout`;
  __resetSpecCache();
  const error = await captureRejection(() => fetchMiotSpec(urn, { baseUrl, timeoutMs: 20 }));

  assert.ok(error instanceof MiotSpecFetchError);
  assert.ok(error instanceof NetworkError);
  assert.equal(error.status, undefined);
  assert.ok(error.cause);
  assert.equal(error.details.dependency, 'miot-spec-registry');
  assert.equal(error.details.timeoutMs, 20);
  assertRegistryUrl(error, baseUrl, urn);
  assertPublicClassification(error, 'NETWORK', 1);
});

test('timed-out MIoT response body remains a NETWORK error', async (t) => {
  const bodyTimeoutMs = 250;
  const baseUrl = `${await startRegistry(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.flushHeaders();
    response.write('{"services":');
  })}/spec`;
  const urn = `${urnPrefix}:body-timeout`;
  __resetSpecCache();
  const error = await captureRejection(() =>
    fetchMiotSpec(urn, { baseUrl, timeoutMs: bodyTimeoutMs }),
  );

  assert.ok(error instanceof MiotSpecFetchError);
  assert.ok(error instanceof NetworkError);
  assert.equal(error.status, 200);
  assert.equal(error.details.status, 200);
  assert.equal(error.details.timeoutMs, bodyTimeoutMs);
  assertRegistryUrl(error, baseUrl, urn);
  assertPublicClassification(error, 'NETWORK', 1);
});

test('MIoT HTTP failures expose stable NETWORK classification and status', async (t) => {
  const origin = await startRegistry(t, (request, response) => {
    const status = Number(new URL(request.url, 'http://registry.test').pathname.slice(1));
    response.writeHead(status, { 'content-type': 'text/plain' });
    response.end('registry failure body is not exposed');
  });

  for (const status of [404, 429, 500]) {
    const baseUrl = `${origin}/${status}`;
    const urn = `${urnPrefix}:http-${status}`;
    __resetSpecCache();
    const error = await captureRejection(() => fetchMiotSpec(urn, { baseUrl }));

    assert.ok(error instanceof MiotSpecFetchError, String(status));
    assert.ok(error instanceof NetworkError, String(status));
    assert.equal(error.status, status);
    assert.equal(error.cause, undefined);
    assert.equal(error.details.dependency, 'miot-spec-registry');
    assert.equal(error.details.status, status);
    assertRegistryUrl(error, baseUrl, urn);
    assertPublicClassification(error, 'NETWORK', 1);
  }
});

test('malformed MIoT JSON is a SCHEMA error with registry context', async (t) => {
  const baseUrl = `${await startRegistry(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"services":');
  })}/spec`;
  const urn = `${urnPrefix}:malformed-json`;
  __resetSpecCache();
  const error = await captureRejection(() => fetchMiotSpec(urn, { baseUrl }));

  assert.ok(error instanceof MiotSpecContentError);
  assert.ok(error instanceof SchemaError);
  assert.equal(error.status, 200);
  assert.ok(error.cause);
  assert.equal(error.details.dependency, 'miot-spec-registry');
  assert.equal(error.details.status, 200);
  assertRegistryUrl(error, baseUrl, urn);
  assertPublicClassification(error, 'SCHEMA', 4);
});

test('successful MIoT JSON response is returned unchanged', async (t) => {
  const expected = { type: `${urnPrefix}:success`, services: [] };
  const baseUrl = `${await startRegistry(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(expected));
  })}/spec`;
  __resetSpecCache();

  assert.deepEqual(await fetchMiotSpec(expected.type, { baseUrl }), expected);
});

test('resolved cache isolates the same URN by effective registry URL', async (t) => {
  const urn = `${cacheUrnPrefix}:registry-identity`;
  let registryAHits = 0;
  let registryBHits = 0;
  const registryA = `${await startRegistry(t, (_request, response) => {
    registryAHits += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ type: urn, registry: 'A' }));
  })}/spec`;
  const registryB = `${await startRegistry(t, (_request, response) => {
    registryBHits += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ type: urn, registry: 'B' }));
  })}/spec`;
  __resetSpecCache();

  assert.equal((await fetchMiotSpec(urn, { baseUrl: registryA })).registry, 'A');
  assert.equal((await fetchMiotSpec(urn, { baseUrl: registryB })).registry, 'B');
  assert.equal((await fetchMiotSpec(urn, { baseUrl: registryA, timeoutMs: 1 })).registry, 'A');
  assert.equal((await fetchMiotSpec(urn, { baseUrl: registryB, timeoutMs: 1 })).registry, 'B');
  assert.equal(registryAHits, 1);
  assert.equal(registryBHits, 1);
});

test('a resolved entry cannot bypass validation of an alternate registry URL', async (t) => {
  const urn = `${cacheUrnPrefix}:invalid-alternate-url`;
  const baseUrl = `${await startRegistry(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ type: urn, registry: 'valid' }));
  })}/spec`;
  __resetSpecCache();

  assert.equal((await fetchMiotSpec(urn, { baseUrl })).registry, 'valid');
  const error = await captureRejection(() =>
    fetchMiotSpec(urn, { baseUrl: 'not a registry URL', timeoutMs: 1 }),
  );
  assert.ok(error instanceof MiotSpecFetchError);
  assert.equal(error.code, 'NETWORK');
  assert.equal(error.details.url, '<invalid-miot-spec-registry-url>');
});

test('same effective URL and timeout dedupe in flight, then resolved data spans deadlines', async (t) => {
  const urn = `${cacheUrnPrefix}:same-policy`;
  let hits = 0;
  const baseUrl = `${await startRegistry(t, (_request, response) => {
    hits += 1;
    sendJsonAfter(response, { type: urn, registry: 'same-policy' }, 40);
  })}/spec`;
  __resetSpecCache();

  const [implicitDefault, explicitDefault] = await Promise.all([
    fetchMiotSpec(urn, { baseUrl }),
    fetchMiotSpec(urn, { baseUrl, timeoutMs: 5000 }),
  ]);
  assert.equal(implicitDefault.registry, 'same-policy');
  assert.equal(explicitDefault.registry, 'same-policy');
  assert.equal(hits, 1);

  assert.equal((await fetchMiotSpec(urn, { baseUrl, timeoutMs: 1 })).registry, 'same-policy');
  assert.equal(hits, 1, 'resolved response identity must not include the timeout policy');
});

test('mixed deadlines never share an in-flight request in either start order', async (t) => {
  const hits = new Map();
  const baseUrl = `${await startRegistry(t, (request, response) => {
    const urn = new URL(request.url, 'http://registry.test').searchParams.get('type');
    hits.set(urn, (hits.get(urn) ?? 0) + 1);
    sendJsonAfter(response, { type: urn, registry: 'mixed-deadlines' }, 300);
  })}/spec`;

  async function runCase(suffix, firstTimeout, secondTimeout) {
    const urn = `${cacheUrnPrefix}:${suffix}`;
    __resetSpecCache();
    const first = fetchMiotSpec(urn, { baseUrl, timeoutMs: firstTimeout });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = fetchMiotSpec(urn, { baseUrl, timeoutMs: secondTimeout });
    const results = await Promise.allSettled([first, second]);
    assert.equal(hits.get(urn), 2);
    return results;
  }

  const longFirst = await runCase('long-first', 1000, 100);
  assertRegistryResult(longFirst[0], 'mixed-deadlines');
  assertTimedOut(longFirst[1], 100);

  const shortFirst = await runCase('short-first', 100, 1000);
  assertTimedOut(shortFirst[0], 100);
  assertRegistryResult(shortFirst[1], 'mixed-deadlines');
});

test('one failed timeout policy does not evict another policy in flight', async (t) => {
  const urn = `${cacheUrnPrefix}:failure-isolation`;
  let hits = 0;
  const baseUrl = `${await startRegistry(t, (_request, response) => {
    hits += 1;
    sendJsonAfter(response, { type: urn, registry: 'survivor' }, 300);
  })}/spec`;
  __resetSpecCache();

  const short = fetchMiotSpec(urn, { baseUrl, timeoutMs: 100 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const long = fetchMiotSpec(urn, { baseUrl, timeoutMs: 1000 });
  await assert.rejects(
    short,
    (error) =>
      error instanceof MiotSpecFetchError &&
      error.code === 'NETWORK' &&
      error.details.timeoutMs === 100,
  );

  // The short policy has failed while the long request is still pending. A
  // same-policy follower must join that survivor instead of starting hit #3.
  const longFollower = fetchMiotSpec(urn, { baseUrl, timeoutMs: 1000 });
  const [firstLong, secondLong] = await Promise.all([long, longFollower]);
  assert.equal(firstLong.registry, 'survivor');
  assert.equal(secondLong.registry, 'survivor');
  assert.equal(hits, 2);

  assert.equal((await fetchMiotSpec(urn, { baseUrl, timeoutMs: 1 })).registry, 'survivor');
  assert.equal(hits, 2);
});

test('configured query values cannot replace the requested URN or enter public details', async (t) => {
  let requestedUrl;
  const origin = await startRegistry(t, (request, response) => {
    requestedUrl = new URL(request.url, 'http://registry.test');
    response.writeHead(500, { 'content-type': 'text/plain' });
    response.end('failure');
  });
  const urn = `${urnPrefix}:configured-query`;
  const baseUrl = `${origin}/spec?type=preexisting-type-secret&token=registry-secret`;
  __resetSpecCache();
  const error = await captureRejection(() => fetchMiotSpec(urn, { baseUrl }));

  assert.equal(requestedUrl.searchParams.get('type'), urn);
  assert.equal(requestedUrl.searchParams.get('token'), 'registry-secret');
  assertRegistryUrl(error, baseUrl, urn);
  const serialized = JSON.stringify(formatErrorJson(error));
  assert.doesNotMatch(serialized, /preexisting-type-secret|registry-secret/);
});

test('public MIoT error JSON redacts registry credentials, unrelated query data, and cause', () => {
  const error = new MiotSpecFetchError(
    'MIoT spec registry request failed',
    'https://registry-user:registry-password@registry.example/spec?token=registry-secret&type=preexisting-type-secret',
    { status: 500, cause: new Error('private transport detail') },
  );
  const serialized = JSON.stringify(formatErrorJson(error));

  assert.doesNotMatch(
    serialized,
    /registry-user|registry-password|registry-secret|preexisting-type-secret/,
  );
  assert.doesNotMatch(serialized, /private transport detail/);
  assert.match(serialized, /registry\.example/);
  assert.match(serialized, /miot-spec-registry/);
});
