import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { GatewayError, createIpcServer } from '@eyaeya/xgg-core';

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const baseUrl = 'http://gateway.invalid';
const agentStartedAt = '2026-07-19T00:00:00.000Z';

function endpointPath(root) {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\xgg-snapshot-${process.pid}-${randomUUID()}`;
  }
  return join(root, 'agent.sock');
}

async function fakeAgent(t, respond) {
  const root = await mkdtemp(join(tmpdir(), 'xgg-cli-snapshot-'));
  const socketPath = endpointPath(root);
  const calls = [];
  const server = await createIpcServer({
    path: socketPath,
    handler: async ({ method, params }) => {
      if (method === '$ping') return { host: baseUrl, agentStartedAt };
      calls.push({ method, params });
      return respond(method, params);
    },
  });
  t.after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  const sessionFile = join(root, 'sessions.json');
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
  return { calls, root, sessionFile };
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: {
        ...process.env,
        XGG_AGENT_MODE: '0',
        XGG_SNAPSHOTS_DIR: '',
        XGG_NO_REFRESH_HINT: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

test('variable mutation emits no write RPC when rollback snapshot collection fails', async (t) => {
  const agent = await fakeAgent(t, async (method) => {
    if (method === '/api/getDevList') return { devList: {} };
    if (method === '/api/getGraphList') {
      throw new GatewayError('rules unavailable during checkpoint', { gatewayCode: -1 });
    }
    if (method === '/api/createVar') return {};
    throw new Error(`unexpected method: ${method}`);
  });
  const snapshotsDir = join(agent.root, 'snapshots');

  const result = await runCli([
    'variable',
    'create',
    '--scope',
    'global',
    '--id',
    'marker',
    '--type',
    'number',
    '--value',
    '1',
    '--name',
    'Marker',
    '--base-url',
    baseUrl,
    '--session-file',
    agent.sessionFile,
    '--snapshots-dir',
    snapshotsDir,
  ]);

  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /rules unavailable during checkpoint/);
  assert.deepEqual(
    agent.calls.map((call) => call.method),
    ['/api/getDevList', '/api/getGraphList'],
  );
  assert.equal(
    agent.calls.some((call) => call.method === '/api/createVar'),
    false,
  );
  await assert.rejects(stat(snapshotsDir), (error) => error?.code === 'ENOENT');
});

test('best-effort dump marks a partial inventory as failed for machine consumers', async (t) => {
  const agent = await fakeAgent(t, async (method) => {
    if (method === '/api/getDevList') return { devList: {} };
    if (method === '/api/getGraphList') {
      throw new GatewayError('rules unavailable', { gatewayCode: -1 });
    }
    if (method === '/api/getVarScopeList') return { scopes: [] };
    throw new Error(`unexpected method: ${method}`);
  });

  const result = await runCli(['dump', '--base-url', baseUrl, '--session-file', agent.sessionFile]);
  const payload = JSON.parse(result.stdout);

  assert.equal(result.status, 1, result.stderr);
  assert.equal(payload.ok, false);
  assert.equal(payload.partial, true);
  assert.deepEqual(payload.devices, {});
  assert.equal(payload.rules, null);
  assert.deepEqual(payload.variableScopes, []);
  assert.deepEqual(payload.errors, [{ resource: 'rules', error: 'rules unavailable' }]);
  assert.deepEqual(
    agent.calls.map((call) => call.method),
    ['/api/getDevList', '/api/getGraphList', '/api/getVarScopeList'],
  );
});
