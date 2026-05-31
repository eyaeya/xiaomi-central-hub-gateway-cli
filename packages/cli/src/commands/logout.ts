import { AuthRequiredError, ConfigError, type SessionStore, createStore, logout } from '@xgg/core';
import { Command } from 'commander';
import { wrap } from '../action-wrap.js';
import { emit } from '../output.js';

/**
 * When --base-url is omitted, fall back to the session store:
 *  - 0 entries → AuthRequiredError (nothing to log out from)
 *  - 1 entry  → use that host automatically
 *  - N entries → ConfigError with actionable hint
 */
async function resolveBaseUrl(explicit: string | undefined, store: SessionStore): Promise<string> {
  if (explicit) return explicit;

  const hosts = await store.hosts();
  if (hosts.length === 0) {
    throw new AuthRequiredError('no active session');
  }
  if (hosts.length > 1) {
    throw new ConfigError(
      `multiple active sessions: ${hosts.join(', ')}; specify --base-url=<host>`,
    );
  }
  // Exactly one host — use it.
  return hosts[0] as string;
}

interface LogoutOpts {
  baseUrl?: string;
  sessionFile?: string;
  pretty?: boolean;
}

export function logoutCommand(): Command {
  return new Command('logout')
    .description('Stop the per-host agent and remove its session entry.')
    .option('--base-url <url>', 'gateway base URL (or XGG_BASE_URL)')
    .option('--session-file <path>', 'session file path')
    .option('--pretty', 'pretty-print JSON output')
    .addHelpText('after', '\nExample:\n  $ xgg logout')
    .action(
      wrap('logout', async (opts: LogoutOpts) => {
        const store = createStore(opts.sessionFile ? { sessionFile: opts.sessionFile } : {});
        const baseUrl = await resolveBaseUrl(opts.baseUrl ?? process.env.XGG_BASE_URL, store);
        const result = await logout({ baseUrl, store });
        emit(result, { pretty: opts.pretty === true });
      }),
    );
}
