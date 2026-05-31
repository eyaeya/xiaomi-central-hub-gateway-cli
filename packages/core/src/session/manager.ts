import { homedir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from './store.js';

export interface SessionManagerOptions {
  sessionFile?: string;
}

export function defaultSessionPath(): string {
  return process.env.XGG_SESSION_FILE ?? join(homedir(), '.xgg', 'session.json');
}

export function createStore(opts: SessionManagerOptions = {}): SessionStore {
  return new SessionStore({
    path: opts.sessionFile ?? defaultSessionPath(),
  });
}
