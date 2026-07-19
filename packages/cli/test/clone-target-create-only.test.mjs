import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createIpcServer } from '@eyaeya/xgg-core';
import { buildProgram } from '../dist/program.js';

const baseUrl = 'http://gateway.invalid';
const targetId = '456';
const startedAt = '2026-07-19T00:00:00.000Z';

function summary(name = 'existing target') {
  return {
    id: targetId,
    enable: false,
    uiType: 'test',
    userData: {
      name,
      transform: { x: 0, y: 0, scale: 1, rotate: 0 },
      lastUpdateTime: 1,
      version: 0,
    },
  };
}

function existingNode() {
  return {
    id: 'existing-node',
    type: 'onLoad',
    cfg: {
      pos: { x: 0, y: 0, width: 200, height: 120 },
      name: 'onLoad',
      version: 1,
    },
    inputs: {},
    outputs: { output: [] },
    props: {},
  };
}

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

async function fakeAgent(t, mode) {
  // Keep the Unix-domain socket below macOS's short sun_path limit even when
  // the test mode name grows.
  const root = await mkdtemp(join(tmpdir(), 'xgg-clone-'));
  const socketPath = join(root, 'agent.sock');
  const sessionFile = join(root, 'session.json');
  const bodyFile = join(root, 'body.json');
  const snapshotsDir = join(root, 'snapshots');
  const calls = [];
  let graphListReads = 0;
  const state = { cfg: summary(), nodes: [existingNode()] };
  if (mode === 'in-place-enabled') state.cfg.enable = true;
  const server = await createIpcServer({
    path: socketPath,
    handler: async ({ method, params, kind }) => {
      if (method === '$ping') return { host: baseUrl, agentStartedAt: startedAt };
      calls.push({ method, params: structuredClone(params), kind });
      if (method === '/api/getDevList') return { devList: {} };
      if (method === '/api/getGraphList') {
        graphListReads += 1;
        const visible =
          mode === 'existing' ||
          mode === 'in-place' ||
          mode === 'in-place-enabled' ||
          (mode === 'late' && graphListReads > 1);
        return visible ? [structuredClone(state.cfg)] : [];
      }
      if (method === '/api/getGraph') {
        return { id: targetId, nodes: structuredClone(state.nodes) };
      }
      if (method === '/api/getVarScopeList') return { scopes: [] };
      if (method === '/api/getVarList') return {};
      if (method === '/api/setGraph') {
        state.cfg = structuredClone(params.cfg);
        state.nodes = structuredClone(params.nodes);
        return null;
      }
      throw new Error(`unexpected fake RPC ${method}`);
    },
  });
  t.after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
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
          agentVersion: '0.1.4',
          lastValidatedAt: startedAt,
        },
      },
    }),
    { mode: 0o600 },
  );
  await writeFile(
    bodyFile,
    JSON.stringify({
      id: targetId,
      nodes: [],
      cfg: summary(mode === 'in-place' ? 'replacement body' : 'clone body'),
    }),
    { mode: 0o600 },
  );
  return { bodyFile, calls, sessionFile, snapshotsDir, state };
}

function args(agent, expectAbsent = true, allowCfgOverwrite = false) {
  return [
    'node',
    'xgg',
    'rule',
    'set',
    '--body',
    agent.bodyFile,
    ...(expectAbsent ? ['--expect-absent'] : []),
    ...(allowCfgOverwrite ? ['--allow-cfg-overwrite'] : []),
    '--base-url',
    baseUrl,
    '--session-file',
    agent.sessionFile,
    '--snapshots-dir',
    agent.snapshotsDir,
    '--no-next-hint',
    '--no-refresh-hint',
  ];
}

for (const mode of ['existing', 'late']) {
  const article = mode === 'existing' ? 'an' : 'a';
  test(`rule set --expect-absent leaves ${article} ${mode} target unchanged with zero write RPCs`, async (t) => {
    const agent = await fakeAgent(t, mode);
    const before = structuredClone(agent.state);

    await assert.rejects(
      buildProgram().parseAsync(args(agent)),
      (error) =>
        error?.code === 'CONFIG' &&
        /already exists; create-only replay will not overwrite it/.test(error.message),
    );

    assert.deepEqual(agent.state, before);
    assert.equal(
      agent.calls.some((call) => call.kind === 'write'),
      false,
    );
    assert.equal(
      agent.calls.some((call) => call.method === '/api/setGraph'),
      false,
    );
    assert.equal(agent.calls.filter((call) => call.method === '/api/getGraphList').length, 2);
  });
}

test('rule set --expect-absent creates an absent target once', async (t) => {
  const agent = await fakeAgent(t, 'absent');
  agent.state.nodes = [];
  const stdout = await captureStdout(() => buildProgram().parseAsync(args(agent)));
  const payload = JSON.parse(stdout);

  assert.equal(payload.ok, true);
  assert.equal(payload.id, targetId);
  assert.equal(payload.cfgPreserved, false);
  assert.equal(agent.calls.filter((call) => call.method === '/api/setGraph').length, 1);
  assert.deepEqual(
    agent.calls.filter((call) => call.kind === 'write').map((call) => call.method),
    ['/api/setGraph'],
  );
});

test('rule set without --expect-absent preserves same-id in-place replay semantics', async (t) => {
  const agent = await fakeAgent(t, 'in-place');
  const stdout = await captureStdout(() => buildProgram().parseAsync(args(agent, false)));
  const payload = JSON.parse(stdout);

  assert.equal(payload.ok, true);
  assert.equal(payload.id, targetId);
  assert.equal(payload.cfgPreserved, true);
  assert.deepEqual(agent.state.nodes, []);
  assert.equal(agent.calls.filter((call) => call.method === '/api/setGraph').length, 1);
});

test('rule set --allow-cfg-overwrite atomically stages an existing enabled target as disabled', async (t) => {
  const agent = await fakeAgent(t, 'in-place-enabled');
  assert.equal(agent.state.cfg.enable, true);

  const stdout = await captureStdout(() => buildProgram().parseAsync(args(agent, false, true)));
  const payload = JSON.parse(stdout);

  assert.equal(payload.ok, true);
  assert.equal(payload.id, targetId);
  assert.equal(payload.cfgPreserved, false);
  assert.equal(agent.state.cfg.enable, false);
  assert.equal(agent.state.cfg.userData.name, 'clone body');
  const writes = agent.calls.filter((call) => call.method === '/api/setGraph');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].params.cfg.enable, false);
  assert.deepEqual(writes[0].params.nodes, []);
});
