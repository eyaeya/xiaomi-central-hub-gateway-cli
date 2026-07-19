import {
  AuthExpiredError,
  AuthRequiredError,
  ConfigError,
  NotConfirmedError,
  SchemaError,
  XggError,
} from '@eyaeya/xgg-core';
import {
  AGENT_MODE_NO_SNAPSHOT_FORBIDDEN_MESSAGE,
  AGENT_MODE_SNAPSHOTS_DIR_REQUIRED_MESSAGE,
} from './mutation-guard-messages.js';

export interface ExitMapping {
  code: number;
}

export function errorToExit(err: unknown): ExitMapping {
  if (err instanceof ConfigError) return { code: 5 };
  if (err instanceof AuthRequiredError || err instanceof AuthExpiredError) return { code: 3 };
  if (err instanceof SchemaError) return { code: 4 };
  if (err instanceof NotConfirmedError) return { code: 2 };
  if (err instanceof XggError) return { code: 1 };
  return { code: 1 };
}

interface HintRule {
  code: string; // XggError.code, e.g. "SCHEMA", or "*" wildcard
  command: string; // e.g. "rule.set", "variable.create", or "*"
  hint: string;
  // M11 F24: optional substring match against the gateway's raw error
  // message. When set, the rule only fires for that specific error
  // class (e.g. "Invalid id format" vs "already exist") so the hint
  // matches the actual failure instead of being a generic catch-all.
  messageMatches?: string;
  /** Exact message match for errors whose wording is a stable local contract. */
  messageEquals?: string;
}

