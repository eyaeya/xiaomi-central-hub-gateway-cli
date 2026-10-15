import {
  ConfigError,
  type LightingFormulaOptions,
  generateLightingFormula,
} from '@eyaeya/xgg-core';
import { Command } from 'commander';
import { wrap } from '../action-wrap.js';
import { emit } from '../output.js';

interface FormulaCliOptions {
  latitude: string;
  min: string;
  max: string;
  speed?: string;
  smoothness?: string;
  offsetMinutes?: string;
  invert?: boolean;
  date?: string;
  sampleMinutes?: string;
  expressionOnly?: boolean;
  pretty?: boolean;
}

function decimal(value: string, flag: string): number {
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value) || !Number.isFinite(Number(value))) {
    throw new ConfigError(
      `${flag} must be a finite decimal number without units or exponent notation.`,
    );
  }
  return Number(value);
}

function renderPretty(result: ReturnType<typeof generateLightingFormula>): void {
  const unit = result.unit === 'kelvin' ? 'K' : '%';
  const lines = [
    `Dynamic lighting formula: ${result.mode}`,
    `Latitude: ${result.parameters.latitude} degrees`,
    `Range: ${result.parameters.min}–${result.parameters.max} ${unit}`,
    `Recommended update interval: ${result.recommendedIntervalSeconds} seconds`,
    `Source: ${result.sourceUrl}`,
    '',
    'Expression:',
    result.expression,
  ];
  if (result.warnings.length > 0) {
    lines.push('', 'Warnings:', ...result.warnings.map((warning) => `- ${warning}`));
  }
  if (result.preview) {
    lines.push(
      '',
      `Preview: ${result.preview.date} (local wall clock; ${result.preview.solarDayState})`,
      `Sampled range: ${result.preview.minimum}–${result.preview.maximum} ${unit}`,
      `Time\tValue (${unit})`,
      ...result.preview.samples.map((sample) => `${sample.time}\t${sample.value}`),
    );
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

export function lightCommand(): Command {
  const light = new Command('light').description('Offline dynamic lighting calculations');
  light
    .command('formula')
    .description(
      'Generate a gateway expression and optional daily preview without network or device access',
    )
    .argument('<mode>', 'temperature, brightness, or brightness-beta')
    .allowExcessArguments(false)
    .requiredOption('--latitude <degrees>', 'latitude from -75 to 75; decimal degrees')
    .requiredOption('--min <value>', 'integer lower bound: 2000–8000 K or 0–100 percent')
    .requiredOption('--max <value>', 'integer upper bound greater than --min')
    .option('--speed <number>', 'beta only: transition speed, 0.1–20 (default 0.3)')
    .option(
      '--smoothness <number>',
      'beta only: shape multiplier, 0.1–5 (default 0.9); larger is steeper',
    )
    .option(
      '--offset-minutes <minutes>',
      'beta only: -180 to 180 (default 0); positive shifts earlier',
    )
    .option('--invert', 'beta only: invert the day/night brightness curve')
    .option(
      '--date <YYYY-MM-DD>',
      'preview an explicit calendar date using local wall-clock samples',
    )
    .option(
      '--sample-minutes <minutes>',
      'preview spacing: integer divisor of 1440 (default 30); requires --date',
    )
    .option('--expression-only', 'emit only the expression and newline; conflicts with --pretty')
    .option(
      '--pretty',
      'human-readable formula, warnings, and preview; conflicts with --expression-only',
    )
    .addHelpText(
      'after',
      `
Examples:
  $ xgg light formula temperature --latitude 23.129 --min 3200 --max 5400
  $ xgg light formula brightness --latitude 23.129 --min 10 --max 100 --expression-only
  $ xgg light formula brightness-beta --latitude 23.129 --min 10 --max 100 --speed 0.3 --smoothness 0.9 --offset-minutes 30 --date 2026-10-15 --pretty

Output defaults to JSON. All numeric options require decimal numbers without units.
This command is entirely local: no login, network, automatic update, device write,
rule creation, or snapshot. It does not apply or enable an automation.
The curve approximates daylight around fixed local-clock noon; it is not an
astronomical sunrise/sunset calculation. Brightness output is percent, not an
arbitrary device's raw value. Check the device property range and step before use.
Use the expression with varSetNumber --expr and an explicit repeating trigger.
`,
    )
    .action(
      wrap('light.formula', async (mode: string, opts: FormulaCliOptions) => {
        if (opts.expressionOnly && opts.pretty) {
          throw new ConfigError('--expression-only and --pretty are mutually exclusive.');
        }
        const options: LightingFormulaOptions = {
          mode: mode as LightingFormulaOptions['mode'],
          latitude: decimal(opts.latitude, '--latitude'),
          min: decimal(opts.min, '--min'),
          max: decimal(opts.max, '--max'),
          ...(opts.speed !== undefined ? { speed: decimal(opts.speed, '--speed') } : {}),
          ...(opts.smoothness !== undefined
            ? { smoothness: decimal(opts.smoothness, '--smoothness') }
            : {}),
          ...(opts.offsetMinutes !== undefined
            ? { offsetMinutes: decimal(opts.offsetMinutes, '--offset-minutes') }
            : {}),
          ...(opts.invert !== undefined ? { invert: opts.invert } : {}),
          ...(opts.date !== undefined ? { date: opts.date } : {}),
          ...(opts.sampleMinutes !== undefined
            ? { sampleMinutes: decimal(opts.sampleMinutes, '--sample-minutes') }
            : {}),
        };
        const result = generateLightingFormula(options);
        if (opts.expressionOnly) process.stdout.write(`${result.expression}\n`);
        else if (opts.pretty) renderPretty(result);
        else emit({ ok: true, ...result }, { pretty: false });
      }),
    );
  return light;
}
