import { dumpBeforeWrite, setRuleTags } from '@xgg/core';
import type { Command } from 'commander';
import { wrap } from '../../action-wrap.js';
import { emit } from '../../output.js';
import {
  addRefreshHintFlag,
  assertAgentModeOrSnapshotsDir,
  printRefreshHint,
} from '../_mutation-guard.js';
import { type RuleOpts, makeDeps } from './_deps.js';

interface SetTagsOpts extends RuleOpts {
  tags: string;
  snapshot?: boolean;
  snapshotsDir?: string;
  refreshHint?: boolean;
}

// F66c (2026-05-31) — `xgg rule set-tags <id> --tags <a,b,c>`. CLI analog of
// the rule-tag modal save. Wraps the core `setRuleTags` helper which calls
// /api/changeGraphConfig with a preserved-cfg payload (only userData.tags +
// monotonic lastUpdateTime change). Pass --tags "" to clear all tags.
function parseTagList(raw: string): string[] {
  if (raw === '') return [];
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

export function attachSetTags(cmd: Command): void {
  const sub = cmd
    .command('set-tags <id>')
    .description("Replace a rule's tag set (comma-separated; empty string clears all)")
    .requiredOption('--tags <CSV>', 'comma-separated tag names; empty string ("") clears all tags')
    .option('--no-snapshot', 'skip the pre-write dump snapshot')
    .option('--snapshots-dir <path>', 'directory for pre-write snapshots (env: XGG_SNAPSHOTS_DIR)')
    .option('--base-url <url>', 'gateway base URL (or XGG_BASE_URL)')
    .option('--session-file <path>', 'session file path')
    .option('--timeout <ms>', 'request timeout in milliseconds', '10000')
    .option('--pretty', 'pretty-print JSON output');
  addRefreshHintFlag(sub)
    .addHelpText(
      'after',
      '\nExamples:\n  $ xgg rule set-tags 1748234567890 --tags "kitchen,morning"\n  $ xgg rule set-tags 1748234567890 --tags ""    # clears all tags',
    )
    .action(
      wrap('rule.set-tags', async (id: string, opts: SetTagsOpts) => {
        const guard = assertAgentModeOrSnapshotsDir(opts);
        const { snapshotsDir } = guard;
        const deps = makeDeps(opts);
        const tags = parseTagList(opts.tags);
        const snapshotPath = !guard.snapshotEnabled
          ? null
          : await dumpBeforeWrite({
              baseUrl: deps.baseUrl,
              store: deps.store,
              ...(deps.timeoutMs !== undefined && { timeoutMs: deps.timeoutMs }),
              ...(snapshotsDir !== undefined && { snapshotsDir }),
            });
        await setRuleTags(id, tags, deps);
        emit({ ok: true, id, tags, snapshot: snapshotPath }, { pretty: opts.pretty === true });
        printRefreshHint(opts, {
          baseUrl: deps.baseUrl,
          context: `rule ${id} (tags: [${tags.join(', ')}])`,
        });
      }),
    );
}
