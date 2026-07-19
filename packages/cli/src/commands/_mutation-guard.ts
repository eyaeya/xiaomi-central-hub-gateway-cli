import { ConfigError, type SessionStore, withMutationWorkflow } from '@eyaeya/xgg-core';
import { type Command, Option } from 'commander';
import {
  AGENT_MODE_NO_SNAPSHOT_FORBIDDEN_MESSAGE,
  AGENT_MODE_SNAPSHOTS_DIR_REQUIRED_MESSAGE,
} from '../mutation-guard-messages.js';
import { ttyBoldYellow } from '../tty.js';

export interface MutationGuardOpts {
  snapshotsDir?: string;
  snapshot?: boolean;
}

export interface ResolvedMutationGuard {
  /** Final snapshots-dir (CLI flag → env fallback). undefined = home default. */
  snapshotsDir: string | undefined;
  /** false ⇒ caller must skip the pre-write dump. */
  snapshotEnabled: boolean;
}

/** Hold the per-gateway lease across every live read/write in a CLI mutation. */
export function runMutationWorkflow<T>(
  operation: string,
  deps: { baseUrl: string; store: SessionStore; timeoutMs?: number },
  run: () => Promise<T>,
): Promise<T> {
  return withMutationWorkflow(
    {
      baseUrl: deps.baseUrl,
      store: deps.store,
      operation,
      ...(deps.timeoutMs !== undefined && { timeoutMs: deps.timeoutMs }),
    },
    run,
  );
}

/**
 * B10 / F63e — refresh-UI hint opts. `commander` parses `--no-refresh-hint`
 * into `refreshHint: false`; default is `true` (hint shown). Env-var
 * `XGG_NO_REFRESH_HINT=1` is honoured in `printRefreshHint` itself so callers
 * don't have to plumb it through each command.
 */
export interface RefreshHintOpts {
  refreshHint?: boolean;
}

/**
 * Single source of truth for the agent-mode mutation contract: when
 * `XGG_AGENT_MODE=1` is set, every mutation must persist a pre-write snapshot
 * into a caller-owned directory so the agent's workspace VCS captures the
 * audit trail (and a `git diff` after the failed run shows exactly what
 * would have changed).
 *
 * Centralising the check ensures rule.set / rule.delete / variable.* /
 * backup.* stay consistent with rule.node-* / rule.edge-* and that future
 * mutation handlers cannot quietly opt out.
 */
export function assertAgentModeOrSnapshotsDir(opts: MutationGuardOpts): ResolvedMutationGuard {
  const agentMode = process.env.XGG_AGENT_MODE === '1';
  const envDir = process.env.XGG_SNAPSHOTS_DIR;
  const snapshotsDir =
    opts.snapshotsDir ?? (envDir !== undefined && envDir !== '' ? envDir : undefined);
  const snapshotEnabled = opts.snapshot !== false;
  if (agentMode) {
    if (!snapshotsDir) {
      throw new ConfigError(AGENT_MODE_SNAPSHOTS_DIR_REQUIRED_MESSAGE);
    }
    if (!snapshotEnabled) {
      throw new ConfigError(AGENT_MODE_NO_SNAPSHOT_FORBIDDEN_MESSAGE);
    }
  }
  return { snapshotsDir, snapshotEnabled };
}

