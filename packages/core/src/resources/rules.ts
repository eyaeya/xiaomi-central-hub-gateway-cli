import type {
  DeviceSpec,
  MiotAction,
  MiotEvent,
  MiotProperty,
  MiotService,
} from '../schemas/device-spec.js';
import {
  MIOT_COMPARISON_CONTRACT,
  isMiotEventWireOperator,
  miotShortcutOperatorToWire,
  parseFiniteDecimalLiteral,
  projectMiotComparisonDtype,
} from '../schemas/miot-comparison.js';
import { type DurationRange, parseDurationLiteral } from '../schemas/nodes/duration.js';
import { NodeUnion } from '../schemas/nodes/index.js';
import {
  GraphSetRequest,
  type Node,
  RuleGetResponse,
  RuleListResponse,
  type RuleSummary,
} from '../schemas/rule.js';
import {
  isValidVariableIdentifier,
  variableIdentifierMessage,
} from '../schemas/variable-identifier.js';
import {
  type AvailableVariable,
  type VarEntry,
  isValidVariableScopeName,
} from '../schemas/variable.js';
import { ConfigError, GatewayError, NotFoundError, parseOrThrow } from '../transport/errors.js';
import { agentCall } from '../usecases/agent-call.js';
import { inputPinNames, targetInputPinStatus } from '../usecases/edge-integrity.js';
import { getDeviceSpec } from '../usecases/get-device-spec.js';
import { layoutGraph } from '../usecases/layout-graph.js';
import { lintGraph } from '../usecases/lint-graph.js';
import { arePinColorsCompatible, resolvePinColor } from '../usecases/pin-colors.js';
import { checkReachability } from '../usecases/reachability.js';
import { validateGraphOrThrow } from '../usecases/validate-graph.js';
import { scanVariableReference } from '../usecases/variable-reference.js';
import { nextCardPosition, sizedPos } from './card-geometry.js';
import { annotateServiceDescription } from './device-partitions.js';
import { getDevice } from './devices.js';
import type { ResourceDeps } from './index.js';
import { withResourceMutationWorkflow } from './mutation-workflow.js';
import {
  createVariable,
  deleteVariable,
  isMissingScopeError,
  listAvailVarsForRule,
  listVariables,
} from './variables.js';

export async function listRules(deps: ResourceDeps): Promise<RuleSummary[]> {
  const raw = await agentCall({
    baseUrl: deps.baseUrl,
    method: '/api/getGraphList',
    params: {},
    store: deps.store,
    ...(deps.ipcClient !== undefined && { ipcClient: deps.ipcClient }),
    ...(deps.timeoutMs !== undefined && { timeoutMs: deps.timeoutMs }),
  });
  return parseOrThrow(RuleListResponse, raw, 'RuleListResponse');
}

export async function getRule(id: string, deps: ResourceDeps): Promise<RuleGetResponse> {
  try {
    const raw = await agentCall({
      baseUrl: deps.baseUrl,
      method: '/api/getGraph',
      params: { id },
      store: deps.store,
      ...(deps.ipcClient !== undefined && { ipcClient: deps.ipcClient }),
      ...(deps.timeoutMs !== undefined && { timeoutMs: deps.timeoutMs }),
    });
    return parseOrThrow(RuleGetResponse, raw, 'RuleGetResponse');
  } catch (err) {
    // F23: gateway reports missing graph as `Load file <path>/<id>.jsonz error: 2`.
    // Classify as NOT_FOUND so callers parity with device get / rule node add.
    if (err instanceof GatewayError && isLoadFileMissError(err.message, id)) {
      throw new NotFoundError(`rule not found: ${id}`, { id });
    }
    throw err;
  }
}

function isLoadFileMissError(message: string, id: string): boolean {
  return message.includes('Load file') && message.includes(id) && message.includes('error: 2');
}

export interface RuleView {
  id: string;
  cfg: RuleSummary;
  nodes: Node[];
}

/**
 * Read the full graph for a rule: list-then-get composition so callers receive
 * the same `{id, cfg, nodes}` shape `rule set --body` consumes. The cfg comes
 * from `listRules` (the only RPC that carries userData/enable/uiType), the
 * node list from `getRule`. This is the standard "view current graph" CLI
 * affordance — F9 / M7 walk-log §3.
 */
export async function viewRule(id: string, deps: ResourceDeps): Promise<RuleView> {
  const [rules, body] = await Promise.all([listRules(deps), getRule(id, deps)]);
  const cfg = rules.find((r) => r.id === id);
  if (cfg === undefined) {
    // Defensive: getRule would have already thrown NotFound for a missing id,
    // but if the gateway just removed it between the two reads we want a
    // consistent NotFound response instead of a phantom view.
    throw new NotFoundError(`rule not found: ${id}`, { id });
  }
  return { id, cfg, nodes: body.nodes };
}

export interface RuleEnableResult {
  id: string;
  prevEnable: boolean;
  enable: boolean;
}

async function setRuleEnable(
  id: string,
  enable: boolean,
  deps: ResourceDeps,
): Promise<RuleEnableResult> {
  // Read: get current summary so we can preserve userData/uiType.
  // changeGraphConfig is full-replace, not merge — omitting userData
  // would delete the rule's name. See docs/api/rules.md.
  const rules = await listRules(deps);
  const current = rules.find((r) => r.id === id);
  if (current === undefined) {
    throw new NotFoundError(`rule not found: ${id}`, { id });
  }

  await agentCall({
    baseUrl: deps.baseUrl,
    method: '/api/changeGraphConfig',
    params: {
      id,
      enable,
      uiType: current.uiType,
      userData: current.userData,
    },
    store: deps.store,
    kind: 'write',
    ...(deps.ipcClient !== undefined && { ipcClient: deps.ipcClient }),
    ...(deps.timeoutMs !== undefined && { timeoutMs: deps.timeoutMs }),
  });

  return { id, prevEnable: current.enable, enable };
}

export interface EnableRuleOptions {
  // F23 enable-gate (2026-05-30): default true. Before flipping `enable` on,
  // fetch the live graph + avail-vars and run the save()-equivalent validator
  // (per-card config + variable existence/scope). The official UI has no
  // separate "enable" step — save() is the only path to an enabled rule and it
  // refuses a graph with lost/ghost vars. The CLI split save into set + enable,
  // so enable is the universal funnel where we restore that invariant: an AI
  // Agent driving the CLI cannot silently activate a rule whose var cards point
  // at a deleted / foreign-scope variable. Set false for a deliberate raw probe
  // (`--no-validate`). disableRule is never gated.
  validate?: boolean;
  getDeviceSpec?: (urn: string) => Promise<DeviceSpec>;
}

async function enableRuleWithinWorkflow(
  id: string,
  deps: ResourceDeps,
  opts: EnableRuleOptions = {},
): Promise<RuleEnableResult> {
  if (opts.validate !== false) {
    const body = await getRule(id, deps);
    // F66a (2026-05-31) — lintGraph strict gate. On enable it blocks invalid
    // topology while retaining advisory warnings such as a same-node feedback
    // edge (GitHub #96), which the canvas permits and may intentionally stop.
    const lintIssues = lintGraph({ graph: { id, nodes: body.nodes }, strict: true });
    const firstLintError = lintIssues.find((i) => i.severity === 'error');
    if (firstLintError !== undefined) {
      throw new ConfigError(`${firstLintError.message} (${firstLintError.path})`, {
        issues: lintIssues,
      });
    }
    // F63b / GitHub #25 — graph-level directed reachability gate, enable-only.
    // A sink card (deviceOutput / varSet* / deviceGetSetVar) with no valid
    // source -> target path from an independent event source will never fire. The
    // gateway accepts the graph; the official UI's save() hides the trap
    // (canvas makes it visually obvious). The CLI's save-then-enable split
    // makes it possible to silently enable a dead rule — this gate restores
    // the invariant on the enable funnel. loop/register need upstream control
    // and timeRange is supporting state, so none is a bootstrap source. NOT run
    // in setGraph (incremental authoring may leave cards floating while wiring).
    if (Array.isArray(body.nodes)) {
      const reachIssues = checkReachability(body.nodes);
      const firstError = reachIssues.find((i) => i.severity === 'error');
      if (firstError !== undefined) {
        throw new ConfigError(`${firstError.message} (${firstError.path})`, {
          issues: reachIssues,
        });
      }
    }
    // Keep the purely local reachability gate before variable/spec lookups so
    // a statically dead graph is rejected after getGraph and before any
    // follow-up gateway RPC (especially before the enable write funnel).
    await validateGraphOrThrow({
      graph: { id, nodes: body.nodes },
      listAvailVars: (ruleId: string) => listAvailVarsForRule(ruleId, deps),
      ...(opts.getDeviceSpec !== undefined && { getDeviceSpec: opts.getDeviceSpec }),
    });
  }
  return setRuleEnable(id, true, deps);
}

export async function enableRule(
  id: string,
  deps: ResourceDeps,
  opts: EnableRuleOptions = {},
): Promise<RuleEnableResult> {
  return withResourceMutationWorkflow(deps, 'rule.enable', () =>
    enableRuleWithinWorkflow(id, deps, opts),
  );
}

export function disableRule(id: string, deps: ResourceDeps): Promise<RuleEnableResult> {
  return withResourceMutationWorkflow(deps, 'rule.disable', () => setRuleEnable(id, false, deps));
}

// F66c (2026-05-31) — rename + set-tags helpers. Both wrap the same
// changeGraphConfig({id, enable, uiType, userData}) full-replace shape
// setRuleEnable uses (the only mutation RPC for these fields). Bundle
// ai-config-v5:
//   • rename: `Jd.graphTool.graphConfig.userData.name = e.target.value` in
//     the rule-header input.onChange, flushed via Ri(Ti.ADD_CHANGED_TAB) →
//     save() → changeGraphConfig{id, enable, uiType, userData:{...,name}}.
//   • tags: rule-tag modal save callback writes
//     `n.userData.tags = tagList.filter(c.checked && c.inputValue).map(label)`,
//     flushed identically through changeGraphConfig.
// Both helpers read the live summary so every cfg field the caller is NOT
// modifying survives; monotonic-now ensures lastUpdateTime advances
// (save()-parity).
function monotonicNow(prior: number | undefined): number {
  const seen = typeof prior === 'number' ? prior : 0;
  return Math.max(seen, Date.now());
}

async function patchRuleUserData(
  id: string,
  patch: (userData: RuleSummary['userData']) => RuleSummary['userData'],
  deps: ResourceDeps,
): Promise<void> {
  const rules = await listRules(deps);
  const current = rules.find((r) => r.id === id);
  if (current === undefined) {
    throw new NotFoundError(`rule not found: ${id}`, { id });
  }
  const nextUserData = patch(current.userData);
  const userData = {
    ...nextUserData,
    lastUpdateTime: monotonicNow(nextUserData.lastUpdateTime),
  };
  await agentCall({
    baseUrl: deps.baseUrl,
    method: '/api/changeGraphConfig',
    params: {
      id,
      enable: current.enable,
      uiType: current.uiType,
      userData,
    },
    store: deps.store,
    kind: 'write',
    ...(deps.ipcClient !== undefined && { ipcClient: deps.ipcClient }),
    ...(deps.timeoutMs !== undefined && { timeoutMs: deps.timeoutMs }),
  });
}

export async function renameRule(id: string, newName: string, deps: ResourceDeps): Promise<void> {
  await withResourceMutationWorkflow(deps, 'rule.rename', () =>
    patchRuleUserData(id, (userData) => ({ ...userData, name: newName }), deps),
  );
}

export async function setRuleTags(id: string, tags: string[], deps: ResourceDeps): Promise<void> {
  await withResourceMutationWorkflow(deps, 'rule.set-tags', () =>
    patchRuleUserData(id, (userData) => ({ ...userData, tags: [...tags] }), deps),
  );
}

export interface SetGraphOptions {
  validate?: boolean;
  getDeviceSpec?: (urn: string) => Promise<DeviceSpec>;
  listAvailVars?: (ruleId: string) => Promise<AvailableVariable[]>;
  // F66a (2026-05-31) — skip ONLY the lintGraph canvas-predicate gate while
  // keeping validateGraphOrThrow active. Subtractive internal mutators
  // (removeNode no-cascade, removeEdge, …) may write a graph whose edges the
  // canvas would refuse only because earlier authoring left a dangling
  // reference behind — re-rejecting it here would block legitimate cleanup.
  // The CLI funnel paths (`rule set`, `rule import`, `rule edge add`)
  // intentionally keep the lint gate ON.
  skipLint?: boolean;
}

async function preflightGraphMutation(req: GraphSetRequest, opts: SetGraphOptions): Promise<void> {
  const params = parseOrThrow(GraphSetRequest, req, 'GraphSetRequest');
  if (opts.validate === false) return;
  if (opts.skipLint !== true) {
    const lintIssues = lintGraph({ graph: params, strict: true });
    const firstLintError = lintIssues.find((i) => i.severity === 'error');
    if (firstLintError !== undefined) {
      throw new ConfigError(`${firstLintError.message} (${firstLintError.path})`, {
        issues: lintIssues,
      });
    }
  }
  // Keep deterministic schema/per-card checks ahead of session access. Live
  // variable/spec callbacks remain inside the leased implementation below.
  await validateGraphOrThrow({ graph: params });
}

async function setGraphWithinWorkflow(
  req: GraphSetRequest,
  deps: ResourceDeps,
  opts: SetGraphOptions = {},
): Promise<void> {
  const params = parseOrThrow(GraphSetRequest, req, 'GraphSetRequest');
  if (opts.validate !== false) {
    // F66a (2026-05-31) — lintGraph gate on the write funnel. Bundle
    // ai-config-v5.28b650.js connectTool.connect (the canvas wire-drag
    // predicate) rejects dangling targets, cross-color edges, fan-in>1, and
    // duplicates before they ever reach setGraph. Same-node feedback is canvas-
    // legal and remains a warning (GitHub #96). CLI bodies (`rule set --stdin`,
    // `rule import`, `rule node add` chains) skip the canvas and may otherwise
    // persist broken edges. Promote only lintGraph's error issues to a
    // ConfigError so every CLI write path inherits the blocking predicates.
    // `skipLint` is the internal-mutator opt-out (see SetGraphOptions).
    if (opts.skipLint !== true) {
      const lintIssues = lintGraph({ graph: params, strict: true });
      const firstLintError = lintIssues.find((i) => i.severity === 'error');
      if (firstLintError !== undefined) {
        throw new ConfigError(`${firstLintError.message} (${firstLintError.path})`, {
          issues: lintIssues,
        });
      }
    }
    // F23: opt-in for the variable-existence check. The CLI `rule set` /
    // `rule node add` paths chain many setGraph calls; auto-fetching the
    // avail-vars list twice per write would double the per-write RPC count
    // on common authoring flows. Use `xgg rule validate --rule-id <id>` for
    // the dedicated dry-run check after each write batch instead.
    await validateGraphOrThrow({
      graph: params,
      ...(opts.getDeviceSpec !== undefined && { getDeviceSpec: opts.getDeviceSpec }),
      ...(opts.listAvailVars !== undefined && { listAvailVars: opts.listAvailVars }),
    });
  }
  await agentCall({
    baseUrl: deps.baseUrl,
    method: '/api/setGraph',
    params,
    store: deps.store,
    kind: 'write',
    ...(deps.ipcClient !== undefined && { ipcClient: deps.ipcClient }),
    ...(deps.timeoutMs !== undefined && { timeoutMs: deps.timeoutMs }),
  });
}

export async function setGraph(
  req: GraphSetRequest,
  deps: ResourceDeps,
  opts: SetGraphOptions = {},
): Promise<void> {
  await preflightGraphMutation(req, opts);
  return withResourceMutationWorkflow(deps, 'rule.set-graph', () =>
    setGraphWithinWorkflow(req, deps, opts),
  );
}

// W-A (2026-05-29 save-flow parity): the official save() always refreshes
// `userData.lastUpdateTime` to the current time before writing (ai-config
// save(): `n.userData.lastUpdateTime = Date.now()`). The CLI's incremental
// mutators read a RuleSummary via listRules and forward it to setGraph; without
// this bump the gateway/app "last edited" ordering regresses to whatever was
// last written by the UI. Kept in the mutator layer (not setGraph) so setGraph
// stays a faithful primitive for `rule export`/raw-probe round-trips, mirroring
// how the gateway keeps the bump in save() rather than saveRule. Monotonic
// guard: never write a timestamp below the value we just read.
function refreshTimestamp(summary: RuleSummary): RuleSummary {
  const existing =
    typeof summary.userData?.lastUpdateTime === 'number' ? summary.userData.lastUpdateTime : 0;
  return {
    ...summary,
    userData: { ...summary.userData, lastUpdateTime: Math.max(existing, Date.now()) },
  };
}

export interface UpsertGraphOptions extends SetGraphOptions {
  // Write the body's cfg (enable/uiType/userData) verbatim instead of
  // preserving the live rule's. lastUpdateTime is still bumped to now.
  allowCfgOverwrite?: boolean;
  /**
   * Create-only precondition used by clone replay. If the destination id is
   * already present in the live rule list, fail before `/api/setGraph` rather
   * than preserving its cfg and replacing its nodes.
   *
   * The check and write are adjacent in this resource workflow. A future
   * per-gateway mutation lease can make that pair atomic with respect to other
   * xgg writers; the gateway currently exposes no compare-and-swap primitive
   * for external Mi Home writers.
   */
  expectAbsent?: boolean;
}

