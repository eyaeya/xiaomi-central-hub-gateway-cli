import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createIpcServer } from '@eyaeya/xgg-core';
import { buildProgram } from '../dist/program.js';
import {
  isKnownScopeForLiveRules,
  isKnownScopeForRule,
  ruleLocalVariableScope,
  warnIfUnknownRuleNodeScope,
} from '../dist/variable-scope-awareness.js';

const baseUrl = 'http://rule-local-scope.invalid';
const startedAt = '2026-07-19T00:00:00.000Z';

function summary(id) {
  return {
    id,
    enable: false,
    uiType: 'rule',
    userData: {
      name: `rule ${id}`,
      transform: { x: 0, y: 0, scale: 1, rotate: 0 },
      lastUpdateTime: 0,
      version: 0,
    },
  };
}

async function fakeAgent(t) {
  const root = await mkdtemp(join(tmpdir(), 'xgg-rule-local-scope-'));
  const socketPath = join(root, 'agent.sock');
  const sessionFile = join(root, 'session.json');
  const calls = [];
  const server = await createIpcServer({
    path: socketPath,
    handler: async ({ method, params }) => {
      if (method === '$ping') return { host: baseUrl, agentStartedAt: startedAt };
      calls.push({ method, params });
      if (method === '/api/getGraphList') return [summary('123')];
      if (method === '/api/getVarList') return {};
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
          agentVersion: '0.1.4',
          lastValidatedAt: startedAt,
        },
      },
    }),
  );
  t.after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  return { calls, root, sessionFile };
}

async function captureIo(fn) {
  const stdout = [];
  const stderr = [];
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  process.stdout.write = (chunk) => {
    stdout.push(String(chunk));
    return true;
  };
  process.stderr.write = (chunk) => {
    stderr.push(String(chunk));
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
  return { stdout: stdout.join(''), stderr: stderr.join('') };
}

function variableCreateArgs(agent, scope) {
  return [
    'node',
    'xgg',
    'variable',
    'create',
    '--scope',
    scope,
    '--id',
    'probe',
    '--type',
    'number',
    '--value',
    '0',
    '--name',
    'Probe',
    '--if-compatible',
    '--check-only',
    '--base-url',
    baseUrl,
    '--session-file',
    agent.sessionFile,
    '--snapshots-dir',
    agent.root,
    '--no-next-hint',
    '--no-refresh-hint',
  ];
}

test('scope classification distinguishes global, current local, live local, and foreign scopes', () => {
  assert.equal(ruleLocalVariableScope('123'), 'R123');
  assert.equal(isKnownScopeForRule('global', '123'), true);
  assert.equal(isKnownScopeForRule('R123', '123'), true);
  assert.equal(isKnownScopeForRule('R999', '123'), false);
  assert.equal(isKnownScopeForLiveRules('R123', [summary('123')]), true);
  assert.equal(isKnownScopeForLiveRules('R999', [summary('123')]), false);
  assert.equal(isKnownScopeForLiveRules('custom', [summary('custom')]), false);
});

test('rule node scope warnings accept only global and the current rule-local scope', async () => {
  const known = await captureIo(() => {
    warnIfUnknownRuleNodeScope({
      commandType: 'varChange',
      scope: 'global',
      ruleId: '123',
      allowUnknownScope: false,
    });
    warnIfUnknownRuleNodeScope({
      commandType: 'varChange',
      scope: 'R123',
      ruleId: '123',
      allowUnknownScope: false,
    });
  });
  assert.equal(known.stderr, '');

  const foreign = await captureIo(() => {
    warnIfUnknownRuleNodeScope({
      commandType: 'varChange',
      scope: 'R999',
      ruleId: '123',
      allowUnknownScope: false,
    });
  });
  assert.match(foreign.stderr, /not visible to rule 123/);
  assert.match(foreign.stderr, /"global" or its current rule-local scope "R123"/);
});

test('variable create recognizes a live R<rule-id> without suppression and warns for a missing rule', async (t) => {
  const agent = await fakeAgent(t);

  const local = await captureIo(() => buildProgram().parseAsync(variableCreateArgs(agent, 'R123')));
  assert.equal(local.stderr, '');
  assert.equal(JSON.parse(local.stdout).scope, 'R123');
  assert.deepEqual(
    agent.calls.map((call) => call.method),
    ['/api/getGraphList', '/api/getVarList'],
  );

  agent.calls.length = 0;
  const global = await captureIo(() =>
    buildProgram().parseAsync(variableCreateArgs(agent, 'global')),
  );
  assert.equal(global.stderr, '');
  assert.deepEqual(
    agent.calls.map((call) => call.method),
    ['/api/getVarList'],
  );

  agent.calls.length = 0;
  const foreign = await captureIo(() =>
    buildProgram().parseAsync(variableCreateArgs(agent, 'R999')),
  );
  assert.match(foreign.stderr, /does not correspond to a live rule id "999"/);
  assert.deepEqual(
    agent.calls.map((call) => call.method),
    ['/api/getGraphList', '/api/getVarList'],
  );
});

test('CLI help documents current-rule local scopes and the raw-only escape hatch', () => {
  const program = buildProgram();
  const rule = program.commands.find((command) => command.name() === 'rule');
  const node = rule?.commands.find((command) => command.name() === 'node');
  const add = node?.commands.find((command) => command.name() === 'add');
  assert.ok(add);
  let help = '';
  add.configureOutput({
    writeOut: (chunk) => {
      help += chunk;
    },
  });
  add.outputHelp();
  assert.match(help, /global or this rule's R<rule-id>/);
  assert.match(help, /--var-scope R123/);
  assert.match(help, /raw experiments only/);
});
