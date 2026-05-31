export interface CmdTagged {
  __xggCmd?: string;
}

/**
 * cmdPath convention: single-noun top-level commands use the bare noun
 * (`login`, `dump`, `api`); subcommand groups use `noun.verb` with kebab-case
 * verb (`rule.set`, `variable.set-value`). lookupHint() in errors.ts matches
 * against these literal strings, so future commands must follow the same form
 * for HintRule entries to take effect.
 *
 * Mutates the thrown Error in place (sets `__xggCmd`). Outer wrap wins when
 * nested.
 */
export function wrap<TArgs extends unknown[]>(
  cmdPath: string,
  fn: (...args: TArgs) => Promise<void>,
): (...args: TArgs) => Promise<void> {
  return async (...args: TArgs) => {
    try {
      await fn(...args);
    } catch (e) {
      if (e instanceof Error) {
        (e as Error & CmdTagged).__xggCmd = cmdPath;
      }
      throw e;
    }
  };
}
