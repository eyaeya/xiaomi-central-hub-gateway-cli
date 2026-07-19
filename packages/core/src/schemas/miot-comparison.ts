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
const DECIMAL_LITERAL_PARTS = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/;
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

export type MiotNumericOperandDomainIssue = {
  kind: 'non-finite' | 'value-list' | 'range' | 'step';
  message: string;
};

interface CanonicalDecimalComponents {
  coefficient: bigint;
  exponent: number;
}

function canonicalDecimalComponents(value: number): CanonicalDecimalComponents | null {
  const match = DECIMAL_LITERAL_PARTS.exec(String(value));
  if (match === null) return null;
  const integerDigits = match[2] ?? '0';
  const fractionalDigits = match[3] ?? match[4] ?? '';
  const digits = `${integerDigits}${fractionalDigits}`.replace(/^0+/, '') || '0';
  const magnitude = BigInt(digits);
  return {
    coefficient: match[1] === '-' ? -magnitude : magnitude,
    exponent: Number(match[5] ?? '0') - fractionalDigits.length,
  };
}

function isCanonicalDecimalStepAligned(value: number, min: number, step: number): boolean {
  const valueParts = canonicalDecimalComponents(value);
  const minParts = canonicalDecimalComponents(min);
  const stepParts = canonicalDecimalComponents(step);
  if (valueParts === null || minParts === null || stepParts === null) return false;
  const commonExponent = Math.min(valueParts.exponent, minParts.exponent, stepParts.exponent);
  const scale = ({ coefficient, exponent }: CanonicalDecimalComponents): bigint =>
    coefficient * 10n ** BigInt(exponent - commonExponent);
  const scaledStep = scale(stepParts);
  return scaledStep !== 0n && (scale(valueParts) - scale(minParts)) % scaledStep === 0n;
}

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
    eventWireOperators: ['=', '!=', '>', '<', '>=', '<=', 'between', 'include'],
    equalityWireOperator: 'include',
  },
  float: {
    shortcutOperators: ['gt', 'lt', 'between'],
    wireOperators: ['>', '<', 'between'],
    scalarWireOperators: ['>', '<'],
    eventWireOperators: ['>', '<', 'between'],
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
 * Validate one numeric comparison operand against the domain advertised by
 * the MIoT property. A non-empty value-list is a closed enum. value-range is
 * treated as `[min, max, step]`; the step check uses a small constant tolerance
 * in step units so decimal ranges such as `[0, 1, 0.1]` survive IEEE-754 noise
 * without becoming more permissive as the quotient grows.
 *
 * `skipRange` backs the existing `--force-out-of-range` escape hatch. It does
 * not bypass a closed value-list: choosing a value the device does not expose
 * is a dtype/domain error, not merely an out-of-range probe.
 */
export function miotNumericOperandDomainIssue(
  property: Pick<MiotProperty, 'value-list' | 'value-range'>,
  value: number,
  options: { skipRange?: boolean } = {},
): MiotNumericOperandDomainIssue | null {
  if (!Number.isFinite(value)) {
    return { kind: 'non-finite', message: `value ${String(value)} is not finite` };
  }
  const valueList = property['value-list'];
  if (Array.isArray(valueList) && valueList.length > 0) {
    const allowed = valueList.map((entry) => entry.value);
    if (!allowed.includes(value)) {
      return {
        kind: 'value-list',
        message: `value ${String(value)} is not in MIoT value-list [${allowed.join(', ')}]`,
      };
    }
  }

  if (options.skipRange === true) return null;
  const range = property['value-range'];
  if (range === undefined) return null;
  const [min, max, step] = range;
  if (value < min || value > max) {
    return {
      kind: 'range',
      message: `value ${String(value)} is outside MIoT value-range [${min}, ${max}]`,
    };
  }
  if (step > 0) {
    let aligned: boolean;
    if (Number.isSafeInteger(value) && Number.isSafeInteger(min) && Number.isSafeInteger(step)) {
      aligned = (BigInt(value) - BigInt(min)) % BigInt(step) === 0n;
    } else if (isCanonicalDecimalStepAligned(value, min, step)) {
      // Most MIoT ranges and CLI operands originate as base-10 JSON literals.
      // Compare those canonical decimals exactly before doing any IEEE-754
      // arithmetic, so non-zero minima and large grid indices stay exact.
      aligned = true;
    } else {
      const units = (value - min) / step;
      const nearest = Math.round(units);
      // Decimal MIoT ranges need a small IEEE-754 allowance. Keep it constant
      // in step units: scaling it with a large quotient can eventually accept
      // a genuinely distinct off-step value.
      const tolerance = Number.EPSILON * 64;
      aligned = Number.isFinite(units) && Math.abs(units - nearest) <= tolerance;
    }
    if (!aligned) {
      return {
        kind: 'step',
        message: `value ${String(value)} is not aligned to MIoT value-range step ${step} from ${min}`,
      };
    }
  }
  return null;
}

export function miotNumericOperandDomainError(
  property: Pick<MiotProperty, 'value-list' | 'value-range'>,
  value: number,
  options: { skipRange?: boolean } = {},
): string | null {
  return miotNumericOperandDomainIssue(property, value, options)?.message ?? null;
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

/**
 * Parse a base-10 literal only when its mathematical value is an exact safe
 * integer. Unlike `Number()` followed by `Number.isSafeInteger()`, this rejects
 * fractional tokens that round or underflow to an integer (`1.0000000000000001`,
 * `1e-324`) while retaining exact scientific notation (`9.007199254740991e15`).
 */
export function parseSafeIntegerDecimalLiteral(raw: string): number | null {
  const value = raw.trim();
  const match = DECIMAL_LITERAL_PARTS.exec(value);
  if (match === null) return null;

  const sign = match[1] === '-' ? -1 : 1;
  const integerDigits = match[2] ?? '0';
  const fractionalDigits = match[3] ?? match[4] ?? '';
  const coefficient = `${integerDigits}${fractionalDigits}`;
  const significant = coefficient.replace(/^0+/, '');
  if (significant.length === 0) return sign < 0 ? -0 : 0;

  const exponent = BigInt(match[5] ?? '0');
  const shift = exponent - BigInt(fractionalDigits.length);
  let integerText: string;
  if (shift >= 0n) {
    if (shift > 16n) return null;
    integerText = `${significant}${'0'.repeat(Number(shift))}`;
  } else {
    const places = -shift;
    if (places > BigInt(coefficient.length)) return null;
    const count = Number(places);
    if (!coefficient.endsWith('0'.repeat(count))) return null;
    integerText = coefficient.slice(0, coefficient.length - count).replace(/^0+/, '') || '0';
  }

  const magnitude = BigInt(integerText);
  if (magnitude > MAX_SAFE_INTEGER_BIGINT) return null;
  const parsed = Number(magnitude);
  return sign < 0 ? -parsed : parsed;
}
