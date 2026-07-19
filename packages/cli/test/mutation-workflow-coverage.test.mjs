import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const funnels = new Map([
  ['src/commands/rule/new.ts', ['rule.new']],
  ['src/commands/rule/set.ts', ['rule.set']],
  ['src/commands/rule/delete.ts', ['rule.delete']],
  ['src/commands/rule/enable.ts', ['rule.enable']],
  ['src/commands/rule/disable.ts', ['rule.disable']],
  ['src/commands/rule/rename.ts', ['rule.rename']],
  ['src/commands/rule/set-tags.ts', ['rule.set-tags']],
  ['src/commands/rule/layout.ts', ['rule.layout']],
  ['src/commands/rule/node-add.ts', ['rule.node.add']],
  ['src/commands/rule/node-update.ts', ['rule.node.update']],
  ['src/commands/rule/node-remove.ts', ['rule.node.remove']],
  ['src/commands/rule/edge-add.ts', ['rule.edge.add']],
  ['src/commands/rule/edge-remove.ts', ['rule.edge.remove']],
  [
    'src/commands/variable.ts',
    ['variable.create', 'variable.delete', 'variable.set-value', 'variable.set-config'],
  ],
  [
    'src/commands/backup.ts',
    ['backup.create', 'backup.download', 'backup.load', 'backup.delete', 'backup.config.set'],
  ],
]);

test('all 22 typed CLI mutation funnels enter a named workflow lease', async () => {
  let count = 0;
  for (const [relativePath, operations] of funnels) {
    const source = await readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');
    for (const operation of operations) {
      count += 1;
      assert.match(
        source,
        new RegExp(`runMutationWorkflow\\(\\s*['\"]${operation.replace('.', '\\.')}['\"]`),
        `${relativePath} does not lease ${operation}`,
      );
    }
  }
  assert.equal(count, 22);
});

test('raw writes and the programmatic probe funnel are leased', async () => {
  const rawApi = await readFile(new URL('../src/commands/api.ts', import.meta.url), 'utf8');
  assert.match(rawApi, /kind === 'write'[\s\S]*runMutationWorkflow\(`api:\$\{method\}`/);

  const probe = await readFile(
    new URL('../../core/src/usecases/probe-node.ts', import.meta.url),
    'utf8',
  );
  assert.match(probe, /withMutationWorkflow\([\s\S]*operation: `probe-node:\$\{input\.scenario\}`/);
});