export interface UpsertGraphResult {
  id: string;
  // true when an existing rule's cfg was preserved over the body's (default
  // path); false for a brand-new rule or under allowCfgOverwrite.
  cfgPreserved: boolean;
  // true when the body's cfg.enable differed from the live rule's and was
  // ignored — the caller should warn and point at `rule enable`/`disable`.
  cfgEnableIgnored: boolean;
}

// W-B (2026-05-29 save-flow parity): `rule set` is the CLI analog of the UI
// Save button. The official save() preserves the loaded rule's cfg
// (enable/uiType/userData) and only bumps lastUpdateTime — it never lets the
// edited payload silently regress those fields. `rule set --body` used to
// forward a hand-edited body verbatim, so a stale export could disable a live
// rule or roll its timestamp backward (F24/W1). upsertGraph reads the live
// summary and, by default, preserves enable/uiType/userData (bumping the
// timestamp), treating the body purely as a nodes update. allowCfgOverwrite
// opts into the body's cfg verbatim (still timestamp-bumped). A rule absent
// from listRules is a create — the body cfg is used as-is.
async function upsertGraphWithinWorkflow(
  body: GraphSetRequest,
  deps: ResourceDeps,
  opts: UpsertGraphOptions = {},
): Promise<UpsertGraphResult> {
  const parsed = parseOrThrow(GraphSetRequest, body, 'GraphSetRequest');
  const rules = await listRules(deps);
  const live = rules.find((r) => r.id === parsed.id);
  if (opts.expectAbsent === true && live !== undefined) {
    throw new ConfigError(
      `rule ${parsed.id} already exists; create-only replay will not overwrite it`,
      { id: parsed.id, expectAbsent: true },
    );
  }

  let cfg: RuleSummary;
  let cfgPreserved = false;
  let cfgEnableIgnored = false;
  if (live !== undefined && opts.allowCfgOverwrite !== true) {
    cfgEnableIgnored = parsed.cfg.enable !== live.enable;
    cfg = refreshTimestamp(live);
    cfgPreserved = true;
  } else {
    cfg = refreshTimestamp(parsed.cfg);
  }

  const { allowCfgOverwrite: _allowCfgOverwrite, expectAbsent: _expectAbsent, ...setOpts } = opts;
  // F23 save()-parity (2026-05-30): `rule set` is the CLI analog of the UI Save
  // button, and the official save() runs the variable-existence check. Build
  // listAvailVars by default (unless validation is off or the caller already
  // supplied one) so a copied / stale body whose var cards reference a foreign
  // rule's local scope is rejected at the write — not silently shipped to
  // surface as "卡片变量丢失" in the UI. A single getVarList pair per upsert
  // (the cost the per-write opt-in deliberately avoided for N-call `node add`).
  const setOptsWithVars: SetGraphOptions =
    setOpts.validate !== false && setOpts.listAvailVars === undefined
      ? { ...setOpts, listAvailVars: (ruleId: string) => listAvailVarsForRule(ruleId, deps) }
      : setOpts;
  await setGraph({ ...parsed, cfg }, deps, setOptsWithVars);
  return { id: parsed.id, cfgPreserved, cfgEnableIgnored };
}

export async function upsertGraph(
  body: GraphSetRequest,
  deps: ResourceDeps,
  opts: UpsertGraphOptions = {},
): Promise<UpsertGraphResult> {
  await preflightGraphMutation(body, opts);
  return withResourceMutationWorkflow(deps, 'rule.upsert', () =>
    upsertGraphWithinWorkflow(body, deps, opts),
  );
}

// F63a (B1+B11) — `R<ruleId>` and `global` scopes don't exist on the gateway
// until something is written into them: there is no addScope/createScope RPC
// (verified against the official gateway frontend bundle — the only
// callAPI vocab that materialises a scope is `createVar`; docs/api/variables.md:112
// confirms "If the scope does not exist, it is auto-created"). That means a
// fresh `rule new` produces a rule whose `R<ruleId>` scope is absent; if the
// user later wires a var card pointing at that scope, `rule enable`'s var-
// existence gate (see validate-graph.ts:430 "卡片变量丢失") trips because
// `listAvailVarsForRule` treats the gateway's known missing-scope responses as
// an empty scope. Same root cause blocks any rule referencing a `global`
// var on a fresh gateway with no globals defined (B11).
//
// ensureScopeBootstrapped is the single private helper both call sites share.
// It is idempotent: it first reads the scope's var list; if ≥1 var exists,
// the scope is alive and we skip the write. Otherwise it writes a sacrificial
// placeholder (`__xgg_scope_init` for global / `__r_scope_init` for R-scopes)
// whose name makes the source clear in the UI. The placeholder is retained
// by design — the user can delete it manually if they don't want it. Errors from a racing concurrent
// create (`Variable already exists`) are tolerated so retries are safe.
async function ensureScopeBootstrapped(scope: string, deps: ResourceDeps): Promise<void> {
  // Rule ids are valid graph ids even when they contain hyphens, but gateway
  // variable scopes are strictly alphanumeric. In that case `R<ruleId>` cannot
  // be materialised as a variable scope; keep rule creation successful and
  // skip only the local-scope convenience bootstrap.
  if (!isValidVariableScopeName(scope)) return;

  // Idempotence guard: if listVariables returns ≥1 var the scope is alive.
  // The gateway returns one of two phrasings when the scope doesn't exist
  // yet — older firmware says "Invalid scope", current firmware says
  // "Scope <name> does not exist" (verified live 2026-05-30 against
  // miaomiaoce/lumi-acn01 firmware). Match both so the bootstrap path
  // works across firmware revs; that's the case we want to fix, so
  // swallow and proceed to createVar.
  try {
    const existing = await listVariables(scope, deps);
    if (Object.keys(existing).length > 0) return;
  } catch (err) {
    if (!isMissingScopeError(err)) throw err;
    // Missing scope → fall through to createVar (which materialises it).
  }

  // Var id must be alphanumeric per gateway constraint (no underscore /
  // hyphen / dot — verified live 2026-05-30 with "Invalid id format").
  // Original F63a draft used "__xgg_scope_init" / "__r_scope_init" which
  // failed at runtime; use camelCase pseudo-magic prefix instead.
  const id = scope === 'global' ? 'xggGlobalInit' : 'xggRuleInit';
  const name =
    scope === 'global'
      ? 'global scope initializer (auto-created by xgg)'
      : 'rule scope initializer (auto-created by xgg)';
  try {
    await createVariable(
      {
        scope,
        id,
        type: 'number',
        value: 0,
        // F66-VarUserData-relax (2026-05-31): bundle ground truth —
        // UI Da.createVar only sends `userData:{name}`; gateway-side
        // qr.createVar has no userData constraint. Don't synthesize
        // lastUpdateTime/version (ghost data the gateway ignores).
        userData: { name },
      },
      deps,
    );
  } catch (err) {
    // Tolerate a concurrent racer (or a prior manual create with the same id).
    // The gateway error vocab here varies by bundle version — match the common
    // "already exists" / duplicate id phrasing without being over-specific.
    if (err instanceof GatewayError && /already exists|duplicate/i.test(err.message)) {
      return;
    }
    throw err;
  }
}

export interface CreateRuleOptions {
  // Skip the scope-bootstrap follow-ups. Reserved for raw probes / restore
  // flows where the caller is supplying the scope state themselves.
  skipScopeBootstrap?: boolean;
}

// F63a — `rule new` analog at the core layer. Wraps setGraph + the two
// scope-bootstrap follow-ups so every CLI/library path that creates a rule
// gets the same invariant ("`R<ruleId>` exists immediately" when the derived
// variable scope is valid). Without this, the agent-funnel write path
// would silently produce rules whose `rule enable` later fails — too far from
// the originating action to debug.
async function createRuleWithinWorkflow(
  req: GraphSetRequest,
  deps: ResourceDeps,
  opts: CreateRuleOptions = {},
): Promise<void> {
  const params = parseOrThrow(GraphSetRequest, req, 'GraphSetRequest');
  // setGraph already runs UI-validator + parseOrThrow; we pass an empty-nodes
  // body in the happy path so that's a no-op, but pass-through keeps surface
  // symmetric with any future `createRule({nodes:[…]})` shortcut.
  await setGraph(params, deps);
  if (opts.skipScopeBootstrap === true) return;
  // Bootstrap R<ruleId> first (the per-rule scope is the most common need),
  // then global. Order doesn't affect correctness but keeps the call log
  // readable.
  await ensureScopeBootstrapped(`R${params.id}`, deps);
  await ensureScopeBootstrapped('global', deps);
}

export async function createRule(
  req: GraphSetRequest,
  deps: ResourceDeps,
  opts: CreateRuleOptions = {},
): Promise<void> {
  await preflightGraphMutation(req, {});
  return withResourceMutationWorkflow(deps, 'rule.create', () =>
    createRuleWithinWorkflow(req, deps, opts),
  );
}

async function deleteGraphWithinWorkflow(id: string, deps: ResourceDeps): Promise<void> {
  await agentCall({
    baseUrl: deps.baseUrl,
    method: '/api/deleteGraph',
    params: { id },
    store: deps.store,
    kind: 'write',
    ...(deps.ipcClient !== undefined && { ipcClient: deps.ipcClient }),
    ...(deps.timeoutMs !== undefined && { timeoutMs: deps.timeoutMs }),
  });
  // F63f (2026-05-30) — cascade R-scope variable cleanup. The gateway's
  // `/api/deleteGraph` removes the rule body but leaves the rule-local
  // variable scope (`R<ruleId>`) intact, so any vars created by `rule new`
  // auto-create (B1 lifecycle pair) or by hand survive as ghost data the UI
  // can't surface — there is no rule to attach them to. The cleanup must
  // live on the write path itself (not just CLI lint) so every funnel — CLI delete,
  // future bulk delete, programmatic SDK use — inherits it. A known missing-
  // scope response (rule never had a local scope) is swallowed and logged,
  // matching the existing `listAvailVarsForRule` swallow precedent in
  // variables.ts; other GatewayErrors propagate so an unexpected cascade
  // failure isn't silently dropped. Runs ONLY after the primary delete
  // resolves — a failed delete must not strand the cascade or claim cleanup.
  const scope = `R${id}`;
  if (!isValidVariableScopeName(scope)) return;
  try {
    await deleteVariable({ scope, all: true }, deps);
  } catch (e) {
    if (isMissingScopeError(e)) {
      process.stderr.write(
        `[rule.delete] cascade: R-scope ${scope} absent (no local vars to clean up)\n`,
      );
      return;
    }
    throw e;
  }
}

export async function deleteGraph(id: string, deps: ResourceDeps): Promise<void> {
  return withResourceMutationWorkflow(deps, 'rule.delete', () =>
    deleteGraphWithinWorkflow(id, deps),
  );
}

// M10 F17: AddNodeShortcut now spans device + non-device node types.
// Discriminated by `type`; runtime synthesize functions inspect only the
// fields relevant to each branch.
export type NonDeviceNodeType =
  | 'onLoad'
  | 'condition'
  | 'logicAnd'
  | 'logicOr'
  | 'signalOr'
  | 'logicNot'
  | 'counter'
  | 'onlyNTimes'
  | 'delay'
  | 'statusLast'
  | 'loop'
  | 'timeRange'
  | 'varChange'
  | 'varGet'
  | 'varSetNumber'
  | 'varSetString'
  | 'register'
  | 'eventSequence'
  | 'modeSwitch'
  | 'alarmClock';

export interface AddNodeShortcut {
  type:
    | 'deviceInput'
    | 'deviceOutput'
    | 'deviceGet'
    | 'deviceInputSetVar'
    | 'deviceGetSetVar'
    | NonDeviceNodeType;
  // Optional node id override — used by `xgg rule export` round-trip and
  // by callers that need stable ids referenced by `rule edge add`. When
  // omitted, the synth functions mint a new `n-<epoch-ms>` id.
  id?: string;
  // Optional canvas position override — `xgg rule export` sets this so a
  // round-trip preserves the user's web-UI layout. Without it the synth
  // emits a canonical default (which is visually but not semantically
  // different from the source). exprHeight is valid only for varSetNumber /
  // varSetString expression cards.
  pos?: { x: number; y: number; width: number; height: number; exprHeight?: number };
  // ---- device-side fields (deviceInput / deviceOutput / device*SetVar) ----
  deviceDid?: string;
  // F63c (2026-05-30): disambiguates --device-property / --device-action /
  // --device-event when a MIoT spec exposes the same short-name (e.g. `on`,
  // `occupancy-status`, `click`) under multiple services. Without this the
  // resolver used to silently return the first siid hit; now it throws a
  // ConfigError listing every candidate siid and asks the caller to pass
  // --device-siid <N>. When set, the resolver filters to service.iid === N.
  deviceSiid?: number;
  deviceProperty?: string;
  deviceAction?: string;
  // F11 (M9): event-driven deviceInput trigger (e.g. BLE button `click`).
  // Codex M8 reverse-engineering: props = `{did, siid, eiid, arguments: []}`
  // with `cfg.version: 0`.
  deviceEvent?: string;
  // B9 / F63d (2026-05-30): per-piid filter expressions for deviceInput
  // event-mode. Each entry is `<piid><op><v1>` where op ∈ {=, !=, >, <, >=,
  // <=}. The synth looks up the dtype via service.properties[piid].format,
  // validates piid ∈ event.arguments, and emits the right F59
  // DeviceInputEventArgument union arm in props.arguments. Omitting this
  // field preserves today's F11 behavior (arguments: []).
  deviceEventArgs?: string[];
  // B4 / F65a (2026-05-30): per-piid variable routing for deviceInputSetVar
  // event-mode. Each entry is `<piid>=<scope>.<id>` (e.g. `1=global.lockOpId`).
  // Symmetric to deviceEventArgs but for SET-VAR side: each captured event
  // argument flows into its own destination variable. Mutually exclusive
  // with varScope/varId. When provided the synth emits one
  // arguments[] entry per --event-arg-var with the dtype resolved from
  // service.properties[piid].format → SetVarDtype.
  deviceEventArgVars?: string[];
  threshold?: number;
  // String property comparison literal for deviceInput/deviceGet. Kept
  // separate from numeric `threshold` so CLI values never pass through
  // Number.parseFloat and silently become NaN.
  propertyValue?: string;
  // F49 (2026-05-30) — `between` joins the comparator vocab for the int
  // dtype (deviceInput/deviceGet) and number varType (varChange/varGet).
  // Requires --threshold + --threshold2 (or threshold + threshold2 fields
  // on the synth API) for v1/v2. Bundle rejects with "Invalid v2" when
  // either bound is missing or non-integer.
  op?: 'gt' | 'lt' | 'eq' | 'ne' | 'gte' | 'lte' | 'between';
  params?: Record<string, unknown>;
  // F16: deviceOutput property-write value (bool→0/1, int→parseInt, ...).
  value?: string;
  // M11 F19: opt out of the threshold ∈ MIoT value-range check on
  // deviceInput shortcuts. The validator otherwise refuses thresholds
  // outside the spec range to save a round-trip + dead rule.
  forceOutOfRange?: boolean;
  // ---- non-device-side fields (M10 F17) ----
  // logicAnd / logicOr: number of inputs (default 2 → input0..inputN-1).
  inputs?: number;
  // Duration-card display value. delay/loop retain the gateway-compatible
  // integer domain; statusLast/eventSequence require a positive integer.
  duration?: string;
  interval?: string;
  // timeRange: "HH:MM" or "HH:MM:SS" window. Plus weekday filter below.
  start?: string;
  end?: string;
  // Day-of-week filter shared by timeRange + alarmClock
  weekdayOnly?: boolean;
  holidayOnly?: boolean;
  days?: number[];
  // varChange trigger and device*SetVar target
  varScope?: string;
  varId?: string;
  // F16 (2026-05-28 audit): gateway variable type vocab is strictly
  // `number | string` — `createVar` rejects `boolean`/`bool`/`int` with
  // `Unsupported type`. Narrow the shortcut to match.
  varType?: 'number' | 'string';
  // F41 (2026-05-30) — string varType varChange/varGet v1 value. Required
  // when `varType: 'string'`; mutually exclusive with `threshold`. The CLI
  // `--var-value <S>` flag forwards the raw string without parseFloat
  // coercion (which would silently NaN-out any non-numeric input).
  varValue?: string;
  threshold2?: number;
  allowUnknownScope?: boolean;
  // varSetNumber / varSetString (M14 task F, 2026-05-29): a single
  // user-facing expression string. The synthesizer runs `parseVarSetExpr()`
  // to produce the gateway's `elements: [{type:"const"|"var",...}]` shape.
  // `$id` defaults to `defaultExprScope` (or "global"); `$scope.id` qualifies.
  expr?: string;
  defaultExprScope?: string;
  // modeSwitch (M14 task G, 2026-05-29): how many `output<N>` pins to pre-create.
  // The `inputs?: number` field is reused for logicAnd/logicOr/signalOr; this
  // is the parallel `outputs` field for modeSwitch.
  outputsCount?: number;
  // alarmClock: pick one of `at` (periodicAlarm) / `sunrise` / `sunset`
  at?: string;
  sunrise?: boolean;
  sunset?: boolean;
  offsetMin?: number;
  latitude?: number;
  longitude?: number;
}

