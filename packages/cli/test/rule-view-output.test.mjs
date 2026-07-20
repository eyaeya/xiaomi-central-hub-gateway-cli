import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createIpcServer } from '@eyaeya/xgg-core';
import stringWidth from 'string-width';
import {
  RULE_VIEW_PRETTY_COLUMN_WIDTHS,
  summarizeRuleOutputs,
  summarizeRuleRecord,
  truncateDisplayText,
  wrapDisplayText,
} from '../dist/commands/rule/view.js';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const baseUrl = 'http://rule-view-output.test';
const ruleId = 'rule-view-output';
const agentStartedAt = '2026-07-20T00:00:00.000Z';
const position = (width, height) => ({ x: 0, y: 0, width, height });

const summary = {
  id: ruleId,
  enable: false,
  uiType: 'graph',
  userData: {
    name: 'Inspector',
    transform: { x: 0, y: 0, scale: 1, rotate: 0 },
    lastUpdateTime: 0,
    version: 0,
  },
};

const dynamicInputs = Object.fromEntries(
  Array.from({ length: 20 }, (_, index) => [`input${index}`, null]),
);

const modeledNodeTypes = [
  'deviceInput',
  'deviceGet',
  'deviceOutput',
  'alarmClock',
  'timeRange',
  'delay',
  'statusLast',
  'condition',
  'loop',
  'onlyNTimes',
  'counter',
  'signalOr',
  'logicOr',
  'logicAnd',
  'logicNot',
  'onLoad',
  'eventSequence',
  'register',
  'modeSwitch',
  'deviceInputSetVar',
  'deviceGetSetVar',
  'varChange',
  'varGet',
  'varSetNumber',
  'varSetString',
];

const nodes = [
  {
    id: 'time',
    type: 'timeRange',
    cfg: {
      pos: position(320, 216),
      name: 'T\u001b\u009b',
      version: 1,
    },
    inputs: {},
    outputs: { output: ['action.trigger'] },
    props: {
      start: { hour: 8, minute: 0, second: 0 },
      end: { hour: 22, minute: 30, second: 0 },
      filter: { day: [1, 2, 3, 4, 5] },
      mingTextShow: false,
    },
  },
  {
    id: 'variable',
    type: 'varChange',
    cfg: { pos: position(320, 120), name: 'Variable', version: 1 },
    inputs: {},
    outputs: { output: [] },
    props: {
      scope: 'global',
      id: 'temperature',
      varType: 'number',
      preload: false,
      operator: 'between',
      v1: 18,
      v2: 25,
    },
  },
  {
    id: 'comparison',
    type: 'deviceInput',
    cfg: {
      urn: 'urn:miot-spec-v2:device:sensor:0000A077:rule-view-test:1',
      pos: position(684, 204),
      name: 'Comparison',
      version: 1,
    },
    inputs: {},
    outputs: { output: ['action.trigger'] },
    props: {
      did: 'sensor-did',
      siid: 2,
      piid: 3,
      preload: false,
      dtype: 'int',
      operator: '=',
      v1: [1, 2, 3],
    },
  },
  {
    id: 'action',
    type: 'deviceOutput',
    cfg: {
      urn: 'urn:miot-spec-v2:device:light:0000A001:rule-view-test:1',
      pos: position(684, 204),
      name: 'Action',
      version: 1,
    },
    inputs: { trigger: null },
    outputs: { output: [] },
    props: {
      did: `light-${'x'.repeat(240)}`,
      siid: 2,
      aiid: 1,
      ins: [
        { piid: 1, value: true },
        {
          piid: 2,
          scope: 'global',
          id: 'level',
          dtype: 'number',
          min: 1,
          max: 100,
          step: 1,
        },
      ],
    },
  },
  {
    id: 'dynamic',
    type: 'logicAnd',
    cfg: { pos: position(320, 376), name: 'Dynamic pins', version: 1 },
    inputs: dynamicInputs,
    outputs: { output: [] },
    props: {},
  },
  {
    id: 'event-comparison',
    type: 'deviceInput',
    cfg: {
      urn: 'urn:miot-spec-v2:device:sensor:0000A077:rule-view-event-test:1',
      pos: position(684, 204),
      name: 'Event comparison',
      version: 1,
    },
    inputs: {},
    outputs: { output: [] },
    props: {
      did: 'event-sensor-did',
      siid: 3,
      eiid: 1,
      arguments: [
        {
          piid: 1,
          dtype: 'int',
          operator: '=',
          v1: Array.from({ length: 20 }, (_, index) => index + 1),
        },
      ],
    },
  },
  {
    id: 'unicode',
    type: 'varChange',
    cfg: {
      pos: position(320, 120),
      name: '中文节点👨‍👩‍👧‍👦é',
      version: 1,
    },
    inputs: {},
    outputs: { output: [] },
    props: {
      scope: 'global',
      id: 'label',
      varType: 'string',
      preload: false,
      operator: '=',
      v1: '中文字符串👨‍👩‍👧‍👦é中文字符串👨‍👩‍👧‍👦é',
    },
  },
  ...modeledNodeTypes.map((type, index) => ({
    id: `n-${1753020000000 + index}`,
    type,
    cfg: { name: type },
    inputs: {},
    outputs: {},
    props: {},
  })),
];

