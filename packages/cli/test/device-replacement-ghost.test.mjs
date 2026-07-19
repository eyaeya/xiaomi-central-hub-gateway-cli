import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createIpcServer } from '@eyaeya/xgg-core';
import { buildProgram } from '../dist/program.js';

const baseUrl = 'http://device-replacement-ghost.test';
const agentStartedAt = '2026-07-20T00:00:00.000Z';
const ruleId = '128';
const sourceDid = 'source-device';
const targetDid = 'target-device';
const sourceUrn = 'urn:miot-spec-v2:device:fixture-source:0000A001:source:1';
const targetUrn = 'urn:miot-spec-v2:device:fixture-target:0000A002:target:9';

function endpointPath(root) {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\xgg-replacement-ghost-${process.pid}-${randomUUID()}`;
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
    model: `fixture.${name}`,
    modelName: name,
    urn,
    roomId: 'room',
    roomName: 'Room',
    icon: '',
    ...overrides,
  };
}

function spec(urn, { siid, vendor, version }) {
  return {
    type: urn,
    description: `${vendor} fixture`,
    services: [
      {
        iid: siid,
        type: `urn:miot-spec-v2:service:fixture-service:00007801:${vendor}:${version}`,
        description: 'fixture service',
        properties: [
          {
            iid: 1,
            type: `urn:miot-spec-v2:property:level:00000001:${vendor}:${version}`,
            description: 'level',
            format: 'uint8',
            access: ['read', 'write', 'notify'],
            'value-range': [0, 100, 1],
          },
        ],
        events: [],
        actions: [],
      },
    ],
  };
}

function sourceNode() {
  return {
    id: 'input-property',
    type: 'deviceInput',
    cfg: {
      urn: sourceUrn,
      pos: { x: 0, y: 0, width: 584, height: 206 },
      name: 'deviceInput',
      version: 1,
    },
    inputs: {},
    outputs: { output: [] },
    props: {
      did: sourceDid,
      siid: 2,
      piid: 1,
      dtype: 'int',
      operator: '>=',
      v1: 42,
    },
  };
}

function summary() {
  return {
    id: ruleId,
    enable: false,
    uiType: 'rule',
    userData: {
      name: 'replacement fixture',
      transform: { x: 0, y: 0, scale: 1, rotate: 0 },
      lastUpdateTime: 0,
      version: 0,
    },
  };
}

async function startFakeAgent(t) {
  const root = await mkdtemp(join(tmpdir(), 'xgg-replacement-ghost-'));
  const socketPath = endpointPath(root);
  const sessionFile = join(root, 'session.json');
  const frames = [];
  const server = await createIpcServer({
    path: socketPath,
    handler: async (request) => {
      frames.push(request);
      if (request.method === '$ping') return { host: baseUrl, agentStartedAt };
      if (request.method === '/api/getGraphList') return [summary()];
      if (request.method === '/api/getGraph') return { id: ruleId, nodes: [sourceNode()] };
      if (request.method === '/api/getDevList') {
        return {
          devList: {
            [sourceDid]: device(sourceUrn, 'Source'),
            [targetDid]: device(targetUrn, 'Ghost target', {
              specV2Access: false,
              specV3Access: false,
              online: true,
            }),
          },
        };
      }
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
  return { frames, root, sessionFile };
}

test('focused ghost dry-run has no planId and performs exactly zero lease, snapshot, or setGraph', async (t) => {
  const agent = await startFakeAgent(t);
  const snapshotsDir = join(agent.root, 'must-not-exist');
  const originalFetch = globalThis.fetch;
  const originalWrite = process.stdout.write;
  const previousEnv = new Map(
    [
      'XGG_AGENT_MODE',
      'XGG_BASE_URL',
      'XGG_SESSION_FILE',
      'XGG_NO_NEXT_HINT',
      'XGG_NO_REFRESH_HINT',
    ].map((key) => [key, process.env[key]]),
  );
  let stdout = '';

  globalThis.fetch = async (input) => {
    const urn = new URL(String(input)).searchParams.get('type');
    const body =
      urn === sourceUrn
        ? spec(sourceUrn, { siid: 2, vendor: 'source', version: 1 })
        : spec(targetUrn, { siid: 9, vendor: 'target', version: 9 });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  process.stdout.write = (chunk) => {
    stdout += String(chunk);
    return true;
  };
  process.env.XGG_AGENT_MODE = '1';
  process.env.XGG_BASE_URL = baseUrl;
  process.env.XGG_SESSION_FILE = agent.sessionFile;
  process.env.XGG_NO_NEXT_HINT = '1';
  process.env.XGG_NO_REFRESH_HINT = '1';

  try {
    await buildProgram().parseAsync(
      [
        'rule',
        'device',
        'replace',
        '--rule-id',
        ruleId,
        '--node-id',
        'input-property',
        '--target-did',
        targetDid,
        '--target-siid',
        '9',
        '--target-piid',
        '1',
        '--snapshots-dir',
        snapshotsDir,
      ],
      { from: 'user' },
    );
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalWrite;
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  const payload = JSON.parse(stdout.trim());
  assert.equal(payload.ok, true);
  assert.equal(payload.dryRun, true);
  assert.equal(payload.plan.candidates[0].eligible, false);
  assert.equal(payload.plan.candidates[0].compatible, true);
  assert.match(
    payload.plan.candidates[0].eligibilityReasons.join('\n'),
    /ghost|autoLocal|ineligible/i,
  );
  assert.equal(Object.hasOwn(payload.plan, 'selectedMapping'), false);
  assert.equal(Object.hasOwn(payload.plan, 'planId'), false);
  assert.match(payload.plan.selectionError.message, /ghost|ineligible/i);
  assert.equal(agent.frames.filter((frame) => frame.method === '$mutation.acquire').length, 0);
  assert.equal(agent.frames.filter((frame) => frame.method === '/api/getVarList').length, 0);
  assert.equal(agent.frames.filter((frame) => frame.method === '/api/setGraph').length, 0);
  await assert.rejects(access(snapshotsDir), (error) => error?.code === 'ENOENT');
});
