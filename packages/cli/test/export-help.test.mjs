import assert from 'node:assert/strict';
import test from 'node:test';

import { buildProgram } from '../dist/program.js';

function exportCommand(program) {
  const rule = program.commands.find((command) => command.name() === 'rule');
  return rule?.commands.find((command) => command.name() === 'export');
}

test('rule export help describes strict opaque-node semantics accurately', () => {
  const command = exportCommand(buildProgram());
  assert.ok(command);
  const help = command.helpInformation().replace(/\s+/g, ' ');
  assert.match(help, /unmodeled opaque cards remain allowed for lossless same-id replay/);
  assert.match(help, /--target-id clone rejects them/);
  assert.doesNotMatch(help, /including unknown cards/);
});
