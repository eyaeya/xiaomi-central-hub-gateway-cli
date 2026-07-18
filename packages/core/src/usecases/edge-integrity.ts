import { TYPED_SCHEMAS } from './typed-schemas.js';

export type TargetInputPinStatus = 'valid' | 'invalid' | 'unknown-node-type';

export function isModeledNodeType(type: unknown): type is string {
  return typeof type === 'string' && Object.hasOwn(TYPED_SCHEMAS, type);
}

export function inputPinNames(node: Record<string, unknown>): string[] {
  const inputs = node.inputs;
  if (typeof inputs !== 'object' || inputs === null || Array.isArray(inputs)) return [];
  return Object.keys(inputs);
}

/**
 * Resolve whether a target pin exists on a node whose shape is modeled locally.
 * Unknown future node types deliberately return `unknown-node-type`: callers
 * must preserve the UnknownNode forward-compatibility path instead of guessing
 * at firmware-defined pin semantics.
 */
export function targetInputPinStatus(
  node: Record<string, unknown>,
  pin: string,
): TargetInputPinStatus {
  const inputs = node.inputs;
  if (
    typeof inputs === 'object' &&
    inputs !== null &&
    !Array.isArray(inputs) &&
    Object.hasOwn(inputs, pin)
  ) {
    return 'valid';
  }
  return isModeledNodeType(node.type) ? 'invalid' : 'unknown-node-type';
}
