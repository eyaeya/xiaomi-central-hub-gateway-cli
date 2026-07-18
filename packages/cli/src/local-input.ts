import { readFile } from 'node:fs/promises';
import { ConfigError } from '@eyaeya/xgg-core';

export const MAX_TIMER_MS = 2_147_483_647;

/** Parse a timer option without accepting Number() aliases such as hex or exponent notation. */
export function parsePositiveTimerMs(raw: string, flag: string): number {
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new ConfigError(
      `${flag} must be a positive decimal integer no greater than ${MAX_TIMER_MS}`,
      { flag },
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > MAX_TIMER_MS) {
    throw new ConfigError(
      `${flag} must be a positive decimal integer no greater than ${MAX_TIMER_MS}`,
      { flag },
    );
  }
  return value;
}

/** Parse caller-provided JSON without copying its potentially sensitive contents into errors. */
export function parseJsonInput<T = unknown>(raw: string, source: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new ConfigError(`${source} must contain valid JSON`, { source });
  }
}

/** Read and parse a JSON file while preserving only path/code metadata in public errors. */
export async function readJsonInput<T = unknown>(path: string, flag: string): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new ConfigError(`unable to read JSON file for ${flag}: ${path}`, {
      flag,
      path,
      ...(code !== undefined && { fsCode: code }),
    });
  }
  return parseJsonInput<T>(raw, `${flag} file ${path}`);
}
