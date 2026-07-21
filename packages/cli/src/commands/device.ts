import {
  ConfigError,
  createStore,
  getDevice,
  getDevicePartitions,
  getDeviceSpec,
  isGhostDevice,
  listDevices,
} from '@eyaeya/xgg-core';
import Table from 'cli-table3';
import { Command } from 'commander';
import { wrap } from '../action-wrap.js';
import {
  addNextHintFlag,
  buildNextSteps,
  nextHintOptedOut,
  printNextStepHintLine,
  withNextSteps,
} from '../agent-hints.js';
import { prepareDeviceSpecOutput } from '../device-spec-output.js';
import {
  prepareDeviceTypeProjection,
  renderDeviceGetPretty,
  renderDeviceListPretty,
} from '../device-type-output.js';
import { parsePositiveTimerMs } from '../local-input.js';
import { type TableColumn, emit, emitList } from '../output.js';

interface DeviceOpts {
  baseUrl?: string;
  sessionFile?: string;
  timeout: string;
  pretty?: boolean;
  nextHint?: boolean;
}

interface DeviceListOpts extends DeviceOpts {
  includeGhost?: boolean;
}

function makeDeps(opts: DeviceOpts) {
  const baseUrl = opts.baseUrl ?? process.env.XGG_BASE_URL;
  if (!baseUrl) throw new ConfigError('missing --base-url or XGG_BASE_URL');
  const timeoutMs = parsePositiveTimerMs(opts.timeout, '--timeout');
  const store = createStore(opts.sessionFile ? { sessionFile: opts.sessionFile } : {});
  return { baseUrl, store, timeoutMs };
}

interface DeviceFields {
  online: boolean;
  pushAvailable: boolean;
  specV2Access: boolean;
  specV3Access: boolean;
  urn?: string;
}

// Derive the device's "availability bucket" matching the web UI three-state.
// M8 follow-up; M9 user verification (`设备已丢失` reported inside an
// autoLocal rule when targeting a ghost device + `-9999 user ack timeout`
// observed via `xgg rule logs`) downgrades ghost from "CLI bonus capability"
// to "autoLocal cannot route commands here":
//
//   ● full     — online && pushAvailable && (specV2Access || specV3Access)
//   ◐ partial  — online && !pushAvailable && spec access (web 部分可用)
//   ○ offline  — !online (web 不可用)
//   ? ghost    — online but no spec access; web hides them and autoLocal
//                does NOT route commands to them. M9 default-excludes from
//                `device list`; `--include-ghost` opts in for debugging.
function availabilityLabel(dev: DeviceFields): string {
  if (!dev.online) return '○ offline';
  const hasSpec = dev.specV2Access || dev.specV3Access;
  if (!hasSpec) return '? ghost';
  if (dev.pushAvailable) return '● full';
  return '◐ partial';
}

export function isGhost(dev: DeviceFields): boolean {
  return isGhostDevice(dev);
}

