#!/usr/bin/env node
import { CommanderError } from 'commander';
import { errorToExit, formatErrorJson } from './errors.js';
import { buildProgram } from './program.js';

async function main(): Promise<void> {
  const program = buildProgram();
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof CommanderError) {
      // commander already wrote help/usage to stderr; propagate its own exit code
      process.exit(err.exitCode);
    }
    process.stderr.write(`${JSON.stringify(formatErrorJson(err))}\n`);
    process.exit(errorToExit(err).code);
  }
}

await main();
