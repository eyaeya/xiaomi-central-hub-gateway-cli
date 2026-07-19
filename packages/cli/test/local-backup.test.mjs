import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createInMemoryMutationLeaseCoordinator,
  createIpcServer,
  readLocalBackup,
} from '../../core/dist/index.js';

const fixture = JSON.parse(
  await readFile(new URL('../../core/test/fixtures/local-backup-v2.json', import.meta.url), 'utf8'),
);
const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const baseUrl = 'http://local-backup-cli.test';
const agentStartedAt = '2026-07-19T00:00:00.000Z';

function endpointPath(root) {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\xgg-local-backup-${process.pid}-${randomUUID()}`
    : join(root, 'agent.sock');
}

function currentRule() {
  return {
    id: 'currentRule',
    cfg: {
      id: 'currentRule',
      enable: false,
      uiType: 'rule',
      userData: {
        name: 'Current rule',
        transform: { x: 0, y: 0, scale: 1, rotate: 0 },
        lastUpdateTime: 0,
        version: 0,
      },
    },
    nodes: [
      {
        id: 'currentSource',
        type: 'onLoad',
        cfg: {
          pos: { x: 0, y: 0, width: 200, height: 120 },
          name: 'onLoad',
          version: 1,
        },
        inputs: {},
        outputs: { output: [] },
        props: {},
      },
    ],
  };
}

async function startFakeAgent(t) {
  const root = await mkdtemp(join(tmpdir(), 'xgg-local-backup-cli-'));
  const socketPath = endpointPath(root);
  const sessionFile = join(root, 'session.json');
  const calls = [];
  const writes = [];
  const control = { snapshotsDir: undefined, snapshotVisibleAtFirstWrite: false };
  const current = currentRule();
  const mutationLeases = createInMemoryMutationLeaseCoordinator();
  const server = await createIpcServer({
    path: socketPath,
    mutationLeases,
    handler: async (request, context) => {
      if (request.method === '$ping') return { host: baseUrl, agentStartedAt };
      calls.push({ ...request, leaseId: context.leaseId });
      switch (request.method) {
        case '/api/getDevList':
          return { devList: {} };
        case '/api/getGraphList':
          return [structuredClone(current.cfg)];
        case '/api/getGraph':
          return { id: current.id, nodes: structuredClone(current.nodes) };
        case '/api/getVarScopeList':
          return { scopes: ['global'] };
        case '/api/getVarList':
          return {
            oldValue: {
              type: 'number',
              value: 1,
              userData: { name: 'Old value' },
            },
          };
        case '/api/deleteGraph':
        case '/api/deleteVar':
        case '/api/createVar':
        case '/api/setVarValue':
        case '/api/setGraph': {
          if (writes.length === 0 && control.snapshotsDir !== undefined) {
            const directories = await readdir(control.snapshotsDir);
            if (directories.length === 1) {
              const snapshot = join(control.snapshotsDir, directories[0], 'dump.json');
              control.snapshotVisibleAtFirstWrite = (await stat(snapshot)).isFile();
            }
          }
          writes.push({ ...request, leaseId: context.leaseId });
          return null;
        }
        default:
          throw new Error(`unexpected method: ${request.method}`);
      }
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
    await rm(root, { recursive: true, force: true });
  });
  return { calls, control, mutationLeases, root, sessionFile, writes };
}

function runCli(args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: {
        ...process.env,
        XGG_AGENT_MODE: options.agentMode ?? '0',
        XGG_BASE_URL: options.baseUrl ?? '',
        XGG_SESSION_FILE: options.sessionFile ?? join(tmpdir(), 'xgg-missing-session.json'),
        XGG_SNAPSHOTS_DIR: options.snapshotsDir ?? '',
        XGG_NO_NEXT_HINT: '1',
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
    child.once('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

function assertJsonFailure(result, code, status) {
  assert.equal(result.status, status, result.stderr);
  assert.equal(result.stdout, '');
  const lines = result.stderr.trimEnd().split('\n');
  assert.equal(lines.length, 1, result.stderr);
  const payload = JSON.parse(lines[0]);
  assert.equal(payload.error.code, code);
  return payload;
}

async function writeFixture(root, name = 'fixture.bak') {
  const path = join(root, name);
  await writeFile(path, Buffer.from(fixture.backupBase64, 'base64'));
  return path;
}

test('tampered local import fails offline before base-url or session access', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'xgg-local-backup-tamper-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = await writeFixture(root);
  const bytes = await readFile(input);
  bytes[8] ^= 0x01;
  await writeFile(input, bytes);

  const result = await runCli(['backup', 'local-import', '--input', input, '--dry-run']);
  const payload = assertJsonFailure(result, 'SCHEMA', 4);
  assert.match(payload.error.message, /digest mismatch/);
  assert.doesNotMatch(payload.error.message, /base-url|session/i);
});

test('local import requires an explicit mode before touching the gateway', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'xgg-local-backup-mode-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = await writeFixture(root);

  for (const flags of [[], ['--dry-run', '--confirm-replace-all']]) {
    const result = await runCli(['backup', 'local-import', '--input', input, ...flags]);
    const payload = assertJsonFailure(result, 'CONFIG', 5);
    assert.match(payload.error.message, /choose exactly one/);
  }
});

test('local-import dry-run reports the full live plan and performs zero writes', async (t) => {
  const agent = await startFakeAgent(t);
  const input = await writeFixture(agent.root);
  const result = await runCli(['backup', 'local-import', '--input', input, '--dry-run'], {
    agentMode: '1',
    baseUrl,
    sessionFile: agent.sessionFile,
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.dryRun, true);
  assert.deepEqual(payload.plan.totals, {
    deleteRules: 1,
    deleteVariableScopes: 1,
    deleteVariables: 1,
    createRules: 1,
    createVariableScopes: 1,
    createVariables: 1,
  });
  assert.deepEqual(agent.writes, []);
  assert.equal(agent.mutationLeases.status().fenced, false);
});

test('confirmed local import enforces Agent snapshot path before IPC', async (t) => {
  const agent = await startFakeAgent(t);
  const input = await writeFixture(agent.root);
  const result = await runCli(
    ['backup', 'local-import', '--input', input, '--confirm-replace-all'],
    { agentMode: '1', baseUrl, sessionFile: agent.sessionFile },
  );

  const payload = assertJsonFailure(result, 'CONFIG', 5);
  assert.match(payload.error.message, /requires --snapshots-dir/);
  assert.deepEqual(agent.calls, []);
});

test('confirmed local import publishes snapshot before leased replace-all writes', async (t) => {
  const agent = await startFakeAgent(t);
  const input = await writeFixture(agent.root);
  const snapshotsDir = join(agent.root, 'snapshots');
  agent.control.snapshotsDir = snapshotsDir;
  const result = await runCli(
    [
      'backup',
      'local-import',
      '--input',
      input,
      '--confirm-replace-all',
      '--snapshots-dir',
      snapshotsDir,
    ],
    { agentMode: '1', baseUrl, sessionFile: agent.sessionFile },
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.dryRun, false);
  assert.equal((await stat(payload.snapshot)).isFile(), true);
  assert.equal(agent.control.snapshotVisibleAtFirstWrite, true);
  assert.deepEqual(
    agent.writes.map((call) => call.method),
    ['/api/deleteGraph', '/api/deleteVar', '/api/createVar', '/api/setVarValue', '/api/setGraph'],
  );
  assert.equal(
    agent.writes.every((call) => typeof call.leaseId === 'string'),
    true,
  );
  assert.equal(agent.mutationLeases.status().fenced, false);
});

test('local-export is read-only and writes a decodable official-format file', async (t) => {
  const agent = await startFakeAgent(t);
  const output = join(agent.root, 'exported.bak');
  const result = await runCli(['backup', 'local-export', '--output', output], {
    agentMode: '1',
    baseUrl,
    sessionFile: agent.sessionFile,
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.file, output);
  const decoded = await readLocalBackup(output);
  assert.deepEqual(
    decoded.rules.map((rule) => rule.id),
    ['currentRule'],
  );
  assert.deepEqual(Object.keys(decoded.variables.global), ['oldValue']);
  assert.deepEqual(agent.writes, []);
  assert.equal(dirname(payload.file), agent.root);
});