// CLI-typed helper: which shortcut types skip device/spec fetch
const NON_DEVICE_SHORTCUT_TYPES = new Set<string>([
  'onLoad',
  'condition',
  'logicAnd',
  'logicOr',
  'signalOr',
  'logicNot',
  'counter',
  'onlyNTimes',
  'delay',
  'statusLast',
  'loop',
  'timeRange',
  'varChange',
  'varGet',
  'varSetNumber',
  'varSetString',
  'register',
  'eventSequence',
  'modeSwitch',
  'alarmClock',
]);

export function isNonDeviceShortcut(s: AddNodeShortcut): boolean {
  return NON_DEVICE_SHORTCUT_TYPES.has(s.type);
}

export interface AddNodeInput {
  ruleId: string;
  node?: unknown;
  shortcut?: AddNodeShortcut;
  /** Optional pure fake-spec seam for offline tests and embedders. */
  getDeviceSpec?: (urn: string) => Promise<DeviceSpec>;
  validate?: boolean;
  // F66f (2026-05-31) — opt-out of the incremental var-existence sweep.
  // Defaults to ON (mirrors the UI save() nodeCheckTool variable phase). Set
  // to false for raw probes / restore flows that knowingly touch a graph
  // whose var refs the gateway has not yet materialised.
  varCheck?: boolean;
}

function assertShortcutVariableIdentifiers(shortcut: AddNodeShortcut): void {
  if (shortcut.varScope !== undefined && !isValidVariableIdentifier(shortcut.varScope)) {
    throw new ConfigError(
      `--var-scope "${shortcut.varScope}" ${variableIdentifierMessage('scope')}`,
      { scope: shortcut.varScope },
    );
  }
  if (shortcut.varId !== undefined && !isValidVariableIdentifier(shortcut.varId)) {
    throw new ConfigError(`--var-id "${shortcut.varId}" ${variableIdentifierMessage('id')}`, {
      id: shortcut.varId,
    });
  }
  if (
    shortcut.defaultExprScope !== undefined &&
    !isValidVariableIdentifier(shortcut.defaultExprScope)
  ) {
    throw new ConfigError(
      `--default-expr-scope "${shortcut.defaultExprScope}" ${variableIdentifierMessage('scope')}`,
      { scope: shortcut.defaultExprScope },
    );
  }
  if (shortcut.type === 'deviceInputSetVar' && Array.isArray(shortcut.deviceEventArgVars)) {
    for (const raw of shortcut.deviceEventArgVars) parseEventArgVarTarget(raw);
  }
}

function assertShortcutPositionUsage(shortcut: AddNodeShortcut): void {
  if (shortcut.pos?.exprHeight === undefined) return;
  if (shortcut.type === 'varSetNumber' || shortcut.type === 'varSetString') return;
  throw new ConfigError(
    `position exprHeight only applies to varSetNumber/varSetString shortcuts (got type ${shortcut.type})`,
    { type: shortcut.type, exprHeight: shortcut.pos.exprHeight },
  );
}

function preflightAddNode(input: AddNodeInput): void {
  let localNode: unknown;
  if (input.shortcut !== undefined) {
    assertShortcutVariableIdentifiers(input.shortcut);
    assertShortcutPositionUsage(input.shortcut);
    if (
      input.shortcut.propertyValue !== undefined &&
      !(
        (input.shortcut.type === 'deviceInput' || input.shortcut.type === 'deviceGet') &&
        input.shortcut.deviceProperty !== undefined &&
        input.shortcut.deviceEvent === undefined
      )
    ) {
      throw new ConfigError(
        '--property-value only applies to deviceInput/deviceGet property-mode shortcuts',
        { type: input.shortcut.type },
      );
    }
    if (isNonDeviceShortcut(input.shortcut)) {
      localNode = synthesizeNonDeviceShortcut(input.shortcut);
    } else if (!input.shortcut.deviceDid) {
      throw new ConfigError(`shortcut type "${input.shortcut.type}" requires --device-did`);
    } else {
      assertDeviceShortcutLocalShape(input.shortcut);
      // Remaining device/spec-dependent synthesis belongs inside the leased
      // workflow, but all required/mutex checks above stay ahead of session
      // access so an eager lease cannot shadow deterministic CONFIG errors.
      return;
    }
  } else if (input.node !== undefined) {
    localNode = input.node;
  } else {
    throw new ConfigError('addNode requires either `node` or `shortcut`');
  }
  parseOrThrow(NodeUnion, localNode, 'AddNodeInput.node');
}

function assertDeviceShortcutLocalShape(shortcut: AddNodeShortcut): void {
  switch (shortcut.type) {
    case 'deviceInput':
      if (!shortcut.deviceEvent && !shortcut.deviceProperty) {
        throw new ConfigError(
          'deviceInput shortcut requires --device-property (or --device-event for event-driven triggers)',
        );
      }
      return;
    case 'deviceOutput':
      if (shortcut.deviceAction) return;
      if (shortcut.deviceProperty) {
        if (shortcut.value === undefined) {
          throw new ConfigError(
            'deviceOutput property-write shortcut requires --value (the value to write)',
          );
        }
        return;
      }
      throw new ConfigError(
        'deviceOutput shortcut requires either --device-action or --device-property + --value',
      );
    case 'deviceGet':
      if (!shortcut.deviceProperty) {
        throw new ConfigError('deviceGet shortcut requires --device-property');
      }
      return;
    case 'deviceGetSetVar':
    case 'deviceInputSetVar':
      if (shortcut.deviceEvent !== undefined) {
        if (shortcut.type === 'deviceGetSetVar') {
          throw new ConfigError(
            'deviceGetSetVar is property-only (--device-property). Bundle Pr.deviceGetSetVar has no event-mode branch — use deviceInputSetVar --device-event for event-driven captures.',
            { event: shortcut.deviceEvent, type: shortcut.type },
          );
        }
        if (shortcut.deviceProperty !== undefined) {
          throw new ConfigError(
            `${shortcut.type} cannot mix --device-event with --device-property; pick one trigger.`,
            { event: shortcut.deviceEvent, property: shortcut.deviceProperty },
          );
        }
        const argVarsRaw = shortcut.deviceEventArgVars ?? [];
        if (argVarsRaw.length > 0 && (shortcut.varScope || shortcut.varId)) {
          throw new ConfigError(
            `deviceInputSetVar --device-event "${shortcut.deviceEvent}": --event-arg-var is mutually exclusive with --var-scope/--var-id. Use --event-arg-var "<piid>=<scope>.<id>" for each captured argument (one entry per arg).`,
            { event: shortcut.deviceEvent, argVars: argVarsRaw },
          );
        }
        return;
      }
      if (!shortcut.deviceProperty) {
        throw new ConfigError(
          `${shortcut.type} shortcut requires --device-property (or --device-event for deviceInputSetVar event-mode)`,
        );
      }
      if (!shortcut.varScope || !shortcut.varId) {
        throw new ConfigError(`${shortcut.type} shortcut requires --var-scope and --var-id`);
      }
      return;
    default:
      throw new ConfigError(`shortcut type "${shortcut.type}" not supported yet`);
  }
}

// Append a node to a rule's graph. Two reads (getGraph + listRules) feed one
// write (setGraph): getGraph supplies the current nodes[], listRules supplies
// the cfg/RuleSummary that setGraph requires (cf. M4 Task 11 e2e finding that
// setGraph rejects bare {id} cfg). Returns the new node's id.
//
// Two entry paths:
// 1. Legacy: caller provides `input.node` (full 4-piece node object).
// 2. Shortcut (M7): caller provides `input.shortcut` with device-did +
//    property/action intent. This path fetches the device + spec from the
//    gateway/public MIoT endpoint and synthesizes the 4-piece node.
async function addNodeWithinWorkflow(
  input: AddNodeInput,
  deps: ResourceDeps,
): Promise<{ nodeId: string }> {
  let rawNode: unknown;

  if (input.shortcut) {
    // Variable grammar is entirely local. Run it before any device/session/
    // MIoT lookup so malformed authoring flags never reach a gateway path.
    assertShortcutVariableIdentifiers(input.shortcut);
    assertShortcutPositionUsage(input.shortcut);
    if (
      input.shortcut.propertyValue !== undefined &&
      !(
        (input.shortcut.type === 'deviceInput' || input.shortcut.type === 'deviceGet') &&
        input.shortcut.deviceProperty !== undefined &&
        input.shortcut.deviceEvent === undefined
      )
    ) {
      throw new ConfigError(
        '--property-value only applies to deviceInput/deviceGet property-mode shortcuts',
        { type: input.shortcut.type },
      );
    }
    if (isNonDeviceShortcut(input.shortcut)) {
      // M10 F17: non-device shortcuts (onLoad / condition / logic gates /
      // timeRange / varChange / alarmClock) build a node entirely from
      // user-supplied flags — no gateway device lookup or MIoT spec fetch.
      rawNode = synthesizeNonDeviceShortcut(input.shortcut);
      // (2026-05-29 save-flow parity) var-existence pre-check for the four
      // var-referencing shortcuts, mirroring the device*SetVar guard below and
      // the official save() variable pass. Runs AFTER synthesis so field/op/
      // required-flag errors surface first — matching the official save() order
      // (nodeCheckTool field checks, then the variable pass). Fail fast on a
      // deleted/mis-scoped target variable rather than leaving it for
      // `rule validate`.
      const sc = input.shortcut;
      // F66h2 (2026-05-31 live probe): honor input.varCheck === false so
      // the CLI --no-var-check escape hatch actually bypasses ALL three
      // var-existence pre-checks (this one, deviceInputSetVar/deviceGetSetVar
      // below, and the multi-arg event-arg-var path). Pre-F66h2 the F66f
      // commit wired only the F66f sweep (validate-graph layer) to the flag,
      // leaving these three legacy pre-checks unconditional — so the
      // escape hatch was advertised in --help but didn't actually work.
      if (
        input.varCheck !== false &&
        (sc.type === 'varChange' ||
          sc.type === 'varGet' ||
          sc.type === 'varSetNumber' ||
          sc.type === 'varSetString') &&
        sc.varScope !== undefined &&
        sc.varId !== undefined
      ) {
        const variables = await listVariables(sc.varScope, deps);
        if (variables[sc.varId] === undefined) {
          throw new ConfigError(
            `${sc.type} target variable not found: ${sc.varScope}.${sc.varId}`,
            { scope: sc.varScope, id: sc.varId },
          );
        }
      }
    } else {
      if (!input.shortcut.deviceDid) {
        throw new ConfigError(`shortcut type "${input.shortcut.type}" requires --device-did`);
      }
      const device = await getDevice(input.shortcut.deviceDid, deps);
      // M9 F31 lesson: ghost devices (online but no spec access) are silently
      // dropped by autoLocal — the web UI calls them "设备已丢失" and
      // /api/getLog reports a `-9999 user ack timeout` on every command. Fail
      // fast on the deviceOutput side so users don't waste time creating
      // rules that will never fire.
      if (
        input.shortcut.type === 'deviceOutput' &&
        device.online &&
        !device.specV2Access &&
        !device.specV3Access
      ) {
        throw new ConfigError(
          `device ${input.shortcut.deviceDid} is in ghost state (online but specV2Access=false && specV3Access=false; web UI labels it "设备已丢失"). autoLocal cannot route commands to it; use a different deviceOutput target.`,
        );
      }
      if (
        input.varCheck !== false &&
        (input.shortcut.type === 'deviceInputSetVar' ||
          input.shortcut.type === 'deviceGetSetVar') &&
        input.shortcut.varScope !== undefined &&
        input.shortcut.varId !== undefined
      ) {
        const variables = await listVariables(input.shortcut.varScope, deps);
        if (variables[input.shortcut.varId] === undefined) {
          throw new ConfigError(
            `${input.shortcut.type} target variable not found: ${input.shortcut.varScope}.${input.shortcut.varId}`,
            { scope: input.shortcut.varScope, id: input.shortcut.varId },
          );
        }
      }
      // B4 / F65a (2026-05-30) — multi-arg deviceInputSetVar event-mode var
      // existence guard. Each --event-arg-var "<piid>=<scope>.<id>" entry
      // routes one event arg into its own destination variable, so every
      // (scope, id) referenced must already exist. Fetch each scope's var
      // map once (cache by scope) and bail on the first missing target.
      if (
        input.varCheck !== false &&
        input.shortcut.type === 'deviceInputSetVar' &&
        Array.isArray(input.shortcut.deviceEventArgVars) &&
        input.shortcut.deviceEventArgVars.length > 0
      ) {
        // F66-VarEntry-strict (2026-05-31): listVariables now returns
        // Record<string, VarEntry>. The cache only checks for `id ∈ map`,
        // so the value type is unused — keep the map opaque-by-value but
        // use the imported VarEntry alias so TS doesn't degrade to any.
        const scopeCache = new Map<string, Record<string, VarEntry>>();
        for (const raw of input.shortcut.deviceEventArgVars) {
          // Cheap structural parse so we can pre-check existence without
          // depending on the device spec; full validation happens inside
          // synthesizeNodeFromShortcut (parseEventArgVar) so this only
          // catches the well-formed-but-target-missing case.
          const { scope, id } = parseEventArgVarTarget(raw);
          let variables = scopeCache.get(scope);
          if (variables === undefined) {
            variables = await listVariables(scope, deps);
            scopeCache.set(scope, variables);
          }
          if (variables[id] === undefined) {
            throw new ConfigError(
              `deviceInputSetVar target variable not found: ${scope}.${id} (referenced by --event-arg-var "${raw}")`,
              { scope, id, argVar: raw },
            );
          }
        }
      }
      const spec =
        input.getDeviceSpec !== undefined
          ? await input.getDeviceSpec(device.urn)
          : await getDeviceSpec(device.urn, {
              ...(deps.timeoutMs !== undefined && { timeoutMs: deps.timeoutMs }),
            });
      rawNode = synthesizeNodeFromShortcut(
        input.shortcut,
        {
          did: input.shortcut.deviceDid,
          urn: device.urn,
          name: device.name,
          // F64b: model enables partition-label injection in ambiguity errors
          // when the device is in PARTITION_MODEL_ALLOWLIST.
          model: device.model,
        },
        spec,
      );
    }
  } else if (input.node !== undefined) {
    rawNode = input.node;
  } else {
    throw new ConfigError('addNode requires either `node` or `shortcut`');
  }

  const parsedNode = parseOrThrow(NodeUnion, rawNode, 'AddNodeInput.node');
  const nodeId = parsedNode.id;
  // Read listRules first so a missing rule fails fast without a wasted
  // getGraph round-trip (mirrors setRuleEnable above).
  const rules = await listRules(deps);
  const summary = rules.find((r) => r.id === input.ruleId);
  if (summary === undefined) {
    throw new NotFoundError(`rule not found: ${input.ruleId}`, { id: input.ruleId });
  }
  const current = await getRule(input.ruleId, deps);
  if (current.nodes.some((n) => (n as { id: string }).id === nodeId)) {
    throw new GatewayError(`node id already exists: ${nodeId}`, { id: nodeId });
  }
  // Auto-layout: a shortcut-synthesized node with no explicit --pos is flowed in
  // tight beside the previous card (prev right edge + gap, wrapping past a
  // screen width), so cards neither overlap nor leave huge gaps. synthesize
  // already set the correct per-type width/height (sizedPos); we only assign x/y
  // here, from the ACTUAL geometry of the cards already on the canvas. Explicit
  // --pos (e.g. `rule export` round-trips) and the legacy `--cfg` node path keep
  // their own position.
  if (input.shortcut !== undefined && input.shortcut.pos === undefined) {
    const cfg = (parsedNode as Record<string, unknown>).cfg as Record<string, unknown> | undefined;
    const pos = cfg?.pos as Record<string, unknown> | undefined;
    if (pos !== undefined && Number.isFinite(pos.width) && Number.isFinite(pos.height)) {
      const existingRects = current.nodes.map((n) => (n as { cfg?: { pos?: unknown } }).cfg?.pos);
      const { x, y } = nextCardPosition(existingRects, {
        width: pos.width as number,
        height: pos.height as number,
      });
      pos.x = x;
      pos.y = y;
    }
  }
  const updatedNodes = [...current.nodes, parsedNode];
  // F66a (2026-05-31) — skipLint: addNode preserves pre-existing nodes read
  // from the gateway; if those carry edges lintGraph rejects (e.g. authored
  // before the F66a gate landed), we must not block legitimate authoring on
  // the new node. The new node itself was just synthesised + NodeUnion-
  // parsed; nothing new to lint at the canvas-edge level.
  //
  // F66f (2026-05-31) — wire listAvailVars so validateGraphOrThrow's
  // var-existence pass fires on every additive write (default-on, matches
  // the UI save() nodeCheckTool variable phase). Opt out via varCheck:
  // false for raw probes / restore flows.
  await setGraph({ id: current.id, nodes: updatedNodes, cfg: refreshTimestamp(summary) }, deps, {
    validate: input.validate !== false,
    skipLint: true,
    ...(input.getDeviceSpec !== undefined && { getDeviceSpec: input.getDeviceSpec }),
    ...(input.varCheck !== false && {
      listAvailVars: (ruleId: string) => listAvailVarsForRule(ruleId, deps),
    }),
  });
  return { nodeId };
}

