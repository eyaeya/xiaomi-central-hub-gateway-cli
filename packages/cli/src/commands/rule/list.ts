import { listRules } from '@eyaeya/xgg-core';
import type { Command } from 'commander';
import { wrap } from '../../action-wrap.js';
import { type TableColumn, emitList } from '../../output.js';
import { type RuleOpts, makeDeps } from './_deps.js';

export function attachList(cmd: Command): void {
  cmd
    .command('list')
    .description('List all rules (graphs) on the gateway')
    .option('--base-url <url>', 'gateway base URL (or XGG_BASE_URL)')
    .option('--session-file <path>', 'session file path')
    .option('--timeout <ms>', 'request timeout in milliseconds', '10000')
    .option('--pretty', 'pretty-print: table view (default: compact JSON)')
    .addHelpText('after', '\nExample:\n  $ xgg rule list --pretty')
    .action(
      wrap('rule.list', async (opts: RuleOpts) => {
        const deps = makeDeps(opts);
        const result = await listRules(deps);
        const columns: TableColumn<(typeof result)[number]>[] = [
          { header: 'id', get: (r) => r.id },
          { header: 'name', get: (r) => r.userData.name },
          { header: 'uiType', get: (r) => r.uiType ?? '' },
          { header: 'enable', get: (r) => String(r.enable) },
        ];
        emitList(
          { jsonPayload: { ok: true, rules: result }, columns, rows: result },
          { pretty: opts.pretty === true },
        );
      }),
    );
}
