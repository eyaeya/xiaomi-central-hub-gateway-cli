import { ConfigError } from '../transport/errors.js';
import { checkVarSetNumberExprString } from './var-expr-check.js';

export type LightingFormulaMode = 'temperature' | 'brightness';

export interface LightingFormulaOptions {
  mode: LightingFormulaMode;
  latitude: number;
  min: number;
  max: number;
  speed?: number;
  offsetMinutes?: number;
  invert?: boolean;
  date?: string;
  sampleMinutes?: number;
}

export interface LightingFormulaParameters {
  latitude: number;
  min: number;
  max: number;
  speed?: number;
  offsetMinutes?: number;
  invert?: boolean;
}

export interface LightingFormulaPreview {
  date: string;
  samples: { time: string; value: number }[];
  /** Minimum and maximum of the requested samples, not continuous extrema. */
  minimum: number;
  maximum: number;
  solarDayState: 'normal' | 'polar-day' | 'polar-night';
  /** Approximate model crossings in seconds since local midnight. */
  approximateSunrise: number | null;
  approximateSunset: number | null;
}

export interface LightingFormulaResult {
  mode: LightingFormulaMode;
  unit: 'kelvin' | 'percent';
  parameters: LightingFormulaParameters;
  expression: string;
  recommendedIntervalSeconds: 30;
  warnings: string[];
  sourceUrl: string;
  preview?: LightingFormulaPreview;
}

const MODES = ['temperature', 'brightness'];
const BRIGHTNESS_OPTIONS = ['speed', 'offsetMinutes', 'invert'] as const;
const OPTION_KEYS = new Set([
  'mode',
  'latitude',
  'min',
  'max',
  ...BRIGHTNESS_OPTIONS,
  'date',
  'sampleMinutes',
]);

