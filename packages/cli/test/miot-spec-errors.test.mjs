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
  const baseUrl = `${await startRegistry(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"services":');
  })}/spec`;
  const urn = `${urnPrefix}:body-timeout`;
  __resetSpecCache();
  const error = await captureRejection(() => fetchMiotSpec(urn, { baseUrl, timeoutMs: 20 }));

  assert.ok(error instanceof MiotSpecFetchError);
  assert.ok(error instanceof NetworkError);
  assert.equal(error.status, 200);
  assert.equal(error.details.status, 200);
  assert.equal(error.details.timeoutMs, 20);
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