// B10 / F63e — refresh-UI hint after a successful gateway write.
//
// Why: the gateway does NOT fan configChanged from a non-UI session's write to
// other open WS sessions. When the operator
// runs `xgg variable create` / `rule new` / etc. with a 米家 dev-console tab
// open in the browser, the tab's in-memory cache stays stale until they F5 —
// silent footgun, exactly the B10 issue we're fixing.
//
// Always print on a successful mutation; let the operator opt out via
// `--no-refresh-hint` per-call or `XGG_NO_REFRESH_HINT=1` for an entire
// session. Goes to stderr so JSON-consumer agents reading stdout
// (output.ts emits on stdout) see clean JSON payloads. Prefixed `note:`
// to match the existing stderr-warning style at
// packages/cli/src/commands/rule/set.ts:61 etc.
//
// B10 / F64a (2026-05-30) — daemon-broadcast survey closed as INFEASIBLE.
// Bundle-side evidence: `configChanged` literal has 0 hits in both
// `gateway.6cbc85.js` and `ai-config-v5.28b650.js`; `ai-config` never
// invokes `registerPush()`/`sendPush()` (0 call sites). The gateway also
// does not fan client→client `/push/<name>` frames — the dispatcher only
// resolves request/response `id`s, and frames with no matching pending id
// are dropped silently in `JsonRpcRouter.readLoop()`. Even if the daemon
// injected a synthetic configChanged onto its WS, the gateway wouldn't
// relay and the SPA wouldn't honor it. F63e MVP is therefore the
// canonical fix forever; F64a strengthens it instead:
//   1. surface the gateway dev-console URL (one-click "open this tab")
//   2. embed the mutation context (`variable global/myvar`,
//      `rule 1234567890`) so the user knows what they just changed
//   3. bold-yellow ANSI when stderr is a TTY (live operators don't miss
//      the line). NOT colored when piped — JSON-consumer agents and CI
//      logs stay clean. Yellow chosen over red so it reads as
//      "info/warning", not "error".
const HINT_BODY =
  'refresh open 米家 dev console tab (F5) to see the change — CLI writes do not auto-push configChanged to other open WS sessions (B10). Pass --no-refresh-hint or set XGG_NO_REFRESH_HINT=1 to silence.';

/**
 * Optional extra detail attached to the hint:
 *   - `baseUrl`: the gateway base URL (e.g. `http://192.168.x.x:8086`).
 *     When set, the hint surfaces it as an actionable "open this tab" link.
 *   - `context`: a short human-readable mutation summary
 *     (e.g. `variable global/temp1`, `rule 1748234567890`) so the user
 *     knows what they just changed without scrolling back through the
 *     stdout JSON payload.
 */
export interface RefreshHintDetail {
  baseUrl?: string | undefined;
  context?: string | undefined;
}

export function printRefreshHint(opts: RefreshHintOpts, detail?: RefreshHintDetail): void {
  if (opts.refreshHint === false) return;
  if (process.env.XGG_NO_REFRESH_HINT === '1') return;
  const parts = ['note:'];
  if (detail?.context) parts.push(`[${detail.context}]`);
  parts.push(HINT_BODY);
  if (detail?.baseUrl) {
    // Trim trailing slash so we don't print `…://host:8086//`. The SPA
    // is served from the gateway root; no client-side route or query
    // string lets us deep-link to a specific rule (verified via
    // ai-config bundle: 0 history.pushState / 0 path:"/…" entries), so
    // the root URL is the most actionable link we can offer.
    const url = detail.baseUrl.replace(/\/+$/, '');
    parts.push(`Open: ${url}/`);
  }
  const line = `${ttyBoldYellow(process.stderr, parts.join(' '))}\n`;
  process.stderr.write(line);
}

/**
 * Attach the `--no-refresh-hint` flag to a command. Centralised so every
 * mutation site picks up the same wording and default (hint on) without
 * each call site having to duplicate the option definition.
 */
export function addRefreshHintFlag<T extends Command>(c: T): T {
  // `Option` with a default of `true` makes `--no-refresh-hint` flip the
  // parsed value to `false` (commander negation semantics). Plain
  // `.option('--no-refresh-hint', ...)` would also work but spelling it out
  // via Option keeps the help-line grouped with the other quiet/no-* flags.
  c.addOption(
    new Option(
      '--no-refresh-hint',
      'suppress the post-write "refresh 米家 web UI" hint (env: XGG_NO_REFRESH_HINT=1)',
    ).default(true),
  );
  return c;
}
