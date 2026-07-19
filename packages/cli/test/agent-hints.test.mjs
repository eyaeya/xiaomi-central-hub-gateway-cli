import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createIpcServer, modeledNodePinNames } from '@eyaeya/xgg-core';
import { buildNextSteps } from '../dist/agent-hints.js';

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const baseUrl = 'http://agent-hints.test';
const agentStartedAt = '2026-07-19T05:00:00.000Z';

const modeledNodeTypes = [
  { type: 'deviceInput', inputs: [], outputs: ['output'], source: 'event' },
  { type: 'deviceGet', inputs: ['input'], outputs: ['output', 'output2'] },
  { type: 'deviceOutput', inputs: ['trigger'], outputs: ['output'] },
  { type: 'alarmClock', inputs: [], outputs: ['output'], source: 'event' },
  { type: 'timeRange', inputs: [], outputs: ['output'], source: 'event' },
  { type: 'delay', inputs: ['input'], outputs: ['output'] },
  { type: 'statusLast', inputs: ['input'], outputs: ['output'] },
  { type: 'condition', inputs: ['trigger', 'condition'], outputs: ['met', 'unmet'] },
  { type: 'loop', inputs: ['start', 'stop'], outputs: ['output'] },
  { type: 'onlyNTimes', inputs: ['input', 'zero'], outputs: ['output'] },
  { type: 'counter', inputs: ['input', 'zero'], outputs: ['output'] },
  { type: 'signalOr', inputs: ['input0', 'input1'], outputs: ['output'] },
  { type: 'logicOr', inputs: ['input0', 'input1'], outputs: ['output'] },
  { type: 'logicAnd', inputs: ['input0', 'input1'], outputs: ['output'] },
  { type: 'logicNot', inputs: ['input'], outputs: ['output'] },
  { type: 'onLoad', inputs: [], outputs: ['output'], source: 'event' },
  { type: 'eventSequence', inputs: ['input1', 'input2'], outputs: ['output'] },
  { type: 'register', inputs: ['setTrue', 'setFalse'], outputs: ['output'] },
  { type: 'modeSwitch', inputs: ['input'], outputs: ['output0', 'output1'] },
  { type: 'deviceInputSetVar', inputs: [], outputs: ['output'], source: 'event' },
  { type: 'deviceGetSetVar', inputs: ['input'], outputs: ['output'] },
  { type: 'varChange', inputs: [], outputs: ['output'], source: 'event' },
  { type: 'varGet', inputs: ['input'], outputs: ['output', 'output2'] },
  { type: 'varSetNumber', inputs: ['input'], outputs: ['output'] },
  { type: 'varSetString', inputs: ['input'], outputs: ['output'] },
];

test('node-add hints follow the authoritative pin direction for all 25 modeled types', () => {
  assert.equal(modeledNodeTypes.length, 25);
  assert.equal(new Set(modeledNodeTypes.map(({ type }) => type)).size, 25);

  for (const expected of modeledNodeTypes) {
    assert.deepEqual(modeledNodePinNames(expected.type, 'input'), expected.inputs, expected.type);
    assert.deepEqual(modeledNodePinNames(expected.type, 'output'), expected.outputs, expected.type);

    const nodeId = `node-${expected.type}`;
    const hints = buildNextSteps(
      'rule.node.add',
      { nodeId, ruleId: 'rule-80', type: expected.type },
      { type: expected.type, varScope: 'global', varId: 'marker' },
    );
    const edgeHint = hints.find(({ cmd }) => cmd.startsWith('xgg rule edge add '));

    if (expected.source === 'event') {
      assert.equal(edgeHint, undefined, `${expected.type} must not receive an incoming edge hint`);
      assert.ok(
        hints.some(({ cmd }) => cmd.startsWith('xgg rule node add ')),
        `${expected.type} should lead to adding a downstream action`,
      );
      continue;
    }

    assert.ok(edgeHint, `${expected.type} should emit an edge hint`);
    assert.doesNotMatch(edgeHint.cmd, /<thisNode>/, expected.type);
    if (expected.source === 'state') {
      assert.match(edgeHint.cmd, new RegExp(`--from ${nodeId}:${expected.outputs[0]}(?: |$)`));
      assert.doesNotMatch(edgeHint.cmd, new RegExp(`--to ${nodeId}:`));
      continue;
    }

    assert.ok(expected.inputs.length > 0, `${expected.type} needs a modeled input`);
    assert.match(edgeHint.cmd, new RegExp(`--to ${nodeId}:${expected.inputs[0]}(?: |$)`));
  }
});

