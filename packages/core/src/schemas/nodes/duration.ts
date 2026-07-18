import { z } from 'zod';

export const DURATION_UNITS = ['ms', 's', 'm'] as const;
export type DurationUnit = (typeof DURATION_UNITS)[number];

export const DurationUnitSchema = z.enum(DURATION_UNITS, {
  errorMap: () => ({ message: 'duration unit must be one of ms, s, or m' }),
});

// Keep the gateway-compatible sign policy in the runtime fields: delay and
// loop accept integer zero (and legacy integer values generally), while
// statusLast and eventSequence retain their existing positive-only schemas.
export const DurationValueSchema = z
  .number({ invalid_type_error: 'duration value must be a finite number' })
  .finite('duration value must be finite')
  .int('duration value must be an integer');

const DURATION_MULTIPLIERS: Readonly<Record<DurationUnit, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
};

// Decimal/exponent syntax covers every finite integer that JavaScript may
// serialize with String(number), including very large values such as 1e+21.
// This keeps export -> shortcut replay lossless across the schema's full
// gateway-compatible integer domain.
const DURATION_LITERAL = /^(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)(ms|s|m)$/;

export type DurationRange = 'integer' | 'positive';

export interface ParsedDuration {
  unit: DurationUnit;
  value: number;
  milliseconds: number;
}

export function isDurationUnit(value: unknown): value is DurationUnit {
  return value === 'ms' || value === 's' || value === 'm';
}

export function durationToMilliseconds(value: number, unit: DurationUnit): number {
  return value * DURATION_MULTIPLIERS[unit];
}

export function parseDurationLiteral(raw: string, range: DurationRange): ParsedDuration | null {
  const match = DURATION_LITERAL.exec(raw.trim());
  if (match === null) return null;
  const value = Number(match[1]);
  const unit = match[2] as DurationUnit;
  const milliseconds = durationToMilliseconds(value, unit);
  if (
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    !Number.isFinite(milliseconds) ||
    !Number.isInteger(milliseconds) ||
    (range === 'positive' && value < 1)
  ) {
    return null;
  }
  return { unit, value, milliseconds };
}

export function refineDurationConsistency(
  cfg: { unit: DurationUnit; value: number },
  runtimeField: 'timeout' | 'interval',
  runtimeMilliseconds: number,
  ctx: z.RefinementCtx,
): void {
  const expectedMilliseconds = durationToMilliseconds(cfg.value, cfg.unit);
  if (runtimeMilliseconds === expectedMilliseconds) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ['props', runtimeField],
    message: `duration mismatch: cfg.value/unit ${cfg.value}${cfg.unit} converts to ${expectedMilliseconds}ms, but props.${runtimeField} is ${runtimeMilliseconds}ms`,
  });
}
