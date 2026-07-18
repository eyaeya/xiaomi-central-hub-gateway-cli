import { Command } from 'commander';
import { agentCommand } from './commands/agent.js';
import { apiCommand } from './commands/api.js';
import { backupCommand } from './commands/backup.js';
import { deviceCommand } from './commands/device.js';
import { dumpCommand } from './commands/dump.js';
import { loginCommand } from './commands/login.js';
import { logoutCommand } from './commands/logout.js';
import { ruleCommand } from './commands/rule/index.js';
import { statusCommand } from './commands/status.js';
import { variableCommand } from './commands/variable.js';

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('xgg')
    .description('Xiaomi Gateway Geek Edition CLI for AI Coding')
    .version('0.1.4')
    .exitOverride();

  program.addCommand(apiCommand());
  program.addCommand(backupCommand());
  program.addCommand(deviceCommand());
  program.addCommand(dumpCommand());
  program.addCommand(loginCommand());
  program.addCommand(logoutCommand());
  program.addCommand(ruleCommand());
  program.addCommand(statusCommand());
  program.addCommand(variableCommand());
  program.addCommand(agentCommand(), { hidden: true });

  // Commander normally writes a human-formatted error before exitOverride()
  // throws. The executable converts that exception to the same single-line
  // CONFIG JSON envelope as action-level input failures, so suppress only the
  // pre-rendered error channel. Successful --help/--version still use stdout.
  configureMachineReadableErrors(program);

  program.addHelpText(
    'after',
    `
Examples:
  $ xgg login --code <CODE>                        Bind agent to gateway
  $ xgg dump > inventory.json                      Export best-effort indexes
  $ xgg rule list --pretty                         Table view
  $ xgg rule new --name "Evening automation"       Create an empty rule
  $ xgg backup list --from fds --pretty            List gateway cloud backups
  $ xgg rule set --body rule.json                  Upsert with pre-write snapshot
  $ xgg variable create --scope my --id v --type number --value 0 --name X
  $ xgg api /api/getDevList --pretty               Raw JSON-RPC escape hatch

Run each subcommand with --help for command-specific options.
`,
  );

  return program;
}

function configureMachineReadableErrors(command: Command): void {
  command.exitOverride();
  command.configureOutput({ outputError: () => {} });
  for (const child of command.commands) configureMachineReadableErrors(child);
}
