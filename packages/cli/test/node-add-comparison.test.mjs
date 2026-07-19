import assert from 'node:assert/strict';
import test from 'node:test';

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
