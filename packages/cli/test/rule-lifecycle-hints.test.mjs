import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createIpcServer } from '@eyaeya/xgg-core';
import { buildNextSteps } from '../dist/agent-hints.js';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const baseUrl = 'http://rule-lifecycle-hints.test';
const agentStartedAt = '2026-07-19T00:00:00.000Z';

const position = (width, height) => ({ x: 0, y: 0, width, height });

function graph(id, connected) {
  return {
    id,
    nodes: [
      {
        id: 'source',
        type: 'onLoad',
        cfg: { pos: position(200, 120), name: 'onLoad', version: 1 },
        inputs: {},
        outputs: { output: connected ? ['sink.trigger'] : [] },
        props: {},
      },
      {
        id: 'sink',
        type: 'deviceOutput',
        cfg: {
          urn: 'urn:miot-spec-v2:device:light:0000A001:lifecycle-hints:1',
          pos: position(684, 204),
          name: 'deviceOutput',
          version: 1,
        },
        inputs: { trigger: null },
        outputs: { output: [] },
        props: { did: 'light-did', siid: 2, piid: 1, value: true },
      },
    ],
  };
}

function warningGraph(id) {
  return {
    id,
    nodes: [
      {
        id: 'repeat',
        type: 'delay',
        cfg: {
          pos: position(320, 120),
          name: 'delay',
          version: 1,
          unit: 's',
          value: 1,
        },
        inputs: { input: null },
        outputs: { output: ['repeat.input'] },
        props: { timeout: 1_000 },
      },
    ],
  };
}

function ruleSummary(id) {
  return {
    id,
    enable: false,
    uiType: 'test',
    userData: {
      name: id,
      transform: { x: 0, y: 0, scale: 1, rotate: 0 },
      lastUpdateTime: 0,
      version: 0,
    },
  };
}