function endpointPath(root) {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\xgg-rule-view-${process.pid}-${randomUUID()}`;
  }
  return join(root, 'agent.sock');
}

async function startFakeAgent(t) {
  const root = await mkdtemp(join(tmpdir(), 'xgg-rule-view-output-'));
  const socketPath = endpointPath(root);
  const server = await createIpcServer({
    path: socketPath,
    handler: async ({ method }) => {
      if (method === '$ping') return { host: baseUrl, agentStartedAt };
      if (method === '/api/getGraphList') return [summary];
      if (method === '/api/getGraph') return { id: ruleId, nodes };
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
  return { root, sessionFile };
}

function runCli(args, agent) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: agent.root,
      env: {
        ...process.env,
        XGG_AGENT_MODE: '0',
        XGG_BASE_URL: baseUrl,
        XGG_NO_NEXT_HINT: '1',
        XGG_NO_REFRESH_HINT: '1',
        XGG_SESSION_FILE: agent.sessionFile,
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
    child.once('close', (status, signal) => resolve({ signal, status, stderr, stdout }));
  });
}

function prettyIdentityRows(stdout) {
  const rows = [];
  let current;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('│')) {
      const cells = line.split('│');
      current ??= { nodeId: '', type: '' };
      current.nodeId += cells[1].trim();
      current.type += cells[2].trim();
      continue;
    }
    if ((line.startsWith('├') || line.startsWith('└')) && current !== undefined) {
      rows.push(current);
      current = undefined;
    }
  }
  return rows.filter(({ nodeId }) => nodeId !== 'nodeId');
}

test('record summaries preserve scalar types and inspect representative node props', () => {
  assert.equal(
    summarizeRuleRecord(nodes[0].props),
    '{"end":{"hour":22,"minute":30,"second":0},"filter":{"day":[1,2,3,4,5]},"mingTextShow":false,"start":{"hour":8,"minute":0,"second":0}}',
  );
  assert.equal(
    summarizeRuleRecord(nodes[1].props),
    '{"id":"temperature","operator":"between","preload":false,"scope":"global","v1":18,"v2":25,"varType":"number"}',
  );
  assert.match(summarizeRuleRecord(nodes[2].props), /"operator":"=".*"v1":\[1,2,3\]/);

  const actionSummary = summarizeRuleRecord(nodes[3].props);
  assert.match(actionSummary, /"value":true/);
  assert.match(actionSummary, /"dtype":"number"/);
  assert.match(actionSummary, /"step":1/);
  assert.match(actionSummary, /…\(\+\d+ chars\)/);
  assert.equal(actionSummary.length <= 420, true);

  const nestedIncludeSummary = summarizeRuleRecord(nodes[5].props);
  assert.match(nestedIncludeSummary, /"v1":\[1,2,3/);
  assert.match(nestedIncludeSummary, /…\(\+\d+ items\)/);
  assert.equal(nestedIncludeSummary.length <= 420, true);
});

test('display-width helpers preserve grapheme clusters and enforce terminal columns', () => {
  const family = '👨‍👩‍👧‍👦';
  const combining = 'é';
  const wrapped = wrapDisplayText(`中文${family}${combining}X`, 4);
  assert.equal(wrapped, `中文\n${family}${combining}X`);
  assert.deepEqual(
    wrapped.split('\n').map((line) => stringWidth(line)),
    [4, 4],
  );

  const truncated = truncateDisplayText(`${family}${combining}中文`, 4);
  assert.equal(truncated, `${family}${combining}…`);
  assert.equal(stringWidth(truncated), 4);
});

test('dynamic pins and output topology are naturally ordered and explicitly bounded', () => {
  const inputs = summarizeRuleRecord(dynamicInputs);
  assert.equal(inputs.indexOf('"input2"') < inputs.indexOf('"input10"'), true);
  assert.match(inputs, /"…":"\(\+4 keys\)"/);
  assert.equal(inputs.length <= 420, true);

  assert.equal(
    summarizeRuleOutputs({ output10: ['z.input'], output2: ['a.trigger'], empty: [] }),
    'output2→a.trigger | output10→z.input',
  );

  const pathological = summarizeRuleRecord(
    Array.from({ length: 50 }, () => ({ value: 'x'.repeat(500) })),
  );
  assert.equal(pathological.length <= 420, true);
  assert.match(pathological, /…\(\+46 items\)/);
});

test('rule view keeps default JSON lossless and pretty output bounded and control-safe', async (t) => {
  const agent = await startFakeAgent(t);
  const raw = await runCli(['rule', 'view', ruleId], agent);
  assert.equal(raw.status, 0, raw.stderr);
  assert.equal(raw.signal, null);
  assert.equal(raw.stderr, '');
  const payload = JSON.parse(raw.stdout);
  assert.deepEqual(payload.nodes, nodes);

  const pretty = await runCli(['rule', 'view', ruleId, '--pretty'], agent);
  assert.equal(pretty.status, 0, pretty.stderr);
  assert.equal(pretty.signal, null);
  assert.equal(pretty.stderr, '');
  assert.match(pretty.stdout, /inputs/);
  assert.match(pretty.stdout, /props/);
  assert.match(pretty.stdout, /outputs/);
  assert.match(pretty.stdout, /between/);
  assert.match(pretty.stdout, /input10/);
  assert.equal(pretty.stdout.includes('\u001b'), false);
  assert.equal(pretty.stdout.includes('\u009b'), false);
  assert.match(pretty.stdout, /\\u001b/);
  assert.match(pretty.stdout, /\\u009b/);
  assert.match(pretty.stdout, /中文节点👨‍👩‍👧‍👦é/);
  assert.match(pretty.stdout, /中文字符串/);

  const expectedTableWidth =
    RULE_VIEW_PRETTY_COLUMN_WIDTHS.reduce((total, width) => total + width, 0) +
    RULE_VIEW_PRETTY_COLUMN_WIDTHS.length +
    1;
  const tableLines = pretty.stdout
    .trimEnd()
    .split('\n')
    .filter((line) => /^[┌├└│]/u.test(line));
  assert.equal(tableLines.length > 0, true);
  for (const line of tableLines) {
    assert.equal(stringWidth(line), expectedTableWidth, line);
  }

  const identities = new Map(
    prettyIdentityRows(pretty.stdout).map(({ nodeId, type }) => [nodeId, type]),
  );
  assert.equal(modeledNodeTypes.length, 25);
  for (const [index, type] of modeledNodeTypes.entries()) {
    const defaultId = `n-${1753020000000 + index}`;
    assert.equal(defaultId.length, 15);
    assert.equal(identities.get(defaultId), type, `${defaultId} must retain exact type ${type}`);
  }
});
