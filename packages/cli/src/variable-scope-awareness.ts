import type { listRules } from '@eyaeya/xgg-core';

export const GLOBAL_VARIABLE_SCOPE = 'global';

type RuleSummary = Awaited<ReturnType<typeof listRules>>[number];

export function ruleLocalVariableScope(ruleId: string): string {
  return `R${ruleId}`;
}

export function isRuleLocalScopeCandidate(scope: string): boolean {
  return scope.startsWith('R') && scope.length > 1;
}

export function isKnownScopeForRule(scope: string, ruleId: string): boolean {
  return scope === GLOBAL_VARIABLE_SCOPE || scope === ruleLocalVariableScope(ruleId);
}

export function isKnownScopeForLiveRules(
  scope: string,
  rules: readonly Pick<RuleSummary, 'id'>[],
): boolean {
  if (scope === GLOBAL_VARIABLE_SCOPE) return true;
  if (!isRuleLocalScopeCandidate(scope)) return false;
  const ruleId = scope.slice(1);
  return rules.some((rule) => rule.id === ruleId);
}

export function warnIfUnknownRuleNodeScope(input: {
  commandType: string;
  scope: string | undefined;
  ruleId: string;
  allowUnknownScope: boolean | undefined;
}): void {
  if (input.allowUnknownScope === true || input.scope === undefined) return;
  if (isKnownScopeForRule(input.scope, input.ruleId)) return;
  const localScope = ruleLocalVariableScope(input.ruleId);
  process.stderr.write(
    `[xgg rule node add ${input.commandType}] warning: variable scope "${input.scope}" is not visible to rule ${input.ruleId}; this rule can use only "${GLOBAL_VARIABLE_SCOPE}" or its current rule-local scope "${localScope}". A foreign or custom scope will fail strict rule validation or become ghost data. Pass --allow-unknown-scope only for a deliberate raw experiment.\n`,
  );
}

export function warnIfUnknownStandaloneScope(input: {
  scope: string;
  liveRules: readonly Pick<RuleSummary, 'id'>[];
  allowUnknownScope: boolean | undefined;
}): void {
  if (input.allowUnknownScope === true) return;
  if (isKnownScopeForLiveRules(input.scope, input.liveRules)) return;
  const detail = isRuleLocalScopeCandidate(input.scope)
    ? `does not correspond to a live rule id "${input.scope.slice(1)}"`
    : 'is neither "global" nor an R<existing-rule-id> scope';
  process.stderr.write(
    `[xgg variable] warning: scope "${input.scope}" ${detail}; the gateway can persist it, but the official editor will not expose it as a usable variable scope. Pass --allow-unknown-scope only for a deliberate ghost-data experiment.\n`,
  );
}
