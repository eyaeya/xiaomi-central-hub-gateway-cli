import {
  ConfigError,
  type HabitLearningDeviceInput,
  XggError,
  createStore,
  getDeviceSpec,
  listDevices,
  planHabitLearning,
} from '@eyaeya/xgg-core';
import { Command } from 'commander';
import { wrap } from '../action-wrap.js';
import { parsePositiveTimerMs } from '../local-input.js';
import { emit } from '../output.js';

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

interface SpecFetchFailure {
  did: string;
  name: string;
  urn: string;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

type DeviceInventory = Awaited<ReturnType<typeof listDevices>>;
type DeviceSpec = Awaited<ReturnType<typeof getDeviceSpec>>;
type SpecLoad =
  | { ok: true; spec: DeviceSpec }
  | {
      ok: false;
      error: unknown;
    };

function describeSpecFailure(
  did: string,
  name: string,
  urn: string,
  error: unknown,
): SpecFetchFailure {
  const message =
    error instanceof Error && error.message.length > 0
      ? error.message
      : 'Unknown MIoT spec fetch failure';
  if (error instanceof XggError) {
    return {
      did,
      name,
      urn,
      code: error.code,
      message,
      ...(error.details !== undefined && { details: error.details }),
    };
  }
  return { did, name, urn, code: 'UNKNOWN', message };
}

async function collectPlannerInputs(
  inventory: DeviceInventory,
  timeoutMs: number,
): Promise<{
  devices: HabitLearningDeviceInput[];
  attemptedDeviceCount: number;
  loadedDeviceCount: number;
  specFailures: SpecFetchFailure[];
}> {
  const entries = Object.entries(inventory).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const specLoads = new Map<string, Promise<SpecLoad>>();
  const loadSpec = (urn: string): Promise<SpecLoad> => {
    const existing = specLoads.get(urn);
    if (existing !== undefined) return existing;
    const pending = getDeviceSpec(urn, { timeoutMs }).then(
      (spec): SpecLoad => ({ ok: true, spec }),
      (error: unknown): SpecLoad => ({ ok: false, error }),
    );
    specLoads.set(urn, pending);
    return pending;
  };

  const resolved = await Promise.all(
    entries.map(async ([did, device]) => {
      const visibleDevice = { ...device, did };
      if (!device.specV2Access && !device.specV3Access) {
        return {
          input: { device: visibleDevice } satisfies HabitLearningDeviceInput,
          attempted: false,
          loaded: false,
        };
      }

      const result = await loadSpec(device.urn);
      if (result.ok) {
        return {
          input: {
            device: visibleDevice,
            spec: result.spec,
            // `getDeviceSpec` returns the raw registry document. No curated
            // semantic catalog was applied, so privacy classification may
            // additionally consult display descriptions and fail closed.
            semanticCatalogFallback: true,
          } satisfies HabitLearningDeviceInput,
          attempted: true,
          loaded: true,
        };
      }

      const failure = describeSpecFailure(did, device.name, device.urn, result.error);
      return {
        input: {
          device: visibleDevice,
          specError: failure.message,
        } satisfies HabitLearningDeviceInput,
        attempted: true,
        loaded: false,
        failure,
      };
    }),
  );

  return {
    devices: resolved.map(({ input }) => input),
    attemptedDeviceCount: resolved.filter(({ attempted }) => attempted).length,
    loadedDeviceCount: resolved.filter(({ loaded }) => loaded).length,
    specFailures: resolved.flatMap(({ failure }) => (failure === undefined ? [] : [failure])),
  };
}

export function learnCommand(): Command {
  const cmd = new Command('learn').description(
    'Read-only household habit-learning discovery and analysis',
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
        const store = createStore(opts.sessionFile ? { sessionFile: opts.sessionFile } : {});

        const inventory = await listDevices({ baseUrl, store, timeoutMs });
        const collected = await collectPlannerInputs(inventory, timeoutMs);
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

  return cmd;
}
