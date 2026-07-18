import { ConfigError, createStore } from '@eyaeya/xgg-core';
import { parsePositiveTimerMs } from '../../local-input.js';

export interface RuleOpts {
  baseUrl?: string;
  sessionFile?: string;
  timeout: string;
  pretty?: boolean;
}

export function makeDeps(opts: RuleOpts) {
  const baseUrl = opts.baseUrl ?? process.env.XGG_BASE_URL;
  if (!baseUrl) throw new ConfigError('missing --base-url or XGG_BASE_URL');
  const timeoutMs = parsePositiveTimerMs(opts.timeout, '--timeout');
  const store = createStore(opts.sessionFile ? { sessionFile: opts.sessionFile } : {});
  return { baseUrl, store, timeoutMs };
}