const HINTS: HintRule[] = [
  // SCHEMA
  {
    code: 'SCHEMA',
    command: '*',
    messageMatches: 'Session file at ',
    hint: 'Preserve the local session file named in error.message before changing it. Inspect or repair that file, or move the corrupt copy aside and log in again with a fresh code; do not overwrite it blindly.',
  },
  {
    code: 'SCHEMA',
    command: '*',
    messageMatches: 'MIoT spec registry',
    hint: 'The MIoT spec registry returned malformed content. Check error.details.url/status, verify the configured registry, and retry.',
  },
  {
    code: 'SCHEMA',
    command: 'rule.set',
    hint: 'cfg must mirror the RuleSummary returned by `xgg rule list`.',
  },
  // M6 schema / agent-mode
  {
    code: 'SCHEMA',
    command: 'rule.node.add',
    messageEquals: 'AddNodeInput.node parse failed',
    hint: 'The node input did not match the expected schema. Run `xgg rule node add --help` to verify the supported shortcut flags and full node JSON shape; error.details identifies the invalid fields.',
  },
  {
    code: 'SCHEMA',
    command: 'rule.node.update',
    messageEquals: 'updateNode.merged parse failed',
    hint: 'The merged node did not match the expected schema. Inspect the current node with `xgg rule view <id>`, then run `xgg rule node update --help` for the accepted patch syntax; error.details identifies the invalid fields.',
  },
  {
    code: 'SCHEMA',
    command: '*',
    messageEquals: 'RuleListResponse parse failed',
    hint: 'The live rule-list response did not match the expected schema. Retry the read-only `xgg rule list`; if it succeeds, inspect the target with `xgg rule view <id>`. error.details identifies the invalid response fields.',
  },
  {
    code: 'SCHEMA',
    command: '*',
    messageEquals: 'RuleGetResponse parse failed',
    hint: 'The live rule graph response did not match the expected schema. Use read-only `xgg rule list` to confirm the summary, then retry `xgg rule view <id>`. error.details identifies the invalid response fields.',
  },
  {
    code: 'SCHEMA',
    command: '*',
    hint: 'Gateway response did not match the schema. See snapshot path in error.details.',
  },

  // GATEWAY
  {
    code: 'GATEWAY',
    command: 'rule.set',
    hint: '"Invalid config" usually means cfg is missing fields. Pass the full RuleSummary from `xgg rule list` back through cfg.',
  },
  {
    code: 'GATEWAY',
    command: 'rule.edge.add',
    hint: '--from/--to must be NID:pin (e.g. n1:output). Also fails if outputs[pin] on the source node already exists and is not an array.',
  },
  {
    code: 'GATEWAY',
    command: 'rule.edge.remove',
    hint: "--from/--to must be NID:pin (e.g. n1:output). Also fails if the edge string is not found in the source node's outputs array.",
  },
  // M11 F24: variable.create gateway errors split by raw message so the
  // hint actually addresses the real failure (M7 walk-log F24: previously
  // every variable.create gateway error returned "scope must be
  // alphanumeric" regardless of whether the id was malformed or already
  // existed — contradicting the message field).
  {
    code: 'GATEWAY',
    command: 'variable.create',
    messageMatches: 'Invalid id format',
    hint: 'variable id must be alphanumeric only (no hyphen/underscore/dot). Same constraint applies to --scope.',
  },
  {
    code: 'GATEWAY',
    command: 'variable.create',
    messageMatches: 'already exist',
    hint: 'this scope+id pair is already on the gateway. Use `xgg variable set-value` to update its value, `xgg variable set-config` to rename, or choose a fresh id.',
  },
  {
    code: 'GATEWAY',
    command: 'variable.create',
    hint: 'gateway rejected the create request. See error.message above; common causes are non-alphanumeric scope/id or a pre-existing variable.',
  },
  {
    code: 'GATEWAY',
    command: 'backup.list',
    hint: 'Backup RPCs require gateway firmware vocabulary; on the captured v6.5.4 gateway use `--from fds`.',
  },
  {
    code: 'GATEWAY',
    command: 'backup.delete',
    hint: 'Use `xgg backup list --from fds` and copy did/ts/fileName exactly.',
  },
  {
    code: 'GATEWAY',
    command: 'backup.load',
    hint: 'Use `xgg backup list --from fds` and copy did/ts/fileName exactly.',
  },
  {
    code: 'GATEWAY',
    command: '*',
    hint: 'The gateway rejected the request. See error.details for the raw message.',
  },

  // AUTH_EXPIRED
  {
    code: 'AUTH_EXPIRED',
    command: '*',
    hint: 'Ask the user for a fresh 6-digit code, then `xgg login --code <NEW_CODE>`.',
  },

  // AUTH_REQUIRED
  {
    code: 'AUTH_REQUIRED',
    command: '*',
    hint: 'Run `xgg login --code <CODE>` to start a session.',
  },

  // NOT_FOUND — agent-facing paths where a named resource (scope, id, etc.)
  // is missing on the gateway. Watch is the primary trigger today, but the
  // catch-all keeps any future NotFoundError from regressing the M11 F24
  // "always actionable hint" invariant.
  {
    code: 'NOT_FOUND',
    command: 'variable.watch',
    hint: 'scope not on the gateway — list scopes with `xgg variable list`. Or pass --allow-unknown-scope to get an empty snapshot.',
  },
  {
    code: 'NOT_FOUND',
    command: '*',
    hint: 'The named resource was not found on the gateway. Check the id/scope and list available ones first.',
  },

  // CONFIG — card-validation gate (rule set / rule enable / node add / validate).
  // Snapshot setup is a global mutation contract, not a command family. Match
  // the two guard messages exactly so unrelated ConfigErrors cannot inherit a
  // snapshots-dir remedy merely because they came from a mutation command.
  {
    code: 'CONFIG',
    command: '*',
    messageEquals: AGENT_MODE_SNAPSHOTS_DIR_REQUIRED_MESSAGE,
    hint: 'When XGG_AGENT_MODE=1 every mutation must be checkpointed: pass --snapshots-dir <dir> (or set XGG_SNAPSHOTS_DIR). For terminal use, unset XGG_AGENT_MODE.',
  },
  {
    code: 'CONFIG',
    command: '*',
    messageEquals: AGENT_MODE_NO_SNAPSHOT_FORBIDDEN_MESSAGE,
    hint: 'Remove --no-snapshot. XGG_AGENT_MODE=1 requires a pre-write rollback checkpoint for every mutation.',
  },
  // Shared command setup failures must also outrank command-family fallbacks.
  // Otherwise a missing connection target or malformed timeout on e.g.
  // rule.edge.add gets mislabeled as a graph-authoring failure.
  {
    code: 'CONFIG',
    command: '*',
    messageEquals: 'missing --base-url or XGG_BASE_URL',
    hint: 'Pass --base-url <url> or set XGG_BASE_URL.',
  },
  {
    code: 'CONFIG',
    command: '*',
    messageMatches: '--timeout must be a positive decimal integer no greater than',
    hint: 'Pass --timeout <ms> as a positive decimal integer within the limit shown in error.message.',
  },
  // These card-specific matches explain the validation failure itself.
  // error.details.issues carries EVERY offending card (the message only names
  // the first).
  {
    code: 'CONFIG',
    command: '*',
    messageMatches: '卡片变量丢失',
    hint: 'A var card references a variable that does not exist. Create it with `xgg variable create`, or fix --var-scope/--var-id. Every offending card path is in error.details.issues; `xgg rule validate --rule-id <id>` lists them all.',
  },
  {
    code: 'CONFIG',
    command: '*',
    messageMatches: '卡片变量有误',
    hint: 'A var card scope is neither "global" nor "R<ruleId>" — often a copied rule still pointing at the source rule\'s local scope. Re-author with --var-scope global, or recreate the variable under THIS rule\'s R<id> scope. See error.details.issues for every card.',
  },
  {
    code: 'CONFIG',
    command: '*',
    messageMatches: '卡片配置有误',
    hint: 'A card failed the save-button validator (field/pin/schema). Fix the field at the path in error.message; every issue is in error.details.issues. Dry-run with `xgg rule validate --rule-id <id>`.',
  },
  // A malformed --from/--to now raises ConfigError (exit 5) instead of
  // GatewayError (exit 1). messageMatches keeps the NID:pin guidance attached to
  // that specific failure. The GATEWAY-class rule.edge.add/remove hints still
  // cover real gateway-side failures (e.g. "outputs[pin] already exists").
  {
    code: 'CONFIG',
    command: 'rule.edge.add',
    messageMatches: 'NID:pin format',
    hint: '--from/--to must be NID:pin (e.g. n1:output). Both halves are required and non-empty.',
  },
  {
    code: 'CONFIG',
    command: 'rule.edge.remove',
    messageMatches: 'NID:pin format',
    hint: '--from/--to must be NID:pin (e.g. n1:output). Both halves are required and non-empty.',
  },
  {
    code: 'CONFIG',
    command: 'rule.edge.add',
    messageMatches: 'fan-in cap:',
    hint: 'Each input pin accepts one incoming edge. Merge event sources with `signalOr`, or state sources with `logicOr`/`logicAnd`, then connect the merged output to the target pin.',
  },
  {
    code: 'CONFIG',
    command: 'rule.edge.add',
    messageMatches: 'cross-color edge:',
    hint: 'Reconnect compatible pin colors: event outputs target event inputs; state inputs require a state-capable (`event|state`) output. Run `xgg rule lint --rule-id <id> --strict` to inspect all color violations.',
  },
  {
    code: 'CONFIG',
    command: 'rule.edge.add',
    messageMatches: 'self-loop:',
    hint: 'A node cannot connect to itself. Route through a distinct node or remove the feedback edge; inspect the graph with `xgg rule view <id>`.',
  },
  {
    code: 'CONFIG',
    command: 'rule.edge.add',
    messageMatches: 'target pin "',
    hint: 'Use one of the target node inputs listed in error.details.availablePins (and error.details.suggestion when present). Action cards commonly use `trigger` rather than `input`.',
  },
  {
    code: 'CONFIG',
    command: 'rule.edge.add',
    messageMatches: 'trigger-only node (no input pins)',
    hint: 'The selected target has no input pins and cannot accept an edge. Choose a downstream card with an event/state input.',
  },
  {
    code: 'CONFIG',
    command: 'rule.edge.add',
    messageMatches: 'edge already exists:',
    hint: 'The exact edge is already present. Do not retry it; inspect the graph with `xgg rule view <id>`, or remove the old edge before replacing it.',
  },
  {
    code: 'CONFIG',
    command: 'rule.node.add',
    hint: 'Fix the node shortcut flag or JSON field named in error.message; `xgg rule node add --help` documents the valid shape.',
  },
  {
    code: 'CONFIG',
    command: 'rule.node.update',
    hint: 'Fix the node patch field named in error.message, then inspect the result with `xgg rule view <id>`.',
  },
  {
    code: 'CONFIG',
    command: 'rule.lint',
    hint: 'Specify exactly one of --rule-id <id> or --all.',
  },
  {
    code: 'CONFIG',
    command: '*',
    hint: 'Check --base-url, --code, or XGG_* env vars.',
  },

  // NETWORK
  {
    code: 'NETWORK',
    command: '*',
    messageMatches: 'MIoT spec registry',
    hint: 'The MIoT spec registry request failed. Check DNS/public internet connectivity and error.details.url/status, then retry.',
  },
  {
    code: 'NETWORK',
    command: '*',
    hint: 'Verify the gateway is reachable on the LAN.',
  },

  // NOT_CONFIRMED
  {
    code: 'NOT_CONFIRMED',
    command: '*',
    messageMatches: 'backup progress polling timed out',
    hint: 'The backup operation may still be running. Use error.details.from and error.details.progressId with `xgg backup progress --from <from> --progress-id <id>` before retrying the write.',
  },
  {
    code: 'NOT_CONFIRMED',
    command: 'variable.set-value',
    hint: 'Write was sent but ack timed out. The value MAY have changed — run `xgg variable get <scope>` to verify.',
  },
  {
    code: 'NOT_CONFIRMED',
    command: '*',
    hint: 'Write was sent but WS ack timed out; current state unknown.',
  },
];

