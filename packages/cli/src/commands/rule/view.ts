import { viewRule } from '@xgg/core';
import Table from 'cli-table3';
import type { Command } from 'commander';
import { wrap } from '../../action-wrap.js';
import { emit } from '../../output.js';
import { type RuleOpts, makeDeps } from './_deps.js';

interface ViewOpts extends RuleOpts {
  nodesOnly?: boolean;
}

export function attachView(cmd: Command): void {
  cmd
    .command('view <id>')
    .description(
      "Read a rule's full graph (cfg + nodes) — the standard read path for `rule set` round-trips",
    )
    .option('--nodes-only', 'omit cfg/userData; emit just the nodes array')
    .option('--base-url <url>', 'gateway base URL (or XGG_BASE_URL)')
    .option('--session-file <path>', 'session file path')
    .option('--timeout <ms>', 'request timeout in milliseconds', '10000')
    .option('--pretty', 'pretty-print: name + node summary table')
    .addHelpText(
      'after',
      '\nExamples:\n  $ xgg rule view 1748234567890\n  $ xgg rule view 1748234567890 --pretty\n  $ xgg rule view 1748234567890 > rule.json && xgg rule set --body rule.json',
    )
    .action(
      wrap('rule.view', async (id: string, opts: ViewOpts) => {
        const deps = makeDeps(opts);
        const view = await viewRule(id, deps);
        const payload = opts.nodesOnly
          ? { ok: true, id: view.id, nodes: view.nodes }
          : { ok: true, ...view };
        if (!opts.pretty) {
          emit(payload, { pretty: false });
          return;
        }
        const name = view.cfg.userData.name;
        process.stdout.write(
          `${name} (id=${view.id}, uiType=${view.cfg.uiType}, enable=${view.cfg.enable})\n\n`,
        );
        const table = new Table({
          head: ['nodeId', 'type', 'name', 'outputs'],
          style: { head: [], border: [] },
        });
        for (const node of view.nodes) {
          const cfg = (node as { cfg?: { name?: string } }).cfg;
          const outputs = (node as { outputs?: Record<string, string[]> }).outputs ?? {};
          const outSummary = Object.entries(outputs)
            .filter(([, targets]) => Array.isArray(targets) && targets.length > 0)
            .map(([pin, targets]) => `${pin}→${(targets as string[]).join(',')}`)
            .join(' | ');
          table.push([
            (node as { id: string }).id,
            (node as { type: string }).type,
            cfg?.name ?? '',
            outSummary,
          ]);
        }
        process.stdout.write(`${table.toString()}\n`);
      }),
    );
}
