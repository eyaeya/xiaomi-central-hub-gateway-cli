// SPDX-License-Identifier: GPL-3.0-or-later
import { resolve } from 'node:path';
import { ConfigError, createCloudTransport, loginGatewayViaCloud } from '@eyaeya/xgg-core';
import { Command } from 'commander';
import { wrap } from '../action-wrap.js';
import { resolveAgentBinary } from '../agent-binary.js';
import { emit } from '../output.js';
import { renderNextCommand } from './_next-command.js';

export function cloudGatewayCommand(): Command {
  const gateway = new Command('gateway').description(
    'Bootstrap a gateway session through Mi Home.',
  );
  const command = new Command('login')
    .description('Fetch a gateway code in memory and log in; reuse a live daemon when possible.')
    .requiredOption('--did <did>', 'explicit gateway, router or smart-screen cloud DID')
    .option('--base-url <url>', 'override the gateway address (or XGG_BASE_URL)')
    .option('--session-file <path>', 'gateway session file (or XGG_SESSION_FILE)')
    .option('--auth-file <path>', 'Mi Home auth file (or XGG_CLOUD_AUTH_FILE)')
    .option('--timeout <ms>', 'cloud request timeout in milliseconds')
    .option('--pretty', 'pretty-print JSON');
  command.action(
    wrap('cloud.gateway.login', async () => {
      const opts = command.optsWithGlobals();
      const timeoutMs = Number(opts.timeout ?? 15000);
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
        throw new ConfigError('--timeout must be a positive integer');
      }
      const authFile = opts.authFile ?? process.env.XGG_CLOUD_AUTH_FILE;
      const baseUrl = opts.baseUrl ?? process.env.XGG_BASE_URL;
      const sessionFile = opts.sessionFile ?? process.env.XGG_SESSION_FILE;
      const transport = createCloudTransport({ ...(authFile ? { authFile } : {}), timeoutMs });
      const result = await loginGatewayViaCloud(transport, {
        did: opts.did,
        ...(baseUrl ? { baseUrl } : {}),
        ...(sessionFile ? { sessionFile } : {}),
        agentBinary: resolveAgentBinary(),
      });
      const argv = ['xgg', 'status', '--base-url', result.host];
      if (sessionFile) argv.push('--session-file', resolve(sessionFile));
      emit(
        { ...result, baseUrl: result.host, ...renderNextCommand(argv) },
        { pretty: opts.pretty === true },
      );
    }),
  );
  gateway.addCommand(command);
  return gateway;
}
