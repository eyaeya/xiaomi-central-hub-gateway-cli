import {
  ConfigError,
  type DeviceReplacementPlan,
  type DeviceReplacementSelector,
  dumpBeforeWrite,
  planDeviceReplacement,
  replaceDevice,
} from '@eyaeya/xgg-core';
import type { Command } from 'commander';
import { wrap } from '../../action-wrap.js';
import { emit } from '../../output.js';
import {
  addRefreshHintFlag,
  assertAgentModeOrSnapshotsDir,
  printRefreshHint,
  runMutationWorkflow,
} from '../_mutation-guard.js';
import { type RuleOpts, makeDeps } from './_deps.js';

interface ReplacementOpts extends RuleOpts {
  ruleId: string;
  nodeId: string;
  targetDid?: string;
  targetSiid?: string;
  targetPiid?: string;
  targetEiid?: string;
  targetAiid?: string;
}

interface ReplaceOpts extends ReplacementOpts {
  targetDid: string;
  apply?: boolean;
  confirmTargetDid?: string;
  snapshot?: boolean;
  snapshotsDir?: string;
  refreshHint?: boolean;
}

function parseIid(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new ConfigError(`${flag} must be a positive decimal integer`, { flag });
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new ConfigError(`${flag} must be a safe positive decimal integer`, { flag });
  }
  return value;
}

function selectorFromOpts(opts: ReplacementOpts): DeviceReplacementSelector {
  const selector: DeviceReplacementSelector = {
    ...(opts.targetSiid !== undefined && {
      siid: parseIid(opts.targetSiid, '--target-siid') as number,
    }),
    ...(opts.targetPiid !== undefined && {
      piid: parseIid(opts.targetPiid, '--target-piid') as number,
    }),
    ...(opts.targetEiid !== undefined && {
      eiid: parseIid(opts.targetEiid, '--target-eiid') as number,
    }),
    ...(opts.targetAiid !== undefined && {
      aiid: parseIid(opts.targetAiid, '--target-aiid') as number,
    }),
  };
  const capabilitySelectors = [selector.piid, selector.eiid, selector.aiid].filter(
    (value) => value !== undefined,
  );
  if (capabilitySelectors.length > 1) {
    throw new ConfigError(
      'use only one of --target-piid, --target-eiid, or --target-aiid for a replacement mapping',
    );
  }
  return selector;
}

function planInput(opts: ReplacementOpts, selector: DeviceReplacementSelector) {
  return {
    ruleId: opts.ruleId,
    nodeId: opts.nodeId,
    ...(opts.targetDid !== undefined && { targetDid: opts.targetDid }),
    ...(Object.keys(selector).length > 0 && { selector }),
  };
}

function assertPlanCanApply(plan: DeviceReplacementPlan, targetDid: string): string {
  if (plan.planId !== undefined && plan.selectedMapping !== undefined) return plan.planId;
  const candidate = plan.candidates.find((entry) => entry.did === targetDid);
  if (plan.selectionError !== undefined) {
    throw new ConfigError(plan.selectionError.message, {
      targetDid,
      selector: plan.selectionError.selector,
      ...(plan.selectionError.details !== undefined && {
        selectionDetails: plan.selectionError.details,
      }),
      candidate,
    });
  }
  throw new ConfigError(
    `device ${targetDid} does not resolve to exactly one compatible mapping; inspect the dry-run and select an explicit target capability`,
    {
      targetDid,
      candidate,
    },
  );
}

function addConnectionOptions(command: Command): Command {
  return command
    .option('--base-url <url>', 'gateway base URL (or XGG_BASE_URL)')
    .option('--session-file <path>', 'session file path')
    .option('--timeout <ms>', 'request timeout', '10000')
    .option('--pretty', 'pretty-print JSON output');
}

function addSelectorOptions(command: Command): Command {
  return command
    .option('--target-siid <iid>', 'select a compatible target service iid')
    .option('--target-piid <iid>', 'select a compatible target property iid')
    .option('--target-eiid <iid>', 'select a compatible target event iid')
    .option('--target-aiid <iid>', 'select a compatible target action iid');
}

