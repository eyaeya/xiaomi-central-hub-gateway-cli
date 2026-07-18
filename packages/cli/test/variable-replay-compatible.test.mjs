import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { GatewayError, createIpcServer } from '@eyaeya/xgg-core';
import { buildProgram } from '../dist/program.js';

const baseUrl = 'http://gateway.invalid';
const startedAt = '2026-07-19T00:00:00.000Z';

async function captureStdout(fn) {
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join('');
}

function cliArgs(sessionFile, snapshotsDir, value, id = 'count', checkOnly = false) {
  return [
    'node',
    'xgg',
    'variable',
    'create',
    '--scope',
    'R456',
    '--id',
    id,
    '--type',
    'number',
    '--value',
    String(value),
    '--name',
    'Count',
    '--if-compatible',
    '--allow-unknown-scope',
    '--base-url',
    baseUrl,
    '--session-file',
    sessionFile,
    '--snapshots-dir',
    snapshotsDir,
    '--no-next-hint',
    '--no-refresh-hint',
    ...(checkOnly ? ['--check-only'] : []),
  ];
}

test('variable create --if-compatible keeps an exact value and rejects mismatches without writes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'xgg-variable-compatible-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const socketPath = join(root, 'agent.sock');
  const sessionFile = join(root, 'session.json');
  await writeFile(
    sessionFile,
    JSON.stringify({
      version: 2,
      sessions: {
        [baseUrl]: {
          host: baseUrl,
          pid: process.pid,
          socketPath,
          agentStartedAt: startedAt,
          agentVersion: '0.1.4',
          lastValidatedAt: startedAt,
        },
      },
    }),
  );

  const calls = [];
  let constructorVisible = false;
  let racedVisible = false;
  const server = await createIpcServer({
    path: socketPath,
    handler: async ({ method, params, kind }) => {
      if (method === '$ping') return { host: baseUrl, agentStartedAt: startedAt };
      calls.push({ method, params, kind });
      if (method === '/api/getVarList') {
        return {
          count: { type: 'number', value: 7, userData: { name: 'Count' } },
          ...(constructorVisible && {
            constructor: { type: 'number', value: 7, userData: { name: 'Count' } },
          }),
          ...(racedVisible && {
            raced: { type: 'number', value: 7, userData: { name: 'Count' } },
          }),
        };
      }
      if (method === '/api/getDevList') return { devList: {} };
      if (method === '/api/getGraphList') return [];
      if (method === '/api/getVarScopeList') return { scopes: [] };
      if (method === '/api/createVar') {
        if (params.id === 'raced') {
          racedVisible = true;
          throw new GatewayError('Variable already exists');
        }
        if (params.id === 'constructor') constructorVisible = true;
        return {};
      }
      throw new Error(`unexpected RPC: ${method}`);
    },
  });
  t.after(() => server.close());

  const invalidCheckOnlyArgs = cliArgs(sessionFile, root, 7, 'count', true).filter(
    (arg) => arg !== '--if-compatible',
  );
  await assert.rejects(
    buildProgram().parseAsync(invalidCheckOnlyArgs),
    (error) => error?.code === 'CONFIG' && /requires --if-compatible/.test(error.message),
  );
  assert.equal(calls.length, 0);

  await assert.rejects(
    buildProgram().parseAsync(cliArgs(sessionFile, root, 7, 'bad-id', true)),
    (error) => error?.code === 'CONFIG' && /non-empty ASCII alphanumeric/.test(error.message),
  );
  const invalidScopeArgs = cliArgs(sessionFile, root, 7, 'newVar', true);
  invalidScopeArgs[invalidScopeArgs.indexOf('--scope') + 1] = 'bad_scope';
  await assert.rejects(
    buildProgram().parseAsync(invalidScopeArgs),
    (error) => error?.code === 'CONFIG' && /non-empty ASCII alphanumeric/.test(error.message),
  );
  const blankNameArgs = cliArgs(sessionFile, root, 7, 'newVar', true);
  blankNameArgs[blankNameArgs.indexOf('--name') + 1] = '   ';
  await assert.rejects(
    buildProgram().parseAsync(blankNameArgs),
    (error) => error?.code === 'CONFIG' && /name must be non-empty/.test(error.message),
  );
  assert.equal(calls.length, 0);

  const stdout = await captureStdout(() =>
    buildProgram().parseAsync(cliArgs(sessionFile, root, 7)),
  );
  assert.deepEqual(JSON.parse(stdout), {
    ok: true,
    scope: 'R456',
    id: 'count',
    type: 'number',
    value: 7,
    created: false,
    existing: true,
    snapshot: null,
  });

  await assert.rejects(
    buildProgram().parseAsync(cliArgs(sessionFile, root, 8)),
    (error) => error?.code === 'CONFIG' && /will not overwrite/.test(error.message),
  );

  const preflightStdout = await captureStdout(() =>
    buildProgram().parseAsync(cliArgs(sessionFile, root, 7, 'constructor', true)),
  );
  assert.deepEqual(JSON.parse(preflightStdout), {
    ok: true,
    scope: 'R456',
    id: 'constructor',
    type: 'number',
    value: 7,
    created: false,
    existing: false,
    missing: true,
    checkOnly: true,
    snapshot: null,
  });

  const inheritedNameStdout = await captureStdout(() =>
    buildProgram().parseAsync(cliArgs(sessionFile, root, 7, 'constructor')),
  );
  const inheritedNamePayload = JSON.parse(inheritedNameStdout);
  assert.equal(inheritedNamePayload.ok, true);
  assert.equal(inheritedNamePayload.id, 'constructor');
  assert.equal(inheritedNamePayload.created, true);
  assert.equal(typeof inheritedNamePayload.snapshot, 'string');

  const inheritedOwnNameStdout = await captureStdout(() =>
    buildProgram().parseAsync(cliArgs(sessionFile, root, 7, 'constructor', true)),
  );
  const inheritedOwnNamePayload = JSON.parse(inheritedOwnNameStdout);
  assert.equal(inheritedOwnNamePayload.created, false);
  assert.equal(inheritedOwnNamePayload.existing, true);
  assert.equal(inheritedOwnNamePayload.checkOnly, true);

  const racedStdout = await captureStdout(() =>
    buildProgram().parseAsync(cliArgs(sessionFile, root, 7, 'raced')),
  );
  const racedPayload = JSON.parse(racedStdout);
  assert.equal(racedPayload.ok, true);
  assert.equal(racedPayload.created, false);
  assert.equal(racedPayload.existing, true);
  assert.equal(racedPayload.raced, true);
  assert.equal(typeof racedPayload.snapshot, 'string');
  assert.deepEqual(
    calls.map((call) => [call.method, call.kind]),
    [
      ['/api/getVarList', 'read'],
      ['/api/getVarList', 'read'],
      ['/api/getVarList', 'read'],
      ['/api/getVarList', 'read'],
      ['/api/getDevList', 'read'],
      ['/api/getGraphList', 'read'],
      ['/api/getVarScopeList', 'read'],
      ['/api/createVar', 'write'],
      ['/api/getVarList', 'read'],
      ['/api/getVarList', 'read'],
      ['/api/getDevList', 'read'],
      ['/api/getGraphList', 'read'],
      ['/api/getVarScopeList', 'read'],
      ['/api/createVar', 'write'],
      ['/api/getVarList', 'read'],
    ],
  );
});