export async function addNode(
  input: AddNodeInput,
  deps: ResourceDeps,
): Promise<{ nodeId: string }> {
  preflightAddNode(input);
  return withResourceMutationWorkflow(deps, 'rule.node.add', () =>
    addNodeWithinWorkflow(input, deps),
  );
}

// ---------------------------------------------------------------------------
// Shortcut synthesis helpers
// ---------------------------------------------------------------------------

// F49 (2026-05-30) — operators that imply both v1 and v2 must be set
// (validate before synth so the agent doesn't see a gateway "Invalid v2"
// round-trip for the trivially-omitted --threshold2 case).
const BETWEEN_OPS = new Set(['between']);

// B9 / F63d (2026-05-30) — parse a single `--event-filter <piid><op><v1>`
// expression into one F59 DeviceInputEventArgument union element. The
// shortcut surface is MVP (scalar ops only — between/include are reachable
// via raw setGraph or a future shortcut extension). Operator vocab matches
// the F40 per-dtype matrix:
//   bool/string: op '=' only, v1 typeof matches dtype
//   int:         op ∈ {=, !=, >, <, >=, <=}, v1 int
//   float:       op ∈ {>, <}, v1 number  (=, !=, >=, <= rejected per F40)
// Operator lexer uses longest-match first (>= before >, etc.).
const EVENT_FILTER_REGEX = /^(\d+)(>=|<=|!=|=|>|<)(.+)$/;

interface ParsedEventArg {
  piid: number;
  dtype: 'int' | 'float' | 'boolean' | 'string';
  operator: '=' | '!=' | '>' | '<' | '>=' | '<=';
  v1: boolean | string | number;
}

function parseDeviceEventArg(
  raw: string,
  event: MiotEvent,
  service: MiotService,
  specType: string,
): ParsedEventArg {
  const m = EVENT_FILTER_REGEX.exec(raw);
  if (!m) {
    throw new ConfigError(
      `--event-filter "${raw}" must be <piid><op><v1> where op ∈ =, !=, >, <, >=, <=`,
      { raw },
    );
  }
  const piid = Number.parseInt(m[1] as string, 10);
  const operator = m[2] as '=' | '!=' | '>' | '<' | '>=' | '<=';
  const rest = m[3] as string;

  const eventArgs = event.arguments ?? [];
  if (!eventArgs.includes(piid)) {
    throw new ConfigError(
      `--event-filter piid=${piid} not declared by event (event.arguments=[${eventArgs.join(', ')}]). Check siid=${service.iid} spec or omit the filter.`,
      { piid, eventArgs },
    );
  }

  // dtype resolution mirrors deviceInputSetVar event-mode pattern at the
  // 1-arg branch — find the matching property on the same service.
  const prop = (service.properties ?? []).find((p) => p.iid === piid);
  if (!prop) {
    throw new ConfigError(
      `event arg piid=${piid} not found as a property of siid=${service.iid} in spec ${specType} — gateway cannot infer dtype`,
      { piid, siid: service.iid },
    );
  }
  const dtype = projectMiotComparisonDtype(prop);
  if (!isMiotEventWireOperator(dtype, operator)) {
    const allowed = MIOT_COMPARISON_CONTRACT[dtype].eventWireOperators.join(', ');
    throw new ConfigError(
      `${dtype} event arg piid=${piid} only supports ${allowed} (got ${operator})`,
      { piid, operator, dtype, allowed },
    );
  }

  if (dtype === 'boolean') {
    let v1: boolean;
    if (rest === 'true' || rest === '1') v1 = true;
    else if (rest === 'false' || rest === '0') v1 = false;
    else {
      throw new ConfigError(`bool v1 must be true|false|0|1, got "${rest}"`, { raw });
    }
    return { piid, dtype, operator, v1 };
  }
  if (dtype === 'string') {
    if (rest.length === 0) {
      throw new ConfigError(`string v1 must not be empty for event arg piid=${piid}`, { raw });
    }
    return { piid, dtype, operator, v1: rest };
  }
  if (dtype === 'float') {
    const v1 = parseFiniteDecimalLiteral(rest);
    if (v1 === null) {
      throw new ConfigError(`float v1 must be numeric, got "${rest}"`, { raw });
    }
    return { piid, dtype, operator, v1 };
  }
  // int — all 6 scalar operators legal per F40.
  const v1 = parseFiniteDecimalLiteral(rest);
  if (v1 === null || !Number.isInteger(v1)) {
    throw new ConfigError(`int v1 must be an integer, got "${rest}"`, { raw });
  }
  return { piid, dtype, operator, v1 };
}

// B4 / F65a (2026-05-30) — parse a single `--event-arg-var <piid>=<scope>.<id>`
// expression into one DeviceInputSetVarArgument element. The RHS is split on
// the FIRST `.` and both sides use the same non-empty alphanumeric grammar as
// variable create; any further dot therefore makes the id invalid. Mirrors
// the parse / validate surface of parseDeviceEventArg (B9).
export interface ParsedEventArgVar {
  piid: number;
  scope: string;
  id: string;
}

// piid must be a non-negative integer; the rest is split on the first '.'.
const EVENT_ARG_VAR_REGEX = /^(\d+)=(.+)$/;

export function parseEventArgVarTarget(raw: string): ParsedEventArgVar {
  const m = EVENT_ARG_VAR_REGEX.exec(raw);
  if (!m) {
    throw new ConfigError(
      `--event-arg-var "${raw}" must be <piid>=<scope>.<id>; ${variableIdentifierMessage('id')}`,
      { raw },
    );
  }
  const piid = Number.parseInt(m[1] as string, 10);
  const rhs = m[2] as string;
  const dot = rhs.indexOf('.');
  if (dot <= 0 || dot === rhs.length - 1) {
    throw new ConfigError(
      `--event-arg-var "${raw}" must contain non-empty <scope>.<id>; ${variableIdentifierMessage('id')}`,
      { raw, rhs },
    );
  }
  const scope = rhs.slice(0, dot);
  const id = rhs.slice(dot + 1);
  if (!isValidVariableIdentifier(scope)) {
    throw new ConfigError(
      `--event-arg-var "${raw}" scope "${scope}" ${variableIdentifierMessage('scope')}`,
      { raw, scope },
    );
  }
  if (!isValidVariableIdentifier(id)) {
    throw new ConfigError(
      `--event-arg-var "${raw}" id "${id}" ${variableIdentifierMessage('id')}`,
      { raw, id },
    );
  }
  return { piid, scope, id };
}

function parseEventArgVar(
  raw: string,
  event: MiotEvent,
  service: MiotService,
  specType: string,
): ParsedEventArgVar {
  const { piid, scope, id } = parseEventArgVarTarget(raw);
  const eventArgs = event.arguments ?? [];
  if (!eventArgs.includes(piid)) {
    throw new ConfigError(
      `--event-arg-var piid=${piid} not declared by event (event.arguments=[${eventArgs.join(', ')}]). Check siid=${service.iid} spec or drop this flag.`,
      { piid, eventArgs },
    );
  }
  // dtype is needed by the synth caller — resolved there via the
  // service.properties lookup (mirrors parseDeviceEventArg pattern).
  // Just validate the property exists for early failure.
  const prop = (service.properties ?? []).find((p) => p.iid === piid);
  if (!prop) {
    throw new ConfigError(
      `event arg piid=${piid} not found as a property of siid=${service.iid} in spec ${specType} — gateway cannot infer dtype`,
      { piid, siid: service.iid },
    );
  }
  return { piid, scope, id };
}

// F16 fix: coerce CLI string value to gateway-storage type per MIoT format.
// Real-rule "All" property-write deviceOutput stores bool on/off as int 1/0
// (props.value=1). String formats pass through; numeric formats parse.
type DeviceOutputVariableDtype = 'number' | 'string' | 'boolean';

interface DeviceOutputVariableRef {
  id: string;
  scope: string;
  dtype: DeviceOutputVariableDtype;
}

function mapFormatToVariableDtype(format: string): DeviceOutputVariableDtype {
  if (format === 'string') return 'string';
  if (format === 'bool') return 'boolean';
  return 'number';
}

function mapFormatToSetVarDtype(format: string): 'number' | 'string' {
  // Live UI validator + gateway probe (2026-05-28): setVar-family cards use
  // the variable value vocab, but bool MIoT properties are stored as numeric
  // 1/0 when the target variable is a gateway number variable.
  if (format === 'string') return 'string';
  return 'number';
}

function parseVariableReference(
  raw: string,
  dtype: DeviceOutputVariableDtype,
): DeviceOutputVariableRef {
  const ref = raw.startsWith('$') ? raw.slice(1) : raw;
  const dot = ref.indexOf('.');
  if (dot <= 0 || dot === ref.length - 1) {
    throw new ConfigError(
      `variable reference must be <scope>.<id> or $<scope>.<id>, got "${raw}"`,
      { raw },
    );
  }
  const scope = ref.slice(0, dot);
  const id = ref.slice(dot + 1);
  if (!isValidVariableIdentifier(scope)) {
    throw new ConfigError(
      `variable reference scope "${scope}" ${variableIdentifierMessage('scope')}`,
      {
        raw,
        scope,
      },
    );
  }
  if (!isValidVariableIdentifier(id)) {
    throw new ConfigError(`variable reference id "${id}" ${variableIdentifierMessage('id')}`, {
      raw,
      id,
    });
  }
  return { scope, id, dtype };
}

function parseVariableParamObject(
  raw: unknown,
  dtype: DeviceOutputVariableDtype,
): DeviceOutputVariableRef | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const marker = (raw as Record<string, unknown>).$var;
  if (typeof marker !== 'string') return null;
  return parseVariableReference(marker, dtype);
}

function propertyRangeFields(property: MiotProperty): Record<string, number> {
  const range = property['value-range'];
  if (range === undefined) return {};
  const [min, max, step] = range;
  return { min, max, step };
}

// When writing a *number* variable into a device property / action input, the
// gateway requires numeric min/max/step. Source them from the target property's
// value-range; for non-number variables emit nothing. Fail fast with an
// actionable message when a number variable targets a property that declares no
// value-range (rather than synthesizing a node the gateway rejects).
function variableRangeFields(
  varRef: DeviceOutputVariableRef,
  property: MiotProperty | undefined,
  context: string,
): Record<string, number> {
  if (varRef.dtype !== 'number') return {};
  const range = property ? propertyRangeFields(property) : {};
  if (!('min' in range)) {
    throw new ConfigError(
      `cannot write a number variable to ${context}: the MIoT property declares no value-range, but the gateway requires numeric min/max/step for a number-dtype variable. Use a literal value, or target a property that declares a value-range.`,
      { context },
    );
  }
  return range;
}

function coercePropertyValue(raw: string, format: string): number | string | boolean {
  if (format === 'string') return raw;
  if (format === 'bool') {
    // F14 REWRITTEN (2026-05-28): emit JSON boolean to match the web UI's
    // wire shape (UI saves `value: true`/`false` for bool properties).
    // Pre-F14 CLI emitted int `1`/`0`; the gateway accepts both at write
    // time (F12 schema widening preserves backward-compat for old fixtures
    // and rules) but the UI's encoding is the canonical one.
    if (raw === '1' || raw === 'true') return true;
    if (raw === '0' || raw === 'false') return false;
    throw new ConfigError(`bool property requires value=true|false|0|1, got "${raw}"`, {
      raw,
      format,
    });
  }
  if (format === 'float') {
    const n = Number.parseFloat(raw);
    if (Number.isNaN(n)) {
      throw new ConfigError(`float property requires numeric value, got "${raw}"`, { raw, format });
    }
    return n;
  }
  // int / uint variants
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) {
    throw new ConfigError(`int property requires numeric value, got "${raw}"`, { raw, format });
  }
  return n;
}

// F63c (2026-05-30) — formats a candidate list for the ambiguity ConfigError.
// Each line carries `siid=<N>:"<service description>"` so the agent can paste
// the right --device-siid back into the command.
//
// F64b (2026-05-30) — when the device's model is in the partition-allowlist
// (e.g. `xiaomi.sensor_occupy.p1`), inject the Mi-Home partition label
// (A-1..B-16) into each candidate description so the agent can pick by
// physical zone instead of a raw siid:
//   `siid=7:"Partition Occupancy Sensor (A-4)"`
function formatSiidCandidates(
  candidates: Array<{ service: MiotService }>,
  model?: string,
): {
  siids: number[];
  descriptions: string;
} {
  const siids = candidates.map((c) => c.service.iid);
  const descriptions = candidates
    .map((c) => {
      const desc =
        model !== undefined ? annotateServiceDescription(model, c.service) : c.service.description;
      return `siid=${c.service.iid}:"${desc}"`;
    })
    .join(', ');
  return { siids, descriptions };
}

function findServiceProperty(
  spec: DeviceSpec,
  propertyName: string,
  deviceSiid?: number,
  model?: string,
): { service: MiotService; property: MiotProperty } {
  // F63c: collect ALL services whose property short-name matches, then
  // disambiguate after the scan. Previously this returned the first hit
  // silently, letting devices that expose `on` / `occupancy-status` /
  // `brightness` under multiple services pick the wrong siid.
  // F64b: `model` (when supplied) feeds the partition-label injector inside
  // formatSiidCandidates so multi-zone occupancy sensors show "A-4" et al.
  const candidates: Array<{ service: MiotService; property: MiotProperty }> = [];
  for (const service of spec.services) {
    for (const property of service.properties ?? []) {
      const segments = property.type.split(':');
      const shortName = segments[3];
      if (shortName === propertyName) {
        candidates.push({ service, property });
      }
    }
  }
  if (candidates.length === 0) {
    throw new ConfigError(`property "${propertyName}" not found in spec ${spec.type}`, {
      propertyName,
      specType: spec.type,
    });
  }
  if (deviceSiid !== undefined) {
    const filtered = candidates.filter((c) => c.service.iid === deviceSiid);
    if (filtered.length === 0) {
      const { siids, descriptions } = formatSiidCandidates(candidates, model);
      throw new ConfigError(
        `--device-siid ${deviceSiid} does not expose property "${propertyName}" on ${spec.type}; candidates: ${descriptions}`,
        { propertyName, specType: spec.type, deviceSiid, candidates: siids },
      );
    }
    return filtered[0] as { service: MiotService; property: MiotProperty };
  }
  if (candidates.length > 1) {
    const { siids, descriptions } = formatSiidCandidates(candidates, model);
    throw new ConfigError(
      `property "${propertyName}" exists in multiple services (siid: ${siids.join(', ')}); pass --device-siid <N> to disambiguate. Service descriptions: ${descriptions}`,
      { propertyName, specType: spec.type, candidates: siids },
    );
  }
  return candidates[0] as { service: MiotService; property: MiotProperty };
}

function findServiceAction(
  spec: DeviceSpec,
  actionName: string,
  deviceSiid?: number,
  model?: string,
): { service: MiotService; action: MiotAction } {
  const candidates: Array<{ service: MiotService; action: MiotAction }> = [];
  for (const service of spec.services) {
    for (const action of service.actions ?? []) {
      const segments = action.type.split(':');
      const shortName = segments[3];
      if (shortName === actionName) {
        candidates.push({ service, action });
      }
    }
  }
  if (candidates.length === 0) {
    throw new ConfigError(`action "${actionName}" not found in spec ${spec.type}`, {
      actionName,
      specType: spec.type,
    });
  }
  if (deviceSiid !== undefined) {
    const filtered = candidates.filter((c) => c.service.iid === deviceSiid);
    if (filtered.length === 0) {
      const { siids, descriptions } = formatSiidCandidates(candidates, model);
      throw new ConfigError(
        `--device-siid ${deviceSiid} does not expose action "${actionName}" on ${spec.type}; candidates: ${descriptions}`,
        { actionName, specType: spec.type, deviceSiid, candidates: siids },
      );
    }
    return filtered[0] as { service: MiotService; action: MiotAction };
  }
  if (candidates.length > 1) {
    const { siids, descriptions } = formatSiidCandidates(candidates, model);
    throw new ConfigError(
      `action "${actionName}" exists in multiple services (siid: ${siids.join(', ')}); pass --device-siid <N> to disambiguate. Service descriptions: ${descriptions}`,
      { actionName, specType: spec.type, candidates: siids },
    );
  }
  return candidates[0] as { service: MiotService; action: MiotAction };
}

