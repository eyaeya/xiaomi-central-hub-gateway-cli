import { ConfigError, type LoginInputs, login } from '@eyaeya/xgg-core';
import { Command } from 'commander';
import { wrap } from '../action-wrap.js';
import { resolveAgentBinary } from '../agent-binary.js';
import {
  addNextHintFlag,
  buildNextSteps,
  nextHintOptedOut,
  printNextStepHintLine,
  withNextSteps,
} from '../agent-hints.js';
import { emit } from '../output.js';

interface LoginOpts {
  code?: string;
  baseUrl?: string;
  sessionFile?: string;
  pretty?: boolean;
  nextHint?: boolean;
}

export function loginCommand(): Command {
  const cmd = new Command('login')
    .description('Authenticate with a 中枢网关极客版 using a 6-digit code.')
    .option('--code <code>', '6-digit login code (or set XGG_LOGIN_CODE)')
    .option('--base-url <url>', 'gateway base URL (or set XGG_BASE_URL)')
    .option('--session-file <path>', 'session file path (default ~/.xgg/session.json)')
    .option('--pretty', 'pretty-print JSON output')
    .addHelpText(
      'after',
      `
Example:
  $ xgg login --code <CODE>

Security:
  --code may be visible in the parent process argv and shell history.
  XGG_LOGIN_CODE avoids parent argv, but remains in its short-lived environment
  and may still enter shell history depending on how it is set.
  Neither form is forwarded in the detached agent's argv or environment.`,
    );
  addNextHintFlag(cmd);
  cmd.action(
    wrap('login', async (opts: LoginOpts) => {
      const code = opts.code ?? process.env.XGG_LOGIN_CODE;
      const baseUrl = opts.baseUrl ?? process.env.XGG_BASE_URL;
      if (!code) throw new ConfigError('missing --code or XGG_LOGIN_CODE');
      if (!baseUrl) throw new ConfigError('missing --base-url or XGG_BASE_URL');
      const loginOpts: LoginInputs = {
        baseUrl,
        passcode: code,
        agentBinary: resolveAgentBinary(),
      };
      if (opts.sessionFile) loginOpts.sessionFile = opts.sessionFile;
      const result = await login(loginOpts);
      const hints = buildNextSteps('login', result, opts);
      const baseJson = { ...(result as unknown as Record<string, unknown>) };
      const payload = nextHintOptedOut(opts) ? baseJson : withNextSteps(baseJson, hints);
      emit(payload, { pretty: opts.pretty === true });
      printNextStepHintLine(hints, opts, { contextLabel: 'login' });
    }),
  );
  return cmd;
}
