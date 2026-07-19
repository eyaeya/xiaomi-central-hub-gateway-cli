import assert from 'node:assert/strict';
import test from 'node:test';

import { ConfigError } from '@eyaeya/xgg-core';
import { buildProgram } from '../dist/program.js';

function nodeAddCommand(program) {
  const rule = program.commands.find((command) => command.name() === 'rule');
  const node = rule?.commands.find((command) => command.name() === 'node');
  return node?.commands.find((command) => command.name() === 'add');
}

test('node-add help exposes a raw string-property comparison flag', () => {
  const add = nodeAddCommand(buildProgram());
  assert.ok(add);
  const help = add.helpInformation();
  assert.match(help, /--property-value <S>/);
  assert.match(help, /string-property\s+equality literal/);
  assert.match(help, /--property-include <N,N,...>/);
  assert.match(help, /--event-filter-include <piid=values>/);
  assert.match(help, /--event-filter-between <piid=lower,upper>/);
  assert.match(help, /`between` requires explicit --threshold \(v1\) \+ --threshold2 \(v2\)/);
  assert.match(help, /required together with explicit --threshold/);
  assert.doesNotMatch(help, /optional second threshold/);
  assert.match(help, /mutually exclusive with --device-event/);
  assert.match(help, /mutually exclusive with --device-property/);
});

test('CLI rejects mixed deviceInput modes and event-mode property comparisons before guards', async (t) => {
  const previousAgentMode = process.env.XGG_AGENT_MODE;
  process.env.XGG_AGENT_MODE = '1';
  t.after(() => {
    if (previousAgentMode === undefined) Reflect.deleteProperty(process.env, 'XGG_AGENT_MODE');
    else process.env.XGG_AGENT_MODE = previousAgentMode;
  });

  const prefix = [
    'node',
    'xgg',
    'rule',
    'node',
    'add',
    '--rule-id',
    'rule-1',
    '--type',
    'deviceInput',
    '--device-did',
    'did-1',
    '--device-event',
    'changed',
    '--no-snapshot',
  ];
  const cases = [
    {
      args: ['--device-property', 'value'],
      message: /cannot mix --device-event with --device-property/,
    },
    {
      args: ['--op', 'between', '--threshold', '1', '--threshold2', '2'],
      message:
        /event mode cannot use property-only comparison option\(s\): --op, --threshold, --threshold2/,
    },
    {
      args: ['--property-value', 'open'],
      message: /event mode cannot use property-only comparison option\(s\): --property-value/,
    },
    {
      args: ['--property-include', '1,2'],
      message: /event mode cannot use property-only comparison option\(s\): --property-include/,
    },
    {
      args: ['--force-out-of-range'],
      message: /event mode cannot use property-only comparison option\(s\): --force-out-of-range/,
    },
  ];

  for (const { args, message } of cases) {
    await assert.rejects(
      buildProgram().parseAsync([...prefix, ...args]),
      (error) => error instanceof ConfigError && message.test(error.message),
    );
  }
});

test('complete comparison flags parse without scalar/list ambiguity', () => {
  const add = nodeAddCommand(buildProgram());
  assert.ok(add);
  add.parseOptions([
    '--property-include',
    '1,2,3',
    '--event-filter-include',
    '2=1,2',
    '--event-filter-include',
    '5=4,6',
    '--event-filter-between',
    '3=1.5,2.5',
  ]);
  assert.deepEqual(add.opts().propertyInclude, [1, 2, 3]);
  assert.deepEqual(add.opts().eventFilterInclude, ['2=1,2', '5=4,6']);
  assert.deepEqual(add.opts().eventFilterBetween, ['3=1.5,2.5']);
});

test('property include preserves safe-integer boundaries and rejects lossy numeric input locally', () => {
  const boundary = nodeAddCommand(buildProgram());
  assert.ok(boundary);
  boundary.parseOptions([
    '--property-include',
    `${Number.MAX_SAFE_INTEGER},${Number.MIN_SAFE_INTEGER}`,
  ]);
  assert.deepEqual(boundary.opts().propertyInclude, [
    Number.MAX_SAFE_INTEGER,
    Number.MIN_SAFE_INTEGER,
  ]);

  for (const raw of [
    '',
    '1,,2',
    '1.5,2',
    '1.0000000000000001,2',
    '9007199254740990.9',
    '1e-324',
    '1,2oops',
    '9007199254740992',
    '9007199254740993',
    '-9007199254740992',
  ]) {
    const add = nodeAddCommand(buildProgram());
    assert.ok(add);
    add.exitOverride();
    add.configureOutput({ writeErr: () => {} });
    assert.throws(
      () => add.parseOptions(['--property-include', raw]),
      (error) =>
        error?.code === 'commander.invalidArgument' &&
        /comma-separated finite integers/.test(error.message),
      raw,
    );
  }
});

