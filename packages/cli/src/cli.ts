#!/usr/bin/env node
import { ConfigError } from '@eyaeya/xgg-core';
import { CommanderError } from 'commander';
import { errorToExit, formatErrorJson } from './errors.js';
import { buildProgram } from './program.js';

async function main(): Promise<void> {
  const program = buildProgram();
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof CommanderError) {
      if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version') {
        process.exitCode = 0;
        return;
      }
      const configError = new ConfigError(err.message, { commanderCode: err.code });
      process.stderr.write(`${JSON.stringify(formatErrorJson(configError))}\n`);
      process.exitCode = errorToExit(configError).code;
      return;
    }
    process.stderr.write(`${JSON.stringify(formatErrorJson(err))}\n`);
    process.exitCode = errorToExit(err).code;
  }
}

await main();
