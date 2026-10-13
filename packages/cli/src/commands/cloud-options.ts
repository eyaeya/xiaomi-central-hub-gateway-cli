// SPDX-License-Identifier: GPL-3.0-or-later
import {
  CloudClient,
  ConfigError,
  type PropertySelector,
  createCloudTransport,
} from '@eyaeya/xgg-core';
import type { Command } from 'commander';

export interface CloudOpts {
  authFile?: string;
  timeout?: string;
  pretty?: boolean;
  did?: string;
  name?: string;
  homeId?: string;
  property?: string;
  properties?: string;
  source?: string;
  siid?: string;
  piid?: string;
  action?: string;
  aiid?: string;
  inputs?: string;
  value?: string;
  snapshotsDir?: string;
  snapshot?: boolean;
}

export function options(command: Command): CloudOpts {
  return command.optsWithGlobals<CloudOpts>();
}

export function positiveInteger(raw: string, flag: string): number {
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new ConfigError(`${flag} must be a positive decimal integer`);
  }
  return Number(raw);
}

export function runtimeOptions(opts: CloudOpts) {
  const authFile = opts.authFile ?? (process.env.XGG_CLOUD_AUTH_FILE || undefined);
  return {
    ...(authFile !== undefined && { authFile }),
    timeoutMs: positiveInteger(opts.timeout ?? '15000', '--timeout'),
  };
}

export function client(opts: CloudOpts): CloudClient {
  return new CloudClient(createCloudTransport(runtimeOptions(opts)));
}

export function deviceSelector(opts: CloudOpts) {
  if (Boolean(opts.did) === Boolean(opts.name)) {
    throw new ConfigError('Specify exactly one of --did or --name');
  }
  return {
    ...(opts.did !== undefined && { did: opts.did }),
    ...(opts.name !== undefined && { name: opts.name }),
    ...(opts.homeId !== undefined && { homeId: opts.homeId }),
  };
}

export function propertySelector(opts: CloudOpts): PropertySelector {
  if (opts.property !== undefined) {
    if (!opts.property.trim() || opts.siid !== undefined || opts.piid !== undefined) {
      throw new ConfigError('Use --property or the pair --siid/--piid, not both');
    }
    return { property: opts.property };
  }
  if (opts.siid === undefined || opts.piid === undefined) {
    throw new ConfigError('Specify --property or both --siid and --piid');
  }
  return {
    siid: positiveInteger(opts.siid, '--siid'),
    piid: positiveInteger(opts.piid, '--piid'),
  };
}

/** Omitted selectors deliberately mean every readable property. */
export function propertySelections(opts: CloudOpts): PropertySelector[] | undefined {
  if (opts.properties !== undefined) {
    if (opts.property !== undefined || opts.siid !== undefined || opts.piid !== undefined) {
      throw new ConfigError('Use --properties, --property, or --siid/--piid exclusively');
    }
    const names = opts.properties.split(',').map((name) => name.trim());
    if (names.some((name) => !name) || new Set(names).size !== names.length) {
      throw new ConfigError('--properties must contain distinct, nonempty comma-separated names');
    }
    return names.map((property) => ({ property }));
  }
  if (opts.property === undefined && opts.siid === undefined && opts.piid === undefined) {
    return undefined;
  }
  return [propertySelector(opts)];
}

export function deviceFlags(cmd: Command): Command {
  return cmd
    .option('--did <id>', 'exact device DID')
    .option('--name <name>', 'unique device name')
    .option('--home-id <id>', 'limit device selection to one home');
}

export function propertyFlags(cmd: Command): Command {
  return cmd
    .option('--property <name>', 'property name, service.property, or SIID.PIID')
    .option('--siid <id>', 'MIoT service instance ID')
    .option('--piid <id>', 'MIoT property instance ID');
}

export type CloudSourcePolicy = 'auto' | 'device' | 'cache';

export function sourcePolicy(
  opts: CloudOpts,
  defaultSource: CloudSourcePolicy = 'auto',
): CloudSourcePolicy {
  const selected = opts.source ?? defaultSource;
  if (selected !== 'auto' && selected !== 'device' && selected !== 'cache') {
    throw new ConfigError('--source must be auto, device, or cache');
  }
  return selected;
}

export function batchPropertyFlags(
  cmd: Command,
  defaultSource: CloudSourcePolicy = 'auto',
): Command {
  return propertyFlags(cmd)
    .option(
      '--source <policy>',
      'property read source: auto (cache preferred), device (direct RPC), cache (cache only)',
      defaultSource,
    )
    .option(
      '--properties <names>',
      'comma-separated property names; omit property flags to read all readable properties',
    );
}
