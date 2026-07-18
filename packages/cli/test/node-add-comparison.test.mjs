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
