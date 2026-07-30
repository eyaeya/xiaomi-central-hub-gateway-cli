import { ConfigError, createStore, listDevices, planHabitLearning } from '@eyaeya/xgg-core';
import { Command } from 'commander';
import { wrap } from '../action-wrap.js';
import { parsePositiveTimerMs } from '../local-input.js';
import { emit } from '../output.js';
import { collectHabitLearningPlannerInputs } from './learn-inputs.js';
import { attachHabitLearningLifecycle } from './learn-lifecycle.js';

interface LearnPlanOpts {
  baseUrl?: string;
  sessionFile?: string;
  timeout: string;
  includeContext?: boolean;
  includeSensitive?: boolean;
  excludeDevice?: string[];
  excludeRoom?: string[];
  pretty?: boolean;
}

export function learnCommand(): Command {
  const cmd = new Command('learn').description(
    'Plan, collect, clarify, and reuse a private household habit study',
  );

  cmd
    .command('plan')
    .description('Build a habit-learning coverage plan from live inventory and MIoT specs')
    .option('--include-context', 'include general P1 environmental context signals')
    .option('--include-sensitive', 'include eligible sensitive signals')
    .option('--exclude-device <did...>', 'exclude one or more device IDs from the plan')
    .option('--exclude-room <room-id...>', 'exclude one or more room IDs from the plan')
    .option('--base-url <url>', 'gateway base URL (or XGG_BASE_URL)')
    .option('--session-file <path>', 'session file path')
    .option('--timeout <ms>', 'gateway and MIoT spec request timeout in milliseconds', '10000')
    .option('--pretty', 'pretty-print JSON output')
    .addHelpText(
      'after',
      '\nThis command only reads /api/getDevList and the public MIoT spec registry. It never creates, updates, enables, disables, or deletes gateway resources.\n\nExample:\n  $ xgg learn plan --include-context --pretty',
    )
    .action(
      wrap('learn.plan', async (opts: LearnPlanOpts) => {
        const baseUrl = opts.baseUrl ?? process.env.XGG_BASE_URL;
        if (!baseUrl) throw new ConfigError('missing --base-url or XGG_BASE_URL');
        const timeoutMs = parsePositiveTimerMs(opts.timeout, '--timeout');
        const store = createStore(
          opts.sessionFile
            ? { sessionFile: opts.sessionFile }
            : process.env.XGG_SESSION_FILE
              ? { sessionFile: process.env.XGG_SESSION_FILE }
              : {},
        );

        const inventory = await listDevices({ baseUrl, store, timeoutMs });
        const collected = await collectHabitLearningPlannerInputs(inventory, timeoutMs);
        const plan = planHabitLearning({
          devices: collected.devices,
          includeContext: opts.includeContext === true,
          includeSensitive: opts.includeSensitive === true,
          excludedDeviceIds: opts.excludeDevice ?? [],
          excludedRoomIds: opts.excludeRoom ?? [],
        });
        const partial = collected.specFailures.length > 0;

        emit(
          {
            ok: true,
            partial,
            readOnly: true,
            specFetch: {
              attemptedDeviceCount: collected.attemptedDeviceCount,
              loadedDeviceCount: collected.loadedDeviceCount,
              failedDeviceCount: collected.specFailures.length,
            },
            specFailures: collected.specFailures,
            plan,
          },
          { pretty: opts.pretty === true },
        );
      }),
    );

  attachHabitLearningLifecycle(cmd);
  return cmd;
}
