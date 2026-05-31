import type { ResourceDeps } from '../resources/index.js';
import { listScopes, listVariables } from '../resources/variables.js';
import { GatewayError, NotFoundError } from '../transport/errors.js';

// M15 (2026-05-29): the gateway only exposes variable reads, not device
// property reads (see docs/api/devices.md "Property / action endpoints —
// DEFERRED"). The Mi-Home Geek-Edition Tampermonkey "real-time variable
// dashboard" piggybacks on the page's WS via `editor.gateway.callAPI` and
// uses exactly two methods: `getVarScopeList` + `getVarList`. We already
// wrap both, so the work here is purely UX: produce a stable snapshot
// (scope → id → entry) and a deterministic diff so the CLI can offer a
// snapshot-once mode for AI-agent threshold picking and a `--follow`
// streaming mode that mirrors the dashboard's 800ms refresh.

export interface VariableSnapshotEntry {
  type: unknown;
  value: unknown;
  userData: Record<string, unknown>;
}

export type VariableSnapshot = Record<string, Record<string, VariableSnapshotEntry>>;

export interface SnapshotAllVariablesOpts {
  /** Restrict the snapshot to a single scope. Absent scopes return empty. */
  scope?: string;
}

export interface SnapshotAllVariablesResult {
  /** Epoch ms when the snapshot finished. */
  ts: number;
  /** ISO 8601 of `ts` — convenience for AI agents. */
  iso: string;
  /**
   * Scopes attempted in this snapshot (alphabetized for stable output).
   * Includes scopes whose `listVariables` call errored — see `errors`.
   * Use `Object.keys(snapshot)` for scopes that actually have data.
   */
  scopes: string[];
  /** Map of `scope -> id -> entry`. */
  snapshot: VariableSnapshot;
  /** Per-scope error message when `listVariables(scope)` threw — keyed by scope. */
  errors: Record<string, string>;
}

/**
 * Fan out `/api/getVarScopeList` + `/api/getVarList(scope)` for every scope
 * (or just `opts.scope` when given) and assemble a single point-in-time
 * snapshot. Only `GatewayError` (per-scope) is captured into `errors`;
 * `AuthExpiredError` / `SchemaError` / `NetworkError` rethrow (fail-fast per
 * commit 40e2984 — infra failures must not be hidden as scope errors).
 */
export async function snapshotAllVariables(
  deps: ResourceDeps,
  opts: SnapshotAllVariablesOpts = {},
): Promise<SnapshotAllVariablesResult> {
  const allScopes = await listScopes(deps);
  const candidates =
    opts.scope !== undefined ? allScopes.filter((s) => s === opts.scope) : [...allScopes];
  candidates.sort();

  if (opts.scope !== undefined && candidates.length === 0) {
    throw new NotFoundError(`variable scope not found: ${opts.scope}`, {
      scope: opts.scope,
      availableScopes: allScopes,
    });
  }

  const snapshot: VariableSnapshot = {};
  const errors: Record<string, string> = {};
  for (const scope of candidates) {
    try {
      const map = await listVariables(scope, deps);
      const norm: Record<string, VariableSnapshotEntry> = {};
      for (const [id, raw] of Object.entries(map)) {
        const obj = (raw ?? {}) as Record<string, unknown>;
        const userData =
          obj.userData && typeof obj.userData === 'object'
            ? (obj.userData as Record<string, unknown>)
            : {};
        norm[id] = { type: obj.type, value: obj.value, userData };
      }
      snapshot[scope] = norm;
    } catch (e) {
      if (!(e instanceof GatewayError)) throw e;
      errors[scope] = e instanceof Error ? e.message : String(e);
    }
  }

  const ts = Date.now();
  return { ts, iso: new Date(ts).toISOString(), scopes: candidates, snapshot, errors };
}

// ─── diff ────────────────────────────────────────────────────────────────────

export type VariableEventOp = 'add' | 'remove' | 'change';

export interface VariableEvent {
  /** Epoch ms — caller supplies via `opts.ts` so the surrounding loop can
   * stamp every event in a tick with the same wall time. */
  ts: number;
  iso: string;
  op: VariableEventOp;
  scope: string;
  id: string;
  /** `next` entry's type for `add`/`change`; `prev` entry's type for `remove`. */
  type?: unknown;
  /** Value before the change. Present on `change` and `remove`. */
  prevValue?: unknown;
  /** Value after the change. Present on `add` and `change`. */
  value?: unknown;
  /** Display name from `userData.name`, when present. */
  name?: string;
}

export interface DiffVariableSnapshotsOpts {
  ts: number;
  /** Restrict diff output to a single scope. */
  scope?: string;
}

/**
 * Compare two snapshots and emit a deterministic event stream describing
 * what changed. Events are sorted by `(scope, id)`. Equality is structural
 * over `type` + `value` (stringified) + `userData.name`. A variable rename
 * (`userData.name` changes, value/type stable) emits a change event so
 * streaming consumers see the new name. Other `userData` fields
 * (`lastUpdateTime`, `version`) are intentionally ignored to avoid emitting
 * on gateway-side metadata bumps that do not reflect user-visible state.
 */
export function diffVariableSnapshots(
  prev: VariableSnapshot,
  next: VariableSnapshot,
  opts: DiffVariableSnapshotsOpts,
): VariableEvent[] {
  const iso = new Date(opts.ts).toISOString();
  const scopeSet = new Set<string>([...Object.keys(prev), ...Object.keys(next)]);
  const scopes = (
    opts.scope !== undefined ? [...scopeSet].filter((s) => s === opts.scope) : [...scopeSet]
  ).sort();

  const events: VariableEvent[] = [];
  for (const scope of scopes) {
    const p = prev[scope] ?? {};
    const n = next[scope] ?? {};
    const ids = [...new Set<string>([...Object.keys(p), ...Object.keys(n)])].sort();
    for (const id of ids) {
      const pEntry = p[id];
      const nEntry = n[id];

      if (pEntry === undefined && nEntry !== undefined) {
        events.push(makeEvent('add', scope, id, opts.ts, iso, undefined, nEntry));
      } else if (pEntry !== undefined && nEntry === undefined) {
        events.push(makeEvent('remove', scope, id, opts.ts, iso, pEntry, undefined));
      } else if (pEntry !== undefined && nEntry !== undefined && !entryEqual(pEntry, nEntry)) {
        events.push(makeEvent('change', scope, id, opts.ts, iso, pEntry, nEntry));
      }
    }
  }
  return events;
}

function makeEvent(
  op: VariableEventOp,
  scope: string,
  id: string,
  ts: number,
  iso: string,
  prev: VariableSnapshotEntry | undefined,
  next: VariableSnapshotEntry | undefined,
): VariableEvent {
  const ref = next ?? prev;
  const evt: VariableEvent = { ts, iso, op, scope, id };
  if (ref !== undefined) evt.type = ref.type;
  if (next !== undefined) evt.value = next.value;
  if (prev !== undefined && op !== 'add') evt.prevValue = prev.value;
  const name = nameFor(ref);
  if (name !== undefined) evt.name = name;
  return evt;
}

function nameFor(entry: VariableSnapshotEntry | undefined): string | undefined {
  if (!entry) return undefined;
  const n = entry.userData?.name;
  return typeof n === 'string' ? n : undefined;
}

function entryEqual(a: VariableSnapshotEntry, b: VariableSnapshotEntry): boolean {
  return (
    stable(a.type) === stable(b.type) &&
    stable(a.value) === stable(b.value) &&
    nameFor(a) === nameFor(b)
  );
}

function stable(v: unknown): string {
  return JSON.stringify(v ?? null);
}