export function deviceCommand(): Command {
  const cmd = new Command('device').description('Device read operations');
  // Set expectations without making a firmware-global impossibility claim:
  // the current xgg modeled surface has no generic live-property stream.
  cmd.addHelpText(
    'after',
    '\nNote: current xgg device reads (list/get/spec) are one-shot snapshots. The\ncurrent xgg modeled client surface does not expose a generic live-property\nstream. For a modeled observation path, copy values into a variable with a\nrule — `deviceInputSetVar` (on change) or `deviceGetSetVar` (on demand) — then\nrun `xgg variable watch --follow`. This is not a claim about every\nfirmware-private API.',
  );

  const listCmd = cmd
    .command('list')
    .description(
      'List devices on the gateway (ghost devices — online but no spec access — are excluded by default; --include-ghost to opt in)',
    )
    .option(
      '--include-ghost',
      'include online devices that the web UI hides and autoLocal cannot route to',
    )
    .option('--base-url <url>', 'gateway base URL (or XGG_BASE_URL)')
    .option('--session-file <path>', 'session file path')
    .option('--timeout <ms>', 'request timeout in milliseconds', '10000')
    .option('--pretty', 'pretty-print: table view (default: compact JSON)')
    .addHelpText(
      'after',
      '\nExamples:\n  $ xgg device list --pretty\n  $ xgg device list --include-ghost --pretty   # show 设备已丢失 entries for debugging',
    );
  addNextHintFlag(listCmd);
  listCmd.action(
    wrap('device.list', async (opts: DeviceListOpts) => {
      const deps = makeDeps(opts);
      const result = await listDevices(deps);
      const allRows = Object.entries(result).map(([id, dev]) => ({ id, ...dev }));
      const includeGhost = opts.includeGhost === true;
      const rows = includeGhost ? allRows : allRows.filter((r) => !isGhost(r));
      const visibleDevices = includeGhost
        ? result
        : Object.fromEntries(Object.entries(result).filter(([, dev]) => !isGhost(dev)));
      const basePayload = {
        ok: true,
        devices: visibleDevices,
        ...(includeGhost ? {} : { ghostExcluded: allRows.length - rows.length }),
      };
      const hints = buildNextSteps('device.list', basePayload, opts);
      const jsonPayload = nextHintOptedOut(opts)
        ? basePayload
        : withNextSteps(basePayload as Record<string, unknown>, hints);
      if (opts.pretty === true) {
        const projection = await prepareDeviceTypeProjection(rows, true, deps.timeoutMs);
        if (projection === undefined) throw new Error('missing device type projection');
        process.stdout.write(
          renderDeviceListPretty(
            rows.map((row) => ({
              ...row,
              availability: availabilityLabel(row),
            })),
            projection,
          ),
        );
      } else {
        emit(jsonPayload, { pretty: false });
      }
      printNextStepHintLine(hints, opts, {
        contextLabel: `device list (${rows.length} visible)`,
      });
    }),
  );

  cmd
    .command('get <id>')
    .description('Get a single device by DID (client-side filter on the device list)')
    .option('--base-url <url>', 'gateway base URL (or XGG_BASE_URL)')
    .option('--session-file <path>', 'session file path')
    .option('--timeout <ms>', 'request timeout in milliseconds', '10000')
    .option(
      '--pretty',
      'human-readable device metadata with stable type token and zh_cn description',
    )
    .addHelpText('after', '\nExample:\n  $ xgg device get <bluetooth-did>')
    .action(
      wrap('device.get', async (id: string, opts: DeviceOpts) => {
        const deps = makeDeps(opts);
        const result = await getDevice(id, deps);
        if (opts.pretty === true) {
          const projection = await prepareDeviceTypeProjection([result], true, deps.timeoutMs);
          if (projection === undefined) throw new Error('missing device type projection');
          process.stdout.write(renderDeviceGetPretty(result, projection));
        } else {
          emit({ ok: true, device: result }, { pretty: false });
        }
      }),
    );

  const specCmd = cmd
    .command('spec <did>')
    .description('Fetch MIoT spec (services/properties/actions/events) for a device')
    .option('--base-url <url>', 'gateway base URL (or XGG_BASE_URL)')
    .option('--session-file <path>', 'session file path')
    .option('--timeout <ms>', 'fetch timeout in milliseconds', '5000')
    .option(
      '--pretty',
      'rule-purpose capability view with semantic labels, selectors, typed domains, and resolved arguments',
    )
    .addHelpText(
      'after',
      '\nExamples:\n  $ xgg device spec lumi.<DID>\n  $ xgg device spec 12345 --pretty',
    );
  addNextHintFlag(specCmd);
  specCmd.action(
    wrap('device.spec', async (did: string, opts: DeviceOpts) => {
      const deps = makeDeps(opts);
      // 1. Resolve did → urn (daemon call via gateway WS)
      const device = await getDevice(did, deps);
      // 2. Fetch MIoT spec (public HTTP, no daemon)
      const spec = await getDeviceSpec(device.urn, {
        timeoutMs: deps.timeoutMs,
      });
      const hints = buildNextSteps('device.spec', { spec }, opts);
      const prepared = await prepareDeviceSpecOutput(spec, opts.pretty === true, deps.timeoutMs);
      if (prepared.format === 'json') {
        // F21: wrap spec in `{ok:true, spec}` so callers can `jq '.ok'` the
        // same way they do with device list / device get. The raw spec is
        // still reachable via `.spec.services` etc.
        // Semantic catalogs are deliberately not fetched on this default path.
        const basePayload = prepared.payload as Record<string, unknown>;
        const payload = nextHintOptedOut(opts) ? basePayload : withNextSteps(basePayload, hints);
        emit(payload, { pretty: false });
      } else {
        process.stdout.write(prepared.text);
      }
      printNextStepHintLine(hints, opts, { contextLabel: `device ${did}` });
    }),
  );

  cmd
    .command('partitions <did>')
    .description(
      'List partition labels (A-1..B-16) for multi-zone occupancy sensors (xiaomi.sensor_occupy.p1). Empty list for non-partition devices.',
    )
    .option('--base-url <url>', 'gateway base URL (or XGG_BASE_URL)')
    .option('--session-file <path>', 'session file path')
    .option('--timeout <ms>', 'request timeout in milliseconds', '10000')
    .option('--pretty', 'pretty-print: ASCII table (default: compact JSON)')
    .addHelpText(
      'after',
      '\nExamples:\n  $ xgg device partitions <DID> --pretty\n  $ xgg device partitions <DID> | jq \'.partitions[] | select(.label == "A-4")\'',
    )
    .action(
      wrap('device.partitions', async (did: string, opts: DeviceOpts) => {
        const deps = makeDeps(opts);
        const partitions = await getDevicePartitions(did, deps);
        const columns: TableColumn<(typeof partitions)[number]>[] = [
          { header: 'siid', get: (r) => String(r.siid) },
          { header: 'label', get: (r) => r.label },
          { header: 'serviceDesc', get: (r) => r.serviceDescription },
          { header: 'propsCount', get: (r) => String(r.propsCount) },
        ];
        emitList(
          { jsonPayload: { ok: true, partitions }, columns, rows: partitions },
          { pretty: opts.pretty === true },
        );
      }),
    );

  return cmd;
}
