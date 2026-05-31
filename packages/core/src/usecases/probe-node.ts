// Single-probe primitive for M6 blind-probe Phase C.
//
// Bypasses RuleGetResponse / GraphSetRequest zod parse on purpose: the point of
// a blind probe is to send intentionally malformed payloads and capture the raw
// response, so we can discover schema shapes our current zod definitions do not
// model. before/after are typed `unknown` because they may legitimately fail to
// match any current schema — that's evidence, not an error.
//
// Error policy: a probe is "rejected" only when the gateway itself returns an
// error (GatewayError or anything else not in the infra-failure set). Infra
// failures — AuthExpiredError, NetworkError — get re-thrown so the batch
// runner's STOP guard can halt the run; counting them as "rejected" would
// mask a dead daemon as evidence.

import type { ResourceDeps } from '../resources/index.js';
import { AuthExpiredError, NetworkError } from '../transport/errors.js';
import { agentCall } from './agent-call.js';

export interface ProbeNodeInput {
  ruleId: string;
  scenario: string;
  payload: unknown;
}

export type ProbeResult = 'accepted' | 'rejected' | 'accepted-with-normalization';

export interface ProbeNodeOutput {
  scenario: string;
  result: ProbeResult;
  error?: string;
  before: unknown;
  after: unknown;
}

interface InjectedApi {
  agentCall: typeof agentCall;
}

export async function probeNode(
  input: ProbeNodeInput,
  opts: ResourceDeps & { _injected?: InjectedApi },
): Promise<ProbeNodeOutput> {
  const api = opts._injected ?? { agentCall };
  const baseArgs = {
    baseUrl: opts.baseUrl,
    store: opts.store,
    ...(opts.ipcClient !== undefined && { ipcClient: opts.ipcClient }),
    ...(opts.timeoutMs !== undefined && { timeoutMs: opts.timeoutMs }),
  };

  const before = await api.agentCall({
    ...baseArgs,
    method: '/api/getGraph',
    params: { id: input.ruleId },
  });

  try {
    await api.agentCall({
      ...baseArgs,
      method: '/api/setGraph',
      params: input.payload,
      kind: 'write',
    });
  } catch (err) {
    if (err instanceof AuthExpiredError || err instanceof NetworkError) throw err;
    return {
      scenario: input.scenario,
      result: 'rejected',
      error: err instanceof Error ? err.message : String(err),
      before,
      after: before,
    };
  }

  const after = await api.agentCall({
    ...baseArgs,
    method: '/api/getGraph',
    params: { id: input.ruleId },
  });

  const matches = JSON.stringify(after) === JSON.stringify(input.payload);
  return {
    scenario: input.scenario,
    result: matches ? 'accepted' : 'accepted-with-normalization',
    before,
    after,
  };
}
