import { GatewayError } from '@eyaeya/xgg-core';

// Shared NID:pin parser — extracted when edge-remove introduced a second call-site.
// GatewayError kept as spike-grade decision; retro will revisit error class.
export function parseEdgeRef(raw: string, flag: string): { nodeId: string; pin: string } {
  const idx = raw.indexOf(':');
  if (idx <= 0 || idx === raw.length - 1) {
    throw new GatewayError(`${flag} must be in NID:pin format (got "${raw}")`, {
      value: raw,
      flag,
    });
  }
  return { nodeId: raw.slice(0, idx), pin: raw.slice(idx + 1) };
}