function findServiceEvent(
  spec: DeviceSpec,
  eventName: string,
  deviceSiid?: number,
  model?: string,
): { service: MiotService; event: MiotEvent } {
  const candidates: Array<{ service: MiotService; event: MiotEvent }> = [];
  for (const service of spec.services) {
    for (const event of service.events ?? []) {
      const segments = event.type.split(':');
      const shortName = segments[3];
      if (shortName === eventName) {
        candidates.push({ service, event });
      }
    }
  }
  if (candidates.length === 0) {
    throw new ConfigError(`event "${eventName}" not found in spec ${spec.type}`, {
      eventName,
      specType: spec.type,
    });
  }
  if (deviceSiid !== undefined) {
    const filtered = candidates.filter((c) => c.service.iid === deviceSiid);
    if (filtered.length === 0) {
      const { siids, descriptions } = formatSiidCandidates(candidates, model);
      throw new ConfigError(
        `--device-siid ${deviceSiid} does not expose event "${eventName}" on ${spec.type}; candidates: ${descriptions}`,
        { eventName, specType: spec.type, deviceSiid, candidates: siids },
      );
    }
    return filtered[0] as { service: MiotService; event: MiotEvent };
  }
  if (candidates.length > 1) {
    const { siids, descriptions } = formatSiidCandidates(candidates, model);
    throw new ConfigError(
      `event "${eventName}" exists in multiple services (siid: ${siids.join(', ')}); pass --device-siid <N> to disambiguate. Service descriptions: ${descriptions}`,
      { eventName, specType: spec.type, candidates: siids },
    );
  }
  return candidates[0] as { service: MiotService; event: MiotEvent };
}

function synthesizePropertyComparison(
  shortcut: AddNodeShortcut,
  property: MiotProperty,
  propertyName: string,
  specType: string,
): Record<string, unknown> {
  const dtype = projectMiotComparisonDtype(property);
  const rawOp = shortcut.op ?? (dtype === 'boolean' || dtype === 'string' ? 'eq' : 'gt');
  const operator = miotShortcutOperatorToWire(dtype, rawOp);
  if (operator === null) {
    const allowed = MIOT_COMPARISON_CONTRACT[dtype].shortcutOperators.join('|');
    throw new ConfigError(
      `${dtype} property "${propertyName}" only supports --op ${allowed} (got ${rawOp})`,
      { op: rawOp, dtype, property: propertyName, allowed },
    );
  }

  if (dtype === 'string') {
    if (shortcut.threshold !== undefined || shortcut.threshold2 !== undefined) {
      throw new ConfigError(
        `string property "${propertyName}" cannot use numeric --threshold/--threshold2; pass --property-value <S> instead`,
        { property: propertyName },
      );
    }
    if (shortcut.propertyValue === undefined || shortcut.propertyValue.length === 0) {
      throw new ConfigError(
        `string property "${propertyName}" requires a non-empty --property-value <S> comparison literal`,
        { property: propertyName },
      );
    }
    return {
      dtype,
      operator,
      v1: shortcut.propertyValue,
      preload: true,
    };
  }

  if (shortcut.propertyValue !== undefined) {
    throw new ConfigError(
      `${dtype} property "${propertyName}" cannot use --property-value; pass numeric --threshold instead`,
      { dtype, property: propertyName },
    );
  }
  if (dtype === 'boolean') {
    if (shortcut.threshold2 !== undefined) {
      throw new ConfigError(
        `boolean property "${propertyName}" cannot use --threshold2; only --op eq with --threshold 0|1 is supported`,
        { property: propertyName },
      );
    }
    return {
      dtype,
      operator,
      v1: boolThresholdFromShortcut(shortcut.threshold, propertyName),
    };
  }

  const thresholdValue = shortcut.threshold ?? 0;
  const validThreshold =
    dtype === 'int' ? Number.isInteger(thresholdValue) : Number.isFinite(thresholdValue);
  if (!validThreshold) {
    throw new ConfigError(
      `${dtype} property "${propertyName}" requires a ${dtype === 'int' ? 'finite integer' : 'finite number'} --threshold (got ${String(thresholdValue)})`,
      { dtype, threshold: shortcut.threshold, property: propertyName },
    );
  }

  const range = property['value-range'];
  if (range !== undefined && shortcut.forceOutOfRange !== true) {
    const [lo, hi] = range;
    if (thresholdValue < lo || thresholdValue > hi) {
      throw new ConfigError(
        `--threshold ${thresholdValue} out of value-range [${lo}, ${hi}] for property "${propertyName}" on urn ${specType}. Pass --force-out-of-range to override.`,
        { threshold: thresholdValue, range, property: propertyName },
      );
    }
  }

  const isBetween = operator === 'between';
  if (isBetween && shortcut.threshold2 === undefined) {
    throw new ConfigError(
      `--op between on property "${propertyName}" requires both --threshold (v1) and --threshold2 (v2). Real-gateway setGraph rejects between without v2 as "Invalid v2".`,
      { op: rawOp, operator, property: propertyName },
    );
  }
  if (!isBetween && shortcut.threshold2 !== undefined) {
    throw new ConfigError(
      `--threshold2 only applies to --op between on property "${propertyName}"`,
      { op: rawOp, property: propertyName },
    );
  }
  if (isBetween) {
    const threshold2 = shortcut.threshold2 as number;
    const validThreshold2 =
      dtype === 'int' ? Number.isInteger(threshold2) : Number.isFinite(threshold2);
    if (!validThreshold2) {
      throw new ConfigError(
        `${dtype} property "${propertyName}" requires a ${dtype === 'int' ? 'finite integer' : 'finite number'} --threshold2 (got ${String(threshold2)})`,
        { dtype, threshold2, property: propertyName },
      );
    }
  }

  return {
    dtype,
    operator,
    v1:
      operator === MIOT_COMPARISON_CONTRACT.int.equalityWireOperator
        ? [thresholdValue]
        : thresholdValue,
    ...(isBetween && { v2: shortcut.threshold2 }),
    preload: true,
  };
}

function synthesizeNodeFromShortcut(
  shortcut: AddNodeShortcut,
  device: { did: string; urn: string; name: string; model?: string },
  spec: DeviceSpec,
): Record<string, unknown> {
  // F64b: pulled out of the device closure so the spec-resolver error
  // formatter (formatSiidCandidates) can annotate candidate siids with
  // their Mi-Home partition labels (A-1..B-16) when applicable.
  const deviceModel = device.model;
  // M12: honor caller-supplied shortcut.id so `xgg rule export` round-trips
  // preserve the original node ids (otherwise `rule edge add` further down
  // the exported script can't resolve PRHsizi7JL etc.).
  const id = shortcut.id ?? `n-${Date.now()}`;

  if (shortcut.type === 'deviceInput') {
    // F11 (M9): event-driven trigger (e.g. BLE button click). Codex M8
    // reverse-engineering confirmed the resulting node uses `eiid` in place
    // of `piid`, an `arguments: []` field that the gateway iterates
    // unconditionally (omitting it crashes with `Symbol.iterator of
    // undefined`), and `cfg.version: 0` (event nodes carry version 0;
    // property nodes carry version 1 — verified by reading the working
    // user sample `按钮单击播报（样例）`).
    if (shortcut.deviceEvent) {
      const { service, event } = findServiceEvent(
        spec,
        shortcut.deviceEvent,
        shortcut.deviceSiid,
        deviceModel,
      );
      // B9 / F63d (2026-05-30) — translate --event-filter expressions into
      // typed arguments[] elements. Empty list preserves F11 behavior.
      const rawArgs = shortcut.deviceEventArgs ?? [];
      const args: ParsedEventArg[] = [];
      const seen = new Set<number>();
      for (const raw of rawArgs) {
        const parsed = parseDeviceEventArg(raw, event, service, spec.type);
        if (seen.has(parsed.piid)) {
          throw new ConfigError(`--event-filter piid=${parsed.piid} specified more than once`, {
            piid: parsed.piid,
          });
        }
        seen.add(parsed.piid);
        args.push(parsed);
      }
      return {
        id,
        type: 'deviceInput',
        cfg: {
          urn: spec.type,
          pos: shortcut.pos ?? sizedPos('deviceInput'),
          name: 'deviceInput',
          version: 0,
        },
        inputs: {},
        outputs: { output: [] },
        props: {
          did: device.did,
          siid: service.iid,
          eiid: event.iid,
          arguments: args,
        },
      };
    }
    if (!shortcut.deviceProperty) {
      throw new ConfigError(
        'deviceInput shortcut requires --device-property (or --device-event for event-driven triggers)',
      );
    }
    const { service, property } = findServiceProperty(
      spec,
      shortcut.deviceProperty,
      shortcut.deviceSiid,
      deviceModel,
    );
    const props: Record<string, unknown> = {
      did: device.did,
      siid: service.iid,
      piid: property.iid,
      ...synthesizePropertyComparison(shortcut, property, shortcut.deviceProperty, spec.type),
    };
    return {
      id,
      type: 'deviceInput',
      cfg: {
        urn: spec.type,
        pos: shortcut.pos ?? sizedPos('deviceInput'),
        name: 'deviceInput',
        version: 1,
      },
      inputs: {},
      outputs: { output: [] },
      props,
    };
  }

  if (shortcut.type === 'deviceOutput') {
    // Two output shapes: action-invoke {did,siid,aiid,ins[]} vs property-write
    // {did,siid,piid,value}. F16: many real devices (light/AC/purifier) have
    // no actions and must use property-write. Route by which intent the
    // caller provided.
    if (shortcut.deviceAction) {
      const { service, action } = findServiceAction(
        spec,
        shortcut.deviceAction,
        shortcut.deviceSiid,
        deviceModel,
      );
      // Build ins[] from action.in (property iids) + shortcut.params
      const ins: Array<
        { piid: number; value: string } | ({ piid: number } & DeviceOutputVariableRef)
      > = [];
      for (const piid of action.in) {
        const prop = (service.properties ?? []).find((p) => p.iid === piid);
        const paramKey = prop
          ? (prop.type.split(':')[3] ?? `piid-${piid}`) // short name, e.g. "text-content"
          : `piid-${piid}`;
        // Only emit an ins entry for piids the caller actually supplied a param
        // for. Filling every action.in piid with `value:''` grew an external
        // rule's ins on export→import round-trips (the exporter emits --params
        // only for present ins). xgg-authored nodes are unaffected.
        if (shortcut.params === undefined || !Object.hasOwn(shortcut.params, paramKey)) continue;
        const rawValue = shortcut.params[paramKey] ?? '';
        const varRef = parseVariableParamObject(
          rawValue,
          mapFormatToVariableDtype(prop?.format ?? 'string'),
        );
        if (varRef)
          ins.push({
            piid,
            ...varRef,
            ...variableRangeFields(varRef, prop, `action input piid=${piid}`),
          });
        else ins.push({ piid, value: String(rawValue) });
      }
      return {
        id,
        type: 'deviceOutput',
        cfg: {
          urn: spec.type,
          pos: shortcut.pos ?? sizedPos('deviceOutput'),
          name: 'deviceOutput',
          version: 1,
        },
        inputs: { trigger: null },
        outputs: { output: [] },
        props: {
          did: device.did,
          siid: service.iid,
          aiid: action.iid,
          ins,
        },
      };
    }

    if (shortcut.deviceProperty) {
      if (shortcut.value === undefined) {
        throw new ConfigError(
          'deviceOutput property-write shortcut requires --value (the value to write)',
        );
      }
      const { service, property } = findServiceProperty(
        spec,
        shortcut.deviceProperty,
        shortcut.deviceSiid,
        deviceModel,
      );
      if (!property.access.includes('write')) {
        throw new ConfigError(
          `property "${shortcut.deviceProperty}" is not writable on ${spec.type}`,
          { property: shortcut.deviceProperty, access: property.access },
        );
      }
      // A single leading dollar keeps the established variable-reference
      // grammar. Doubling it escapes exactly one dollar so string literals
      // such as "$hello" and "$global.foo" can round-trip without being
      // rejected or silently reinterpreted as variables.
      const escapedLiteral = shortcut.value.startsWith('$$') ? shortcut.value.slice(1) : null;
      const varRef =
        escapedLiteral === null && shortcut.value.startsWith('$')
          ? parseVariableReference(shortcut.value, mapFormatToVariableDtype(property.format))
          : null;
      const coerced =
        varRef === null
          ? coercePropertyValue(escapedLiteral ?? shortcut.value, property.format)
          : null;
      return {
        id,
        type: 'deviceOutput',
        cfg: {
          urn: spec.type,
          pos: shortcut.pos ?? sizedPos('deviceOutput'),
          name: 'deviceOutput',
          version: 1,
        },
        inputs: { trigger: null },
        outputs: { output: [] },
        props: {
          did: device.did,
          siid: service.iid,
          piid: property.iid,
          ...(varRef === null
            ? { value: coerced }
            : {
                ...varRef,
                ...variableRangeFields(varRef, property, `property "${shortcut.deviceProperty}"`),
              }),
        },
      };
    }

    throw new ConfigError(
      'deviceOutput shortcut requires either --device-action or --device-property + --value',
    );
  }

  if (shortcut.type === 'deviceGet') {
    // M14 task D — deviceGet c-shortcut. Mirror of property-driven deviceInput
    // with three wire differences:
    //   - cfg.name: 'deviceGet'
    //   - inputs:   { input: null }
    //   - outputs:  { output: [], output2: [] }  (output2 = unmet branch)
    if (!shortcut.deviceProperty) {
      throw new ConfigError('deviceGet shortcut requires --device-property');
    }
    const { service, property } = findServiceProperty(
      spec,
      shortcut.deviceProperty,
      shortcut.deviceSiid,
      deviceModel,
    );
    const props: Record<string, unknown> = {
      did: device.did,
      siid: service.iid,
      piid: property.iid,
      ...synthesizePropertyComparison(shortcut, property, shortcut.deviceProperty, spec.type),
    };
    return {
      id,
      type: 'deviceGet',
      cfg: {
        urn: spec.type,
        pos: shortcut.pos ?? sizedPos('deviceGet'),
        name: 'deviceGet',
        version: 1,
      },
      inputs: { input: null },
      outputs: { output: [], output2: [] },
      props,
    };
  }

  if (shortcut.type === 'deviceInputSetVar' || shortcut.type === 'deviceGetSetVar') {
    // F50 (2026-05-30) — deviceInputSetVar event-mode c-shortcut. Bundle
    // Pr.deviceInputSetVar accepts either property-mode `{piid, dtype,
    // scope, id}` OR event-mode `{eiid, arguments: [{piid, dtype, scope?,
    // id?}]}`. deviceGetSetVar is property-only (it's a pull, not a push).
    // Event-mode mutex with --device-property; reject if both flags are
    // set so the agent's intent is unambiguous.
    if (shortcut.deviceEvent !== undefined) {
      if (shortcut.type === 'deviceGetSetVar') {
        throw new ConfigError(
          'deviceGetSetVar is property-only (--device-property). Bundle Pr.deviceGetSetVar has no event-mode branch — use deviceInputSetVar --device-event for event-driven captures.',
          { event: shortcut.deviceEvent, type: shortcut.type },
        );
      }
      if (shortcut.deviceProperty !== undefined) {
        throw new ConfigError(
          `${shortcut.type} cannot mix --device-event with --device-property; pick one trigger.`,
          { event: shortcut.deviceEvent, property: shortcut.deviceProperty },
        );
      }
      const { service, event } = findServiceEvent(
        spec,
        shortcut.deviceEvent,
        shortcut.deviceSiid,
        deviceModel,
      );
      const eventArgs = event.arguments ?? [];
      // F61 (2026-05-30, user-physical-test) — 0-arg events (BLE button
      // click / dbl-click / long-press) MUST NOT synthesize a
      // deviceInputSetVar node. The F50-era branch emitted
      // `{eiid, arguments: []}` here for a "trigger-only setVar", but
      // bundle `ai-config-v5` `Bs.getAvailableSpecs` filters out every
      // spec event whose `arguments.length === 0` from the service
      // dropdown, so the resulting node renders as "原已选功能丢失" in the
      // UI and the user has no way to edit it. Semantically a setVar
      // node with no captures is a no-op. Redirect the agent to
      // `deviceInput --device-event` (which IS the legitimate
      // trigger-only event card and does not pretend to copy data).
      if (eventArgs.length === 0) {
        throw new ConfigError(
          `deviceInputSetVar --device-event "${shortcut.deviceEvent}" (siid=${service.iid} eiid=${event.iid}) targets a 0-argument event — there is nothing to capture into a variable. The UI drops 0-arg events from this card's spec dropdown ("原已选功能丢失"), so a node persisted this way cannot be re-edited. Use \`deviceInput --device-event "${shortcut.deviceEvent}"\` for a trigger-only event card.`,
          {
            event: shortcut.deviceEvent,
            siid: service.iid,
            eiid: event.iid,
            redirect: 'deviceInput',
          },
        );
      }
      // B4 / F65a (2026-05-30) — `--event-arg-var` repeatable flag routes
      // each event-argument piid into its own destination variable. Mutex
      // with --var-scope/--var-id (whole-event single-target form): if
      // both are set the agent's intent is ambiguous (does
      // --var-scope/--var-id apply to which arg?) — fail fast.
      const argVarsRaw = shortcut.deviceEventArgVars ?? [];
      if (argVarsRaw.length > 0 && (shortcut.varScope || shortcut.varId)) {
        throw new ConfigError(
          `deviceInputSetVar --device-event "${shortcut.deviceEvent}": --event-arg-var is mutually exclusive with --var-scope/--var-id. Use --event-arg-var "<piid>=<scope>.<id>" for each captured argument (one entry per arg).`,
          { event: shortcut.deviceEvent, argVars: argVarsRaw },
        );
      }
      if (argVarsRaw.length > 0) {
        const parsed: ParsedEventArgVar[] = [];
        const seen = new Set<number>();
        for (const raw of argVarsRaw) {
          const p = parseEventArgVar(raw, event, service, spec.type);
          if (seen.has(p.piid)) {
            throw new ConfigError(`--event-arg-var piid=${p.piid} specified more than once`, {
              piid: p.piid,
            });
          }
          seen.add(p.piid);
          parsed.push(p);
        }
        const argsOut = parsed.map((p) => {
          const prop = service.properties?.find((pp) => pp.iid === p.piid) as MiotProperty;
          return {
            piid: p.piid,
            dtype: mapFormatToSetVarDtype(prop.format),
            scope: p.scope,
            id: p.id,
          };
        });
        return {
          id,
          type: shortcut.type,
          cfg: {
            urn: spec.type,
            pos: shortcut.pos ?? sizedPos(shortcut.type),
            name: shortcut.type,
            version: 1,
          },
          inputs: {},
          outputs: { output: [] },
          props: {
            did: device.did,
            siid: service.iid,
            eiid: event.iid,
            arguments: argsOut,
          },
        };
      }
      // 1-arg event: route the single arg into --var-scope/--var-id.
      if (eventArgs.length === 1) {
        if (!shortcut.varScope || !shortcut.varId) {
          throw new ConfigError(
            `deviceInputSetVar --device-event "${shortcut.deviceEvent}" has 1 argument (piid=${eventArgs[0]}); pass --var-scope and --var-id to route that arg into a variable (or --event-arg-var "${eventArgs[0]}=<scope>.<id>").`,
            { event: shortcut.deviceEvent, eventArgs },
          );
        }
        const argPiid = eventArgs[0] as number;
        const argProperty = service.properties?.find((p) => p.iid === argPiid);
        if (!argProperty) {
          throw new ConfigError(
            `event "${shortcut.deviceEvent}" arg piid=${argPiid} not found as a property of siid=${service.iid} in spec ${spec.type}`,
            { eventArgs, argPiid, siid: service.iid },
          );
        }
        return {
          id,
          type: shortcut.type,
          cfg: {
            urn: spec.type,
            pos: shortcut.pos ?? sizedPos(shortcut.type),
            name: shortcut.type,
            version: 1,
          },
          inputs: {},
          outputs: { output: [] },
          props: {
            did: device.did,
            siid: service.iid,
            eiid: event.iid,
            arguments: [
              {
                piid: argPiid,
                dtype: mapFormatToSetVarDtype(argProperty.format),
                scope: shortcut.varScope,
                id: shortcut.varId,
              },
            ],
          },
        };
      }
      // 2+ arg events: B4 / F65a (2026-05-30) — multi-arg routing now has
      // a first-class c-shortcut surface via --event-arg-var (handled
      // above). Hitting this branch means the agent supplied --var-scope/
      // --var-id (single-target) for a multi-arg event, which is
      // ambiguous (which arg does the var capture?). Point at the
      // per-piid flag instead of raw setGraph.
      throw new ConfigError(
        `deviceInputSetVar --device-event "${shortcut.deviceEvent}" has ${eventArgs.length} arguments (piids: ${eventArgs.join(', ')}); use --event-arg-var "<piid>=<scope>.<id>" for each captured arg (or only the ones you want) — e.g. ${eventArgs.map((p) => `--event-arg-var "${p}=global.var${p}"`).join(' ')}.`,
        { event: shortcut.deviceEvent, eventArgs },
      );
    }
    if (!shortcut.deviceProperty) {
      throw new ConfigError(
        `${shortcut.type} shortcut requires --device-property (or --device-event for deviceInputSetVar event-mode)`,
      );
    }
    if (!shortcut.varScope || !shortcut.varId) {
      throw new ConfigError(`${shortcut.type} shortcut requires --var-scope and --var-id`);
    }
    const { service, property } = findServiceProperty(
      spec,
      shortcut.deviceProperty,
      shortcut.deviceSiid,
      deviceModel,
    );
    const base = {
      id,
      type: shortcut.type,
      cfg: {
        urn: spec.type,
        pos: shortcut.pos ?? sizedPos(shortcut.type),
        name: shortcut.type,
        version: 1,
      },
      outputs: { output: [] },
      props: {
        did: device.did,
        siid: service.iid,
        piid: property.iid,
        dtype: mapFormatToSetVarDtype(property.format),
        scope: shortcut.varScope,
        id: shortcut.varId,
      },
    };
    return shortcut.type === 'deviceInputSetVar'
      ? { ...base, inputs: {} }
      : { ...base, inputs: { input: null } };
  }

  throw new ConfigError(`shortcut type "${shortcut.type}" not supported yet`);
}