export function attachDeviceReplacement(cmd: Command): void {
  const device =
    cmd.commands.find((entry) => entry.name() === 'device') ??
    cmd.command('device').description('Capability-aware device-card operations');

  const replacements = device
    .command('replacements')
    .description(
      'Read-only: explain compatible replacement devices and every capability contract check',
    )
    .requiredOption('--rule-id <id>', 'rule id')
    .requiredOption('--node-id <id>', 'one of the five device-card node ids')
    .option('--target-did <did>', 'focus the dry-run on one target device');
  addConnectionOptions(addSelectorOptions(replacements))
    .addHelpText(
      'after',
      [
        '',
        'This command never writes. Compatibility mirrors the official editor:',
        'URN first five segments, dtype, value-range min/max/step, value-list',
        'values, event arguments, and action inputs.',
        'Default discovery excludes ghost devices. A focused ghost target is returned',
        'as eligible=false with no planId and remains diagnostic-only.',
        '',
        'Examples:',
        '  $ xgg rule device replacements --rule-id 123 --node-id lightOn --pretty',
        '  $ xgg rule device replacements --rule-id 123 --node-id lightOn --target-did lumi.target --pretty',
      ].join('\n'),
    )
    .action(
      wrap('rule.device.replacements', async (opts: ReplacementOpts) => {
        const selector = selectorFromOpts(opts);
        if (Object.keys(selector).length > 0 && opts.targetDid === undefined) {
          throw new ConfigError('target capability selectors require --target-did');
        }
        const plan = await planDeviceReplacement(planInput(opts, selector), makeDeps(opts));
        emit({ ok: true, plan }, { pretty: opts.pretty === true });
      }),
    );

  const replace = device
    .command('replace')
    .description(
      'Dry-run by default; replace one device card only with --apply and exact DID confirmation',
    )
    .requiredOption('--rule-id <id>', 'rule id')
    .requiredOption('--node-id <id>', 'one of the five device-card node ids')
    .requiredOption('--target-did <did>', 'replacement device DID')
    .option('--apply', 'write the replacement after a second fresh spec check')
    .option(
      '--confirm-target-did <did>',
      'required with --apply and must exactly equal --target-did',
    )
    .option('--no-snapshot', 'unsupported: device replacement always requires a rollback snapshot')
    .option(
      '--snapshots-dir <path>',
      'directory for the pre-write rollback snapshot (env: XGG_SNAPSHOTS_DIR)',
    );
  addRefreshHintFlag(addConnectionOptions(addSelectorOptions(replace)))
    .addHelpText(
      'after',
      [
        '',
        'Safety flow for --apply: one mutation lease -> dry-run -> rollback snapshot',
        '-> fresh graph/device/spec recheck -> strict graph validation -> setGraph -> readback.',
        'The fresh device inventory rejects a target that is or became a ghost before setGraph.',
        'The MIoT recheck bypasses process caches. A final live graph read detects external edits;',
        'the gateway has no CAS, so stop editing the web canvas during --apply.',
        'Node id, inputs, outputs, edges, comparison values, and variable settings are preserved.',
        '',
        'Examples:',
        '  $ xgg rule device replace --rule-id 123 --node-id lightOn --target-did lumi.target --pretty',
        '  $ xgg rule device replace --rule-id 123 --node-id lightOn --target-did lumi.target \\',
        '      --target-siid 2 --target-piid 1 --apply --confirm-target-did lumi.target \\',
        '      --snapshots-dir ./snapshots/',
      ].join('\n'),
    )
    .action(
      wrap('rule.device.replace', async (opts: ReplaceOpts) => {
        const selector = selectorFromOpts(opts);
        const deps = makeDeps(opts);
        const input = planInput(opts, selector);

        if (opts.apply !== true) {
          const plan = await planDeviceReplacement(input, deps);
          emit({ ok: true, dryRun: true, plan }, { pretty: opts.pretty === true });
          return;
        }
        if (opts.confirmTargetDid !== opts.targetDid) {
          throw new ConfigError(
            '--apply requires --confirm-target-did to exactly equal --target-did',
            { targetDid: opts.targetDid },
          );
        }

        const guard = assertAgentModeOrSnapshotsDir(opts);
        if (!guard.snapshotEnabled) {
          throw new ConfigError(
            'device replacement always requires a pre-write rollback snapshot; remove --no-snapshot',
          );
        }
        const outcome = await runMutationWorkflow('rule.device.replace', deps, async () => {
          const initialPlan = await planDeviceReplacement(input, deps);
          const expectedPlanId = assertPlanCanApply(initialPlan, opts.targetDid);
          const snapshot = await dumpBeforeWrite({
            baseUrl: deps.baseUrl,
            store: deps.store,
            ...(deps.timeoutMs !== undefined && { timeoutMs: deps.timeoutMs }),
            ...(guard.snapshotsDir !== undefined && { snapshotsDir: guard.snapshotsDir }),
          });
          const result = await replaceDevice(
            {
              ruleId: opts.ruleId,
              nodeId: opts.nodeId,
              targetDid: opts.targetDid,
              expectedPlanId,
              rollbackSnapshotPath: snapshot,
              ...(Object.keys(selector).length > 0 && { selector }),
            },
            deps,
          );
          return { snapshot, result };
        });
        emit(
          {
            ok: true,
            dryRun: false,
            snapshot: outcome.snapshot,
            result: outcome.result,
          },
          { pretty: opts.pretty === true },
        );
        printRefreshHint(opts, {
          baseUrl: deps.baseUrl,
          context: `rule ${opts.ruleId} (device-replace ${opts.nodeId} -> ${opts.targetDid})`,
        });
      }),
    );
}
