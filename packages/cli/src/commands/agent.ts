import type { Readable } from 'node:stream';
import {
  ConfigError,
  type RunAgentMainHandle,
  type RunAgentMainOptions,
  runAgentMain,
} from '@eyaeya/xgg-core';
import { Command } from 'commander';
import { parsePositiveTimerMs } from '../local-input.js';

interface AgentServeOpts {
  host?: string;
  sessionFile?: string;
  idleMs?: string;
}

export interface AgentCommandDeps {
  input?: Readable;
  startAgent?: (opts: RunAgentMainOptions) => Promise<RunAgentMainHandle>;
}

/**
 * Hidden subcommand the CLI re-execs itself into when starting the per-host
 * agent. The parent spawns `node <cli-entry> agent serve --host <host>`, sends
 * the single-use code over an anonymous stdin pipe, waits for the `READY
 * <json>` line on the child's stdout, then `unref`s the child and exits.
 */
export function agentCommand(deps: AgentCommandDeps = {}): Command {
  const cmd = new Command('agent').description('(internal) per-host agent daemon');

  cmd
    .command('serve', { hidden: true })
    .description('(internal) run the per-host agent daemon')
    .option('--host <url>', 'gateway base URL (required)')
    .option('--session-file <path>', 'session file path (default ~/.xgg/session.json)')
    .option('--idle-ms <ms>', 'idle window before self-exit (default 3600000)')
    // Intentionally NOT wrap()-ed: this is the daemon entry the parent re-execs
    // into. Its errors surface to the parent via stderr+exit (parent reads
    // READY/FAILED on the child's stdout, then unrefs); the CLI-user-facing
    // hint lookup in errors.ts does not apply to this internal subcommand.
    .action(async (opts: AgentServeOpts) => {
      const host = opts.host;
      if (!host) throw new ConfigError('agent serve: missing --host');
      const idleMs =
        opts.idleMs !== undefined ? parsePositiveTimerMs(opts.idleMs, '--idle-ms') : undefined;
      // Consume and close the one-shot pipe before any gateway connection.
      let passcode = await readOneShotLoginCode(deps.input ?? process.stdin);
      const mainOpts: RunAgentMainOptions = {
        host,
        passcode,
        agentVersion: '0.1.4',
      };
      if (opts.sessionFile) mainOpts.sessionFile = opts.sessionFile;
      if (idleMs !== undefined) mainOpts.idleMs = idleMs;
      let handle: RunAgentMainHandle;
      try {
        handle = await (deps.startAgent ?? runAgentMain)(mainOpts);
      } finally {
        // runAgentMain consumes the code during handshake. Drop references
        // before this async action waits for the long-lived daemon to exit.
        passcode = '';
        mainOpts.passcode = '';
      }
      // Graceful shutdown: when `xgg logout` sends SIGTERM (or the user
      // presses Ctrl-C), invoke the agent's stop chain so the IPC server
      // can unlink the Unix socket before the process exits.
      const shutdown = () => {
        void handle.stop();
      };
      process.once('SIGTERM', shutdown);
      process.once('SIGINT', shutdown);
      try {
        await handle.done;
      } finally {
        process.off('SIGTERM', shutdown);
        process.off('SIGINT', shutdown);
      }
    });

  return cmd;
}

const MAX_LOGIN_CODE_BYTES = 8;

/** Read the internal one-shot login-code pipe, then destroy and wipe buffers. */
export async function readOneShotLoginCode(input: Readable): Promise<string> {
  const secret = Buffer.alloc(MAX_LOGIN_CODE_BYTES);
  let length = 0;

  try {
    for await (const chunk of input) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (length + bytes.length > MAX_LOGIN_CODE_BYTES) {
        bytes.fill(0);
        throw new ConfigError('agent serve: login code pipe must contain 6–8 digits');
      }
      bytes.copy(secret, length);
      length += bytes.length;
      bytes.fill(0);
    }

    const passcode = secret.subarray(0, length).toString('utf8');
    if (!/^\d{6,8}$/.test(passcode)) {
      throw new ConfigError('agent serve: login code pipe must contain 6–8 digits');
    }
    return passcode;
  } finally {
    secret.fill(0);
    input.destroy();
  }
}