// ===========================================================================
// M10 F17 — non-device node shortcuts
// ===========================================================================

const TIME_HMS_REGEX = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/;

function parseHmsOrThrow(
  raw: string,
  flag: string,
): { hour: number; minute: number; second: number } {
  const m = TIME_HMS_REGEX.exec(raw);
  if (!m) {
    throw new ConfigError(`${flag} must be HH:MM or HH:MM:SS (got "${raw}")`);
  }
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  const second = m[3] !== undefined ? Number(m[3]) : 0;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
    throw new ConfigError(`${flag} out of range (HH 0-23, MM/SS 0-59): "${raw}"`);
  }
  return { hour, minute, second };
}

function parseDurationOrThrow(
  raw: string | undefined,
  flag: string,
  range: DurationRange = 'positive',
): { unit: 'ms' | 's' | 'm'; value: number; ms: number } {
  if (raw === undefined) {
    throw new ConfigError(`${flag} is required (examples: 500ms, 5s, 2m)`);
  }
  const duration = parseDurationLiteral(raw, range);
  if (duration === null) {
    const rangeDescription = range === 'integer' ? 'an' : 'a positive';
    throw new ConfigError(
      `${flag} must be ${rangeDescription} integer duration ending in ms, s, or m`,
    );
  }
  return { unit: duration.unit, value: duration.value, ms: duration.milliseconds };
}

// Mirrors timeRange + alarmClock filter union: `{}` (every day),
// `{inHoliday: bool}` (workdays|holidays), `{day: [0..6]}` (custom set).
function buildDayFilter(shortcut: AddNodeShortcut): Record<string, unknown> {
  const flagsSet = [shortcut.weekdayOnly, shortcut.holidayOnly, shortcut.days !== undefined].filter(
    Boolean,
  ).length;
  if (flagsSet > 1) {
    throw new ConfigError(
      '--weekday-only / --holiday-only / --days are mutually exclusive (pick at most one)',
    );
  }
  if (shortcut.weekdayOnly) return { inHoliday: false };
  if (shortcut.holidayOnly) return { inHoliday: true };
  if (shortcut.days !== undefined) {
    for (const d of shortcut.days) {
      if (!Number.isInteger(d) || d < 0 || d > 6) {
        throw new ConfigError(`--days entries must be integers 0-6, got "${d}"`);
      }
    }
    return { day: shortcut.days };
  }
  return {};
}

function synthesizeNonDeviceShortcut(shortcut: AddNodeShortcut): Record<string, unknown> {
  // M12: same id + pos passthrough as device shortcut for export round-trips.
  const id = shortcut.id ?? `n-${Date.now()}`;
  const baseCfg = (name: string) => ({
    pos: shortcut.pos ?? sizedPos(shortcut.type),
    name,
    version: 1,
  });

  switch (shortcut.type) {
    case 'onLoad':
      return {
        id,
        type: 'onLoad',
        cfg: baseCfg('onLoad'),
        inputs: {},
        outputs: { output: [] },
        props: {},
      };

    case 'condition':
      // condition routes a trigger to `met` or `unmet` based on the
      // boolean-valued condition pin. Inputs/outputs are fixed.
      return {
        id,
        type: 'condition',
        cfg: baseCfg('condition'),
        inputs: { trigger: null, condition: null },
        outputs: { met: [], unmet: [] },
        props: {},
      };

    case 'logicAnd':
    case 'logicOr':
    case 'signalOr': {
      const n = shortcut.inputs ?? 2;
      if (!Number.isInteger(n) || n < 2) {
        throw new ConfigError(`--inputs must be an integer ≥ 2 (got ${shortcut.inputs})`);
      }
      const inputs: Record<string, null> = {};
      for (let i = 0; i < n; i += 1) inputs[`input${i}`] = null;
      return {
        id,
        type: shortcut.type,
        cfg: baseCfg(shortcut.type),
        inputs,
        outputs: { output: [] },
        props: {},
      };
    }

    case 'logicNot':
      return {
        id,
        type: 'logicNot',
        cfg: baseCfg('logicNot'),
        inputs: { input: null },
        outputs: { output: [] },
        props: {},
      };

    case 'counter':
    case 'onlyNTimes': {
      const n = shortcut.threshold;
      if (n === undefined || !Number.isInteger(n) || n < 1) {
        throw new ConfigError(
          `${shortcut.type} shortcut requires --threshold <N> as an integer >= 1`,
        );
      }
      return {
        id,
        type: shortcut.type,
        cfg: baseCfg(shortcut.type),
        inputs: { input: null, zero: null },
        outputs: { output: [] },
        props: { n },
      };
    }

    case 'delay':
    case 'statusLast': {
      const duration = parseDurationOrThrow(
        shortcut.duration,
        '--duration',
        shortcut.type === 'delay' ? 'integer' : 'positive',
      );
      return {
        id,
        type: shortcut.type,
        cfg: {
          ...baseCfg(shortcut.type),
          unit: duration.unit,
          value: duration.value,
        },
        inputs: { input: null },
        outputs: { output: [] },
        props: { timeout: duration.ms },
      };
    }

    case 'loop': {
      const interval = parseDurationOrThrow(shortcut.interval, '--interval', 'integer');
      return {
        id,
        type: 'loop',
        cfg: {
          ...baseCfg('loop'),
          unit: interval.unit,
          value: interval.value,
        },
        inputs: { start: null, stop: null },
        outputs: { output: [] },
        props: { interval: interval.ms },
      };
    }

    case 'timeRange': {
      if (!shortcut.start || !shortcut.end) {
        throw new ConfigError(
          'timeRange shortcut requires --start HH:MM[:SS] and --end HH:MM[:SS]',
        );
      }
      const start = parseHmsOrThrow(shortcut.start, '--start');
      const end = parseHmsOrThrow(shortcut.end, '--end');
      return {
        id,
        type: 'timeRange',
        cfg: baseCfg('timeRange'),
        inputs: {},
        outputs: { output: [] },
        props: { start, end, filter: buildDayFilter(shortcut) },
      };
    }

    case 'varChange': {
      if (!shortcut.varScope || !shortcut.varId || !shortcut.varType) {
        throw new ConfigError(
          'varChange shortcut requires --var-scope <S> --var-id <I> --var-type number|string',
        );
      }
      // F38 (2026-05-29) — bundle Pr.varChange hard-requires
      // `operator === '='` when `varType === 'string'`. Mirrors the F37 bool
      // fix: reject non-eq in synth so raw `validate:false` paths can't sneak
      // a `>=`/`!=`/etc. past either layer.
      const rawOp = shortcut.op ?? 'eq';
      if (shortcut.varType === 'string' && rawOp !== 'eq') {
        throw new ConfigError(
          `varChange string-varType only supports --op eq (got ${rawOp}). Real-gateway setGraph rejects non-"=" operators on string variables as Invalid operator. For inverse-equality semantics route through a logicNot or the unmet output of a varGet.`,
          { op: rawOp, varType: shortcut.varType, varId: shortcut.varId },
        );
      }
      const operator = varChangeOpSymbol(rawOp);
      // F49 (2026-05-30) — `between` on number varType requires both
      // --threshold (v1) and --threshold2 (v2). Fail fast so the agent
      // sees the missing flag, not a gateway "Invalid v2" round-trip.
      if (BETWEEN_OPS.has(operator) && shortcut.threshold2 === undefined) {
        throw new ConfigError(
          `varChange --op between requires both --threshold (v1) and --threshold2 (v2). Real-gateway setGraph rejects between without v2 as "Invalid v2".`,
          { op: rawOp, varType: shortcut.varType, varId: shortcut.varId },
        );
      }
      const v1 = varComparisonV1FromShortcut(shortcut, 'varChange');
      const props: Record<string, unknown> = {
        preload: false,
        id: shortcut.varId,
        scope: shortcut.varScope,
        varType: shortcut.varType,
        operator,
        v1,
      };
      if (shortcut.threshold2 !== undefined) props.v2 = shortcut.threshold2;
      return {
        id,
        type: 'varChange',
        cfg: baseCfg('varChange'),
        inputs: {},
        outputs: { output: [] },
        props,
      };
    }

    case 'varSetNumber':
    case 'varSetString': {
      // M14 task F (2026-05-29) — varSetNumber/varSetString c-shortcut.
      // Wire shape:
      //   inputs:  { input: null }
      //   outputs: { output: [] }
      //   props:   { scope, id, elements: [{type:"const"|"var", ...}, ...] }
      // The user-facing `--expr` flag is split via parseVarSetExpr into the
      // elements array. For varSetNumber the gateway syntax-checks the joined
      // expression (Mr.check); varSetString just concatenates.
      if (!shortcut.varScope || !shortcut.varId) {
        throw new ConfigError(
          `${shortcut.type} shortcut requires --var-scope <S> --var-id <I> for the target variable`,
        );
      }
      if (shortcut.expr === undefined) {
        throw new ConfigError(
          `${shortcut.type} shortcut requires --expr "<expression>" (e.g. "$global.count + 1" or "当前温度: $temp 度"). Use $$ for a literal $.`,
        );
      }
      const elements = parseVarSetExpr(shortcut.expr, {
        ...(shortcut.defaultExprScope !== undefined && {
          defaultScope: shortcut.defaultExprScope,
        }),
      });
      return {
        id,
        type: shortcut.type,
        cfg: baseCfg(shortcut.type),
        inputs: { input: null },
        outputs: { output: [] },
        props: {
          scope: shortcut.varScope,
          id: shortcut.varId,
          elements,
        },
      };
    }

    case 'register': {
      // M14 task G (2026-05-29) — register is a parameter-less boolean latch:
      // setTrue/setFalse pins flip an internal bit; output emits the current
      // value as a state. Wire shape per gateway-Pr.register check.
      return {
        id,
        type: 'register',
        cfg: baseCfg('register'),
        inputs: { setTrue: null, setFalse: null },
        outputs: { output: [] },
        props: {},
      };
    }

    case 'eventSequence': {
      // M14 task G — eventSequence requires that two input events arrive in
      // input1→input2 order within the timeout window. cfg.unit/value are
      // cosmetic (like delay/statusLast/loop); props.timeout is the
      // gateway-enforced positive integer (ms).
      const duration = parseDurationOrThrow(shortcut.duration, '--duration');
      return {
        id,
        type: 'eventSequence',
        cfg: {
          ...baseCfg('eventSequence'),
          unit: duration.unit,
          value: duration.value,
        },
        inputs: { input1: null, input2: null },
        outputs: { output: [] },
        props: { timeout: duration.ms },
      };
    }

    case 'modeSwitch': {
      // M14 task G — modeSwitch rotates through N output pins; each input
      // event advances to the next pin. Schema (widened earlier) requires
      // output0 + output1 minimum.
      const n = shortcut.outputsCount ?? 2;
      if (!Number.isInteger(n) || n < 2) {
        throw new ConfigError(
          `modeSwitch shortcut requires --outputs <N> as an integer >= 2 (got ${shortcut.outputsCount})`,
        );
      }
      const outputs: Record<string, unknown[]> = {};
      for (let i = 0; i < n; i += 1) outputs[`output${i}`] = [];
      return {
        id,
        type: 'modeSwitch',
        cfg: baseCfg('modeSwitch'),
        inputs: { input: null },
        outputs,
        props: {},
      };
    }

    case 'varGet': {
      // M14 task E — varGet c-shortcut. Reuses varChange's flag set.
      // Wire differences from varChange:
      //   - inputs:  { input: null }
      //   - outputs: { output: [], output2: [] }
      //   - NO preload field (gateway-side Pr.varGet has no preload check; UI omits)
      // Gateway operator vocab for number variables: >=, <=, =, !=, >, <, between
      // (NO include — that's deviceGet/deviceInput specific).
      if (!shortcut.varScope || !shortcut.varId || !shortcut.varType) {
        throw new ConfigError(
          'varGet shortcut requires --var-scope <S> --var-id <I> --var-type number|string',
        );
      }
      // F38 (2026-05-29) — bundle Pr.varGet shares the same string-varType
      // `operator === '='` constraint as Pr.varChange. See varChange branch
      // above for full rationale.
      const rawVarGetOp = shortcut.op ?? 'eq';
      if (shortcut.varType === 'string' && rawVarGetOp !== 'eq') {
        throw new ConfigError(
          `varGet string-varType only supports --op eq (got ${rawVarGetOp}). Real-gateway setGraph rejects non-"=" operators on string variables as Invalid operator. Branch on the unmet (output2) pin for inverse-equality semantics instead.`,
          { op: rawVarGetOp, varType: shortcut.varType, varId: shortcut.varId },
        );
      }
      const operator = varChangeOpSymbol(rawVarGetOp);
      // F49 (2026-05-30) — same `between` v1+v2 requirement as varChange.
      if (BETWEEN_OPS.has(operator) && shortcut.threshold2 === undefined) {
        throw new ConfigError(
          `varGet --op between requires both --threshold (v1) and --threshold2 (v2). Real-gateway setGraph rejects between without v2 as "Invalid v2".`,
          { op: rawVarGetOp, varType: shortcut.varType, varId: shortcut.varId },
        );
      }
      const v1 = varComparisonV1FromShortcut(shortcut, 'varGet');
      const props: Record<string, unknown> = {
        scope: shortcut.varScope,
        id: shortcut.varId,
        varType: shortcut.varType,
        operator,
        v1,
      };
      if (shortcut.threshold2 !== undefined) props.v2 = shortcut.threshold2;
      return {
        id,
        type: 'varGet',
        cfg: baseCfg('varGet'),
        inputs: { input: null },
        outputs: { output: [], output2: [] },
        props,
      };
    }

    case 'alarmClock': {
      const forms = [
        shortcut.at !== undefined,
        shortcut.sunrise === true,
        shortcut.sunset === true,
      ].filter(Boolean).length;
      if (forms !== 1) {
        throw new ConfigError(
          'alarmClock shortcut requires exactly one of --at HH:MM[:SS] / --sunrise / --sunset',
        );
      }
      const filter = buildDayFilter(shortcut);
      if (shortcut.at !== undefined) {
        const t = parseHmsOrThrow(shortcut.at, '--at');
        return {
          id,
          type: 'alarmClock',
          cfg: {
            ...baseCfg('alarmClock'),
            happenType: 'now',
            tempOffset: 0,
          },
          inputs: {},
          outputs: { output: [] },
          props: {
            type: 'periodicAlarm',
            isSunset: false,
            hour: t.hour,
            minute: t.minute,
            second: t.second,
            filter,
          },
        };
      }
      // sunrise / sunset form: gateway needs lat/long to compute today's
      // sun event. Codex T4 showed no `/api/getLocation` RPC; user must
      // pass --latitude / --longitude.
      if (shortcut.latitude === undefined || shortcut.longitude === undefined) {
        throw new ConfigError(
          '--sunrise / --sunset require --latitude <DEG> --longitude <DEG> (no gateway RPC to autoload)',
        );
      }
      const offsetSec = (shortcut.offsetMin ?? 0) * 60;
      return {
        id,
        type: 'alarmClock',
        cfg: {
          ...baseCfg('alarmClock'),
          happenType: 'now',
          tempOffset: 0,
        },
        inputs: {},
        outputs: { output: [] },
        props: {
          type: 'sunset',
          isSunset: shortcut.sunset === true,
          offset: offsetSec,
          latitude: shortcut.latitude,
          longitude: shortcut.longitude,
          filter,
        },
      };
    }
  }

  throw new ConfigError(`unsupported non-device shortcut type "${shortcut.type}"`);
}

