import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { SessionFile, StoredSession } from '../schemas/session.js';
import { AuthRequiredError } from '../transport/errors.js';

export interface SessionStoreOptions {
  path: string;
}

/**
 * Per-host session persistence backed by a single JSON file (mode 0600).
 *
 * The on-disk layout is `{ version: 2, sessions: { [host]: StoredSession } }`,
 * holding the per-host agent endpoint (pid + socketPath) — never the passcode,
 * which is single-use on the gateway side. Reading a v1 file (the M2 shape that
 * stored a passcode) deletes it and raises `AuthRequiredError` so the CLI can
 * prompt the user to `xgg login` again.
 */
export class SessionStore {
  private readonly path: string;

  constructor(opts: SessionStoreOptions) {
    this.path = opts.path;
  }

  async write(session: StoredSession): Promise<void> {
    StoredSession.parse(session);
    let file: SessionFile;
    try {
      file = await this.readFile();
    } catch (e) {
      // F47 (2026-05-30) — narrow the swallow window. ENOENT (file
      // doesn't exist yet) and AuthRequiredError (v1 legacy file just
      // deleted by readFile) are the canonical "start fresh" signals.
      // Anything else (corrupt JSON, EACCES, ZodError on a different
      // host's entry) was previously masked by the catch-all — the
      // previous behavior reset the file and wrote OUR session,
      // destroying every other host's stored entry. Surface the
      // failure so the user can decide whether to discard.
      if (!isMissingFile(e) && !(e instanceof AuthRequiredError)) throw e;
      file = { version: 2, sessions: {} };
    }
    file.sessions[session.host] = session;
    await fs.mkdir(dirname(this.path), { recursive: true });
    await fs.writeFile(this.path, JSON.stringify(file, null, 2), { mode: 0o600 });
    await fs.chmod(this.path, 0o600);
  }

  async read(host: string): Promise<StoredSession> {
    let file: SessionFile;
    try {
      file = await this.readFile();
    } catch (e) {
      if (e instanceof AuthRequiredError) throw e;
      throw new AuthRequiredError(`No session file at ${this.path}`);
    }
    const entry = file.sessions[host];
    if (!entry) {
      throw new AuthRequiredError(`No session for host ${host}`);
    }
    return entry;
  }

  /**
   * Return all host keys currently stored in the session file.
   * Returns `[]` when the file is missing, empty, or a legacy v1 file
   * (which is deleted as a side-effect of readFile).
   */
  async hosts(): Promise<string[]> {
    let file: SessionFile;
    try {
      file = await this.readFile();
    } catch (e) {
      // F47 (2026-05-30) — see write() for the narrowing rationale.
      // ENOENT + AuthRequiredError mean "no usable session file"; any
      // other error (corruption, EACCES, schema parse failure) deserves
      // to surface so errorToExit can produce the right SCHEMA exit.
      if (!isMissingFile(e) && !(e instanceof AuthRequiredError)) throw e;
      return [];
    }
    return Object.keys(file.sessions);
  }

  async delete(host: string): Promise<void> {
    let file: SessionFile;
    try {
      file = await this.readFile();
    } catch (e) {
      // F47 (2026-05-30) — same shape as hosts()/write(): ENOENT and
      // v1-legacy (AuthRequiredError) are best-effort no-ops, everything
      // else surfaces. Logout's auto-resolve relies on this distinction
      // — silent corruption used to make `xgg logout` report success
      // while leaving a stale entry intact.
      if (!isMissingFile(e) && !(e instanceof AuthRequiredError)) throw e;
      return;
    }
    delete file.sessions[host];
    await fs.writeFile(this.path, JSON.stringify(file, null, 2), { mode: 0o600 });
    await fs.chmod(this.path, 0o600);
  }

  private async readFile(): Promise<SessionFile> {
    const raw = await fs.readFile(this.path, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'version' in parsed &&
      (parsed as { version: unknown }).version !== 2
    ) {
      await fs.unlink(this.path).catch(() => {});
      throw new AuthRequiredError('legacy v1 session file detected; agent endpoint not available', {
        hint: 'Run `xgg login --code <CODE>` to start an agent for this gateway.',
      });
    }
    return SessionFile.parse(parsed);
  }
}

/** True when the error is a Node.js fs ENOENT (file/dir missing). */
function isMissingFile(e: unknown): boolean {
  return (
    typeof e === 'object' && e !== null && 'code' in e && (e as { code: unknown }).code === 'ENOENT'
  );
}
