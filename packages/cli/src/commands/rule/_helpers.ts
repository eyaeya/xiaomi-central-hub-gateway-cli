import { ConfigError } from '@eyaeya/xgg-core';

// Shared NID:pin parser — extracted when edge-remove introduced a second call-site.
// A malformed --from/--to is a user input error, so it maps to ConfigError
// (CLI exit 5) — not GatewayError (exit 1) — so agents can distinguish
// "I mistyped the ref" from "the gateway rejected/dropped the call".
export function parseEdgeRef(raw: string, flag: string): { nodeId: string; pin: string } {
  const idx = raw.indexOf(':');
  if (idx <= 0 || idx === raw.length - 1) {
    throw new ConfigError(`${flag} must be in NID:pin format (got "${raw}")`, {
      value: raw,
      flag,
    });
  }
  return { nodeId: raw.slice(0, idx), pin: raw.slice(idx + 1) };
}

export interface EdgeEndpointOpts {
  from?: string;
  to?: string;
  fromNodeId?: string;
  fromPin?: string;
  toNodeId?: string;
  toPin?: string;
}

/**
 * Resolve either the compact NID:pin pair or the lossless split endpoint form.
 *
 * The compact syntax remains convenient for canonical ids, but it cannot
 * represent a persisted legacy id containing `:` without ambiguity. Exported
 * replay scripts therefore use the split form.
 */
export function parseEdgeEndpoints(opts: EdgeEndpointOpts): {
  from: { nodeId: string; pin: string };
  to: { nodeId: string; pin: string };
} {
  const compactPresent = opts.from !== undefined || opts.to !== undefined;
  const splitValues = [opts.fromNodeId, opts.fromPin, opts.toNodeId, opts.toPin];
  const splitPresent = splitValues.some((value) => value !== undefined);

  if (compactPresent && splitPresent) {
    throw new ConfigError(
      'edge endpoints must use either --from/--to or the four split endpoint flags, not both',
    );
  }
  if (compactPresent) {
    if (opts.from === undefined || opts.to === undefined) {
      throw new ConfigError('--from and --to must be provided together');
    }
    return {
      from: parseEdgeRef(opts.from, '--from'),
      to: parseEdgeRef(opts.to, '--to'),
    };
  }
  if (splitPresent) {
    if (splitValues.some((value) => value === undefined || value.length === 0)) {
      throw new ConfigError(
        '--from-node-id, --from-pin, --to-node-id, and --to-pin must all be non-empty',
      );
    }
    return {
      from: { nodeId: opts.fromNodeId as string, pin: opts.fromPin as string },
      to: { nodeId: opts.toNodeId as string, pin: opts.toPin as string },
    };
  }
  throw new ConfigError(
    'edge endpoints are required: use --from/--to or all four split endpoint flags',
  );
}