function specificity(r: HintRule): number {
  // M11 F24: an exact message is the strongest signal, followed by a message
  // substring. Code+command comes next, then code-only, then catch-all.
  return (
    (r.messageEquals !== undefined ? 8 : 0) +
    (r.messageMatches !== undefined ? 4 : 0) +
    (r.code !== '*' ? 2 : 0) +
    (r.command !== '*' ? 1 : 0)
  );
}

export function lookupHint(code: string, command: string, message?: string): string {
  const matches = HINTS.filter((r) => {
    if (r.code !== code && r.code !== '*') return false;
    if (r.command !== command && r.command !== '*') return false;
    if (r.messageEquals !== undefined) {
      if (message === undefined || message !== r.messageEquals) return false;
    }
    if (r.messageMatches !== undefined) {
      if (message === undefined) return false;
      return message.includes(r.messageMatches);
    }
    return true;
  });
  if (matches.length === 0) return '';
  matches.sort((a, b) => specificity(b) - specificity(a));
  const top = matches[0];
  return top ? top.hint : '';
}

export interface ErrorJson {
  ok: false;
  error: {
    code: string;
    message: string;
    hint: string;
    details: Record<string, unknown> | undefined;
  };
}

export function formatErrorJson(err: unknown): ErrorJson {
  const command = (err as { __xggCmd?: string }).__xggCmd ?? '*';
  if (err instanceof XggError) {
    return {
      ok: false,
      error: {
        code: err.code,
        message: err.message,
        hint: lookupHint(err.code, command, err.message),
        details: err.details,
      },
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    ok: false,
    error: {
      code: 'UNKNOWN',
      message,
      hint: lookupHint('UNKNOWN', command, message),
      details: undefined,
    },
  };
}
