import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createIpcServer } from '@eyaeya/xgg-core';
import { buildProgram } from '../dist/program.js';

const baseUrl = 'http://variable-string-value.test';
const startedAt = '2026-07-19T00:00:00.000Z';
const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

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
  return JSON.parse(chunks.join(''));
}

async function startFakeAgent(t) {
  const root = await mkdtemp(join(tmpdir(), 'xgg-variable-string-value-'));
  const socketPath = join(root, 'agent.sock');
  const sessionFile = join(root, 'session.json');
  const variables = new Map();
  const writes = [];
  const server = await createIpcServer({
    path: socketPath,
    handler: async ({ method, params, kind }) => {
      if (method === '$ping') return { host: baseUrl, agentStartedAt: startedAt };
      if (method === '/api/createVar') {
        writes.push({ method, params, kind });
        variables.set(params.id, structuredClone(params));
        return {};
      }
      if (method === '/api/getVarConfig') {
        const variable = variables.get(params.id);
        assert.ok(variable, `missing fake variable ${params.id}`);
        return { type: variable.type, value: variable.value, userData: variable.userData };
      }
      if (method === '/api/setVarValue') {
        writes.push({ method, params, kind });
        const variable = variables.get(params.id);
        assert.ok(variable, `missing fake variable ${params.id}`);
        variable.value = params.value;
        return {};
      }
      throw new Error(`unexpected RPC: ${method}`);
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
          agentStartedAt: startedAt,
          agentVersion: 'test',
          lastValidatedAt: startedAt,
        },
      },
    }),
    { mode: 0o600 },
  );
  t.after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  return { sessionFile, variables, writes };
}

function common(agent) {
  return [
    '--base-url',
    baseUrl,
    '--session-file',
    agent.sessionFile,
    '--no-snapshot',
    '--no-next-hint',
    '--no-refresh-hint',
  ];
}

async function create(agent, { id, type, value }) {
  return captureStdout(() =>
    buildProgram().parseAsync([
      'node',
      'xgg',
      'variable',
      'create',
      '--scope',
      'global',
      '--id',
      id,
      '--type',
      type,
      '--value',
      value,
      '--name',
      id,
      ...common(agent),
    ]),
  );
}

async function setValue(agent, { id, value }) {
  return captureStdout(() =>
    buildProgram().parseAsync([
      'node',
      'xgg',
      'variable',
      'set-value',
      '--scope',
      'global',
      '--id',
      id,
      '--value',
      value,
      ...common(agent),
    ]),
  );
}

test('variable create and set-value preserve string argv text and still convert numbers', async (t) => {
  const previousAgentMode = process.env.XGG_AGENT_MODE;
  process.env.XGG_AGENT_MODE = '0';
  t.after(() => {
    if (previousAgentMode === undefined) Reflect.deleteProperty(process.env, 'XGG_AGENT_MODE');
    else process.env.XGG_AGENT_MODE = previousAgentMode;
  });
  const agent = await startFakeAgent(t);

  assert.equal((await create(agent, { id: 'plain', type: 'string', value: 'Seed' })).value, 'Seed');
  assert.equal(
    (await create(agent, { id: 'quoted', type: 'string', value: '"Seed"' })).value,
    '"Seed"',
  );
  assert.equal((await create(agent, { id: 'number', type: 'number', value: '007' })).value, 7);

  assert.equal((await setValue(agent, { id: 'plain', value: 'Next' })).value, 'Next');
  assert.equal((await setValue(agent, { id: 'quoted', value: '"Next"' })).value, '"Next"');
  assert.equal((await setValue(agent, { id: 'number', value: '8.5' })).value, 8.5);

  assert.deepEqual(
    agent.writes.map(({ method, params, kind }) => ({ method, value: params.value, kind })),
    [
      { method: '/api/createVar', value: 'Seed', kind: 'write' },
      { method: '/api/createVar', value: '"Seed"', kind: 'write' },
      { method: '/api/createVar', value: 7, kind: 'write' },
      { method: '/api/setVarValue', value: 'Next', kind: 'write' },
      { method: '/api/setVarValue', value: '"Next"', kind: 'write' },
      { method: '/api/setVarValue', value: 8.5, kind: 'write' },
    ],
  );
});

test('variable help describes type-specific value handling without claiming JSON parsing', () => {
  for (const command of ['create', 'set-value']) {
    const result = spawnSync(process.execPath, [cliPath, 'variable', command, '--help'], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /JSON-parsed/i);
    assert.match(result.stdout, /number: numeric conversion/);
    assert.match(result.stdout, /string:\s+argv\s+text verbatim/);
  }
});
