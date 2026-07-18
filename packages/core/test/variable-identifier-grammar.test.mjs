import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ConfigError,
  VARIABLE_IDENTIFIER_CONSTRAINT,
  addNode,
  checkVarSetNumberExprString,
  exportRuleFromView,
  parseEventArgVarTarget,
  parseVarSetExpr,
} from '../dist/index.js';
import { VariableCreateRequest } from '../dist/schemas/variable.js';

const position = { x: 0, y: 0, width: 712, height: 220, exprHeight: 30 };

function createRequest(scope, id) {
  return {
    scope,
    id,
    type: 'number',
    value: 0,
    userData: { name: 'grammar test' },
  };
}

test('variable create uses the shared non-empty ASCII alphanumeric grammar', () => {
  assert.equal(VariableCreateRequest.safeParse(createRequest('123', '456abc')).success, true);

  for (const id of ['', 'bad_id', 'bad-id', 'bad.id', '变量']) {
    const parsed = VariableCreateRequest.safeParse(createRequest('global', id));
    assert.equal(parsed.success, false, `expected id ${JSON.stringify(id)} to fail`);
    assert.match(parsed.error.issues[0].message, /\[A-Za-z0-9\]\+/);
  }
  for (const scope of ['', 'bad_scope', 'bad-scope', 'bad.scope', '范围']) {
    const parsed = VariableCreateRequest.safeParse(createRequest(scope, 'valid1'));
    assert.equal(parsed.success, false, `expected scope ${JSON.stringify(scope)} to fail`);
    assert.match(parsed.error.issues[0].message, /\[A-Za-z0-9\]\+/);
  }
});

test('expression parser accepts digit-leading references and preserves normal concatenation/escape behavior', () => {
  assert.deepEqual(parseVarSetExpr('前$123中$global.456后$R789.012|$alpha|$$价格'), [
    { type: 'const', value: '前' },
    { type: 'var', scope: 'global', id: '123' },
    { type: 'const', value: '中' },
    { type: 'var', scope: 'global', id: '456' },
    { type: 'const', value: '后' },
    { type: 'var', scope: 'R789', id: '012' },
    { type: 'const', value: '|' },
    { type: 'var', scope: 'global', id: 'alpha' },
    { type: 'const', value: '|$价格' },
  ]);
  assert.deepEqual(parseVarSetExpr('$1$2', { defaultScope: 'R3' }), [
    { type: 'var', scope: 'R3', id: '1' },
    { type: 'var', scope: 'R3', id: '2' },
  ]);
  assert.deepEqual(parseVarSetExpr('$x-1 + $x-abs(1) + $x-.5 + $x-Infinity'), [
    { type: 'var', scope: 'global', id: 'x' },
    { type: 'const', value: '-1 + ' },
    { type: 'var', scope: 'global', id: 'x' },
    { type: 'const', value: '-abs(1) + ' },
    { type: 'var', scope: 'global', id: 'x' },
    { type: 'const', value: '-.5 + ' },
    { type: 'var', scope: 'global', id: 'x' },
    { type: 'const', value: '-Infinity' },
  ]);
});

test('expression parser diagnoses invalid unescaped variable-looking tokens for number and string cards', () => {
  for (const expr of ['$bad_id', '$bad-id', '$global.', '$global.bad.more', '$', '$变量']) {
    assert.throws(
      () => parseVarSetExpr(expr),
      (error) =>
        error instanceof ConfigError &&
        error.message.includes('invalid variable reference') &&
        error.message.includes('[A-Za-z0-9]+'),
      expr,
    );
  }

  assert.deepEqual(parseVarSetExpr('literal $$bad_id $$bad-id $$'), [
    { type: 'const', value: 'literal $bad_id $bad-id $' },
  ]);
});

