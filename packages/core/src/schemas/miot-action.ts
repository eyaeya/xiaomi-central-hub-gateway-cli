import type { MiotProperty } from './device-spec.js';

export type MiotActionVariableDtype = 'number' | 'string' | 'boolean';

/**
 * The pinned editor exposes deviceOutput variables only for free-form string
 * targets and numeric value-range targets. Boolean and every target carrying
 * a value-list field (including an empty array) are rendered through literal
 * controls instead. The gateway's
 * save schema accepts a wider legacy ref shape, but the pinned executor gives
 * no evidence that those refs execute.
 */
export function deviceOutputVariableRefUnsupportedReason(property: MiotProperty): string | null {
  if (property.format === 'bool') {
    return `deviceOutput variable reference for boolean MIoT property ${property.type} is unsupported. The pinned UI exposes this target as a literal-only dropdown; the gateway save schema accepts a legacy dtype "boolean" ref shape, but there is no executor evidence for it. Branch a number 0/1 state before the output and route the branches to separate deviceOutput nodes with literal false/true (or legacy property literals 0/1).`;
  }
  if (Object.hasOwn(property, 'value-list')) {
    return `deviceOutput variable reference for value-list MIoT property ${property.type} is unsupported. The pinned UI takes the literal-only dropdown/value-list path whenever that field is present, including an empty array, and provides no variable-selector executor evidence. Route explicit branches to separate deviceOutput nodes using literal values from the MIoT value-list; if the list is empty, treat the spec as incomplete rather than guessing a variable executor path.`;
  }
  return null;
}

export function miotActionVariableDtype(format: string): MiotActionVariableDtype {
  if (format === 'string') return 'string';
  if (format === 'bool') return 'boolean';
  return 'number';
}

export function isMiotActionIntegerFormat(format: string): boolean {
  return format !== 'string' && format !== 'bool' && format !== 'float' && format !== 'double';
}

/** Project the property URN onto the JSON key consumed by typed `--params`. */
export function miotActionInputParamName(property: Pick<MiotProperty, 'iid' | 'type'>): string {
  return property.type.split(':')[3] ?? `piid-${property.iid}`;
}

export interface MiotActionInputParamCollision {
  paramName: string;
  piids: number[];
}

export function findDuplicateMiotActionInputPiids(piids: readonly number[]): number[] {
  const seen = new Set<number>();
  const duplicates = new Set<number>();
  for (const piid of piids) {
    if (seen.has(piid)) duplicates.add(piid);
    seen.add(piid);
  }
  return [...duplicates];
}

/**
 * Find distinct action input PIIDs that collapse onto the same property
 * short-name. A JSON object cannot represent those inputs independently, so
 * typed authoring must reject the spec and permissive export must warn.
 */
export function findMiotActionInputParamCollisions(
  inputs: ReadonlyArray<{
    piid: number;
    property: Pick<MiotProperty, 'iid' | 'type'>;
  }>,
): MiotActionInputParamCollision[] {
  const piidsByName = new Map<string, number[]>();
  for (const { piid, property } of inputs) {
    const paramName = miotActionInputParamName(property);
    const piids = piidsByName.get(paramName) ?? [];
    if (!piids.includes(piid)) piids.push(piid);
    piidsByName.set(paramName, piids);
  }
  return [...piidsByName.entries()]
    .filter(([, piids]) => piids.length > 1)
    .map(([paramName, piids]) => ({ paramName, piids }));
}
