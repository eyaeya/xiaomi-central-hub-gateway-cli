import { getRule } from '@eyaeya/xgg-core';
import type { Command } from 'commander';
import { wrap } from '../../action-wrap.js';
import { emit } from '../../output.js';
import { type RuleOpts, makeDeps } from './_deps.js';

export function attachGet(cmd: Command): void {
  cmd
    .command('get <id>')
    .description('Get a single rule (graph) by id')
    .option('--base-url <url>', 'gateway base URL (or XGG_BASE_URL)')
    .option('--session-file <path>', 'session file path')
    .option('--timeout <ms>', 'request timeout in milliseconds', '10000')
    .option('--pretty', 'pretty-print JSON output')
    .addHelpText('after', '\nExample:\n  $ xgg rule get 1748234567890 --pretty')
    .action(
      wrap('rule.get', async (id: string, opts: RuleOpts) => {
        const deps = makeDeps(opts);
        const result = await getRule(id, deps);
        emit({ ok: true, rule: result }, { pretty: opts.pretty === true });
      }),
    );
}
