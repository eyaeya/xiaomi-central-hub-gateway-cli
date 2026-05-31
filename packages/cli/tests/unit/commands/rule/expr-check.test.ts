import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ruleCommand } from '../../../../src/commands/rule/index.js';

// expr-check is a pure local command (no gateway). We can drive it end-to-end
// through commander's parseAsync, capture stdout, and assert the JSON payload +
// process.exitCode (0 valid / 2 invalid).
async function runExprCheck(...argv: string[]): Promise<{ out: string; exitCode: number }> {
  const cmd = ruleCommand();
  cmd.exitOverride(); // throw instead of process.exit on commander errors
  let out = '';
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  process.exitCode = 0;
  try {
    await cmd.parseAsync(['expr-check', ...argv], { from: 'user' });
  } finally {
    writeSpy.mockRestore();
  }
  const exitCode = typeof process.exitCode === 'number' ? process.exitCode : 0;
  return { out, exitCode };
}

describe('rule expr-check (command wiring)', () => {
  it('is registered as a subcommand', () => {
    const cmd = ruleCommand();
    const sub = cmd.commands.find((c) => c.name() === 'expr-check');
    expect(sub).toBeDefined();
    expect(sub?.description()).toContain('expression');
  });
});

describe('rule expr-check (behavior)', () => {
  beforeEach(() => {
    process.exitCode = 0;
  });
  afterEach(() => {
    process.exitCode = 0;
    vi.restoreAllMocks();
  });

  it('accepts a valid expression with exit 0 and ok:true JSON', async () => {
    const { out, exitCode } = await runExprCheck('$global.count + 1');
    const payload = JSON.parse(out.trim());
    expect(payload.ok).toBe(true);
    expect(payload.template).toBe('$ + 1');
    expect(exitCode).toBe(0);
  });

  it('rejects an unknown function with exit 2 and kind:function', async () => {
    const { out, exitCode } = await runExprCheck('flor($x)');
    const payload = JSON.parse(out.trim());
    expect(payload.ok).toBe(false);
    expect(payload.kind).toBe('function');
    expect(payload.message).toBeTruthy();
    expect(payload.template).toBe('flor($)');
    expect(exitCode).toBe(2);
  });

  it('rejects unbalanced parens with kind:bracket', async () => {
    const { out, exitCode } = await runExprCheck('abs($x');
    const payload = JSON.parse(out.trim());
    expect(payload.ok).toBe(false);
    expect(payload.kind).toBe('bracket');
    expect(exitCode).toBe(2);
  });

  it('--pretty prints a human-readable line for a valid expression', async () => {
    const { out, exitCode } = await runExprCheck('round($x / 655.35)', '--pretty');
    expect(out).toContain('✓ 合法');
    expect(out).toContain('round($ / 655.35)');
    expect(exitCode).toBe(0);
  });
});
