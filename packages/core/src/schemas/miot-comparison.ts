import type { MiotProperty } from './device-spec.js';

export type MiotComparisonDtype = 'int' | 'float' | 'boolean' | 'string';
export type MiotComparisonShortcutOperator = 'gt' | 'lt' | 'eq' | 'ne' | 'gte' | 'lte' | 'between';
export type MiotComparisonWireOperator =
  | '>'
  | '<'
  | '='
  | '!='
  | '>='
  | '<='
  | 'between'
  | 'include';

const FINITE_DECIMAL_LITERAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * One source of truth for the comparison dialect accepted by MIoT rule cards.
 *
 * Property shortcuts, event-filter parsing, spec-aware validation, strict node
 * schemas, and export replay all consume this table. In particular, equality
 * is deliberately dtype-specific: integer properties use `include` + an array,
 * while boolean and string properties use `=` + a scalar.
 */
export const MIOT_COMPARISON_CONTRACT = {
  int: {
    shortcutOperators: ['gt', 'lt', 'eq', 'ne', 'gte', 'lte', 'between'],
    wireOperators: ['>', '<', '=', '!=', '>=', '<=', 'between', 'include'],
    scalarWireOperators: ['>=', '<=', '=', '!=', '>', '<'],
    eventWireOperators: ['=', '!=', '>', '<', '>=', '<='],
    equalityWireOperator: 'include',
  },
  float: {
    shortcutOperators: ['gt', 'lt', 'between'],
    wireOperators: ['>', '<', 'between'],
    scalarWireOperators: ['>', '<'],
    eventWireOperators: ['>', '<'],
    equalityWireOperator: null,
  },
  boolean: {
    shortcutOperators: ['eq'],
    wireOperators: ['='],
    scalarWireOperators: ['='],
    eventWireOperators: ['='],
    equalityWireOperator: '=',
  },
  string: {
    shortcutOperators: ['eq'],
    wireOperators: ['='],
    scalarWireOperators: ['='],
    eventWireOperators: ['='],
    equalityWireOperator: '=',
  },
} as const;

export function hasMiotValueList(property: Pick<MiotProperty, 'value-list'>): boolean {
  return Array.isArray(property['value-list']) && property['value-list'].length > 0;
}

/**
 * Project a MIoT property onto the gateway rule-card comparison dtype.
 *
 * The web UI treats a float property with a non-empty value-list as a discrete
 * enum, so it must use the integer comparison dialect. A continuous float
 * remains float; bool and string have their own scalar dialects; all integer
 * widths (and forward-compatible unknown numeric formats) collapse to int.
 */
export function projectMiotComparisonDtype(
  property: Pick<MiotProperty, 'format' | 'value-list'>,
): MiotComparisonDtype {
  if (property.format === 'float') return hasMiotValueList(property) ? 'int' : 'float';
  if (property.format === 'string') return 'string';
  if (property.format === 'bool') return 'boolean';
  return 'int';
}

export function miotShortcutOperatorToWire(
  dtype: MiotComparisonDtype,
  operator: MiotComparisonShortcutOperator,
): MiotComparisonWireOperator | null {
  const contract = MIOT_COMPARISON_CONTRACT[dtype];
  if (!(contract.shortcutOperators as readonly string[]).includes(operator)) return null;
  if (operator === 'eq') return contract.equalityWireOperator;
  switch (operator) {
    case 'gt':
      return '>';
    case 'lt':
      return '<';
    case 'ne':
      return '!=';
    case 'gte':
      return '>=';
    case 'lte':
      return '<=';
    case 'between':
      return 'between';
  }
}

export function isMiotEventWireOperator(
  dtype: MiotComparisonDtype,
  operator: string,
): operator is MiotComparisonWireOperator {
  return (MIOT_COMPARISON_CONTRACT[dtype].eventWireOperators as readonly string[]).includes(
    operator,
  );
}

export function isMiotWireOperator(
  dtype: MiotComparisonDtype,
  operator: string,
): operator is MiotComparisonWireOperator {
  return (MIOT_COMPARISON_CONTRACT[dtype].wireOperators as readonly string[]).includes(operator);
}

/**
 * Parse a finite base-10 numeric literal without JavaScript's empty-string,
 * hexadecimal, or trailing-junk coercions. Surrounding CLI whitespace is
 * ignored, but the trimmed token must be entirely numeric.
 */
export function parseFiniteDecimalLiteral(raw: string): number | null {
  const value = raw.trim();
  if (!FINITE_DECIMAL_LITERAL.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
