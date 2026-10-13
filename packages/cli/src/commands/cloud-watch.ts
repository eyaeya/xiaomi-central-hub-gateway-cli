// SPDX-License-Identifier: GPL-3.0-or-later
import {
  CloudClient,
  ConfigError,
  GatewayError,
  NetworkError,
  createCloudTransport,
} from '@eyaeya/xgg-core';
import { Command } from 'commander';
import { wrap } from '../action-wrap.js';
import {
  type CloudOpts,
  batchPropertyFlags,
  deviceFlags,
  deviceSelector,
  positiveInteger,
  propertySelections,
  runtimeOptions,
  sourcePolicy,
} from './cloud-options.js';

interface WatchOptions extends CloudOpts {
  intervalMs?: string;
  durationMs?: string;
  maxEvents?: string;
  follow?: boolean;
}

type PropertyResults = Awaited<ReturnType<CloudClient['getProperties']>>;

function waitForPoll(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

function observationKey(results: PropertyResults): string {
  // Poll timestamps can advance while the reported value stays unchanged.
  return JSON.stringify(results.map(({ did, siid, piid, value }) => ({ did, siid, piid, value })));
}

function requireConfirmedSample(results: PropertyResults): void {
  if (results.length === 0) {
    throw new ConfigError('Selected device has no readable properties to watch', {
      domain: 'cloud',
    });
  }
  for (const result of results) {
    if (result.code === 1) {
      throw new NetworkError('Cloud property read was accepted but has no confirmed value', {
        domain: 'cloud',
      });
    }
    if (result.code !== 0) {
      throw new GatewayError(`Cloud watched property read failed (code ${result.code})`, {
        domain: 'cloud',
        cloudCode: result.code,
      });
    }
  }
}

/** Always emits NDJSON; a cloud report is not evidence of physical state or a push event. */
export function cloudWatchCommand(): Command {
  return batchPropertyFlags(deviceFlags(new Command('watch')), 'device')
    .description('Poll cloud-reported properties and emit initial snapshot plus changes as NDJSON')
    .option('--interval-ms <ms>', 'poll interval (minimum 1000 milliseconds)', '3000')
    .option('--duration-ms <ms>', 'stop after this duration (default: 60000 unless --follow)')
    .option('--max-events <count>', 'stop after N emitted events, including the initial snapshot')
    .option(
      '--follow',
      'keep polling until interrupted unless a duration or event limit is reached',
    )
    .addHelpText(
      'after',
      '\nPolling is not a push subscription. Values are cloud reports; verify gateway logs separately.\nNetwork failures retry at most twice; authentication, schema and device errors stop immediately.\n',
    )
    .action(
      wrap('cloud.device.watch', async (_local: unknown, command: Command) => {
        const opts = command.optsWithGlobals<WatchOptions>();
        const intervalMs = positiveInteger(opts.intervalMs ?? '3000', '--interval-ms');
        if (intervalMs < 1000 || intervalMs > 2_147_483_647) {
          throw new ConfigError('--interval-ms must be between 1000 and 2147483647');
        }
        const durationMs =
          opts.durationMs !== undefined
            ? positiveInteger(opts.durationMs, '--duration-ms')
            : opts.follow
              ? undefined
              : 60_000;
        if (durationMs !== undefined && durationMs > 2_147_483_647) {
          throw new ConfigError('--duration-ms must not exceed 2147483647');
        }
        const maxEvents =
          opts.maxEvents !== undefined
            ? positiveInteger(opts.maxEvents, '--max-events')
            : undefined;
        const selector = deviceSelector(opts);
        const properties = propertySelections(opts);
        const source = sourcePolicy(opts, 'device');
        const controller = new AbortController();
        const onInterrupt = () => controller.abort();
        const durationTimer =
          durationMs === undefined ? undefined : setTimeout(onInterrupt, durationMs);
        process.on('SIGINT', onInterrupt);
        process.on('SIGTERM', onInterrupt);
        try {
          const api = new CloudClient(
            createCloudTransport({ ...runtimeOptions(opts), signal: controller.signal }),
          );
          // Bind a display name to one DID before polling. A later rename must not retarget a watch.
          const selectedDevice = await api.resolveDevice(selector);
          const target = {
            did: selectedDevice.did,
            ...(opts.homeId === undefined ? {} : { homeId: opts.homeId }),
          };
          let previous: string | undefined;
          let emitted = 0;
          let consecutiveFailures = 0;
          while (!controller.signal.aborted) {
            try {
              const results = await api.getProperties(target, properties, { source });
              if (controller.signal.aborted) break;
              requireConfirmedSample(results);
              consecutiveFailures = 0;
              const current = observationKey(results);
              if (previous !== current) {
                process.stdout.write(
                  `${JSON.stringify({
                    ok: true,
                    event: previous === undefined ? 'snapshot' : 'change',
                    source: 'cloud',
                    sourcePolicy: source,
                    mode: 'polling',
                    evidence: 'reported',
                    observedAt: new Date().toISOString(),
                    intervalMs,
                    results,
                  })}\n`,
                );
                previous = current;
                emitted++;
                if (maxEvents !== undefined && emitted >= maxEvents) break;
              }
            } catch (error) {
              if (controller.signal.aborted) break;
              if (!(error instanceof NetworkError)) throw error;
              consecutiveFailures++;
              if (consecutiveFailures >= 3) throw error;
              // Never write failed reads into stdout or into the comparison baseline.
              process.stderr.write(
                `[xgg cloud device watch] cloud read unavailable; retry ${consecutiveFailures}/2 after ${intervalMs} ms.\n`,
              );
            }
            await waitForPoll(intervalMs, controller.signal);
          }
        } catch (error) {
          if (!controller.signal.aborted) throw error;
        } finally {
          if (durationTimer !== undefined) clearTimeout(durationTimer);
          process.removeListener('SIGINT', onInterrupt);
          process.removeListener('SIGTERM', onInterrupt);
          controller.abort();
        }
      }),
    );
}
