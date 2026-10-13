// SPDX-License-Identifier: GPL-3.0-or-later
/** Prefer argv for process APIs; nextAction is an equivalent POSIX-shell-safe representation. */
export function renderNextCommand(argv: string[]) {
  const quote = (value: string) =>
    value.length > 0 && !/[^a-zA-Z0-9_./:-]/.test(value)
      ? value
      : `'${value.replaceAll("'", "'\\''")}'`;
  return { nextCommand: { argv }, nextAction: argv.map(quote).join(' ') };
}