test('unknown node types preserve explicit placeholders instead of guessed pin semantics', () => {
  assert.equal(modeledNodePinNames('futureCard', 'input'), undefined);
  assert.deepEqual(
    buildNextSteps(
      'rule.node.add',
      { nodeId: 'future', ruleId: 'rule-80', type: 'futureCard' },
      { type: 'futureCard' },
    ),
    [
      {
        cmd: 'xgg rule edge add --rule-id rule-80 --from <upstream>:<pin> --to future:<pin>',
        why: 'wire this node into the existing graph before adding more',
        lifecycle: 'drafting → wiring',
      },
    ],
  );
});

function endpointPath(root) {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\xgg-agent-hints-${process.pid}-${randomUUID()}`;
  }
  return join(root, 'agent.sock');
}

async function startFakeAgent(t) {
  const root = await mkdtemp(join(tmpdir(), 'xgg-agent-hints-'));
  const socketPath = endpointPath(root);
  const sessionFile = join(root, 'session.json');
  const writes = [];
  const state = {
    summary: {
      id: 'rule-80',
      enable: false,
      uiType: 'test',
      userData: {
        name: 'Issue 80',
        transform: { x: 0, y: 0, scale: 1, rotate: 0 },
        lastUpdateTime: 0,
        version: 0,
      },
    },
    nodes: [
      {
        id: 'source',
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

  const server = await createIpcServer({
    path: socketPath,
    handler: async (request) => {
      switch (request.method) {
        case '$ping':
          return { host: baseUrl, agentStartedAt };
        case '/api/getGraphList':
          return [structuredClone(state.summary)];
        case '/api/getGraph':
          return { id: 'rule-80', nodes: structuredClone(state.nodes) };
        case '/api/setGraph': {
          const graph = request.params;
          assert.equal(graph.id, 'rule-80');
          state.summary = structuredClone(graph.cfg);
          state.nodes = structuredClone(graph.nodes);
          writes.push(structuredClone(graph));
          return {};
        }
        default:
          throw new Error(`unexpected fake gateway method: ${request.method}`);
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
    await rm(root, { force: true, recursive: true });
  });
  return { sessionFile, state, writes };
}

function runCli(args, agent) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: {
        ...process.env,
        XGG_AGENT_MODE: '0',
        XGG_BASE_URL: baseUrl,
        XGG_NO_NEXT_HINT: '0',
        XGG_NO_REFRESH_HINT: '1',
        XGG_SESSION_FILE: agent.sessionFile,
        XGG_SNAPSHOTS_DIR: '',
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
    child.once('close', (status, signal) => resolvePromise({ status, signal, stdout, stderr }));
  });
}

test('deviceOutput process hint names trigger and its follow-up edge succeeds', async (t) => {
  const agent = await startFakeAgent(t);
  const cfg = JSON.stringify({
    cfg: {
      urn: 'urn:miot-spec-v2:device:light:0000A001:issue80:1',
      pos: { x: 240, y: 0, width: 684, height: 204 },
      name: 'deviceOutput',
      version: 1,
    },
    inputs: { trigger: null },
    outputs: { output: [] },
    props: { did: 'light-did', siid: 2, piid: 1, value: true },
  });
  const addResult = await runCli(
    [
      'rule',
      'node',
      'add',
      '--rule-id',
      'rule-80',
      '--type',
      'deviceOutput',
      '--id',
      'sink',
      '--cfg',
      cfg,
      '--no-snapshot',
      '--no-var-check',
    ],
    agent,
  );

  assert.equal(addResult.status, 0, addResult.stderr);
  assert.equal(addResult.signal, null);
  const addPayload = JSON.parse(addResult.stdout);
  assert.equal(addPayload.nodeId, 'sink');
  assert.equal(addPayload.nextSteps.length, 1);
  const followUp = addPayload.nextSteps[0].cmd;
  assert.equal(
    followUp,
    'xgg rule edge add --rule-id rule-80 --from <trigger>:output --to sink:trigger',
  );
  assert.match(addResult.stderr, /--to sink:trigger/);
  assert.doesNotMatch(addResult.stderr, /--to (?:<thisNode>|sink):input/);
  assert.equal(agent.writes.length, 1);

  const followArgs = followUp
    .replace('<trigger>', 'source')
    .slice('xgg '.length)
    .split(' ')
    .concat('--no-snapshot', '--no-var-check');
  const edgeResult = await runCli(followArgs, agent);

  assert.equal(edgeResult.status, 0, edgeResult.stderr);
  assert.equal(edgeResult.signal, null);
  const edgePayload = JSON.parse(edgeResult.stdout);
  assert.equal(edgePayload.edgeString, 'sink.trigger');
  assert.equal(agent.writes.length, 2);
  assert.deepEqual(agent.state.nodes[0].outputs.output, ['sink.trigger']);
});
