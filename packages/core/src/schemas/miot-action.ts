import type { MiotProperty } from './device-spec.js';

export type MiotActionVariableDtype = 'number' | 'string' | 'boolean';

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
