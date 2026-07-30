import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createIpcServer, isKnownGatewayWriteMethod } from '@eyaeya/xgg-core';
import { buildProgram } from '../dist/program.js';

const baseUrl = 'http://learn-plan.test';
const agentStartedAt = '2026-07-30T00:00:00.000Z';

function endpointPath(root) {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\xgg-learn-plan-${process.pid}-${randomUUID()}`;
  }
  return join(root, 'agent.sock');
}

function device(urn, name, overrides = {}) {
  return {
    specV2Access: true,
    specV3Access: false,
    online: true,
    pushAvailable: true,
    name,
    model: `fixture.${name.toLowerCase().replaceAll(' ', '-')}`,
    modelName: name,
    urn,
    roomId: 'room-1',
    roomName: 'Room One',
    icon: '',
    ...overrides,
  };
}

function fixtureSpec(urn) {
  return {
    type: urn,
    description: 'Learning fixture',
    services: [
      {
        iid: 2,
        type: 'urn:miot-spec-v2:service:switch:0000780C:learn-plan:1',
        description: 'Switch',
        properties: [
          {
            iid: 1,
            type: 'urn:miot-spec-v2:property:on:00000006:learn-plan:1',
            description: 'On',
            format: 'bool',
            access: ['read', 'write', 'notify'],
          },
        ],
        events: [],
        actions: [],
      },
    ],
  };
}

async function startFakeAgent(t, devList) {
  const root = await mkdtemp(join(tmpdir(), 'xgg-learn-plan-'));
  const socketPath = endpointPath(root);
  const sessionFile = join(root, 'session.json');
  const frames = [];
  const server = await createIpcServer({
    path: socketPath,
    handler: async (request) => {
      frames.push(request);
      if (request.method === '$ping') return { host: baseUrl, agentStartedAt };
      if (request.method === '/api/getDevList') return { devList };
      throw new Error(`unexpected IPC method: ${request.method}`);
    },
  });
  await writeFile(
    sessionFile,
    JSON.stringify({
      version: 2,
      sessions: {
        [baseUrl]: {
          host: baseUrl,
          pid: process.pid,
          socketPath,
          agentStartedAt,
          agentVersion: 'test',
          lastValidatedAt: agentStartedAt,
        },
      },
    }),
    { mode: 0o600 },
  );
  t.after(async () => {
    await server.close();
    await rm(root, { force: true, recursive: true });
  });
  return { frames, sessionFile };
}

test('learn plan uses live inventory and specs, preserves per-device failures, and never writes', async (t) => {
  const suffix = randomUUID();
  const loadedUrn = `urn:miot-spec-v2:device:learn-loaded:0000A001:${suffix}:1`;
  const failedUrn = `urn:miot-spec-v2:device:learn-failed:0000A002:${suffix}:1`;
  const ghostUrn = `urn:miot-spec-v2:device:learn-ghost:0000A003:${suffix}:1`;
  const agent = await startFakeAgent(t, {
    loaded: device(loadedUrn, 'Loaded device'),
    failedOne: device(failedUrn, 'Failed one'),
    failedTwo: device(failedUrn, 'Failed two'),
    ghost: device(ghostUrn, 'Ghost device', {
      specV2Access: false,
      specV3Access: false,
    }),
  });
  const fetches = [];
  const originalFetch = globalThis.fetch;
  const originalWrite = process.stdout.write;
  const originalSessionFile = process.env.XGG_SESSION_FILE;
  let stdout = '';

  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const urn = url.searchParams.get('type');
    fetches.push({ urn, method: init?.method, signal: init?.signal });
    if (urn === loadedUrn) {
      return new Response(JSON.stringify(fixtureSpec(loadedUrn)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (urn === failedUrn) {
      return new Response('registry unavailable', { status: 503 });
    }
    throw new Error(`unexpected spec request: ${urn}`);
  };
  process.stdout.write = (chunk) => {
    stdout += String(chunk);
    return true;
  };
  process.env.XGG_SESSION_FILE = agent.sessionFile;

  try {
    await buildProgram().parseAsync(
      [
        'learn',
        'plan',
        '--base-url',
        baseUrl,
        '--timeout',
        '4321',
        '--include-context',
        '--include-sensitive',
        '--exclude-room',
        'room-never-present',
      ],
      { from: 'user' },
    );
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalWrite;
    if (originalSessionFile === undefined) Reflect.deleteProperty(process.env, 'XGG_SESSION_FILE');
    else process.env.XGG_SESSION_FILE = originalSessionFile;
  }

  assert.equal(stdout.trim().split('\n').length, 1);
  const payload = JSON.parse(stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.partial, true);
  assert.equal(payload.readOnly, true);
  assert.deepEqual(payload.specFetch, {
    attemptedDeviceCount: 3,
    loadedDeviceCount: 1,
    failedDeviceCount: 2,
  });
  assert.deepEqual(
    payload.specFailures.map(({ did, urn, code, details }) => ({
      did,
      urn,
      code,
      dependency: details?.dependency,
      status: details?.status,
    })),
    [
      {
        did: 'failedOne',
        urn: failedUrn,
        code: 'NETWORK',
        dependency: 'miot-spec-registry',
        status: 503,
      },
      {
        did: 'failedTwo',
        urn: failedUrn,
        code: 'NETWORK',
        dependency: 'miot-spec-registry',
        status: 503,
      },
    ],
  );
  assert.equal(payload.plan.policy.includeContext, true);
  assert.equal(payload.plan.policy.includeSensitive, true);
  assert.deepEqual(payload.plan.policy.excludedDeviceIds, []);
  assert.deepEqual(payload.plan.policy.excludedRoomIds, ['room-never-present']);
  assert.deepEqual(payload.plan.specs.loadedUrns, [loadedUrn]);
  assert.deepEqual(payload.plan.specs.failedUrns, [failedUrn]);
  assert.ok(
    payload.plan.deviceCoverage
      .find(({ did }) => did === 'failedOne')
      .reasonCodes.includes('spec-fetch-failed'),
  );
  assert.ok(
    payload.plan.deviceCoverage
      .find(({ did }) => did === 'ghost')
      .reasonCodes.includes('device-ghost'),
  );

  assert.equal(fetches.length, 2);
  assert.deepEqual(fetches.map(({ urn }) => urn).sort(), [failedUrn, loadedUrn].sort());
  assert.ok(fetches.every(({ method }) => method === 'GET'));
  assert.ok(fetches.every(({ signal }) => signal instanceof AbortSignal));
  assert.equal(agent.frames.filter(({ method }) => method === '/api/getDevList').length, 1);
  assert.ok(agent.frames.every(({ method }) => !isKnownGatewayWriteMethod(method)));
});

test('learn plan rejects an invalid timeout before session or network access', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error('fetch should not run');
  };
  try {
    await assert.rejects(
      buildProgram().parseAsync(['learn', 'plan', '--base-url', baseUrl, '--timeout', '0'], {
        from: 'user',
      }),
      (error) => error?.code === 'CONFIG' && /--timeout/.test(error.message),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetchCalled, false);
});
