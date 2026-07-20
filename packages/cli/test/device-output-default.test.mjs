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
const baseUrl = 'http://device-output-default.test';
const agentStartedAt = '2026-07-20T00:00:00.000Z';

const device = {
  specV2Access: true,
  specV3Access: false,
  online: true,
  pushAvailable: true,
  name: '测试灯',
  model: 'test.light.v1',
  modelName: '实例产品名称',
  urn: 'urn:miot-spec-v2:device:light:0000A001:test-model:1',
  roomId: 'room-1',
  roomName: '客厅',
  icon: 'icon.png',
  extensionField: { preserved: true },
};

function endpointPath(root) {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\xgg-device-output-${process.pid}-${randomUUID()}`;
  }
  return join(root, 'agent.sock');
}

async function startFakeAgent(t) {
  const root = await mkdtemp(join(tmpdir(), 'xgg-device-output-default-'));
  const socketPath = endpointPath(root);
  const calls = [];
  const server = await createIpcServer({
    path: socketPath,
    handler: async ({ method, params }) => {
      if (method === '$ping') return { host: baseUrl, agentStartedAt };
      calls.push({ method, params });
      if (method === '/api/getDevList') return { devList: { 'device-id': device } };
      throw new Error(`unexpected RPC: ${method}`);
    },
  });
  const sessionFile = join(root, 'session.json');
  const preload = join(root, 'forbid-fetch.mjs');
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
      "globalThis.fetch = async () => { process.stderr.write('__UNEXPECTED_SEMANTIC_FETCH__\\n'); throw new Error('fetch forbidden'); };\n",
      { mode: 0o600 },
    ),
  ]);

  t.after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  return { calls, preload, sessionFile };
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

test('default device list/get JSON shapes remain exact and perform no semantic fetch', async (t) => {
  const agent = await startFakeAgent(t);

  const list = await runCli(['device', 'list', '--no-next-hint'], agent);
  assert.equal(list.status, 0, list.stderr);
  assert.doesNotMatch(list.stderr, /__UNEXPECTED_SEMANTIC_FETCH__/);
  assert.deepEqual(JSON.parse(list.stdout), {
    ok: true,
    devices: { 'device-id': device },
    ghostExcluded: 0,
  });

  const get = await runCli(['device', 'get', 'device-id'], agent);
  assert.equal(get.status, 0, get.stderr);
  assert.doesNotMatch(get.stderr, /__UNEXPECTED_SEMANTIC_FETCH__/);
  assert.deepEqual(JSON.parse(get.stdout), { ok: true, device });
  assert.deepEqual(
    agent.calls.map(({ method }) => method),
    ['/api/getDevList', '/api/getDevList'],
  );
});
