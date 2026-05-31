import { ConfigError, type RunAgentMainOptions, runAgentMain } from '@eyaeya/xgg-core';
import { Command } from 'commander';

interface AgentServeOpts {
  host?: string;
  sessionFile?: string;
  idleMs?: string;
}

/**
 * Hidden subcommand the CLI re-execs itself into when starting the per-host
 * agent. The parent spawns `node <cli-entry> agent serve --host <host>` with
 * `XGG_LOGIN_CODE` in the environment (so the single-use code never appears in
 * `ps`), waits for the `READY <json>` line on the child's stdout, then `unref`s
 * the child and exits.
 */
export function agentCommand(): Command {
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
      const passcode = process.env.XGG_LOGIN_CODE;
      if (!host) throw new ConfigError('agent serve: missing --host');
      if (!passcode) throw new ConfigError('agent serve: missing XGG_LOGIN_CODE in env');
      const idleMs = opts.idleMs ? Number(opts.idleMs) : undefined;
      if (idleMs !== undefined && (!Number.isFinite(idleMs) || idleMs <= 0)) {
        throw new ConfigError('agent serve: --idle-ms must be a positive number');
      }
      const mainOpts: RunAgentMainOptions = {
        host,
        passcode,
        agentVersion: '0.1.0',
      };
      if (opts.sessionFile) mainOpts.sessionFile = opts.sessionFile;
      if (idleMs !== undefined) mainOpts.idleMs = idleMs;
      const handle = await runAgentMain(mainOpts);
      // Wipe the env so it doesn't show in `/proc/<pid>/environ` for the
      // remainder of the agent's lifetime. `= undefined` would coerce to the
      // literal string "undefined" on process.env — delete is the only way.
      // biome-ignore lint/performance/noDelete: process.env requires real delete to remove the var
      delete process.env.XGG_LOGIN_CODE;
      // Graceful shutdown: when `xgg logout` sends SIGTERM (or the user
      // presses Ctrl-C), invoke the agent's stop chain so the IPC server
      // can unlink the Unix socket before the process exits.
      const shutdown = () => {
        void handle.stop();
      };
      process.once('SIGTERM', shutdown);
      process.once('SIGINT', shutdown);
      await handle.done;
    });

  return cmd;
}