function endpointPath(root) {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\xgg-rule-hints-${process.pid}-${randomUUID()}`;
  }
  return join(root, 'agent.sock');
}

async function startFakeAgent(t) {
  const root = await mkdtemp(join(tmpdir(), 'xgg-rule-lifecycle-hints-'));
  const socketPath = endpointPath(root);
  const calls = [];
  const graphs = new Map([
    ['connected', graph('connected', true)],
    ['disconnected', graph('disconnected', false)],
    ['warning', warningGraph('warning')],
  ]);
  const control = { listedRuleIds: ['connected'] };
  const server = await createIpcServer({
    path: socketPath,
    handler: async ({ method, params }) => {
      if (method === '$ping') return { host: baseUrl, agentStartedAt };
      calls.push({ method, params });
      if (method === '/api/getDevList') return { devList: {} };
      if (method === '/api/getGraphList') {
        return control.listedRuleIds.map(ruleSummary);
      }
      if (method === '/api/getGraph') {
        const current = graphs.get(params.id);
        if (current === undefined) throw new Error(`unknown graph: ${params.id}`);
        return current;
      }
      if (method === '/api/getVarList') return {};
      throw new Error(`unexpected RPC: ${method}`);
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

  t.after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  return { calls, control, root, sessionFile };
}

function runCli(args, agent, input) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      XGG_AGENT_MODE: '0',
      XGG_BASE_URL: baseUrl,
      XGG_NO_NEXT_HINT: '0',
      XGG_NO_REFRESH_HINT: '1',
      XGG_SESSION_FILE: agent.sessionFile,
      XGG_SNAPSHOTS_DIR: '',
    };
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: packageRoot,
      env,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
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
    if (input !== undefined) child.stdin.end(input);
    child.once('error', reject);
    child.once('close', (status, signal) =>
      resolve({ status, signal, stdout, stderr, payload: JSON.parse(stdout) }),
    );
  });
}

function assertOnlyHint(result, status, command) {
  assert.equal(result.status, status, result.stderr);
  assert.equal(result.signal, null);
  assert.deepEqual(
    result.payload.nextSteps?.map((step) => step.cmd),
    [command],
  );
  assert.match(result.stderr, /next →/);
  assert.match(result.stderr, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

function assertNoHint(result, status) {
  assert.equal(result.status, status, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(Object.hasOwn(result.payload, 'nextSteps'), false);
  assert.doesNotMatch(result.stderr, /next →/);
}

test('live validate routes both connected and disconnected clean graphs only to strict lint', async (t) => {
  const agent = await startFakeAgent(t);

  for (const id of ['connected', 'disconnected']) {
    const result = await runCli(['rule', 'validate', '--rule-id', id], agent);
    assert.equal(result.payload.summary.errors, 0);
    assert.equal(result.payload.summary.warnings, 0);
    assertOnlyHint(result, 0, `xgg rule lint --rule-id ${id} --strict`);
    assert.doesNotMatch(result.stderr, /xgg rule enable/);
  }
});

test('only a clean single-rule strict lint suggests enable', async (t) => {
  const agent = await startFakeAgent(t);

  const advisoryClean = await runCli(['rule', 'lint', '--rule-id', 'connected'], agent);
  assertOnlyHint(advisoryClean, 0, 'xgg rule lint --rule-id connected --strict');

  const strictClean = await runCli(['rule', 'lint', '--rule-id', 'connected', '--strict'], agent);
  assertOnlyHint(strictClean, 0, 'xgg rule enable connected');

  const advisoryDisconnected = await runCli(['rule', 'lint', '--rule-id', 'disconnected'], agent);
  assert.equal(advisoryDisconnected.payload.summary.errors, 0);
  assert.equal(advisoryDisconnected.payload.summary.warnings, 0);
  assertOnlyHint(advisoryDisconnected, 0, 'xgg rule lint --rule-id disconnected --strict');

  const advisoryWarning = await runCli(['rule', 'lint', '--rule-id', 'warning'], agent);
  assert.equal(advisoryWarning.payload.summary.warnings > 0, true);
  assertNoHint(advisoryWarning, 1);

  const strictWarning = await runCli(['rule', 'lint', '--rule-id', 'warning', '--strict'], agent);
  assert.equal(strictWarning.payload.summary.errors > 0, true);
  assertNoHint(strictWarning, 2);

  const strictError = await runCli(
    ['rule', 'lint', '--rule-id', 'disconnected', '--strict'],
    agent,
  );
  assert.equal(strictError.payload.summary.errors > 0, true);
  assertNoHint(strictError, 2);
});

test('clean --all lint never suggests enabling an arbitrary rule', async (t) => {
  const agent = await startFakeAgent(t);
  agent.control.listedRuleIds = ['connected'];

  assertNoHint(await runCli(['rule', 'lint', '--all'], agent), 0);
  assertNoHint(await runCli(['rule', 'lint', '--all', '--strict'], agent), 0);
});

test('offline --body and --stdin validation never suggests a live lint or enable', async (t) => {
  const agent = await startFakeAgent(t);
  const offline = graph('offline-rule-id', true);
  const bodyPath = join(agent.root, 'offline-graph.json');
  await writeFile(bodyPath, JSON.stringify(offline));
  const callsBefore = agent.calls.length;

  assertNoHint(await runCli(['rule', 'validate', '--body', bodyPath], agent), 0);
  assertNoHint(await runCli(['rule', 'validate', '--stdin'], agent, JSON.stringify(offline)), 0);
  assert.equal(agent.calls.length, callsBefore, 'offline validation unexpectedly used gateway IPC');
});

test('validation and lint issue summaries have no loop or enable hints', () => {
  const result = { ruleId: 'r', summary: { errors: 0, warnings: 0 } };
  const issueSummaries = [
    { errors: 1, warnings: 0 },
    { errors: 0, warnings: 1 },
    { errors: 1, warnings: 1 },
  ];

  for (const summary of issueSummaries) {
    assert.deepEqual(buildNextSteps('rule.validate', { ...result, summary }, { ruleId: 'r' }), []);
    assert.deepEqual(buildNextSteps('rule.lint', { ...result, summary }, { ruleId: 'r' }), []);
    assert.deepEqual(
      buildNextSteps('rule.lint', { ...result, summary }, { ruleId: 'r', strict: true }),
      [],
    );
  }
});

test('set and import authoring hints cannot bypass the strict lint funnel', () => {
  const result = { id: 'r', ruleId: 'r' };
  const setHints = buildNextSteps('rule.set', result, {});
  const importHints = buildNextSteps('rule.import', result, {});

  assert.deepEqual(
    setHints.map((hint) => hint.cmd),
    ['xgg rule lint --rule-id r --strict'],
  );
  assert.deepEqual(
    importHints.map((hint) => hint.cmd),
    ['xgg rule validate --rule-id r'],
  );
  for (const hint of [...setHints, ...importHints]) {
    assert.doesNotMatch(hint.cmd, /xgg rule enable/);
  }
});
