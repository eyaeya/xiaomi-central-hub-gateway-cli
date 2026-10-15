import { createRequire } from 'node:module';
import { Command } from 'commander';
import { wrap } from '../action-wrap.js';
import { emit } from '../output.js';
import { runUpdate } from '../update/service.js';

const require = createRequire(import.meta.url);
const { version } = require('../../package.json') as { version: string };

export function updateCommand(): Command {
  return new Command('update')
    .description('Upgrade this global npm CLI and synchronize installed Agent Skills.')
    .option('--check', 'check only; do not install')
    .option('--registry <https-url>', 'override update registry (or XGG_UPDATE_REGISTRY)')
    .option('--pretty', 'pretty-print JSON output')
    .addHelpText(
      'after',
      '\nExamples:\n  $ xgg update --check\n  $ xgg update\n  $ xgg update --registry https://registry.npmmirror.com\n\nDefault: npm official, then npmmirror. Mirror metadata may lag. No GitHub access required.\nAutomatic release checks run before finite queries, at most once every 24 hours;\nthe updated CLI executes the pending query once. XGG_AUTO_UPDATE=0 disables automatic updates.\nSource/local/npx/pnpm installs are check-only; use their original package manager.\nExisting managed Agent Skills are synchronized from the installed package, even when the CLI is current.\nCustomized copies are backed up before replacement; customization is not merged. Inspect the skills result.\nAutomatic local Skill repair also runs during the release-check cooldown and after an old CLI hands off.\nAfter synchronization, reread SKILL.md and relevant references. --check never writes Skills.\n',
    )
    .action(
      wrap('update', async (opts: { check?: boolean; registry?: string; pretty?: boolean }) => {
        const result = await runUpdate(version, {
          check: opts.check,
          registry: opts.registry ?? process.env.XGG_UPDATE_REGISTRY,
        });
        emit(result, { pretty: opts.pretty === true });
      }),
    );
}
