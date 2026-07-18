import { ConfigError, createStore, dumpAll } from '@eyaeya/xgg-core';
import { Command } from 'commander';
import { wrap } from '../action-wrap.js';
import { parsePositiveTimerMs } from '../local-input.js';
import { emit } from '../output.js';

interface DumpOpts {
  baseUrl?: string;
  sessionFile?: string;
  timeout: string;
  pretty?: boolean;
}

export function dumpCommand(): Command {
  return new Command('dump')
    .description('Dump a best-effort device/rule/scope inventory as JSON (not a rollback snapshot)')
    .option('--base-url <url>', 'gateway base URL (or XGG_BASE_URL)')
    .option('--session-file <path>', 'session file path')
    .option('--timeout <ms>', 'request timeout in milliseconds', '10000')
    .option('--pretty', 'pretty-print JSON output')
    .addHelpText('after', '\nExample:\n  $ xgg dump > inventory.json')
    .action(
      wrap('dump', async (opts: DumpOpts) => {
        const baseUrl = opts.baseUrl ?? process.env.XGG_BASE_URL;
        if (!baseUrl) throw new ConfigError('missing --base-url or XGG_BASE_URL');
        const timeoutMs = parsePositiveTimerMs(opts.timeout, '--timeout');
        const store = createStore(opts.sessionFile ? { sessionFile: opts.sessionFile } : {});
        const result = await dumpAll({ baseUrl, store, timeoutMs });
        const partial = result.errors.length > 0;
        emit({ ok: !partial, partial, ...result }, { pretty: opts.pretty === true });
        if (partial) process.exitCode = 1;
      }),
    );
}
