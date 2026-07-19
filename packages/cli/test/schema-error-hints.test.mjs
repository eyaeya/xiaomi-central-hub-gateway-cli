import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { SchemaError, createIpcServer } from '@eyaeya/xgg-core';
import { formatErrorJson } from '../dist/errors.js';

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const baseUrl = 'http://schema-error-hints.test';
const agentStartedAt = '2026-07-19T08:00:00.000Z';

const commandCases = [
  {
    name: 'add',
    command: 'rule.node.add',
    args: [
      'rule',
      'node',
      'add',
      '--rule-id',
      'issue91',
      '--type',
      'onLoad',
      '--no-snapshot',
      '--no-var-check',
    ],
  },
  {
    name: 'update',
    command: 'rule.node.update',
    args: [
      'rule',
      'node',
      'update',
      '--rule-id',
      'issue91',
      '--node-id',
      'node1',
      '--patch',
      '{"cfg":{"name":"updated"}}',
      '--no-snapshot',
      '--no-var-check',
    ],
  },
];

const ruleSummary = {
  id: 'issue91',
  userData: {
    name: 'Issue 91',
    transform: { x: 0, y: 0, scale: 1, rotate: 0 },
    lastUpdateTime: 0,
    version: 0,
  },
  uiType: 'test',
  enable: false,
};

const currentGraph = {
  id: 'issue91',
  nodes: [
    {
      id: 'node1',
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

function endpointPath(root) {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\xgg-schema-hints-${process.pid}-${randomUUID()}`;
  }
  return join(root, 'agent.sock');
}

async function startFakeAgent(t) {
  const root = await mkdtemp(join(tmpdir(), 'xgg-schema-hints-'));
  const socketPath = endpointPath(root);
  const sessionFile = join(root, 'session.json');
  const frames = [];
  const control = {
    ruleListResponse: structuredClone([ruleSummary]),
    ruleGetResponse: structuredClone(currentGraph),
  };
  const server = await createIpcServer({
    path: socketPath,
    handler: async (request) => {
      frames.push(request);
      if (request.method === '$ping') return { host: baseUrl, agentStartedAt };
      if (request.method === '/api/getGraphList') {
        return structuredClone(control.ruleListResponse);
      }
      if (request.method === '/api/getGraph') return structuredClone(control.ruleGetResponse);
      throw new Error(`unexpected fake gateway method: ${request.method}`);
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
  return { control, frames, root, sessionFile };
}

function runCli(args, agent, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: {
        ...process.env,
        XGG_AGENT_MODE: '0',
        XGG_BASE_URL: baseUrl,
        XGG_NO_NEXT_HINT: '1',
        XGG_NO_REFRESH_HINT: '1',
        ...(agent?.sessionFile !== undefined && { XGG_SESSION_FILE: agent.sessionFile }),
        ...env,
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

function assertSchemaFailure(result, expectedMessage) {
  assert.equal(result.status, 4, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, '');
  const lines = result.stderr.trimEnd().split('\n');
  assert.equal(lines.length, 1, result.stderr);
  const payload = JSON.parse(lines[0]);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'SCHEMA');
  if (expectedMessage instanceof RegExp) {
    assert.match(payload.error.message, expectedMessage);
  } else {
    assert.equal(payload.error.message, expectedMessage);
  }
  return payload;
}

function recoveryCommands(hint) {
  return [...hint.matchAll(/`(xgg [^`]+)`/g)].map((match) => match[1]);
}

async function assertCommandSurfacesAccepted(commands) {
  for (const command of commands) {
    const args = command
      .split(/\s+/)
      .slice(1)
      .map((part) => (/^<[^>]+>$/.test(part) ? 'fixture' : part));
    if (!args.includes('--help')) args.push('--help');
    const result = await runCli(args);
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
    assert.equal(result.signal, null, command);
    assert.equal(result.stderr, '', command);
    assert.match(result.stdout, /Usage: xgg /, command);
  }
}

function publicSchemaError(command, message) {
  const error = new SchemaError(message, { zodErrors: [] });
  error.__xggCmd = command;
  return formatErrorJson(error);
}

test('only exact node parse failures receive node-authoring recovery commands', async () => {
  const cases = [
    {
      command: 'rule.node.add',
      message: 'AddNodeInput.node parse failed',
      expected: ['xgg rule node add --help'],
    },
    {
      command: 'rule.node.update',
      message: 'updateNode.merged parse failed',
      expected: ['xgg rule view <id>', 'xgg rule node update --help'],
    },
  ];

  for (const scenario of cases) {
    const payload = publicSchemaError(scenario.command, scenario.message);
    const commands = recoveryCommands(payload.error.hint);
    assert.deepEqual(commands, scenario.expected, scenario.command);
    assert.doesNotMatch(payload.error.hint, /--explain|--type <T>/, scenario.command);
    await assertCommandSurfacesAccepted(commands);

    const nearMiss = publicSchemaError(scenario.command, `${scenario.message} (extra context)`);
    assert.doesNotMatch(nearMiss.error.hint, /xgg rule node (?:add|update) --help/);
  }
});

test('malformed live rule responses use only read-only rule diagnostics', async (t) => {
  const agent = await startFakeAgent(t);
  const responseCases = [
    {
      name: 'list',
      message: 'RuleListResponse parse failed',
      configure: () => {
        agent.control.ruleListResponse = { malformed: true };
        agent.control.ruleGetResponse = structuredClone(currentGraph);
      },
      expectedMethod: '/api/getGraphList',
    },
    {
      name: 'view',
      message: 'RuleGetResponse parse failed',
      configure: () => {
        agent.control.ruleListResponse = structuredClone([ruleSummary]);
        agent.control.ruleGetResponse = { malformed: true };
      },
      expectedMethod: '/api/getGraph',
    },
  ];

  for (const response of responseCases) {
    response.configure();
    for (const command of commandCases) {
      agent.frames.length = 0;
      const payload = assertSchemaFailure(await runCli(command.args, agent), response.message);
      const commands = recoveryCommands(payload.error.hint);
      assert.deepEqual(commands, ['xgg rule list', 'xgg rule view <id>']);
      assert.doesNotMatch(payload.error.hint, /xgg rule node (?:add|update) --help/);
      assert.match(payload.error.hint, /live rule(?:-list| graph) response/);
      assert.ok(
        agent.frames.some(({ method }) => method === response.expectedMethod),
        `${command.name}/${response.name} did not reach ${response.expectedMethod}`,
      );
      await assertCommandSurfacesAccepted(commands);
    }
  }
});

test('corrupt sessions outrank every node and live-response hint', async (t) => {
  const agent = await startFakeAgent(t);
  const corruptSessionFile = join(agent.root, 'corrupt-session.json');
  await writeFile(corruptSessionFile, '{"version":2,"sessions":');

  for (const command of commandCases) {
    agent.frames.length = 0;
    const result = await runCli(command.args, agent, { XGG_SESSION_FILE: corruptSessionFile });
    const payload = assertSchemaFailure(result, /Session file at .* invalid JSON/);
    assert.match(payload.error.hint, /Preserve the local session file/);
    assert.match(payload.error.hint, /repair.*move the corrupt copy aside.*log in again/);
    assert.doesNotMatch(payload.error.hint, /xgg rule node|xgg rule view|live rule response/);
    assert.deepEqual(agent.frames, [], `${command.name} reached IPC with a corrupt session`);
  }
});
