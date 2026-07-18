import assert from 'node:assert/strict';
import test from 'node:test';

import { __resetSpecCache } from '../dist/http-client.js';
import { getDeviceSpec, validateGraph } from '../dist/index.js';

const registryBaseUrl = 'https://registry.invalid/miot-spec-v2/instance';

function urnFor(suffix) {
  return `urn:miot-spec-v2:device:light:0000A001:issue26-${suffix}:1`;
}

function captureNode(urn, { id = 'capture', dtype = 'number', version = 1 } = {}) {
  return {
    id,
    type: 'deviceGetSetVar',
    cfg: {
      urn,
      pos: { x: 0, y: 0, width: 566, height: 200 },
      name: 'deviceGetSetVar',
      version,
    },
    inputs: { input: null },
    outputs: { output: [] },
    props: {
      did: 'dummy-device',
      siid: 2,
      piid: 1,
      dtype,
      scope: 'global',
      id: 'captured-value',
    },
  };
}

function specFor(urn) {
  return {
    type: urn,
    description: 'Issue 26 fixture',
    services: [
      {
        iid: 2,
        type: 'urn:miot-spec-v2:service:light:00007802:issue26:1',
        description: 'Light',
        properties: [
          {
            iid: 1,
            type: 'urn:miot-spec-v2:property:on:00000006:issue26:1',
            description: 'On',
            format: 'bool',
            access: ['read', 'notify'],
          },
        ],
      },
    ],
  };
}

function stubFetch(t, implementation) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (...args) => {
    calls.push(args);
    return implementation(...args);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return calls;
}

async function specAwareIssues(urn, timeoutMs = 100) {
  return validateGraph({
    graph: { id: 'rule-issue-26', nodes: [captureNode(urn)] },
    getDeviceSpec: (requestedUrn) =>
      getDeviceSpec(requestedUrn, { baseUrl: registryBaseUrl, timeoutMs }),
  });
}

test('validateGraph is offline by default and never invokes global fetch', async (t) => {
  const urn = urnFor('offline');
  __resetSpecCache();
  const calls = stubFetch(t, async () => {
    throw new Error('unexpected external request');
  });

  const issues = await validateGraph({
    graph: { id: 'rule-issue-26', nodes: [captureNode(urn)] },
  });

  assert.deepEqual(issues, []);
  assert.equal(calls.length, 0);
});

test('explicit spec-aware validation consumes a successful stubbed spec', async (t) => {
  const urn = urnFor('success');
  __resetSpecCache();
  const calls = stubFetch(
    t,
    async () =>
      new Response(JSON.stringify(specFor(urn)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );

  const issues = await validateGraph({
    graph: {
      id: 'rule-issue-26',
      nodes: [
        captureNode(urn, { id: 'capture-a', dtype: 'string' }),
        captureNode(urn, { id: 'capture-b', dtype: 'string' }),
      ],
    },
    getDeviceSpec: (requestedUrn) =>
      getDeviceSpec(requestedUrn, { baseUrl: registryBaseUrl, timeoutMs: 100 }),
  });

  assert.equal(calls.length, 1, 'same-URN checks should share one explicit spec request');
  assert.equal(issues.length, 2);
  assert.ok(issues.every((entry) => entry.severity === 'error'));
  assert.ok(issues.every((entry) => entry.path.endsWith('.props.dtype')));
  assert.ok(issues.every((entry) => entry.message.includes('expects variable dtype "number"')));
});

test('spec-aware 404 is a visible warning instead of an exception', async (t) => {
  const urn = urnFor('404');
  __resetSpecCache();
  stubFetch(t, async () => new Response('', { status: 404 }));

  const issues = await specAwareIssues(urn);

  assert.deepEqual(
    issues.map(({ severity, path }) => ({ severity, path })),
    [{ severity: 'warn', path: 'nodes[0].cfg.urn' }],
  );
  assert.match(issues[0].message, /not found \(HTTP 404\).*checks skipped/i);
});

test('spec-aware 5xx is returned as an independent NETWORK error issue', async (t) => {
  const urn = urnFor('500');
  __resetSpecCache();
  stubFetch(t, async () => new Response('registry unavailable', { status: 500 }));

  const issues = await specAwareIssues(urn);

  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, 'error');
  assert.equal(issues[0].path, 'nodes[0].cfg.urn');
  assert.match(issues[0].message, /\[NETWORK HTTP 500\]/);
});

test('spec-aware timeout is returned as an independent NETWORK error issue', async (t) => {
  const urn = urnFor('timeout');
  __resetSpecCache();
  stubFetch(
    t,
    (_url, init) =>
      new Promise((_resolve, reject) => {
        const abort = () => reject(init.signal.reason ?? new Error('aborted'));
        if (init.signal.aborted) abort();
        else init.signal.addEventListener('abort', abort, { once: true });
      }),
  );

  const issues = await specAwareIssues(urn, 10);

  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, 'error');
  assert.match(issues[0].message, /\[NETWORK\].*timed out after 10ms/i);
});

test('spec-aware malformed JSON is returned as an independent SCHEMA error issue', async (t) => {
  const urn = urnFor('malformed-json');
  __resetSpecCache();
  stubFetch(
    t,
    async () =>
      new Response('{"services":', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );

  const issues = await specAwareIssues(urn);

  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, 'error');
  assert.match(issues[0].message, /\[SCHEMA\].*malformed JSON/i);
});

test('spec-aware invalid spec shape is returned as a SCHEMA error issue', async (t) => {
  const urn = urnFor('invalid-shape');
  __resetSpecCache();
  stubFetch(
    t,
    async () =>
      new Response(JSON.stringify({ type: urn, description: 'missing services' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );

  const issues = await specAwareIssues(urn);

  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, 'error');
  assert.match(issues[0].message, /\[SCHEMA\].*DeviceSpec parse failed/i);
});

test('external spec failure does not suppress local validation issues', async (t) => {
  const urn = urnFor('local-plus-500');
  __resetSpecCache();
  stubFetch(t, async () => new Response('registry unavailable', { status: 503 }));

  const issues = await validateGraph({
    graph: {
      id: 'rule-issue-26',
      nodes: [captureNode(urn, { version: 1.5 })],
    },
    getDeviceSpec: (requestedUrn) =>
      getDeviceSpec(requestedUrn, { baseUrl: registryBaseUrl, timeoutMs: 100 }),
  });

  assert.equal(issues.length, 2);
  assert.equal(
    issues.some((entry) => entry.message.includes('Invalid cfg.version')),
    true,
  );
  assert.equal(
    issues.some((entry) => entry.message.includes('[NETWORK HTTP 503]')),
    true,
  );
});
