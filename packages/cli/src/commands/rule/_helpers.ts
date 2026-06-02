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
