import assert from 'node:assert/strict';
import test from 'node:test';

import { ConfigError, exportRuleFromView, parseVarSetExpr } from '../dist/index.js';

const position = { x: 0, y: 0, width: 712, height: 220, exprHeight: 30 };

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

async function exportedExpression(elements, type = 'varSetString') {
  const exported = await exportRuleFromView(view(elements, type), {
    baseUrl: 'http://gateway.invalid',
    store: {},
  });
  const node = exported.commands.find(
    (command) => command.kind === 'node-add' && command.nodeId === 'set1',
  );
  assert.ok(node);
  return node.flags.find((flag) => flag.name === '--expr')?.value;
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
