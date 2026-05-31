import { ConfigError, createStore, status } from '@xgg/core';
import { Command } from 'commander';
import { wrap } from '../action-wrap.js';
import { emit } from '../output.js';

interface StatusOpts {
  baseUrl?: string;
  sessionFile?: string;
  pretty?: boolean;
}

export function statusCommand(): Command {
  return new Command('status')
    .description('Show the per-host agent metadata plus a live IPC liveness probe.')
    .option('--base-url <url>', 'gateway base URL (or XGG_BASE_URL)')
    .option('--session-file <path>', 'session file path')
    .option('--pretty', 'pretty-print JSON output')
    .addHelpText('after', '\nExample:\n  $ xgg status --pretty')
    .action(
      wrap('status', async (opts: StatusOpts) => {
        const baseUrl = opts.baseUrl ?? process.env.XGG_BASE_URL;
        if (!baseUrl) throw new ConfigError('missing --base-url or XGG_BASE_URL');
        const store = createStore(opts.sessionFile ? { sessionFile: opts.sessionFile } : {});
        const result = await status({ baseUrl, store });
        emit(result, { pretty: opts.pretty === true });
      }),
    );
}
