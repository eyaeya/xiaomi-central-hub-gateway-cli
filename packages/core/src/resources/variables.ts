import {
  type AvailableVariable,
  type VarConfigResponse,
  VarConfigResponse as VarConfigResponseSchema,
  type VarEntry,
  VarListResponse,
  VarScopeListResponse,
  type VarValueResponse,
  VarValueResponse as VarValueResponseSchema,
  VariableCreateRequest,
  VariableDeleteRequest,
  VariableSetConfigRequest,
  VariableSetValueRequest,
} from '../schemas/variable.js';
import { GatewayError, parseOrThrow } from '../transport/errors.js';
import { agentCall } from '../usecases/agent-call.js';
import type { ResourceDeps } from './index.js';

export async function listScopes(deps: ResourceDeps): Promise<string[]> {
  const raw = await agentCall({
    baseUrl: deps.baseUrl,
    method: '/api/getVarScopeList',
    params: {},
    store: deps.store,
    ...(deps.ipcClient !== undefined && { ipcClient: deps.ipcClient }),
    ...(deps.timeoutMs !== undefined && { timeoutMs: deps.timeoutMs }),
  });
  return parseOrThrow(VarScopeListResponse, raw, 'VarScopeListResponse').scopes;
}

// F66-VarEntry-strict (2026-05-31): return type is now
// `Record<string, VarEntry>` (typed `{type, value, userData{name}}`)
// instead of the M11/M12-era `Record<string, VariableConfig>` where
// VariableConfig was `z.record(z.unknown())`. The bundle's UI mapper
// (ai-config-v5.28b650.js — `Object.keys(e).map(n => ({...e[n], scope,
// id})).filter(e => wa(e.type))`) treats listVar entries as full
// VarEntry shapes; xgg matches.
export async function listVariables(
  scope: string,
  deps: ResourceDeps,
): Promise<Record<string, VarEntry>> {
  const raw = await agentCall({
    baseUrl: deps.baseUrl,
    method: '/api/getVarList',
    params: { scope },
    store: deps.store,
    ...(deps.ipcClient !== undefined && { ipcClient: deps.ipcClient }),
    ...(deps.timeoutMs !== undefined && { timeoutMs: deps.timeoutMs }),
  });
  return parseOrThrow(VarListResponse, raw, 'VarListResponse');
}

const MISSING_SCOPE_MESSAGES = [/^Invalid scope$/i, /^Scope\s+\S+\s+does not exist$/i];

/** Whether a gateway error means that a variable scope has not been materialised yet. */
export function isMissingScopeError(error: unknown): error is GatewayError {
  return (
    error instanceof GatewayError &&
    MISSING_SCOPE_MESSAGES.some((pattern) => pattern.test(error.message.trim()))
  );
}

// F23 (2026-05-30): the UI save() flow calls `varTool.listAvailVars(graphId)`.
// Preserve each local-rule/global variable's exact scope and id so a same-named
// variable in the other scope cannot satisfy the graph's existence check.
// Missing scopes are tolerated — neither `R<graphId>` nor `global` is required
// to exist (a rule with no local vars / a fresh gateway with no globals still
// lints cleanly).
export async function listAvailVarsForRule(
  ruleId: string,
  deps: ResourceDeps,
): Promise<AvailableVariable[]> {
  const variables: AvailableVariable[] = [];
  for (const scope of [`R${ruleId}`, 'global']) {
    try {
      const map = await listVariables(scope, deps);
      for (const id of Object.keys(map)) variables.push({ scope, id });
    } catch (e) {
      // Scope doesn't exist (gateway throws on unknown scope); skip silently.
      if (!isMissingScopeError(e)) throw e;
    }
  }
  return variables;
}

// F66-VarEntry-strict (2026-05-31): the gateway exposes
// `/api/getVarConfig` and `/api/getVarValue` for single-variable
// lookups. Pre-F66 return type was `unknown` (M11 placeholder); the
// bundle's UI shows the response shapes are well-defined —
//   - getVarConfig → VarConfigResponse (same shape as a listVar entry)
//   - getVarValue  → VarValueResponse  `{value: number|string}`
// so `parseOrThrow` validates and the caller gets typed access.
export async function getVariableConfig(
  scope: string,
  id: string,
  deps: ResourceDeps,
): Promise<VarConfigResponse> {
  const raw = await agentCall({
    baseUrl: deps.baseUrl,
    method: '/api/getVarConfig',
    params: { scope, id },
    store: deps.store,
    ...(deps.ipcClient !== undefined && { ipcClient: deps.ipcClient }),
    ...(deps.timeoutMs !== undefined && { timeoutMs: deps.timeoutMs }),
  });
  return parseOrThrow(VarConfigResponseSchema, raw, 'VarConfigResponse');
}

export async function getVariableValue(
  scope: string,
  id: string,
  deps: ResourceDeps,
): Promise<VarValueResponse> {
  const raw = await agentCall({
    baseUrl: deps.baseUrl,
    method: '/api/getVarValue',
    params: { scope, id },
    store: deps.store,
    ...(deps.ipcClient !== undefined && { ipcClient: deps.ipcClient }),
    ...(deps.timeoutMs !== undefined && { timeoutMs: deps.timeoutMs }),
  });
  return parseOrThrow(VarValueResponseSchema, raw, 'VarValueResponse');
}

export async function createVariable(
  req: VariableCreateRequest,
  deps: ResourceDeps,
): Promise<void> {
  const params = parseOrThrow(VariableCreateRequest, req, 'VariableCreateRequest');
  await agentCall({
    baseUrl: deps.baseUrl,
    method: '/api/createVar',
    params,
    store: deps.store,
    kind: 'write',
    ...(deps.ipcClient !== undefined && { ipcClient: deps.ipcClient }),
    ...(deps.timeoutMs !== undefined && { timeoutMs: deps.timeoutMs }),
  });
}

export async function deleteVariable(
  req: VariableDeleteRequest,
  deps: ResourceDeps,
): Promise<void> {
  const params = parseOrThrow(VariableDeleteRequest, req, 'VariableDeleteRequest');
  await agentCall({
    baseUrl: deps.baseUrl,
    method: '/api/deleteVar',
    params,
    store: deps.store,
    kind: 'write',
    ...(deps.ipcClient !== undefined && { ipcClient: deps.ipcClient }),
    ...(deps.timeoutMs !== undefined && { timeoutMs: deps.timeoutMs }),
  });
}

export async function setVariableConfig(
  req: VariableSetConfigRequest,
  deps: ResourceDeps,
): Promise<void> {
  const params = parseOrThrow(VariableSetConfigRequest, req, 'VariableSetConfigRequest');
  await agentCall({
    baseUrl: deps.baseUrl,
    method: '/api/setVarConfig',
    params,
    store: deps.store,
    kind: 'write',
    ...(deps.ipcClient !== undefined && { ipcClient: deps.ipcClient }),
    ...(deps.timeoutMs !== undefined && { timeoutMs: deps.timeoutMs }),
  });
}

export async function setVariableValue(
  req: VariableSetValueRequest,
  deps: ResourceDeps,
): Promise<void> {
  const params = parseOrThrow(VariableSetValueRequest, req, 'VariableSetValueRequest');
  await agentCall({
    baseUrl: deps.baseUrl,
    method: '/api/setVarValue',
    params,
    store: deps.store,
    kind: 'write',
    ...(deps.ipcClient !== undefined && { ipcClient: deps.ipcClient }),
    ...(deps.timeoutMs !== undefined && { timeoutMs: deps.timeoutMs }),
  });
}