function boundedNumber(value: number, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be a finite number in [${min}, ${max}]`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function parseCalendarDate(date: string): { month: number; day: number } {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ConfigError('date must be a valid YYYY-MM-DD calendar date');
  }
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthLength = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (year < 1 || monthLength === undefined || day < 1 || day > monthLength) {
    throw new ConfigError('date must be a valid YYYY-MM-DD calendar date');
  }
  return { month, day };
}

// Explicit subtraction avoids the gateway checker's unary-negative edge cases.
function literal(value: number): string {
  return value < 0 ? `(0-${-value})` : String(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function buildExpression(p: LightingFormulaParameters): string {
  const declination = '23.44*sin(2*pi()/365*(month()*30+date()-81))*pi()/180';
  const angle = `(0-tan(${literal(p.latitude)}*pi()/180)*tan(${declination}))`;
  const halfDay = `(acos(max((0-1),min(1,${angle})))*43200/pi())`;
  const denominator = `max(1,min(${halfDay},43200-${halfDay}))`;
  const slope =
    p.speed === undefined ? `(4.5/${denominator})` : `(4.5*${literal(p.speed)}/${denominator})`;
  const offset = p.offsetMinutes === undefined ? '' : `+${literal(p.offsetMinutes * 60)}`;
  const time = `(hours()*3600+minutes()*60+seconds()-43200${offset})`;
  const exponent = `max((0-60),min(60,${slope}*(abs(${time})-${halfDay})))`;
  const dayWeight = `(1/(1+pow(e(),${exponent})))`;
  const weight = p.invert ? `(1-${dayWeight})` : dayWeight;
  return `max(${p.min},min(${p.max},floor(${p.min}+${p.max - p.min}*${weight})))`;
}

function previewFormula(
  p: LightingFormulaParameters,
  date: string,
  month: number,
  day: number,
  sampleMinutes: number,
): LightingFormulaPreview {
  const declination = 23.44 * Math.sin(((2 * Math.PI) / 365) * (month * 30 + day - 81));
  const angle = -Math.tan((p.latitude * Math.PI) / 180) * Math.tan((declination * Math.PI) / 180);
  const halfDay = (Math.acos(clamp(angle, -1, 1)) * 43200) / Math.PI;
  const denominator = Math.max(1, Math.min(halfDay, 43200 - halfDay));
  const slope = (4.5 * (p.speed ?? 1)) / denominator;
  const samples: LightingFormulaPreview['samples'] = [];
  for (let minute = 0; minute < 1440; minute += sampleMinutes) {
    const time = minute * 60 - 43200 + (p.offsetMinutes ?? 0) * 60;
    const exponent = clamp(slope * (Math.abs(time) - halfDay), -60, 60);
    const dayWeight = 1 / (1 + Math.E ** exponent);
    const weight = p.invert ? 1 - dayWeight : dayWeight;
    const value = clamp(Math.floor(p.min + (p.max - p.min) * weight), p.min, p.max);
    samples.push({
      time: `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`,
      value,
    });
  }
  const solarDayState = angle <= -1 ? 'polar-day' : angle >= 1 ? 'polar-night' : 'normal';
  return {
    date,
    samples,
    minimum: Math.min(...samples.map((sample) => sample.value)),
    maximum: Math.max(...samples.map((sample) => sample.value)),
    solarDayState,
    approximateSunrise: solarDayState === 'normal' ? 43200 - halfDay : null,
    approximateSunset: solarDayState === 'normal' ? 43200 + halfDay : null,
  };
}

/**
 * Generate an offline gateway expression from the MIoT Geek mathematical model.
 * No authorization, network, filesystem, device mutation or arbitrary evaluation.
 * The month*30+day calendar and fixed noon are intentional source approximations.
 */
export function generateLightingFormula(options: LightingFormulaOptions): LightingFormulaResult {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new ConfigError('Lighting formula options must be an object');
  }
  for (const key of Object.keys(options)) {
    if (key === 'smoothness') {
      throw new ConfigError('smoothness is no longer supported; use brightness speed (default 1)');
    }
    if (!OPTION_KEYS.has(key)) throw new ConfigError(`Unsupported lighting formula option: ${key}`);
  }
  if (!MODES.includes(options.mode)) {
    throw new ConfigError('mode must be temperature or brightness; brightness-beta was removed');
  }
  if (options.mode !== 'brightness') {
    for (const key of BRIGHTNESS_OPTIONS) {
      if (options[key] !== undefined) throw new ConfigError(`${key} requires brightness mode`);
    }
  }
  const isTemperature = options.mode === 'temperature';
  const lower = isTemperature ? 2000 : 0;
  const upper = isTemperature ? 8000 : 100;
  const parameters: LightingFormulaParameters = {
    latitude: boundedNumber(options.latitude, 'latitude', -75, 75),
    min: boundedNumber(options.min, 'min', lower, upper),
    max: boundedNumber(options.max, 'max', lower, upper),
  };
  if (!Number.isInteger(parameters.min) || !Number.isInteger(parameters.max)) {
    throw new ConfigError('min and max must be integers');
  }
  if (parameters.min >= parameters.max) throw new ConfigError('min must be less than max');
  if (options.mode === 'brightness') {
    parameters.speed = boundedNumber(
      options.speed === undefined ? 1 : options.speed,
      'speed',
      0.1,
      20,
    );
    parameters.offsetMinutes = boundedNumber(
      options.offsetMinutes === undefined ? 0 : options.offsetMinutes,
      'offsetMinutes',
      -180,
      180,
    );
    if (options.invert !== undefined && typeof options.invert !== 'boolean') {
      throw new ConfigError('invert must be a boolean');
    }
    parameters.invert = options.invert ?? false;
  }
  if (options.sampleMinutes !== undefined && options.date === undefined) {
    throw new ConfigError('sampleMinutes requires date');
  }
  const sampleMinutes = boundedNumber(
    options.sampleMinutes === undefined ? 30 : options.sampleMinutes,
    'sampleMinutes',
    1,
    1440,
  );
  if (!Number.isInteger(sampleMinutes) || 1440 % sampleMinutes !== 0) {
    throw new ConfigError('sampleMinutes must be an integer divisor of 1440');
  }
  const calendar = options.date === undefined ? undefined : parseCalendarDate(options.date);
  const expression = buildExpression(parameters);
  const checked = checkVarSetNumberExprString(expression);
  if (!checked.ok) {
    throw new ConfigError('Generated lighting formula failed gateway expression validation', {
      kind: checked.kind,
    });
  }
  const warnings = [
    'Approximate model: month()*30+date(), fixed local-clock noon, no longitude or timezone correction; not astronomical sunrise/sunset.',
    'Noon and polar boundaries are numerically bounded; polar behavior is an extension of the source model, not verified astronomy.',
    'Integer output uses floor and may not reach the requested maximum. Check the actual device range, step and unit before applying.',
  ];
  if (options.mode === 'brightness') {
    warnings.push(
      'Speed is a dimensionless transition multiplier: 1 preserves the standard curve, smaller is gentler and larger is steeper; it is not a duration. Positive offset advances the curve; offsets do not wrap across midnight.',
    );
  }
  const result: LightingFormulaResult = {
    mode: options.mode,
    unit: isTemperature ? 'kelvin' : 'percent',
    parameters,
    expression,
    recommendedIntervalSeconds: 30,
    warnings,
    sourceUrl: 'https://lzj.ac.cn/tools/iot/miot-geek',
  };
  if (calendar !== undefined && options.date !== undefined) {
    result.preview = previewFormula(
      parameters,
      options.date,
      calendar.month,
      calendar.day,
      sampleMinutes,
    );
  }
  return result;
}