// F35: varChange uses character operators + scalar v1 (≠ deviceInput which
// uses `include` + array v1). Map the user-facing CLI vocabulary to the
// gateway's varChange dialect so AI agents see one `--op` set across types.
// F49 (2026-05-30) — `between` joins the varChange/varGet number-varType
// vocab. Bundle Pr.varChange / Pr.varGet require both v1 and v2 numerics
// when operator is `between`.
const VAR_CHANGE_OP_SYMBOLS: Record<string, string> = {
  gt: '>',
  lt: '<',
  eq: '=',
  ne: '!=',
  between: 'between',
  gte: '>=',
  lte: '<=',
};

// F38 (2026-05-29) — bool threshold strict 0|1 helper. Used by both the
// deviceInput and deviceGet bool branches above. Background: c-shortcut
// callers (CLI + library) pass `threshold` as a JS number after Commander's
// `Number.parseFloat` coercion. That coercion silently maps "true"/"false"/
// "xyz" to NaN, and the original `Boolean(thresholdValue)` then mapped
// NaN→false (inverting user intent for `--threshold true`) and any nonzero
// numeric (e.g. 2) to true. The gateway-side validator (Pr.deviceInput /
// Pr.deviceGet) only checks `typeof v1 === 'boolean'`, so neither the wire
// nor the save-button validator catches the silent flip — synth must
// enforce 0|1 explicitly.
function boolThresholdFromShortcut(
  threshold: number | undefined,
  property: string | undefined,
): boolean {
  if (threshold === 0) return false;
  if (threshold === 1) return true;
  const display =
    threshold === undefined
      ? 'omitted (no --threshold)'
      : Number.isNaN(threshold)
        ? 'NaN'
        : threshold;
  throw new ConfigError(
    `bool property "${property}" requires --threshold 0 or 1 (got ${display}). Use 1 to match "true"/on, 0 to match "false"/off. Note: --threshold true/false would silently become NaN via Number.parseFloat — pass 0|1 instead.`,
    { threshold, property },
  );
}

// F41 (2026-05-30) — pick the right v1 for a varChange/varGet shortcut
// based on varType. number variables use `--threshold <N>` (existing
// path; defaults to 0 for backwards-compat). string variables require
// the new `--var-value <S>` flag because Commander's `Number.parseFloat`
// would silently NaN-out any non-numeric string. The two flags are
// mutually exclusive — passing both is an obvious authoring mistake.
function varComparisonV1FromShortcut(
  shortcut: AddNodeShortcut,
  kind: 'varChange' | 'varGet',
): number | string {
  if (shortcut.varType === 'string') {
    if (shortcut.varValue === undefined) {
      throw new ConfigError(
        `${kind} string-varType requires --var-value <S> for the comparison literal (got nothing). The bundle's Pr.${kind} validator requires v1: string when varType: "string".`,
        { varType: shortcut.varType, varId: shortcut.varId },
      );
    }
    if (shortcut.threshold !== undefined) {
      throw new ConfigError(
        `${kind} string-varType cannot mix --threshold (numeric) with --var-value (string). Pass --var-value only for string varType.`,
        { varType: shortcut.varType, varId: shortcut.varId },
      );
    }
    return shortcut.varValue;
  }
  // number varType (default). varValue is meaningless here.
  if (shortcut.varValue !== undefined) {
    throw new ConfigError(
      `${kind} number-varType cannot use --var-value (string). Pass --threshold <N> for the numeric comparison threshold.`,
      { varType: shortcut.varType, varId: shortcut.varId },
    );
  }
  return shortcut.threshold ?? 0;
}

function varChangeOpSymbol(op: string): string {
  const sym = VAR_CHANGE_OP_SYMBOLS[op];
  if (!sym)
    throw new ConfigError(
      `unknown varChange operator: ${op} (expected one of gt|lt|eq|ne|gte|lte)`,
      { op },
    );
  return sym;
}

// ---------- $expr DSL parser (F task — varSetNumber/varSetString shortcuts) ----------
//
// Splits a user-facing expression string into the gateway's
// `elements: Array<{type:"const",value} | {type:"var",scope,id}>` shape.
//
// Grammar:
//   expr   = (literal | varref | escape)*
//   varref = "$" <ident> ("." <ident>)?
//   escape = "$$"                  literal '$'
//   ident  = [A-Za-z0-9]+           gateway scope/id vocab (alphanumeric)
//   literal= anything else (incl. Chinese, math operators, function calls)
//
// `$id` form defaults the scope to `defaultScope` (caller-provided, "global"
// when omitted). `$scope.id` uses the qualified scope. Adjacent const
// fragments are coalesced.
//
// Examples:
//   parseVarSetExpr("$global.count + 1")
//     → [{type:"var",scope:"global",id:"count"}, {type:"const",value:" + 1"}]
//   parseVarSetExpr("当前温度: $skillWalkTemp 度")
//     → [{type:"const",value:"当前温度: "}, {type:"var",scope:"global",id:"skillWalkTemp"}, {type:"const",value:" 度"}]
//   parseVarSetExpr("cost: $$10")
//     → [{type:"const",value:"cost: $10"}]
//
// Every unescaped `$` must start a valid reference. This makes the string-card
// path fail early too: `$bad_id` cannot silently become var `bad` + const
// `_id`. Use `$$` for a literal dollar.

export type VarSetExprElement =
  | { type: 'const'; value: string }
  | { type: 'var'; scope: string; id: string };

export function parseVarSetExpr(
  input: string,
  opts: { defaultScope?: string } = {},
): VarSetExprElement[] {
  const defaultScope = opts.defaultScope ?? 'global';
  if (!isValidVariableIdentifier(defaultScope)) {
    throw new ConfigError(
      `default expression scope "${defaultScope}" ${variableIdentifierMessage('scope')}`,
      { scope: defaultScope },
    );
  }
  const out: VarSetExprElement[] = [];
  let buf = '';
  let i = 0;

  const flushConst = () => {
    if (buf.length > 0) {
      const last = out[out.length - 1];
      if (last !== undefined && last.type === 'const') {
        last.value += buf;
      } else {
        out.push({ type: 'const', value: buf });
      }
      buf = '';
    }
  };

  while (i < input.length) {
    const ch = input[i];
    if (ch !== '$') {
      buf += ch;
      i += 1;
      continue;
    }
    const token = scanVariableReference(input, i, defaultScope);
    if (token.kind === 'escape') {
      buf += '$';
      i += token.consumed;
      continue;
    }
    if (token.kind === 'invalid') {
      throw new ConfigError(token.message, {
        offset: i,
        reference: token.raw,
      });
    }
    flushConst();
    out.push({ type: 'var', scope: token.scope, id: token.id });
    i += token.consumed;
  }
  flushConst();
  return out;
}

export interface UpdateNodeInput {
  ruleId: string;
  nodeId: string;
  patch: Record<string, unknown>;
  // F66f (2026-05-31) — see AddNodeInput.varCheck. Default-on var-existence
  // sweep; opt out for raw probes.
  varCheck?: boolean;
}

// Update an existing node in a rule's graph via read-modify-write. Top-level
// fields are shallow-merged; `cfg` is deep-merged (one level) so callers can
// patch e.g. `{cfg: {name: 'new'}}` without clobbering urn/pos/version.
// `id` and `type` are immutable — attempts to change them throw GatewayError.
async function updateNodeWithinWorkflow(
  input: UpdateNodeInput,
  deps: ResourceDeps,
): Promise<{ nodeId: string }> {
  const rules = await listRules(deps);
  const summary = rules.find((r) => r.id === input.ruleId);
  if (summary === undefined) {
    throw new NotFoundError(`rule not found: ${input.ruleId}`, { id: input.ruleId });
  }

  const current = await getRule(input.ruleId, deps);
  const idx = current.nodes.findIndex((n) => (n as { id: string }).id === input.nodeId);
  if (idx === -1) {
    throw new NotFoundError(`node not found: ${input.nodeId}`, {
      ruleId: input.ruleId,
      nodeId: input.nodeId,
    });
  }

  const existingNode = current.nodes[idx] as Record<string, unknown>;

  if ('id' in input.patch && input.patch.id !== existingNode.id) {
    throw new GatewayError('cannot change node id or type', { nodeId: input.nodeId });
  }
  if ('type' in input.patch && input.patch.type !== existingNode.type) {
    throw new GatewayError('cannot change node id or type', { nodeId: input.nodeId });
  }

  let merged: Record<string, unknown> = { ...existingNode, ...input.patch };
  if (
    input.patch.cfg !== undefined &&
    typeof input.patch.cfg === 'object' &&
    input.patch.cfg !== null &&
    typeof existingNode.cfg === 'object' &&
    existingNode.cfg !== null
  ) {
    merged = {
      ...merged,
      cfg: {
        ...(existingNode.cfg as Record<string, unknown>),
        ...(input.patch.cfg as Record<string, unknown>),
      },
    };
  }

  const validated = parseOrThrow(NodeUnion, merged, 'updateNode.merged');

  const updatedNodes = [...current.nodes];
  updatedNodes[idx] = validated;
  // F66a (2026-05-31) — skipLint: updateNode patches one node and preserves
  // all others. Edges authored elsewhere shouldn't gate a property-level patch.
  // F66f (2026-05-31) — wire listAvailVars (default-on); the patched node
  // may have introduced a new var ref the gateway hasn't materialised yet.
  await setGraph({ id: current.id, nodes: updatedNodes, cfg: refreshTimestamp(summary) }, deps, {
    skipLint: true,
    ...(input.varCheck !== false && {
      listAvailVars: (ruleId: string) => listAvailVarsForRule(ruleId, deps),
    }),
  });
  return { nodeId: input.nodeId };
}

export async function updateNode(
  input: UpdateNodeInput,
  deps: ResourceDeps,
): Promise<{ nodeId: string }> {
  return withResourceMutationWorkflow(deps, 'rule.node.update', () =>
    updateNodeWithinWorkflow(input, deps),
  );
}

export interface RemoveNodeInput {
  ruleId: string;
  nodeId: string;
  cascadeEdges?: boolean;
}

// Cascade is opt-in: by default we leave dangling edge strings in place so
// lint-graph can report them as warnings (callers may want to inspect or
// stitch them to a replacement node). We skip re-validation of rebuilt
// nodes because cascade only filters strings out of existing arrays —
// subtractive mutations can't break the schema.
async function removeNodeWithinWorkflow(
  input: RemoveNodeInput,
  deps: ResourceDeps,
): Promise<{ nodeId: string; removedEdges: number }> {
  const rules = await listRules(deps);
  const summary = rules.find((r) => r.id === input.ruleId);
  if (summary === undefined) {
    throw new NotFoundError(`rule not found: ${input.ruleId}`, { id: input.ruleId });
  }

  const current = await getRule(input.ruleId, deps);
  const idx = current.nodes.findIndex((n) => (n as { id: string }).id === input.nodeId);
  if (idx === -1) {
    throw new NotFoundError(`node not found: ${input.nodeId}`, {
      ruleId: input.ruleId,
      nodeId: input.nodeId,
    });
  }

  let remainingNodes = current.nodes.filter((_, i) => i !== idx);
  let removedEdges = 0;

  if (input.cascadeEdges === true) {
    const prefix = `${input.nodeId}.`;
    remainingNodes = remainingNodes.map((node) => {
      const outputs = (node as Record<string, unknown>).outputs as Record<string, unknown>;
      if (outputs === undefined || outputs === null || typeof outputs !== 'object') {
        return node;
      }
      let nodeChanged = false;
      const newOutputs: Record<string, unknown> = {};
      for (const pin of Object.keys(outputs)) {
        const pinArr = outputs[pin];
        if (!Array.isArray(pinArr)) {
          newOutputs[pin] = pinArr;
          continue;
        }
        const kept = pinArr.filter((entry: unknown) => {
          if (typeof entry === 'string' && entry.startsWith(prefix)) {
            removedEdges++;
            return false;
          }
          return true;
        });
        if (kept.length !== pinArr.length) {
          nodeChanged = true;
        }
        newOutputs[pin] = kept;
      }
      if (!nodeChanged) return node;
      return { ...(node as Record<string, unknown>), outputs: newOutputs } as typeof node;
    });
  }

  // F66a (2026-05-31) — skipLint: removeNode is subtractive; the resulting
  // graph may have dangling edges that the canvas would reject, but blocking
  // cleanup of a broken rule via the lint gate is worse UX (re-blocks the
  // only way out). Cascade=true already scrubs incoming references.
  await setGraph({ id: current.id, nodes: remainingNodes, cfg: refreshTimestamp(summary) }, deps, {
    skipLint: true,
  });
  return { nodeId: input.nodeId, removedEdges };
}

export async function removeNode(
  input: RemoveNodeInput,
  deps: ResourceDeps,
): Promise<{ nodeId: string; removedEdges: number }> {
  return withResourceMutationWorkflow(deps, 'rule.node.remove', () =>
    removeNodeWithinWorkflow(input, deps),
  );
}

// F65c — common pin-name typos coming from the event-card mental model
// where every action sink is conceptualised as "trigger". Mapping is per
// node-type so a typo on one node-type doesn't false-positive on another.
// `null` means: no high-confidence suggestion → fall through to Levenshtein.
const PIN_ALIAS_TABLE: Record<string, Record<string, string>> = {
  // Var setters/getters take `input`; agents typing `trigger`/`fire`/`in`
  // come from the event-sink mental model.
  varSetNumber: { trigger: 'input', fire: 'input', in: 'input' },
  varSetString: { trigger: 'input', fire: 'input', in: 'input' },
  varGet: { trigger: 'input', fire: 'input', in: 'input' },
  // Condition has `trigger` + `condition` — common confusions both ways.
  condition: { enter: 'trigger', gate: 'condition', input: 'trigger' },
  // deviceOutput's only sink is `trigger`; agents type `input` (the universal
  // default in this codebase).
  deviceOutput: { input: 'trigger', fire: 'trigger' },
};

