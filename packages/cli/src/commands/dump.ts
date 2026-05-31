import { ConfigError, createStore, dumpAll } from '@eyaeya/xgg-core';
import { Command } from 'commander';
import { wrap } from '../action-wrap.js';
import { emit } from '../output.js';

interface DumpOpts {
  baseUrl?: string;
  sessionFile?: string;
  timeout: string;
  pretty?: boolean;
}

export function dumpCommand(): Command {
  return new Command('dump')
    .description('Dump device list, rule list, and variable scopes as a single JSON document')
    .option('--base-url <url>', 'gateway base URL (or XGG_BASE_URL)')
    .option('--session-file <path>', 'session file path')
    .option('--timeout <ms>', 'request timeout in milliseconds', '10000')
    .option('--pretty', 'pretty-print JSON output')
    .addHelpText('after', '\nExample:\n  $ xgg dump > snapshot.json')
    .action(
      wrap('dump', async (opts: DumpOpts) => {
        const baseUrl = opts.baseUrl ?? process.env.XGG_BASE_URL;
        if (!baseUrl) throw new ConfigError('missing --base-url or XGG_BASE_URL');
        const store = createStore(opts.sessionFile ? { sessionFile: opts.sessionFile } : {});
        const result = await dumpAll({ baseUrl, store, timeoutMs: Number(opts.timeout) });
        emit({ ok: true, ...result }, { pretty: opts.pretty === true });
      }),
    );
}
