import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createIpcServer } from '@eyaeya/xgg-core';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const baseUrl = 'http://rule-logs-output.test';
const ruleId = 'rule-logs-output';
const agentStartedAt = '2026-07-20T00:00:00.000Z';

function endpointPath(root) {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\xgg-rule-logs-${process.pid}-${randomUUID()}`;
  }
  return join(root, 'agent.sock');
}

test('follow JSON emits one initial envelope followed by NDJSON entries', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'xgg-rule-logs-output-'));
  const socketPath = endpointPath(root);
  const initialLine = `3|1000|i|${ruleId}|initial|success`;
  const freshLine = `3|2000|i|${ruleId}|fresh|success`;
  let logCalls = 0;
  const server = await createIpcServer({
    path: socketPath,
    handler: async ({ method, params }) => {
      if (method === '$ping') return { host: baseUrl, agentStartedAt };
      if (method !== '/api/getLog') throw new Error(`unexpected RPC: ${method}`);
      assert.deepEqual(params, { num: 0 });
      logCalls += 1;
      return logCalls === 1 ? initialLine : `${initialLine}\n${freshLine}`;
    },
  });
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
          agentStartedAt,
          agentVersion: 'test',
          lastValidatedAt: agentStartedAt,
        },
      },
    }),
    { mode: 0o600 },
  );

  const child = spawn(
    process.execPath,
    [
      cliPath,
      'rule',
      'logs',
      ruleId,
      '--follow',
      '--json',
      '--tail',
      '1',
      '--interval-ms',
      '10',
      '--max-blocks',
      '1',
      '--base-url',
      baseUrl,
      '--session-file',
      sessionFile,
      '--no-next-hint',
    ],
    {
      cwd: packageRoot,
      env: {
        ...process.env,
        XGG_AGENT_MODE: '0',
        XGG_NO_REFRESH_HINT: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdout = '';
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const closeResult = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ signal, status }));
  });
  const lines = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out waiting for follow JSON output: ${stderr}`));
    }, 5_000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const complete = stdout.split('\n').filter((line) => line.length > 0);
      if (complete.length < 2) return;
      clearTimeout(timer);
      resolve(complete.slice(0, 2));
    });
  });

  child.kill('SIGINT');
  const closed = await closeResult;
  assert.equal(closed.signal, 'SIGINT');
  assert.equal(closed.status, null);
  assert.equal(stderr, '');
  assert.equal(logCalls >= 2, true);

  const initial = JSON.parse(lines[0]);
  assert.equal(initial.ok, true);
  assert.equal(initial.count, 1);
  assert.equal(initial.entries.length, 1);
  assert.equal(initial.entries[0].nodeId, 'initial');

  const fresh = JSON.parse(lines[1]);
  assert.equal(fresh.nodeId, 'fresh');
  assert.equal(Object.hasOwn(fresh, 'ok'), false);
  assert.equal(Object.hasOwn(fresh, 'entries'), false);
});
