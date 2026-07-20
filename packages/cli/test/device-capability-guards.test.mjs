import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createIpcServer } from '@eyaeya/xgg-core';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const baseUrl = 'http://device-capability-cli.invalid';
const agentStartedAt = '2026-07-21T01:00:00.000Z';
const did = 'cli-capability-device';
const urn = 'urn:miot-spec-v2:device:test-device:0000A001:cli-capability:1';

const spec = {
  type: urn,
  description: 'CLI device capability fixture',
  services: [
    {
      iid: 2,
      type: 'urn:miot-spec-v2:service:test-service:00007801:cli-capability:1',
      description: 'fixture service',
      properties: [
        {
          iid: 1,
          type: 'urn:miot-spec-v2:property:notify-only:00000001:cli-capability:1',
          description: 'notify only',
          format: 'bool',
          access: ['notify'],
        },
        {
          iid: 2,
          type: 'urn:miot-spec-v2:property:read-only:00000002:cli-capability:1',
          description: 'read only',
          format: 'bool',
          access: ['read'],
        },
        {
          iid: 3,
          type: 'urn:miot-spec-v2:property:event-value:00000003:cli-capability:1',
          description: 'event value',
          format: 'uint8',
          access: ['read', 'notify'],
          'value-range': [0, 10, 1],
        },
      ],
      events: [
        {
          iid: 10,
          type: 'urn:miot-spec-v2:event:changed:00005001:cli-capability:1',
          description: 'changed',
          arguments: [3],
        },
      ],
    },
  ],
};

const device = {
  specV2Access: true,
  specV3Access: false,
  online: true,
  pushAvailable: false,
  name: 'CLI capability fixture',
  model: 'test.cli.capability.v1',
  modelName: 'CLI Capability Fixture',
  urn,
  roomId: 'room-1',
  roomName: 'Test Room',
  icon: '',
};

function endpointPath(root) {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\xgg-capability-${process.pid}-${randomUUID()}`;
  }
  return join(root, 'agent.sock');
}

async function startFakeAgent(t) {
  const root = await mkdtemp(join(tmpdir(), 'xgg-device-capability-cli-'));
  const socketPath = endpointPath(root);
  const sessionFile = join(root, 'session.json');
  const preload = join(root, 'stub-spec-fetch.mjs');
  const state = {
    summary: {
      id: 'rule174',
      enable: false,
      uiType: 'rule',
      userData: {
        name: 'CLI capability test',
        transform: { x: 0, y: 0, scale: 1, rotate: 0 },
        lastUpdateTime: 0,
        version: 0,
      },
    },
    nodes: [],
  };
  const calls = [];
  const server = await createIpcServer({
    path: socketPath,
    handler: async ({ method, params }) => {
      if (method === '$ping') return { host: baseUrl, agentStartedAt };
      if (method === '$mutation.acquire') return { leaseId: 'cli-capability-lease' };
      if (method === '$mutation.release' || method === '$mutation.fence') return { ok: true };
      calls.push({ method, params });
      if (method === '/api/getDevList') return { devList: { [did]: device } };
      if (method === '/api/getGraphList') return [structuredClone(state.summary)];
      if (method === '/api/getGraph') {
        return { id: state.summary.id, nodes: structuredClone(state.nodes) };
      }
      if (method === '/api/getVarList') {
        return params.scope === 'global'
          ? { captured: { type: 'number', value: 0, userData: { name: 'captured' } } }
          : {};
      }
      if (method === '/api/setGraph') {
        state.summary = structuredClone(params.cfg);
        state.nodes = structuredClone(params.nodes);
        return null;
      }
      throw new Error(`unexpected RPC: ${method}`);
    },
  });
  await Promise.all([
    writeFile(
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
    ),
    writeFile(
      preload,
      `globalThis.fetch = async () => new Response(${JSON.stringify(JSON.stringify(spec))}, { status: 200, headers: { 'content-type': 'application/json' } });\n`,
      { mode: 0o600 },
    ),
  ]);
  t.after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  return { calls, preload, sessionFile, state };
}

function runCli(args, agent) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: packageRoot,
      env: {
        ...process.env,
        NODE_OPTIONS: `--import=${pathToFileURL(agent.preload).href}`,
        XGG_BASE_URL: baseUrl,
        XGG_SESSION_FILE: agent.sessionFile,
        XGG_NO_NEXT_HINT: '1',
        XGG_NO_REFRESH_HINT: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function baseArgs(type, id) {
  return [
    'rule',
    'node',
    'add',
    '--rule-id',
    'rule174',
    '--type',
    type,
    '--id',
    id,
    '--device-did',
    did,
    '--no-snapshot',
    '--no-var-check',
    '--no-next-hint',
  ];
}

test('CLI forwards --allow-no-push for property/event sources and keeps it probe-only', async (t) => {
  const agent = await startFakeAgent(t);
  const routes = [
    {
      id: 'inputProperty',
      args: [
        ...baseArgs('deviceInput', 'inputProperty'),
        '--device-property',
        'notify-only',
        '--op',
        'eq',
        '--threshold',
        '1',
      ],
    },
    {
      id: 'captureEvent',
      args: [
        ...baseArgs('deviceInputSetVar', 'captureEvent'),
        '--device-event',
        'changed',
        '--var-scope',
        'global',
        '--var-id',
        'captured',
      ],
    },
  ];

  for (const route of routes) {
    const rejected = await runCli(route.args, agent);
    assert.equal(rejected.status, 5, rejected.stderr);
    assert.match(rejected.stderr, /pushAvailable=false.*--allow-no-push/);

    const accepted = await runCli([...route.args, '--allow-no-push'], agent);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(JSON.parse(accepted.stdout).nodeId, route.id);
    const node = agent.state.nodes.find(({ id }) => id === route.id);
    assert.ok(node);
    assert.equal('allowNoPush' in node, false);
    assert.equal('allowNoPush' in node.props, false);
  }

  const inventoryReadsBefore = agent.calls.filter(
    ({ method }) => method === '/api/getDevList',
  ).length;
  const validation = await runCli(
    ['rule', 'validate', '--rule-id', 'rule174', '--spec-aware', '--no-next-hint'],
    agent,
  );
  assert.equal(validation.status, 2, validation.stderr);
  const validationPayload = JSON.parse(validation.stdout);
  assert.equal(validationPayload.specAware, true);
  assert.deepEqual(
    validationPayload.issues
      .filter(({ message }) => message.includes('pushAvailable=false'))
      .map(({ path }) => path),
    ['nodes[0].props.did', 'nodes[1].props.did'],
  );
  assert.equal(
    agent.calls.filter(({ method }) => method === '/api/getDevList').length,
    inventoryReadsBefore + 1,
    'online spec-aware validation should load one consistent inventory snapshot',
  );

  const setGraphCallsBefore = agent.calls.filter(({ method }) => method === '/api/setGraph').length;
  const accessMismatch = await runCli(
    [
      ...baseArgs('deviceInput', 'missingNotify'),
      '--device-property',
      'read-only',
      '--op',
      'eq',
      '--threshold',
      '1',
      '--allow-no-push',
    ],
    agent,
  );
  assert.equal(accessMismatch.status, 5, accessMismatch.stderr);
  assert.match(JSON.parse(accessMismatch.stderr).error.message, /requires MIoT access "notify"/);
  assert.equal(
    agent.calls.filter(({ method }) => method === '/api/setGraph').length,
    setGraphCallsBefore,
    'probe override must not bypass notify access or reach setGraph',
  );
});