test('expr-check shares the parser grammar, including digit-leading IDs and identifier diagnostics', () => {
  const valid = checkVarSetNumberExprString('$123 + $global.456 + $R789.012');
  assert.deepEqual(valid, { ok: true, template: '$ + $ + $' });
  assert.equal(checkVarSetNumberExprString('$x-1').ok, true);
  assert.equal(checkVarSetNumberExprString('$x-abs(1)').ok, true);
  assert.equal(checkVarSetNumberExprString('$x-.5').ok, true);
  assert.equal(checkVarSetNumberExprString('$x-Infinity').ok, true);

  for (const expr of ['$bad_id + 1', '$bad-id + 1', '$global. + 1', '$']) {
    const invalid = checkVarSetNumberExprString(expr);
    assert.equal(invalid.ok, false, expr);
    assert.equal(invalid.kind, 'identifier', expr);
    assert.match(invalid.message, /\[A-Za-z0-9\]\+/, expr);
  }
});

test('event argument variable routing uses the same scope/id grammar before spec lookup', () => {
  assert.deepEqual(parseEventArgVarTarget('1=global.123'), {
    piid: 1,
    scope: 'global',
    id: '123',
  });
  assert.deepEqual(parseEventArgVarTarget('2=123.456'), { piid: 2, scope: '123', id: '456' });

  for (const raw of [
    '1=global.bad_id',
    '1=global.bad-id',
    '1=global.bad.id',
    '1=global.',
    '1=.id',
  ]) {
    assert.throws(
      () => parseEventArgVarTarget(raw),
      (error) =>
        error instanceof ConfigError && error.message.includes(VARIABLE_IDENTIFIER_CONSTRAINT),
      raw,
    );
  }
});

test('shortcut grammar failures happen before any session, gateway, or MIoT lookup', async () => {
  let sessionReads = 0;
  const deps = {
    baseUrl: 'http://gateway.invalid',
    store: {
      read: async () => {
        sessionReads += 1;
        throw new Error('must not read a session for local grammar errors');
      },
    },
  };

  await assert.rejects(
    addNode(
      {
        ruleId: 'rule1',
        shortcut: {
          type: 'deviceInputSetVar',
          deviceDid: 'device1',
          deviceEvent: 'event1',
          deviceEventArgVars: ['1=global.bad_id'],
        },
      },
      deps,
    ),
    (error) =>
      error instanceof ConfigError && error.message.includes(VARIABLE_IDENTIFIER_CONSTRAINT),
  );
  await assert.rejects(
    addNode(
      {
        ruleId: 'rule1',
        shortcut: {
          type: 'varSetString',
          varScope: 'global',
          varId: 'bad-id',
          expr: '$$literal',
        },
      },
      deps,
    ),
    (error) =>
      error instanceof ConfigError && error.message.includes(VARIABLE_IDENTIFIER_CONSTRAINT),
  );
  assert.equal(sessionReads, 0);
});

test('varSet export reparses digit-leading IDs without changing elements', async () => {
  const elements = [
    { type: 'var', scope: 'global', id: '123' },
    { type: 'const', value: '|' },
    { type: 'var', scope: 'R456', id: '789' },
    { type: 'const', value: '|$' },
  ];
  const exported = await exportRuleFromView(
    {
      id: 'rule1',
      cfg: {
        id: 'rule1',
        enable: false,
        uiType: 'test',
        userData: {
          name: 'identifier round-trip',
          transform: { x: 0, y: 0, scale: 1, rotate: 0 },
          lastUpdateTime: 0,
          version: 0,
        },
      },
      nodes: [
        {
          id: 'set1',
          type: 'varSetString',
          cfg: { pos: position, name: 'varSetString', version: 1 },
          inputs: { input: null },
          outputs: { output: [] },
          props: { scope: 'global', id: '123', elements },
        },
      ],
    },
    { baseUrl: 'http://gateway.invalid', store: {} },
  );

  const nodeAdd = exported.commands.find(
    (command) => command.kind === 'node-add' && command.nodeId === 'set1',
  );
  assert.ok(nodeAdd);
  assert.equal(nodeAdd.flags.find((flag) => flag.name === '--var-id')?.value, '123');
  const expr = nodeAdd.flags.find((flag) => flag.name === '--expr')?.value;
  assert.equal(expr, '$global.123|$R456.789|$$');
  assert.deepEqual(parseVarSetExpr(expr), elements);
});
