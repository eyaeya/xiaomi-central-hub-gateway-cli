import { z } from 'zod';

export const CANONICAL_DURATION_UNITS = ['ms', 's', 'min', 'hour'] as const;
export type CanonicalDurationUnit = (typeof CANONICAL_DURATION_UNITS)[number];

// `m` was emitted by older xgg releases. Keep accepting it when reading an
// existing graph, but never return it from the shortcut parser: newly
// synthesized nodes always use the Bundle's canonical `min` spelling.
export const DURATION_UNITS = ['ms', 's', 'min', 'hour', 'm'] as const;
export type DurationUnit = (typeof DURATION_UNITS)[number];

export const DurationUnitSchema = z.enum(DURATION_UNITS, {
  errorMap: () => ({
    message: 'duration unit must be one of ms, s, min, or hour (legacy m is also accepted)',
  }),
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
  min: 60_000,
  hour: 3_600_000,
  m: 60_000,
};

// Decimal/exponent syntax covers every finite integer that JavaScript may
// serialize with String(number), including very large values such as 1e+21.
// This keeps export -> shortcut replay lossless across the schema's full
// gateway-compatible integer domain.
const DURATION_LITERAL = /^(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)(ms|s|min|hour|m|h)$/;

export type DurationRange = 'integer' | 'positive';

export interface ParsedDuration {
  unit: CanonicalDurationUnit;
  value: number;
  milliseconds: number;
}

export function isDurationUnit(value: unknown): value is DurationUnit {
  return value === 'ms' || value === 's' || value === 'min' || value === 'hour' || value === 'm';
}

export function durationToMilliseconds(value: number, unit: DurationUnit): number {
  return value * DURATION_MULTIPLIERS[unit];
}

export function parseDurationLiteral(raw: string, range: DurationRange): ParsedDuration | null {
  const match = DURATION_LITERAL.exec(raw.trim());
  if (match === null) return null;
  const value = Number(match[1]);
  const literalUnit = match[2] as CanonicalDurationUnit | 'm' | 'h';
  const unit: CanonicalDurationUnit =
    literalUnit === 'm' ? 'min' : literalUnit === 'h' ? 'hour' : literalUnit;
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
