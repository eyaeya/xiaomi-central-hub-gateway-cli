import {
  AuthExpiredError,
  AuthRequiredError,
  ConfigError,
  NotConfirmedError,
  SchemaError,
  XggError,
} from '@xgg/core';

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
}

const HINTS: HintRule[] = [
  // SCHEMA
  {
    code: 'SCHEMA',
    command: 'rule.set',
    hint: 'cfg must mirror the RuleSummary returned by `xgg rule list`.',
  },
  // M6 schema / agent-mode
  {
    code: 'SCHEMA',
    command: 'rule.node.add',
    hint: 'cfg failed client-side schema parse. Run `xgg rule lint --explain --type <T>` to see the expected schema.',
  },
  {
    code: 'SCHEMA',
    command: 'rule.node.update',
    hint: 'patch failed client-side schema parse. Run `xgg rule lint --explain --type <T>` to see the expected cfg schema.',
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
  // messageMatches wins over the command-specific snapshots-dir hints below, so
  // a 卡片… validation failure gets an actionable fix instead of a misleading
  // env-var / agent-mode hint. error.details.issues carries EVERY offending
  // card (the message only names the first).
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
  {
    code: 'CONFIG',
    command: 'rule.node.add',
    hint: 'When XGG_AGENT_MODE=1 every mutation must be checkpointed: pass --snapshots-dir <dir> (or set XGG_SNAPSHOTS_DIR). For terminal use, unset XGG_AGENT_MODE.',
  },
  {
    code: 'CONFIG',
    command: 'rule.node.update',
    hint: 'When XGG_AGENT_MODE=1 every mutation must be checkpointed: pass --snapshots-dir <dir> (or set XGG_SNAPSHOTS_DIR).',
  },
  {
    code: 'CONFIG',
    command: 'rule.node.remove',
    hint: 'When XGG_AGENT_MODE=1 every mutation must be checkpointed: pass --snapshots-dir <dir> (or set XGG_SNAPSHOTS_DIR).',
  },
  {
    code: 'CONFIG',
    command: 'rule.edge.add',
    hint: 'When XGG_AGENT_MODE=1 every mutation must be checkpointed: pass --snapshots-dir <dir> (or set XGG_SNAPSHOTS_DIR).',
  },
  {
    code: 'CONFIG',
    command: 'rule.edge.remove',
    hint: 'When XGG_AGENT_MODE=1 every mutation must be checkpointed: pass --snapshots-dir <dir> (or set XGG_SNAPSHOTS_DIR).',
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
    hint: 'Verify the gateway is reachable on the LAN.',
  },

  // NOT_CONFIRMED
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
  // M11 F24: a message-match is the most specific signal — it fires only
  // for one particular gateway error class. Code+command pair comes
  // next, then code-only, then catch-all.
  return (
    (r.messageMatches !== undefined ? 4 : 0) +
    (r.code !== '*' ? 2 : 0) +
    (r.command !== '*' ? 1 : 0)
  );
}

export function lookupHint(code: string, command: string, message?: string): string {
  const matches = HINTS.filter((r) => {
    if (r.code !== code && r.code !== '*') return false;
    if (r.command !== command && r.command !== '*') return false;
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