// F65c — Levenshtein distance for "did you mean" suggestions. Capped at 3
// to keep table tiny and avoid false-positive suggestions for totally-
// different pin names. Threshold ≤ 2 in caller.
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  // 1-D DP row.
  let prev = new Array(n + 1).fill(0).map((_, j) => j) as number[];
  let curr = new Array(n + 1).fill(0) as number[];
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      // biome-ignore lint/style/noNonNullAssertion: indices in-bounds by construction
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  // biome-ignore lint/style/noNonNullAssertion: indices in-bounds by construction
  return prev[n]!;
}

// F65c — pick a single best canonical pin name to suggest, or null if no
// reasonably-close match exists. Returned suggestion is always one of
// `availablePins` (i.e. a pin that DOES exist on this node).
export function suggestPinName(
  nodeType: string,
  requestedPin: string,
  availablePins: string[],
): string | null {
  if (availablePins.length === 0) return null;
  // 1) Static alias table — high-confidence common typos. Only suggest
  //    if the canonical name is actually one of the node's input pins
  //    (defensive against schema drift).
  const alias = PIN_ALIAS_TABLE[nodeType]?.[requestedPin];
  if (alias !== undefined && availablePins.includes(alias)) return alias;
  // 2) Levenshtein fallback — accept distance ≤ 2 against any available pin.
  let best: { pin: string; dist: number } | null = null;
  for (const pin of availablePins) {
    const d = levenshtein(requestedPin, pin);
    if (d <= 2 && (best === null || d < best.dist)) best = { pin, dist: d };
  }
  return best?.pin ?? null;
}

// The concrete edge endpoint shape used by addEdge/removeEdge. Gateway
// pin keys (output, trigger, ...) are always strings.
export interface EdgeRef {
  nodeId: string;
  pin: string;
}

export interface AddEdgeInput {
  ruleId: string;
  from: EdgeRef;
  to: EdgeRef;
  // F66f (2026-05-31) — see AddNodeInput.varCheck. Default-on.
  varCheck?: boolean;
}

// M14 F1+F5+F6 — validate target node + target pin existence so dangling
// edge references (e.g. CLI default `:input` against a deviceOutput whose
// real input pin is `:trigger`) are caught at add time, not via lint after
// the user opens the front-end and sees orphaned nodes. Source pin is not
// validated because absent/empty outputs[pin] keys are auto-initialized for
// convenience (see existing tests).
async function addEdgeWithinWorkflow(
  input: AddEdgeInput,
  deps: ResourceDeps,
): Promise<{ edgeString: string }> {
  const rules = await listRules(deps);
  const summary = rules.find((r) => r.id === input.ruleId);
  if (summary === undefined) {
    throw new NotFoundError(`rule not found: ${input.ruleId}`, { id: input.ruleId });
  }

  const current = await getRule(input.ruleId, deps);
  const srcIdx = current.nodes.findIndex((n) => (n as { id: string }).id === input.from.nodeId);
  if (srcIdx === -1) {
    throw new NotFoundError(`source node not found: ${input.from.nodeId}`, {
      ruleId: input.ruleId,
      nodeId: input.from.nodeId,
    });
  }

  const tgtNode = current.nodes.find((n) => (n as { id: string }).id === input.to.nodeId) as
    | Record<string, unknown>
    | undefined;
  if (tgtNode === undefined) {
    throw new NotFoundError(`target node not found: ${input.to.nodeId}`, {
      ruleId: input.ruleId,
      nodeId: input.to.nodeId,
    });
  }
  const tgtInputKeys = inputPinNames(tgtNode);
  if (targetInputPinStatus(tgtNode, input.to.pin) !== 'valid') {
    const tgtType = String(tgtNode.type ?? 'unknown');
    const suggestion = suggestPinName(tgtType, input.to.pin, tgtInputKeys);
    const didYouMean = suggestion !== null ? `; did you mean \`${suggestion}\`?` : '';
    const hint =
      tgtInputKeys.length === 0
        ? `${tgtType} is a trigger-only node (no input pins) — it cannot be the target of an edge`
        : `target pin "${input.to.pin}" not in ${tgtType}.inputs (available: ${tgtInputKeys.join(', ')})${didYouMean}`;
    throw new ConfigError(hint, {
      ruleId: input.ruleId,
      targetNodeId: input.to.nodeId,
      targetPin: input.to.pin,
      availablePins: tgtInputKeys,
      ...(suggestion !== null && { suggestion }),
    });
  }

  const edgeString = `${input.to.nodeId}.${input.to.pin}`;
  const srcNode = current.nodes[srcIdx] as Record<string, unknown>;
  const srcOutputs = (srcNode.outputs ?? {}) as Record<string, unknown>;
  const existing = srcOutputs[input.from.pin];
  if (existing !== undefined && !Array.isArray(existing)) {
    throw new GatewayError(
      `outputs[${input.from.pin}] is not an array on node ${input.from.nodeId}`,
      { ruleId: input.ruleId, nodeId: input.from.nodeId, pin: input.from.pin },
    );
  }
  // Preserve retry classification before the broader fan-in scan: an exact
  // source endpoint already carrying this target is a duplicate, not a second
  // incoming source.
  if (Array.isArray(existing) && existing.includes(edgeString)) {
    throw new ConfigError(
      `edge already exists: ${input.from.nodeId}.${input.from.pin} -> ${edgeString}`,
      {
        ruleId: input.ruleId,
        from: `${input.from.nodeId}.${input.from.pin}`,
        to: edgeString,
      },
    );
  }
  // F66a (2026-05-31) — cross-color guard. Bundle connectTool.connect uses
  // `p===Qe.both||p===f` to refuse event→state / state→event wires (the
  // src-side dual `event|state` is the only wildcard). lintGraph already
  // reports this at error severity on a written graph; surface it on the
  // primary write path too so an LLM driving `rule edge add` doesn't ship
  // an edge whose ConfigError it could have seen pre-write.
  const srcColor = resolvePinColor(
    String(srcNode.type ?? ''),
    input.from.pin,
    'output',
    srcNode.props as Record<string, unknown> | undefined,
  );
  const tgtColor = resolvePinColor(
    String(tgtNode.type ?? ''),
    input.to.pin,
    'input',
    tgtNode.props as Record<string, unknown> | undefined,
  );
  if (arePinColorsCompatible(srcColor, tgtColor) === false) {
    throw new ConfigError(
      `cross-color edge: ${srcColor} output "${input.from.nodeId}.${input.from.pin}" → ${tgtColor} input "${edgeString}" (canvas-illegal, runtime-dead)`,
      {
        ruleId: input.ruleId,
        from: `${input.from.nodeId}.${input.from.pin}`,
        to: edgeString,
        srcColor,
        tgtColor,
      },
    );
  }
  // F66a (2026-05-31) — fan-in cap. Bundle connectTool.connect rejects a
  // second wire into a pin that already has one ("一个输入节点只能连一条线
  // 。你可能需要使用逻辑卡片"). Loop every other node's outputs and refuse
  // the add when the target endpoint is already in any output array. Scan the
  // attempted source node as well: a different output pin on that same node is
  // still a distinct incoming wire.
  for (const otherRaw of current.nodes) {
    const other = otherRaw as Record<string, unknown>;
    const outs = other.outputs as Record<string, unknown> | undefined;
    if (outs === undefined) continue;
    for (const [otherPin, arr] of Object.entries(outs)) {
      if (!Array.isArray(arr)) continue;
      if (arr.includes(edgeString)) {
        const existingFrom = `${String(other.id)}.${otherPin}`;
        throw new ConfigError(
          `fan-in cap: input pin "${edgeString}" is already wired from ${existingFrom} (canvas-illegal — "一个输入节点只能连一条线"). Use a logicOr/signalOr card to merge multiple triggers.`,
          {
            ruleId: input.ruleId,
            existingSource: existingFrom,
            to: edgeString,
            attemptedFrom: `${input.from.nodeId}.${input.from.pin}`,
          },
        );
      }
    }
  }

  let newArr: string[];
  if (existing === undefined) {
    newArr = [edgeString];
  } else if (Array.isArray(existing)) {
    newArr = [...existing, edgeString];
  } else {
    // Guarded above; retained for exhaustive narrowing if the shape changes.
    throw new GatewayError(`outputs[${input.from.pin}] is invalid on node ${input.from.nodeId}`, {
      ruleId: input.ruleId,
      nodeId: input.from.nodeId,
      pin: input.from.pin,
    });
  }

  const newSrc = { ...srcNode, outputs: { ...srcOutputs, [input.from.pin]: newArr } };
  const validated = parseOrThrow(NodeUnion, newSrc, 'addEdge.source');

  const updatedNodes = [...current.nodes];
  updatedNodes[srcIdx] = validated;
  // F66a / GitHub #96 — skipLint: the new edge was already vetted inline for
  // blocking predicates (cross-color / fan-in / target-pin existence /
  // duplicate). Same-node feedback is allowed and remains visible on the next
  // advisory or strict lint. Pre-existing edges shouldn't gate this write.
  // F66f (2026-05-31) — wire listAvailVars (default-on). New edge can route
  // a ghost-var trigger into a sink the user expects to fire.
  await setGraph({ id: current.id, nodes: updatedNodes, cfg: refreshTimestamp(summary) }, deps, {
    skipLint: true,
    ...(input.varCheck !== false && {
      listAvailVars: (ruleId: string) => listAvailVarsForRule(ruleId, deps),
    }),
  });
  return { edgeString };
}

export async function addEdge(
  input: AddEdgeInput,
  deps: ResourceDeps,
): Promise<{ edgeString: string }> {
  return withResourceMutationWorkflow(deps, 'rule.edge.add', () =>
    addEdgeWithinWorkflow(input, deps),
  );
}

export interface RemoveEdgeInput {
  ruleId: string;
  from: EdgeRef;
  to: EdgeRef;
  // F66f (2026-05-31) — see AddNodeInput.varCheck. Default-on; pass false
  // for cleanup of a graph whose unrelated cards reference ghost vars.
  varCheck?: boolean;
}

// Purely subtractive — removes one string from one array; skip re-validation.
async function removeEdgeWithinWorkflow(
  input: RemoveEdgeInput,
  deps: ResourceDeps,
): Promise<{ edgeString: string }> {
  const rules = await listRules(deps);
  const summary = rules.find((r) => r.id === input.ruleId);
  if (summary === undefined) {
    throw new NotFoundError(`rule not found: ${input.ruleId}`, { id: input.ruleId });
  }

  const current = await getRule(input.ruleId, deps);
  const srcIdx = current.nodes.findIndex((n) => (n as { id: string }).id === input.from.nodeId);
  if (srcIdx === -1) {
    throw new NotFoundError(`source node not found: ${input.from.nodeId}`, {
      ruleId: input.ruleId,
      nodeId: input.from.nodeId,
    });
  }

  const srcNode = current.nodes[srcIdx] as Record<string, unknown>;
  const srcOutputs = (srcNode.outputs ?? {}) as Record<string, unknown>;
  const pinArr = srcOutputs[input.from.pin];

  if (pinArr === undefined) {
    throw new NotFoundError('edge not found', {
      ruleId: input.ruleId,
      nodeId: input.from.nodeId,
      pin: input.from.pin,
    });
  }
  if (!Array.isArray(pinArr)) {
    throw new GatewayError(
      `outputs[${input.from.pin}] is not an array on node ${input.from.nodeId}`,
      { ruleId: input.ruleId, nodeId: input.from.nodeId, pin: input.from.pin },
    );
  }

  const edgeString = `${input.to.nodeId}.${input.to.pin}`;
  const matchIdx = pinArr.findIndex((entry) => entry === edgeString);
  if (matchIdx === -1) {
    throw new NotFoundError('edge not found', {
      ruleId: input.ruleId,
      nodeId: input.from.nodeId,
      pin: input.from.pin,
      edgeString,
    });
  }

  const newPinArr = [...pinArr.slice(0, matchIdx), ...pinArr.slice(matchIdx + 1)];
  const newSrc = {
    ...srcNode,
    outputs: { ...srcOutputs, [input.from.pin]: newPinArr },
  } as (typeof current.nodes)[number];

  const updatedNodes = [...current.nodes];
  updatedNodes[srcIdx] = newSrc;
  // F66a (2026-05-31) — skipLint: removeEdge is subtractive; never blocks
  // cleanup of broken graphs.
  // F66f (2026-05-31) — wire listAvailVars (default-on). Subtractive ops
  // can still ship a graph with ghost var refs unrelated to the removed
  // edge; the gate gives the agent a chance to notice. CLI opt-out via
  // input.varCheck === false matches the rest of the F66f surface.
  await setGraph({ id: current.id, nodes: updatedNodes, cfg: refreshTimestamp(summary) }, deps, {
    skipLint: true,
    ...(input.varCheck !== false && {
      listAvailVars: (ruleId: string) => listAvailVarsForRule(ruleId, deps),
    }),
  });
  return { edgeString };
}

export async function removeEdge(
  input: RemoveEdgeInput,
  deps: ResourceDeps,
): Promise<{ edgeString: string }> {
  return withResourceMutationWorkflow(deps, 'rule.edge.remove', () =>
    removeEdgeWithinWorkflow(input, deps),
  );
}

export interface RelayoutGraphResult {
  id: string;
  nodeCount: number;
  moved: number;
}

// Flow-aware relayout (`xgg rule layout`): re-position every card by its wiring.
// The per-node auto-layout (card-geometry) runs at add-time before edges exist,
// so it can only flow by insertion order; run this ONCE after the graph is fully
// wired to arrange cards by data flow — triggers left, each node right of its
// inputs, branches stacked, independent sub-automations in separate horizontal
// bands. Only cfg.pos.x/y change (sizes, props, edges untouched).
async function relayoutGraphWithinWorkflow(
  ruleId: string,
  deps: ResourceDeps,
  // F66f (2026-05-31) — `varCheck` opt-out matches the rest of the
  // incremental editing surface. Default-on so the agent's pos-only
  // relayout still trips on a graph with ghost var refs.
  opts: { validate?: boolean; varCheck?: boolean } = {},
): Promise<RelayoutGraphResult> {
  const rules = await listRules(deps);
  const summary = rules.find((r) => r.id === ruleId);
  if (summary === undefined) {
    throw new NotFoundError(`rule not found: ${ruleId}`, { id: ruleId });
  }
  const current = await getRule(ruleId, deps);

  const layoutNodes: Array<{ id: string; width: number; height: number }> = [];
  const edges: Array<{ from: string; to: string }> = [];
  for (const raw of current.nodes) {
    const node = raw as {
      id: string;
      cfg?: { pos?: Record<string, unknown> };
      outputs?: Record<string, unknown>;
    };
    const pos = node.cfg?.pos ?? {};
    layoutNodes.push({
      id: node.id,
      width: typeof pos.width === 'number' ? pos.width : 0,
      height: typeof pos.height === 'number' ? pos.height : 0,
    });
    for (const arr of Object.values(node.outputs ?? {})) {
      if (!Array.isArray(arr)) continue;
      for (const entry of arr) {
        if (typeof entry !== 'string') continue;
        const dot = entry.indexOf('.');
        edges.push({ from: node.id, to: dot === -1 ? entry : entry.slice(0, dot) });
      }
    }
  }

  const positions = layoutGraph({ nodes: layoutNodes, edges });
  let moved = 0;
  const updatedNodes = current.nodes.map((raw) => {
    const node = raw as Record<string, unknown>;
    const p = positions[node.id as string];
    const cfg = node.cfg as Record<string, unknown> | undefined;
    const pos = cfg?.pos as Record<string, unknown> | undefined;
    if (p === undefined || cfg === undefined || pos === undefined) return raw;
    if (pos.x !== p.x || pos.y !== p.y) moved += 1;
    return { ...node, cfg: { ...cfg, pos: { ...pos, x: p.x, y: p.y } } } as typeof raw;
  });

  // F66a (2026-05-31) — skipLint: relayoutGraph only touches cfg.pos.x/y on
  // each node; edge content is preserved verbatim. If the source graph had a
  // pre-existing lint error (authored before the gate), blocking layout
  // would prevent the visual cleanup the user is asking for.
  // F66f (2026-05-31) — wire listAvailVars (default-on). Even a pos-only
  // write is still an authoring touchpoint, so the var-existence sweep
  // gives the agent symmetric coverage with the rest of the F66f surface.
  await setGraph({ id: current.id, nodes: updatedNodes, cfg: refreshTimestamp(summary) }, deps, {
    validate: opts.validate !== false,
    skipLint: true,
    ...(opts.varCheck !== false && {
      listAvailVars: (rId: string) => listAvailVarsForRule(rId, deps),
    }),
  });
  return { id: ruleId, nodeCount: current.nodes.length, moved };
}

export async function relayoutGraph(
  ruleId: string,
  deps: ResourceDeps,
  opts: { validate?: boolean; varCheck?: boolean } = {},
): Promise<RelayoutGraphResult> {
  return withResourceMutationWorkflow(deps, 'rule.layout', () =>
    relayoutGraphWithinWorkflow(ruleId, deps, opts),
  );
}
