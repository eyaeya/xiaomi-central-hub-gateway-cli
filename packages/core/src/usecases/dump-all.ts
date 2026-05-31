import { listDevices } from '../resources/devices.js';
import type { ResourceDeps } from '../resources/index.js';
import { listRules } from '../resources/rules.js';
import { listScopes } from '../resources/variables.js';
import type { Device } from '../schemas/device.js';
import type { RuleSummary } from '../schemas/rule.js';

export interface DumpAllResult {
  devices: Record<string, Device> | null;
  rules: RuleSummary[] | null;
  variableScopes: string[] | null;
  errors: Array<{ resource: string; error: string }>;
  dumpedAt: string;
}

/**
 * Composite read: dump the three top-level resources (devices, rules,
 * variable scopes) as a single document.
 *
 * Calls run sequentially because the per-host agent's JSON-RPC handler does
 * not multiplex concurrent in-flight requests. Each resource has its own
 * try/catch so a single failure (e.g. gateway transient error) doesn't abort
 * the rest — the failed slot reports `null` and the failure is recorded in
 * `errors`.
 */
export async function dumpAll(deps: ResourceDeps): Promise<DumpAllResult> {
  const errors: Array<{ resource: string; error: string }> = [];
  let devices: Record<string, Device> | null = null;
  let rules: RuleSummary[] | null = null;
  let variableScopes: string[] | null = null;

  try {
    devices = await listDevices(deps);
  } catch (e) {
    errors.push({ resource: 'devices', error: e instanceof Error ? e.message : String(e) });
  }
  try {
    rules = await listRules(deps);
  } catch (e) {
    errors.push({ resource: 'rules', error: e instanceof Error ? e.message : String(e) });
  }
  try {
    variableScopes = await listScopes(deps);
  } catch (e) {
    errors.push({
      resource: 'variableScopes',
      error: e instanceof Error ? e.message : String(e),
    });
  }

  return { devices, rules, variableScopes, errors, dumpedAt: new Date().toISOString() };
}
