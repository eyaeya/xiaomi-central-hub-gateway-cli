import type { StoredSession } from '../schemas/session.js';
import { AuthExpiredError } from '../transport/errors.js';
import { canonicalGatewayKey } from './ipc-path.js';

export interface AgentPingIdentity {
  host?: unknown;
  agentStartedAt?: unknown;
}

/**
 * Refuse to trust an IPC endpoint until it proves it is the daemon instance
 * recorded in the session file.
 */
export function assertAgentIdentity(
  ping: unknown,
  session: StoredSession,
): asserts ping is { host: string; agentStartedAt: string } {
  const candidate =
    typeof ping === 'object' && ping !== null ? (ping as AgentPingIdentity) : undefined;
  const actualHost = candidate?.host;
  const actualStartedAt = candidate?.agentStartedAt;

  let hostMatches = false;
  if (typeof actualHost === 'string') {
    try {
      hostMatches = canonicalGatewayKey(actualHost) === canonicalGatewayKey(session.host);
    } catch {
      hostMatches = false;
    }
  }

  if (hostMatches && actualStartedAt === session.agentStartedAt) return;

  throw new AuthExpiredError('agent identity does not match the stored session', {
    expectedHost: canonicalGatewayKey(session.host),
    actualHost: typeof actualHost === 'string' ? actualHost : null,
    expectedAgentStartedAt: session.agentStartedAt,
    actualAgentStartedAt: typeof actualStartedAt === 'string' ? actualStartedAt : null,
    hint: 'Run `xgg logout && xgg login --code <CODE>` to replace the stale session.',
  });
}
