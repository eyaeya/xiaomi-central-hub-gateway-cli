import assert from 'node:assert/strict';
import test from 'node:test';

import { ConfigError, addNode, exportRuleFromView, parseVarSetExpr } from '../dist/index.js';

const position = { x: 0, y: 0, width: 712, height: 220, exprHeight: 30 };
const baseUrl = 'http://gateway.invalid';
const agentStartedAt = '2026-07-19T00:00:00.000Z';

function view(elements, type = 'varSetString') {
  return {
    id: 'rule1',
    cfg: {
      id: 'rule1',
      enable: false,
      uiType: 'test',
      userData: {
        name: 'lossless varSet export',
        transform: { x: 0, y: 0, scale: 1, rotate: 0 },
        lastUpdateTime: 0,
        version: 0,
      },
    },
    nodes: [
      {
        id: 'set1',
        type,
        cfg: { pos: position, name: type, version: 1 },
        inputs: { input: null },
        outputs: { output: [] },
        props: { scope: 'global', id: 'target', elements },
      },
    ],
  };
}

function variableEntry(type, name) {
  return {
    type,
    value: type === 'number' ? 0 : '',
    userData: { name },
  };
}

function inventoryForExpression(elements, type) {
  const operandType = type === 'varSetNumber' ? 'number' : 'string';
  const variables = {
    target: variableEntry(operandType, 'target'),
  };
  for (const element of elements) {
    if (element.type === 'var' && element.scope === 'global') {
      variables[element.id] ??= variableEntry(operandType, `operand ${element.id}`);
    }
  }
  return variables;
}

async function exportedExpression(elements, type = 'varSetString') {
  const gateway = statefulGateway('rule1', inventoryForExpression(elements, type));
  const exported = await exportRuleFromView(view(elements, type), gateway.deps);
  const node = exported.commands.find(
    (command) => command.kind === 'node-add' && command.nodeId === 'set1',
  );
  assert.ok(node);
  return node.flags.find((flag) => flag.name === '--expr')?.value;
}

function summary(id = 'rule1') {
  return {
    id,
    enable: false,
    uiType: 'test',
    userData: {
      name: 'lossless varSet export',
      transform: { x: 0, y: 0, scale: 1, rotate: 0 },
      lastUpdateTime: 0,
      version: 0,
    },
  };
}

function statefulGateway(
  id = 'rule1',
  globalVariables = {
    numberTarget: variableEntry('number', 'number target'),
    stringTarget: variableEntry('string', 'string target'),
  },
) {
  const calls = [];
  const state = { summary: summary(id), nodes: [] };
  return {
    calls,
    state,
    deps: {
      baseUrl,
      store: {
        read: async () => ({
          host: baseUrl,
          pid: 1,
          socketPath: '/tmp/xgg-varset-export-unused.sock',
          agentStartedAt,
          agentVersion: '0.1.4',
          lastValidatedAt: agentStartedAt,
        }),
      },
      ipcClient: () => ({
        request: async (method, params) => {
          if (method === '$ping') return { host: baseUrl, agentStartedAt };
          if (method === '$mutation.acquire') return { leaseId: 'test-lease' };
          if (method === '$mutation.release' || method === '$mutation.fence') return { ok: true };
          calls.push({ method, params });
          if (method === '/api/getVarList') {
            assert.deepEqual(params, { scope: 'global' });
            return structuredClone(globalVariables);
          }
          if (method === '/api/getGraphList') return [structuredClone(state.summary)];
          if (method === '/api/getGraph') {
            return { id, nodes: structuredClone(state.nodes) };
          }
          if (method === '/api/setGraph') {
            state.summary = structuredClone(params.cfg);
            state.nodes = structuredClone(params.nodes);
            return null;
          }
          throw new Error(`unexpected RPC: ${method}`);
        },
        close: () => {},
      }),
    },
  };
}

function flagValue(command, name) {
  return command.flags.find((flag) => flag.name === name)?.value;
}

function legacyReplayIntentFromExport(command) {
  return command.flags.some((flag) => flag.name === '--allow-legacy-id')
    ? { legacyNodeIdReplay: true }
    : {};
}

function shortcutFromExport(command) {
  const rawPos = flagValue(command, '--pos');
  const parts = rawPos?.split(',').map(Number);
  assert.ok(parts?.length === 4 || parts?.length === 5);
  return {
    type: command.type,
    id: flagValue(command, '--id'),
    pos: {
      x: parts[0],
      y: parts[1],
      width: parts[2],
      height: parts[3],
      ...(parts.length === 5 && { exprHeight: parts[4] }),
    },
    varScope: flagValue(command, '--var-scope'),
    varId: flagValue(command, '--var-id'),
    expr: flagValue(command, '--expr'),
  };
}

