import assert from 'node:assert/strict';
import test from 'node:test';

import { buildProgram } from '../dist/program.js';

function nodeAddCommand(program) {
  const rule = program.commands.find((command) => command.name() === 'rule');
  const node = rule?.commands.find((command) => command.name() === 'node');
  return node?.commands.find((command) => command.name() === 'add');
}

test('node-add help exposes plain-text and lossless Quill Delta nop authoring', () => {
  const add = nodeAddCommand(buildProgram());
  assert.ok(add);
  const help = add.helpInformation();
  assert.match(help, /--text <S>/);
  assert.match(help, /--delta <JSON>/);
  assert.match(help, /--background <CSS>/);
  assert.match(help, /lossless Quill Delta/);

  add.parseOptions([
    '--rule-id',
    'rule1',
    '--type',
    'nop',
    '--text',
    '画布说明',
    '--background',
    '#FFD966',
  ]);
  assert.equal(add.opts().text, '画布说明');
  assert.equal(add.opts().background, '#FFD966');
});
