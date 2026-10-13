// SPDX-License-Identifier: GPL-3.0-or-later
import {
  ConfigError,
  NetworkError,
  cloudLogout,
  cloudStatus,
  writeCloudSnapshot,
} from '@eyaeya/xgg-core';
import { Command } from 'commander';
import { wrap } from '../action-wrap.js';
import { emit } from '../output.js';
import { assertAgentModeOrSnapshotsDir } from './_mutation-guard.js';
import { cloudGatewayCommand } from './cloud-gateway.js';
import { cloudLoginCommand, removeCloudLoginQr } from './cloud-login.js';
import {
  type CloudOpts,
  batchPropertyFlags,
  client,
  deviceFlags,
  deviceSelector,
  options,
  positiveInteger,
  propertyFlags,
  propertySelections,
  propertySelector,
  runtimeOptions,
  sourcePolicy,
} from './cloud-options.js';
import { cloudWatchCommand } from './cloud-watch.js';

function nonnegativeInteger(raw: string, flag: string): number {
  if (!/^(0|[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new ConfigError(`${flag} must be a nonnegative decimal integer`);
  }
  return Number(raw);
}

function parseJson(raw: string, flag: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new ConfigError(`${flag} must be valid JSON`);
  }
}

function actionSelector(opts: CloudOpts) {
  const inputs = parseJson(opts.inputs ?? '[]', '--inputs');
  if (!Array.isArray(inputs)) throw new ConfigError('--inputs must be a JSON array');
  if (opts.action !== undefined) {
    if (!opts.action.trim() || opts.siid !== undefined || opts.aiid !== undefined) {
      throw new ConfigError('Use --action or the pair --siid/--aiid, not both');
    }
    return { action: opts.action, inputs };
  }
  if (opts.siid === undefined || opts.aiid === undefined) {
    throw new ConfigError('Specify --action or both --siid and --aiid');
  }
  return {
    siid: positiveInteger(opts.siid, '--siid'),
    aiid: positiveInteger(opts.aiid, '--aiid'),
    inputs,
  };
}

function mutationFlags(cmd: Command): Command {
  return cmd
    .option('--snapshots-dir <path>', 'private cloud audit snapshots (or XGG_SNAPSHOTS_DIR)')
    .option('--no-snapshot', 'skip audit snapshot; forbidden in XGG_AGENT_MODE=1');
}

async function snapshot(
  opts: CloudOpts,
  operation: string,
  target: Record<string, unknown>,
  request: Record<string, unknown>,
  before?: unknown,
): Promise<string | null> {
  const guard = assertAgentModeOrSnapshotsDir(opts);
  if (!guard.snapshotEnabled) return null;
  return writeCloudSnapshot({
    operation,
    target,
    request,
    ...(before !== undefined && { before }),
    ...(guard.snapshotsDir !== undefined && { snapshotsDir: guard.snapshotsDir }),
  });
}

function output(payload: Record<string, unknown>, opts: CloudOpts): void {
  emit({ ok: true, ...payload }, { pretty: opts.pretty === true });
}

export function cloudCommand(): Command {
  const cloud = new Command('cloud')
    .description('Control Xiaomi Home devices through the cloud, independently of gateway login')
    .option('--auth-file <path>', 'cloud auth file (or XGG_CLOUD_AUTH_FILE)')
    .option('--timeout <ms>', 'cloud request timeout in milliseconds', '15000')
    .option('--pretty', 'indent JSON output')
    .addHelpText(
      'after',
      `
Examples:
  $ xgg cloud login                         Start QR authorization
  $ xgg cloud login --complete              Finish after scanning the QR URL
  $ xgg cloud device list
  $ xgg cloud device get --did <DID> --property light.on
  $ xgg cloud device set --did <DID> --property light.on --value true
  $ xgg rule logs <RULE_ID> --since <ISO_TIMESTAMP> --json

Cloud writes report API acknowledgement; accepted/unconfirmed does not prove
physical execution. Cloud action snapshots are audit records, not rollback backups.`,
    );

  cloud.addCommand(cloudLoginCommand());
  cloud
    .command('status')
    .description('Show non-secret cloud authentication status')
    .action(
      wrap('cloud.status', async (_local: unknown, command: Command) => {
        const opts = options(command);
        output(await cloudStatus(runtimeOptions(opts)), opts);
      }),
    );
  cloud
    .command('logout')
    .description('Remove local cloud credentials and pending QR authorization')
    .action(
      wrap('cloud.logout', async (_local: unknown, command: Command) => {
        const opts = options(command);
        await cloudLogout(runtimeOptions(opts));
        await removeCloudLoginQr(runtimeOptions(opts).authFile);
        output({ authenticated: false }, opts);
      }),
    );

  const device = cloud.command('device').description('Cloud device discovery and MIoT control');
  device
    .command('list')
    .description('List cloud devices with secret and location fields removed')
    .option('--home-id <id>', 'filter by home ID')
    .action(
      wrap('cloud.device.list', async (_local: unknown, command: Command) => {
        const opts = options(command);
        output({ devices: await client(opts).listDevices(opts.homeId) }, opts);
      }),
    );
  deviceFlags(
    device.command('spec').description('Show readable/writable properties and actions'),
  ).action(
    wrap('cloud.device.spec', async (_local: unknown, command: Command) => {
      const opts = options(command);
      const selector = deviceSelector(opts);
      output({ spec: await client(opts).deviceSpec(selector) }, opts);
    }),
  );
  batchPropertyFlags(
    deviceFlags(
      device.command('get').description('Read one, selected, or all readable properties'),
    ),
  ).action(
    wrap('cloud.device.get', async (_local: unknown, command: Command) => {
      const opts = options(command);
      const selector = deviceSelector(opts);
      const properties = propertySelections(opts);
      const source = sourcePolicy(opts);
      const api = client(opts);
      const singleProperty = properties?.[0];
      if (singleProperty && properties.length === 1 && opts.properties === undefined) {
        output(
          {
            sourcePolicy: source,
            result: await api.getProperty(selector, singleProperty, { source }),
          },
          opts,
        );
      } else {
        output(
          {
            sourcePolicy: source,
            results: await api.getProperties(selector, properties, { source }),
          },
          opts,
        );
      }
    }),
  );
  device.addCommand(cloudWatchCommand());
  cloud
    .command('spec')
    .description('Read a public MIoT specification without account authorization')
    .requiredOption('--type <urn>', 'full MIoT device specification URN')
    .action(
      wrap('cloud.spec', async (_local: unknown, command: Command) => {
        const opts = command.optsWithGlobals<CloudOpts & { type: string }>();
        output({ spec: await client(opts).specByType(opts.type) }, opts);
      }),
    );
  mutationFlags(
    propertyFlags(
      deviceFlags(device.command('set').description('Set a writable device property')),
    ).requiredOption('--value <json>', 'new property value as JSON (e.g. true, 50, or "auto")'),
  ).action(
    wrap('cloud.device.set', async (_local: unknown, command: Command) => {
      const opts = options(command);
      assertAgentModeOrSnapshotsDir(opts);
      const selector = deviceSelector(opts);
      const property = propertySelector(opts);
      const value = parseJson(opts.value ?? '', '--value');
      const api = client(opts);
      const selectedDevice = await api.resolveDevice(selector);
      const target = { did: selectedDevice.did, ...(opts.homeId ? { homeId: opts.homeId } : {}) };
      let before: unknown;
      try {
        const previous = await api.getProperty(target, property, { source: 'device' });
        if (previous.code !== 0 || previous.value === undefined) {
          throw new NetworkError('Cloud pre-write value is not confirmed; no write was sent', {
            domain: 'cloud',
          });
        }
        before = { ...previous, sourcePolicy: 'device' };
      } catch (error) {
        if (
          !(error instanceof ConfigError) ||
          error.details?.domain !== 'cloud' ||
          error.details?.reason !== 'property-not-readable'
        ) {
          throw error;
        }
        before = { unavailable: 'property-not-readable' };
      }
      const checkpoint = await snapshot(opts, 'device.set', target, { ...property, value }, before);
      const result = await api.setProperty(target, property, value);
      output({ snapshot: checkpoint, result }, opts);
    }),
  );
  mutationFlags(
    deviceFlags(device.command('action').description('Invoke a MIoT device action'))
      .option('--action <name>', 'action name, service.action, or SIID.AIID')
      .option('--siid <id>', 'MIoT service instance ID')
      .option('--aiid <id>', 'MIoT action instance ID')
      .option('--inputs <json>', 'action input values as a JSON array', '[]'),
  ).action(
    wrap('cloud.device.action', async (_local: unknown, command: Command) => {
      const opts = options(command);
      assertAgentModeOrSnapshotsDir(opts);
      const selector = deviceSelector(opts);
      const action = actionSelector(opts);
      const api = client(opts);
      const checkpoint = await snapshot(opts, 'device.action', selector, action);
      output({ snapshot: checkpoint, result: await api.action(selector, action) }, opts);
    }),
  );

  cloud
    .command('home')
    .description('Cloud homes and rooms')
    .command('list')
    .action(
      wrap('cloud.home.list', async (_local: unknown, command: Command) => {
        const opts = options(command);
        output({ homes: await client(opts).listHomes() }, opts);
      }),
    );
  const scene = cloud.command('scene').description('Cloud scenes');
  scene
    .command('list')
    .option('--home-id <id>', 'filter by home ID')
    .action(
      wrap('cloud.scene.list', async (_local: unknown, command: Command) => {
        const opts = options(command);
        output({ scenes: await client(opts).listScenes(opts.homeId) }, opts);
      }),
    );
  mutationFlags(
    scene.command('run <scene-id>').requiredOption('--home-id <id>', 'home containing the scene'),
  ).action(
    wrap('cloud.scene.run', async (sceneId: string, _local: unknown, command: Command) => {
      const opts = options(command);
      assertAgentModeOrSnapshotsDir(opts);
      const homeId = opts.homeId ?? '';
      const api = client(opts);
      const checkpoint = await snapshot(opts, 'scene.run', { sceneId, homeId }, {});
      output({ snapshot: checkpoint, result: await api.runScene(sceneId, homeId) }, opts);
    }),
  );
  cloud
    .command('consumable')
    .description('Device consumable status')
    .command('list')
    .option('--home-id <id>', 'filter by home ID')
    .action(
      wrap('cloud.consumable.list', async (_local: unknown, command: Command) => {
        const opts = options(command);
        output({ consumables: await client(opts).listConsumables(opts.homeId) }, opts);
      }),
    );
  cloud
    .command('statistics')
    .description('Query historical device statistics (epoch seconds)')
    .requiredOption('--did <id>', 'device DID')
    .requiredOption('--key <key>', 'statistics key')
    .requiredOption('--data-type <type>', 'statistics type (e.g. stat_day_v3)')
    .requiredOption('--start <seconds>', 'inclusive start timestamp in epoch seconds')
    .requiredOption('--end <seconds>', 'end timestamp in epoch seconds')
    .option('--limit <count>', 'maximum records', '20')
    .action(
      wrap('cloud.statistics', async (_local: unknown, command: Command) => {
        const opts = command.optsWithGlobals<
          CloudOpts & {
            key: string;
            dataType: string;
            start: string;
            end: string;
            limit: string;
          }
        >();
        const start = nonnegativeInteger(opts.start, '--start');
        const end = nonnegativeInteger(opts.end, '--end');
        if (end < start) throw new ConfigError('--end must be at or after --start');
        const params = {
          did: opts.did ?? '',
          key: opts.key,
          data_type: opts.dataType,
          limit: positiveInteger(opts.limit, '--limit'),
          time_start: start,
          time_end: end,
        };
        output({ statistics: await client(opts).statistics(params) }, opts);
      }),
    );
  const speaker = cloud.command('speaker').description('XiaoAI voice instructions and speech');
  for (const kind of ['run', 'play'] as const) {
    const speakerCommand = mutationFlags(
      deviceFlags(speaker.command(kind)).requiredOption(
        '--text <text>',
        kind === 'run' ? 'voice instruction' : 'text to speak',
      ),
    );
    if (kind === 'run') {
      speakerCommand.option('--quiet', 'suppress spoken response (default)', true);
      speakerCommand.option('--no-quiet', 'allow a spoken response');
    }
    speakerCommand.action(
      wrap(`cloud.speaker.${kind}`, async (_local: unknown, command: Command) => {
        const opts = command.optsWithGlobals<CloudOpts & { text: string; quiet?: boolean }>();
        assertAgentModeOrSnapshotsDir(opts);
        if (!opts.text.trim()) throw new ConfigError('--text must not be empty');
        const selector = deviceSelector(opts);
        const api = client(opts);
        const checkpoint = await snapshot(opts, `speaker.${kind}`, selector, {
          text: opts.text,
          quiet: kind === 'run' && opts.quiet !== false,
        });
        output(
          {
            snapshot: checkpoint,
            result: await api.speaker(
              selector,
              opts.text,
              kind,
              kind === 'run' && opts.quiet !== false,
            ),
          },
          opts,
        );
      }),
    );
  }
  cloud.addCommand(cloudGatewayCommand());
  return cloud;
}