test('varSet export preserves safe separators, adjacent variables, and literal dollars', async () => {
  const elements = [
    { type: 'var', scope: 'global', id: 'first' },
    { type: 'const', value: '-1 + ' },
    { type: 'var', scope: 'global', id: 'second' },
    { type: 'var', scope: 'global', id: 'third' },
    { type: 'const', value: '$tail' },
  ];
  const expression = await exportedExpression(elements);
  assert.equal(expression, '$global.first-1 + $global.second$global.third$$tail');
  assert.deepEqual(parseVarSetExpr(expression), elements);

  const numberElements = [
    { type: 'var', scope: 'global', id: 'first' },
    { type: 'const', value: '-1 + ' },
    { type: 'var', scope: 'global', id: 'second' },
  ];
  const numberExpression = await exportedExpression(numberElements, 'varSetNumber');
  assert.equal(numberExpression, '$global.first-1 + $global.second');
  assert.deepEqual(parseVarSetExpr(numberExpression), numberElements);
});

test('varSet export fails closed when a following constant would absorb or invalidate a variable id', async () => {
  for (const suffix of ['abc', '123', '-foo', '.tail', '_tail']) {
    await assert.rejects(
      exportedExpression([
        { type: 'var', scope: 'global', id: 'text' },
        { type: 'const', value: suffix },
      ]),
      (error) =>
        error instanceof ConfigError &&
        error.code === 'CONFIG' &&
        /cannot export varSetString node set1 losslessly/.test(error.message),
      suffix,
    );
  }
});

test('strict export replay preserves custom exprHeight for number and string expression cards', async () => {
  const nodes = [
    {
      id: 'set-number',
      type: 'varSetNumber',
      cfg: {
        pos: { x: 10, y: 20, width: 740, height: 220, exprHeight: 37 },
        name: 'varSetNumber',
        version: 1,
      },
      inputs: { input: null },
      outputs: { output: [] },
      props: {
        scope: 'global',
        id: 'numberTarget',
        elements: [{ type: 'const', value: '42' }],
      },
    },
    {
      id: 'set-string',
      type: 'varSetString',
      cfg: {
        pos: { x: 800, y: 20, width: 712, height: 220, exprHeight: 61.5 },
        name: 'varSetString',
        version: 1,
      },
      inputs: { input: null },
      outputs: { output: [] },
      props: {
        scope: 'global',
        id: 'stringTarget',
        elements: [{ type: 'const', value: 'hello' }],
      },
    },
  ];
  const gateway = statefulGateway();
  const exported = await exportRuleFromView(
    { id: 'rule1', cfg: summary(), nodes },
    gateway.deps,
    undefined,
    true,
  );
  const commands = exported.commands.filter((command) => command.kind === 'node-add');

  assert.deepEqual(
    commands.map((command) => flagValue(command, '--pos')),
    ['10,20,740,220,37', '800,20,712,220,61.5'],
  );

  for (const command of commands) {
    await addNode(
      {
        ruleId: 'rule1',
        shortcut: shortcutFromExport(command),
        ...legacyReplayIntentFromExport(command),
        validate: false,
        varCheck: false,
      },
      gateway.deps,
    );
  }

  assert.deepEqual(gateway.state.nodes, nodes);
});

test('strict export replay keeps legacy four-part expression positions unchanged', async () => {
  const node = {
    id: 'set-string',
    type: 'varSetString',
    cfg: {
      pos: { x: 5, y: 10, width: 712, height: 220 },
      name: 'varSetString',
      version: 1,
    },
    inputs: { input: null },
    outputs: { output: [] },
    props: {
      scope: 'global',
      id: 'stringTarget',
      elements: [{ type: 'const', value: 'legacy' }],
    },
  };
  const gateway = statefulGateway();
  const exported = await exportRuleFromView(
    { id: 'rule1', cfg: summary(), nodes: [node] },
    gateway.deps,
    undefined,
    true,
  );
  const command = exported.commands.find((candidate) => candidate.kind === 'node-add');
  assert.ok(command);
  assert.equal(flagValue(command, '--pos'), '5,10,712,220');

  await addNode(
    {
      ruleId: 'rule1',
      shortcut: shortcutFromExport(command),
      ...legacyReplayIntentFromExport(command),
      validate: false,
      varCheck: false,
    },
    gateway.deps,
  );

  assert.deepEqual(gateway.state.nodes, [node]);
});

test('shortcut rejects exprHeight on non-expression cards before gateway access', async () => {
  const gateway = statefulGateway();
  await assert.rejects(
    addNode(
      {
        ruleId: 'rule1',
        shortcut: {
          type: 'onLoad',
          pos: { x: 0, y: 0, width: 200, height: 120, exprHeight: 30 },
        },
        validate: false,
        varCheck: false,
      },
      gateway.deps,
    ),
    (error) =>
      error instanceof ConfigError &&
      error.code === 'CONFIG' &&
      /exprHeight only applies to varSetNumber\/varSetString/.test(error.message),
  );
  assert.deepEqual(gateway.calls, []);
});