test('numeric threshold parser preserves the original decimal token for dtype-aware parsing', () => {
  const add = nodeAddCommand(buildProgram());
  assert.ok(add);
  add.parseOptions(['--threshold', ' 9.007199254740991e15 ', '--threshold2', '1.25e1']);
  assert.deepEqual(add.opts().threshold, {
    literal: '9.007199254740991e15',
    value: Number.MAX_SAFE_INTEGER,
  });
  assert.deepEqual(add.opts().threshold2, { literal: '1.25e1', value: 12.5 });
});

test('node-add exposes explicit preload true/false without hiding omission', () => {
  const omitted = nodeAddCommand(buildProgram());
  assert.ok(omitted);
  omitted.parseOptions([]);
  assert.equal(omitted.opts().preload, undefined);

  const enabled = nodeAddCommand(buildProgram());
  assert.ok(enabled);
  enabled.parseOptions(['--preload']);
  assert.equal(enabled.opts().preload, true);

  const disabled = nodeAddCommand(buildProgram());
  assert.ok(disabled);
  disabled.parseOptions(['--no-preload']);
  assert.equal(disabled.opts().preload, false);

  const help = disabled.helpInformation();
  assert.match(help, /--preload/);
  assert.match(help, /--no-preload/);
  assert.match(help, /official new-card default/);
  assert.match(help, /historical eager deviceInput behavior/);
});

test('numeric thresholds reject parseFloat-style trailing junk before command action', () => {
  const add = nodeAddCommand(buildProgram());
  assert.ok(add);
  add.exitOverride();
  add.configureOutput({ writeErr: () => {} });
  assert.throws(
    () => add.parseOptions(['--threshold', '1oops']),
    (error) =>
      error?.code === 'commander.invalidArgument' &&
      /expected a finite decimal number/.test(error.message),
  );
});

test('node-add accepts four-part positions and expression-card exprHeight positions', () => {
  const fourPart = nodeAddCommand(buildProgram());
  assert.ok(fourPart);
  fourPart.parseOptions(['--pos', '1,2,740,220']);
  assert.deepEqual(fourPart.opts().pos, { x: 1, y: 2, width: 740, height: 220 });

  const fivePart = nodeAddCommand(buildProgram());
  assert.ok(fivePart);
  fivePart.parseOptions(['--pos', '1,2,712,220,61.5']);
  assert.deepEqual(fivePart.opts().pos, {
    x: 1,
    y: 2,
    width: 712,
    height: 220,
    exprHeight: 61.5,
  });
  assert.match(fivePart.helpInformation(), /--pos <x,y,width,height\[,exprHeight\]>/);
});

test('node-add rejects malformed position component counts and trailing junk', () => {
  for (const raw of ['1,2,3', '1,2,3,4,5,6', '1,2,3,4oops']) {
    const add = nodeAddCommand(buildProgram());
    assert.ok(add);
    add.exitOverride();
    add.configureOutput({ writeErr: () => {} });
    assert.throws(
      () => add.parseOptions(['--pos', raw]),
      (error) =>
        error?.code === 'commander.invalidArgument' &&
        /x,y,width,height\[,exprHeight\]/.test(error.message),
      raw,
    );
  }
});

test('node-add help exposes typed simplified values and preserves explicit false', () => {
  const enabled = nodeAddCommand(buildProgram());
  assert.ok(enabled);
  assert.match(enabled.helpInformation(), /--simplified <true\|false>/);
  enabled.parseOptions(['--simplified', 'true']);
  assert.equal(enabled.opts().simplified, true);

  const disabled = nodeAddCommand(buildProgram());
  assert.ok(disabled);
  disabled.parseOptions(['--simplified', 'false']);
  assert.equal(disabled.opts().simplified, false);

  const invalid = nodeAddCommand(buildProgram());
  assert.ok(invalid);
  invalid.exitOverride();
  invalid.configureOutput({ writeErr: () => {} });
  assert.throws(
    () => invalid.parseOptions(['--simplified', 'yes']),
    (error) =>
      error?.code === 'commander.invalidArgument' && /expected true or false/.test(error.message),
  );
});
