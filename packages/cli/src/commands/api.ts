import { readFileSync } from 'node:fs';
import { ConfigError, agentCall, createStore } from '@xgg/core';
import { Command } from 'commander';
import { wrap } from '../action-wrap.js';
import { emit } from '../output.js';

interface ApiOpts {
  params?: string;
  paramsFile?: string;
  baseUrl?: string;
  sessionFile?: string;
  timeout: string;
  pretty?: boolean;
}

export function apiCommand(): Command {
  return new Command('api')
    .description('Low-level escape hatch: forward a raw JSON-RPC call through the per-host agent.')
    .argument('<method>', 'JSON-RPC method name')
    .option('--params <json>', 'JSON params (string)')
    .option('--params-file <path>', 'JSON params from file')
    .option('--base-url <url>', 'gateway base URL (or XGG_BASE_URL)')
    .option('--session-file <path>', 'session file path')
    .option('--timeout <ms>', 'request timeout in milliseconds', '10000')
    .option('--pretty', 'pretty-print JSON output')
    .addHelpText(
      'after',
      '\nExamples:\n  $ xgg api /api/getDevList --pretty\n  $ xgg api /api/getGraph --params \'{"id":"1748234567890"}\'',
    )
    .action(
      wrap('api', async (method: string, opts: ApiOpts) => {
        const baseUrl = opts.baseUrl ?? process.env.XGG_BASE_URL;
        if (!baseUrl) throw new ConfigError('missing --base-url or XGG_BASE_URL');
        let params: unknown = null;
        if (opts.paramsFile) {
          params = JSON.parse(readFileSync(opts.paramsFile, 'utf8'));
        } else if (opts.params) {
          params = JSON.parse(opts.params);
        }
        const store = createStore(opts.sessionFile ? { sessionFile: opts.sessionFile } : {});
        const result = await agentCall({
          baseUrl,
          method,
          params,
          store,
          timeoutMs: Number(opts.timeout),
        });
        emit({ ok: true, method, result }, { pretty: opts.pretty === true });
      }),
    );
}
