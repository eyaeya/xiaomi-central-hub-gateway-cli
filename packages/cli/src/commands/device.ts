import {
  ConfigError,
  createStore,
  getDevice,
  getDevicePartitions,
  getDeviceSpec,
  listDevices,
} from '@xgg/core';
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
  const store = createStore(opts.sessionFile ? { sessionFile: opts.sessionFile } : {});
  return { baseUrl, store, timeoutMs: Number(opts.timeout) };
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
  return dev.online && !dev.specV2Access && !dev.specV3Access;
}

// urn:miot-spec-v2:device:<category>:<urn-hash>:<vendor>:<version>
//                                ^^^ split(':')[3]
// Codex T3 confirmed the frontend resolves the Chinese label by joining
// this with miot-spec.org/template/list/device descriptions; CLI keeps
// the lowercase machine token so it stays stable across locales.
export function categoryFromUrn(urn: string | undefined): string {
  if (!urn) return '';
  const parts = urn.split(':');
  // parts[0]='urn', [1]='miot-spec-v2', [2]='device', [3]='<category>'
  return parts[3] ?? '';
}

export function deviceCommand(): Command {
  const cmd = new Command('device').description('Device read operations');

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
      const columns: TableColumn<(typeof rows)[number]>[] = [
        { header: 'id', get: (r) => r.id },
        { header: 'name', get: (r) => r.name },
        { header: 'model', get: (r) => r.model },
        { header: 'roomName', get: (r) => r.roomName ?? '' },
        // F22 closed in M9: category derives from urn.split(':')[3]
        // (`light` / `sensor` / `remote-control` / ...). The Chinese
        // label table the web UI uses is a public MIoT registry; CLI
        // keeps the machine token for stability.
        { header: 'category', get: (r) => categoryFromUrn(r.urn) },
        { header: 'urn', get: (r) => r.urn ?? '' },
        { header: 'avail', get: (r) => availabilityLabel(r) },
      ];
      const basePayload = {
        ok: true,
        devices: visibleDevices,
        ...(includeGhost ? {} : { ghostExcluded: allRows.length - rows.length }),
      };
      const hints = buildNextSteps('device.list', basePayload, opts);
      const jsonPayload = nextHintOptedOut(opts)
        ? basePayload
        : withNextSteps(basePayload as Record<string, unknown>, hints);
      emitList({ jsonPayload, columns, rows }, { pretty: opts.pretty === true });
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
    .option('--pretty', 'pretty-print JSON output')
    .addHelpText('after', '\nExample:\n  $ xgg device get <bluetooth-did>')
    .action(
      wrap('device.get', async (id: string, opts: DeviceOpts) => {
        const deps = makeDeps(opts);
        const result = await getDevice(id, deps);
        emit({ ok: true, device: result }, { pretty: opts.pretty === true });
      }),
    );

  const specCmd = cmd
    .command('spec <did>')
    .description('Fetch MIoT spec (services/properties/actions/events) for a device')
    .option('--base-url <url>', 'gateway base URL (or XGG_BASE_URL)')
    .option('--session-file <path>', 'session file path')
    .option('--timeout <ms>', 'fetch timeout in milliseconds', '5000')
    .option('--pretty', 'pretty-print as human-readable summary table')
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
        timeoutMs: Number(opts.timeout ?? '5000'),
      });
      const hints = buildNextSteps('device.spec', { spec }, opts);
      if (!opts.pretty) {
        // F21: wrap spec in `{ok:true, spec}` so callers can `jq '.ok'` the
        // same way they do with device list / device get. The raw spec is
        // still reachable via `.spec.services` etc.
        const basePayload = { ok: true, spec } as Record<string, unknown>;
        const payload = nextHintOptedOut(opts) ? basePayload : withNextSteps(basePayload, hints);
        emit(payload, { pretty: false });
      } else {
        // Pretty-print: per-service tables for properties / actions / events
        process.stdout.write(`${spec.description} (${spec.type})\n\n`);
        for (const svc of spec.services) {
          process.stdout.write(`Service ${svc.iid}: ${svc.description} [${svc.type}]\n`);
          if (svc.properties && svc.properties.length > 0) {
            const table = new Table({
              head: ['iid', 'description', 'format', 'access', 'unit', 'range'],
              style: { head: [], border: [] },
            });
            for (const p of svc.properties) {
              table.push([
                String(p.iid),
                p.description,
                p.format,
                p.access.join(', '),
                p.unit ?? '',
                p['value-range'] ? p['value-range'].join(', ') : '',
              ]);
            }
            process.stdout.write(`  Properties:\n${table.toString()}\n`);
          }
          if (svc.actions && svc.actions.length > 0) {
            const table = new Table({
              head: ['iid', 'description', 'in', 'out'],
              style: { head: [], border: [] },
            });
            for (const a of svc.actions) {
              table.push([String(a.iid), a.description, a.in.join(', '), a.out.join(', ')]);
            }
            process.stdout.write(`  Actions:\n${table.toString()}\n`);
          }
          if (svc.events && svc.events.length > 0) {
            const table = new Table({
              head: ['iid', 'description', 'arguments'],
              style: { head: [], border: [] },
            });
            for (const e of svc.events) {
              table.push([String(e.iid), e.description, e.arguments ? e.arguments.join(', ') : '']);
            }
            process.stdout.write(`  Events:\n${table.toString()}\n`);
          }
          process.stdout.write('\n');
        }
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
