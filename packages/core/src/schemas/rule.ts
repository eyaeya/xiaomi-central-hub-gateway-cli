import { z } from 'zod';
import { NodeUnion } from './nodes/index.js';

// F57 (2026-05-30) — ai-config bundle persists `userData.transform` as a
// strict 4-key numeric quad `{x, y, scale, rotate}`. Every persistent
// write literal in the bundle (graphConfig default, addRule init,
// ADD_TAB fallback, duplicate-rule path) uses exactly these 4 keys,
// and every real-gateway dump observed across M3→M14 snapshots matches
// (including signed integers like `{x:-6, y:-4267, scale:1, rotate:0}`
// from skill-walk/pre-clear-dump). The in-memory transformTool also
// carries a 5th `temp` field but it is NEVER persisted. Tighten to
// match the actual wire contract; the surrounding UserData stays
// .passthrough() so unrelated future fields (e.g. UI-only tags) still
// flow through without an unrelated breakage.
const Transform = z
  .object({
    x: z.number(),
    y: z.number(),
    scale: z.number(),
    rotate: z.number(),
  })
  .strict();

// F66c (2026-05-31) — `tags` is the UI rule-filter dimension. Bundle
// ai-config-v5 builds `userData.tags = filter(checked && inputValue).map(label)`
// in the rule-tag modal; every read carries `(userData.tags || []).forEach(...)`
// so the absence of the field is treated the same as `[]`. Schema-tighten as an
// optional string array; the surrounding UserData stays .passthrough() so
// unknown future fields still survive a round-trip.
const UserData = z
  .object({
    name: z.string(),
    transform: Transform,
    lastUpdateTime: z.number(),
    version: z.number(),
    tags: z.array(z.string()).optional(),
  })
  .passthrough();

export const RuleSummary = z
  .object({
    id: z.string(),
    userData: UserData,
    uiType: z.string(),
    enable: z.boolean(),
  })
  .passthrough();
export type RuleSummary = z.infer<typeof RuleSummary>;

export const RuleListResponse = z.array(RuleSummary);
export type RuleListResponse = z.infer<typeof RuleListResponse>;

export const Node = NodeUnion;
export type Node = NodeUnion;

export const RuleGetResponse = z.object({
  id: z.string(),
  nodes: z.array(Node),
});
export type RuleGetResponse = z.infer<typeof RuleGetResponse>;

// cfg mirrors the RuleSummary shape returned by /api/getGraphList — the
// gateway rejects any subset (M4 Task 11 e2e probe, 2026-05-26: bare {id}
// → "Invalid config"; full RuleSummary → ok). Callers should pass the
// summary they got from listRules() back through here, mutating only the
// fields they intend to change.
export const GraphSetRequest = z
  .object({
    id: z.string(),
    nodes: z.array(Node),
    cfg: RuleSummary,
  })
  .passthrough();
export type GraphSetRequest = z.infer<typeof GraphSetRequest>;
