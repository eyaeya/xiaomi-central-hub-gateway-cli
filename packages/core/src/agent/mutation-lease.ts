import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { ConfigError, NetworkError } from '../transport/errors.js';
import { canonicalGatewayKey } from './ipc-path.js';

export interface MutationLeaseStatus {
  active: boolean;
  fenced: boolean;
  operation: string | null;
  acquiredAt: string | null;
}

export interface MutationLeaseCoordinator {
  acquire(connectionId: string, operation: string, waitTimeoutMs: number): Promise<string>;
  /** Block new mutations and wait for a live holder (or a fence) before logout. */
  prepareShutdown(connectionId: string, waitTimeoutMs: number): Promise<void>;
  /** Authorize daemon self-stop only for the connection that prepared shutdown. */
  commitShutdown(connectionId: string): void;
  enter(connectionId: string, leaseId: string | undefined, write: boolean): Promise<() => void>;
  release(connectionId: string, leaseId: string): Promise<void>;
  fence(connectionId: string, leaseId: string | undefined, reason: string): void;
  connectionClosed(connectionId: string): void;
  /** Freeze ownership while the IPC listener and gateway transport stop. */
  beginDaemonShutdown(): void;
  status(): MutationLeaseStatus;
  close(): Promise<void>;
}

interface ActiveLease {
  connectionId: string;
  leaseId: string;
  operation: string;
  acquiredAt: string;
  inFlight: number;
  inFlightWrites: number;
  wrote: boolean;
  releaseRequested: boolean;
  connectionClosed: boolean;
  fenced: boolean;
  fileToken?: string;
}

interface Waiter {
  connectionId: string;
  operation: string;
  deadline: number;
  resolve: (leaseId: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ShutdownWaiter {
  connectionId: string;
  deadline: number;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface LeaseBackend {
  acquire(
    deadline: number,
    options?: { allowPersistentFence?: boolean },
  ): Promise<string | undefined>;
  markWriteStarted(token: string | undefined): Promise<void>;
  release(token: string | undefined, options?: { clearPersistentFence?: boolean }): Promise<void>;
  clearPersistentFences(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Connection-bound workflow lease. The coordinator serialises whole mutation
 * workflows, not individual RPCs, so read/modify/write sequences cannot
 * interleave. A failed/ambiguous write fences the lease until daemon shutdown.
 */
class Coordinator implements MutationLeaseCoordinator {
  private active: ActiveLease | undefined;
  private readonly closedConnections = new Set<string>();
  private readonly waiters: Waiter[] = [];
  private readonly shutdownWaiters: ShutdownWaiter[] = [];
  private shutdownOwner: string | undefined;
  private shutdownCommitted = false;
  private shutdownFileToken: string | undefined;
  private shutdownPumping = false;
  private pumping = false;
  private readonly pendingWriteMarks = new Set<Promise<void>>();
  private daemonStopping = false;
  private clearPersistentFencesOnClose = false;
  private closed = false;

  constructor(private readonly backend: LeaseBackend) {}

  acquire(connectionId: string, operation: string, waitTimeoutMs: number): Promise<string> {
    if (this.closed || this.daemonStopping)
      return Promise.reject(new NetworkError('mutation lease coordinator is closed'));
    if (!Number.isSafeInteger(waitTimeoutMs) || waitTimeoutMs <= 0) {
      return Promise.reject(
        new ConfigError('mutation lease wait timeout must be a positive integer'),
      );
    }
    if (this.active?.connectionId === connectionId) {
      return Promise.reject(new ConfigError('this IPC connection already owns a mutation lease'));
    }
    if (this.closedConnections.has(connectionId)) {
      return Promise.reject(new NetworkError('IPC connection is already closed'));
    }
    if (this.shutdownOwner || this.shutdownPumping || this.shutdownWaiters.length > 0) {
      return Promise.reject(new NetworkError('agent shutdown is waiting for mutation workflows'));
    }
    const deadline = Date.now() + waitTimeoutMs;
    return new Promise<string>((resolve, reject) => {
      const waiter: Waiter = {
        connectionId,
        operation,
        deadline,
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index < 0) return;
          this.waiters.splice(index, 1);
          reject(waitTimeoutError(operation));
        }, waitTimeoutMs),
      };
      this.waiters.push(waiter);
      void this.pump();
    });
  }

  prepareShutdown(connectionId: string, waitTimeoutMs: number): Promise<void> {
    if (this.closed || this.daemonStopping)
      return Promise.reject(new NetworkError('mutation lease coordinator is closed'));
    if (!Number.isSafeInteger(waitTimeoutMs) || waitTimeoutMs <= 0) {
      return Promise.reject(new ConfigError('shutdown wait timeout must be a positive integer'));
    }
    if (this.closedConnections.has(connectionId)) {
      return Promise.reject(new NetworkError('IPC connection is already closed'));
    }
    if (this.shutdownOwner === connectionId) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const waiter: ShutdownWaiter = {
        connectionId,
        deadline: Date.now() + waitTimeoutMs,
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.shutdownWaiters.indexOf(waiter);
          if (index < 0) return;
          this.shutdownWaiters.splice(index, 1);
          reject(new NetworkError('timed out waiting to prepare agent shutdown'));
          if (this.shutdownWaiters.length === 0 && !this.shutdownOwner) void this.pump();
        }, waitTimeoutMs),
      };
      this.shutdownWaiters.push(waiter);
      this.pumpShutdown();
    });
  }

  commitShutdown(connectionId: string): void {
    if (this.closed || this.daemonStopping) {
      throw new NetworkError('mutation lease coordinator is closed');
    }
    if (this.shutdownOwner !== connectionId) {
      throw new ConfigError('daemon shutdown was not prepared by this IPC connection');
    }
    this.shutdownCommitted = true;
  }

  async enter(
    connectionId: string,
    leaseId: string | undefined,
    write: boolean,
  ): Promise<() => void> {
    if (this.daemonStopping || this.closed) {
      throw new NetworkError('mutation lease coordinator is closed');
    }
    const active = this.active;
    if (!leaseId || !active || active.connectionId !== connectionId || active.leaseId !== leaseId) {
      if (write) {
        throw new ConfigError('gateway mutation requires an active mutation workflow lease', {
          hint: 'use withMutationWorkflow() or a mutation-capable xgg CLI command',
        });
      }
      if (leaseId) throw new ConfigError('mutation workflow lease is not owned by this connection');
      return () => {};
    }
    if (active.releaseRequested) {
      throw new ConfigError('mutation workflow lease is already being released');
    }
    if (active.fenced) {
      throw new NotUsableLeaseError(active.operation);
    }
    active.inFlight += 1;
    if (write) {
      active.inFlightWrites += 1;
      active.wrote = true;
      const pendingMark = this.backend.markWriteStarted(active.fileToken);
      this.pendingWriteMarks.add(pendingMark);
      try {
        // Persist ambiguity before the gateway write can be sent. A daemon
        // crash after this point leaves a fail-safe fence for its replacement.
        await pendingMark;
        if (this.closed || this.daemonStopping || this.active !== active) {
          throw new NetworkError('mutation lease coordinator stopped before gateway write');
        }
        if (active.releaseRequested || active.fenced) {
          throw new NotUsableLeaseError(active.operation);
        }
      } catch (error) {
        active.inFlight -= 1;
        active.inFlightWrites -= 1;
        void this.maybeFinish(active);
        throw error;
      } finally {
        this.pendingWriteMarks.delete(pendingMark);
      }
    }
    let exited = false;
    return () => {
      if (exited) return;
      exited = true;
      active.inFlight -= 1;
      if (write) active.inFlightWrites -= 1;
      void this.maybeFinish(active);
    };
  }

  async release(connectionId: string, leaseId: string): Promise<void> {
    const active = this.active;
    if (!active || active.connectionId !== connectionId || active.leaseId !== leaseId) {
      throw new ConfigError('mutation workflow lease is not owned by this connection');
    }
    active.releaseRequested = true;
    // Releasing while a write is still outstanding means its acknowledgement
    // was not observed by the workflow. Preserve the lock as an ambiguity fence.
    if (active.inFlightWrites > 0) {
      active.fenced = true;
      this.pumpShutdown();
    }
    await this.maybeFinish(active);
  }

  fence(connectionId: string, leaseId: string | undefined, _reason: string): void {
    const active = this.active;
    if (!active || !leaseId || active.connectionId !== connectionId || active.leaseId !== leaseId) {
      return;
    }
    active.fenced = true;
    this.pumpShutdown();
  }

  connectionClosed(connectionId: string): void {
    this.closedConnections.add(connectionId);
    const active = this.active;
    if (active?.connectionId === connectionId) {
      active.connectionClosed = true;
      active.releaseRequested = true;
      // Once a workflow has issued a write, an ungraceful disconnect means the
      // client may not have observed the acknowledgement or completed readback.
      if (active.wrote) active.fenced = true;
      if (active.fenced) this.pumpShutdown();
      void this.maybeFinish(active);
    }
    for (let i = this.waiters.length - 1; i >= 0; i -= 1) {
      const waiter = this.waiters[i];
      if (waiter?.connectionId !== connectionId) continue;
      this.waiters.splice(i, 1);
      clearTimeout(waiter.timer);
      waiter.reject(new NetworkError('IPC connection closed while waiting for mutation lease'));
    }
    for (let i = this.shutdownWaiters.length - 1; i >= 0; i -= 1) {
      const waiter = this.shutdownWaiters[i];
      if (waiter?.connectionId !== connectionId) continue;
      this.shutdownWaiters.splice(i, 1);
      clearTimeout(waiter.timer);
      waiter.reject(new NetworkError('IPC connection closed while preparing agent shutdown'));
    }
    if (this.shutdownOwner === connectionId) {
      if (this.daemonStopping || this.shutdownCommitted) return;
      this.shutdownOwner = undefined;
      const token = this.shutdownFileToken;
      this.shutdownFileToken = undefined;
      void (async () => {
        await this.backend.release(token);
        this.pumpShutdown();
        if (!this.shutdownOwner && !this.shutdownPumping && this.shutdownWaiters.length === 0) {
          void this.pump();
        }
      })();
    }
  }

  beginDaemonShutdown(): void {
    if (this.closed || this.daemonStopping) return;
    this.daemonStopping = true;
    // Prepare only reserves ordering. Only a same-connection shutdown commit
    // authorizes durable-fence recovery; idle/WS cleanup racing an abandoned
    // or mismatched prepare must preserve ambiguity for explicit inspection.
    this.clearPersistentFencesOnClose = this.shutdownCommitted && this.shutdownOwner !== undefined;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new NetworkError('mutation lease coordinator is stopping'));
    }
    for (const waiter of this.shutdownWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new NetworkError('mutation lease coordinator is stopping'));
    }
  }

  status(): MutationLeaseStatus {
    return {
      active: this.active !== undefined,
      fenced: this.active?.fenced ?? false,
      operation: this.active?.operation ?? null,
      acquiredAt: this.active?.acquiredAt ?? null,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new NetworkError('mutation lease coordinator closed'));
    }
    for (const waiter of this.shutdownWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new NetworkError('mutation lease coordinator closed'));
    }
    // No new mark can start after `closed = true`. Drain publications that
    // already passed enter() before clearing fences/releasing the ticket, then
    // their post-await recheck prevents the old handler from reaching gateway.
    await Promise.allSettled([...this.pendingWriteMarks]);
    this.shutdownOwner = undefined;
    this.shutdownCommitted = false;
    const shutdownFileToken = this.shutdownFileToken;
    this.shutdownFileToken = undefined;
    const active = this.active;
    this.active = undefined;
    if (this.clearPersistentFencesOnClose) await this.backend.clearPersistentFences();
    if (active) await this.backend.release(active.fileToken);
    await this.backend.release(shutdownFileToken);
    await this.backend.close();
  }

  private async maybeFinish(active: ActiveLease): Promise<void> {
    if (
      this.active !== active ||
      !active.releaseRequested ||
      active.inFlight > 0 ||
      active.fenced ||
      this.daemonStopping
    ) {
      return;
    }
    await this.backend.release(active.fileToken, { clearPersistentFence: true });
    if (this.active !== active) return;
    this.active = undefined;
    this.pumpShutdown();
    if (!this.shutdownOwner && this.shutdownWaiters.length === 0) void this.pump();
  }

  private async pump(): Promise<void> {
    if (
      this.pumping ||
      this.closed ||
      this.daemonStopping ||
      this.active ||
      this.shutdownOwner ||
      this.shutdownPumping ||
      this.shutdownWaiters.length > 0
    ) {
      return;
    }
    this.pumping = true;
    try {
      while (
        !this.closed &&
        !this.daemonStopping &&
        !this.active &&
        this.shutdownWaiters.length === 0 &&
        this.waiters.length > 0
      ) {
        const waiter = this.waiters.shift();
        if (!waiter) break;
        clearTimeout(waiter.timer);
        if (Date.now() >= waiter.deadline) {
          waiter.reject(waitTimeoutError(waiter.operation));
          continue;
        }
        try {
          const fileToken = await this.backend.acquire(waiter.deadline);
          if (
            this.closed ||
            this.daemonStopping ||
            this.closedConnections.has(waiter.connectionId)
          ) {
            await this.backend.release(fileToken);
            waiter.reject(
              new NetworkError(
                this.closed || this.daemonStopping
                  ? 'mutation lease coordinator closed'
                  : 'IPC connection closed while waiting for mutation lease',
              ),
            );
            continue;
          }
          const leaseId = randomUUID();
          this.active = {
            connectionId: waiter.connectionId,
            leaseId,
            operation: waiter.operation,
            acquiredAt: new Date().toISOString(),
            inFlight: 0,
            inFlightWrites: 0,
            wrote: false,
            releaseRequested: false,
            connectionClosed: false,
            fenced: false,
            ...(fileToken !== undefined && { fileToken }),
          };
          waiter.resolve(leaseId);
        } catch (error) {
          waiter.reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
    } finally {
      this.pumping = false;
      if (!this.closed && !this.daemonStopping && this.shutdownWaiters.length > 0) {
        this.pumpShutdown();
      }
      if (
        !this.closed &&
        !this.daemonStopping &&
        !this.active &&
        this.shutdownWaiters.length === 0 &&
        this.waiters.length > 0
      ) {
        void this.pump();
      }
    }
  }

  private pumpShutdown(): void {
    void this.pumpShutdownAsync();
  }

  private async pumpShutdownAsync(): Promise<void> {
    // `FileBackend` represents one coordinator and permits one acquisition at
    // a time. A normal waiter already inside backend.acquire() has queue order;
    // shutdown must wait for it to become the active holder (and then release)
    // instead of starting a second backend acquisition against the same state.
    if (
      this.closed ||
      this.daemonStopping ||
      this.shutdownOwner ||
      this.shutdownPumping ||
      this.pumping
    ) {
      return;
    }
    // A fenced workflow is deliberately unblockable by normal mutations, but
    // logout must remain the explicit recovery path. Otherwise wait for the
    // holder to finish and release normally.
    if (this.active && !this.active.fenced) return;
    while (this.shutdownWaiters.length > 0) {
      const waiter = this.shutdownWaiters.shift();
      if (!waiter) return;
      clearTimeout(waiter.timer);
      if (Date.now() >= waiter.deadline) {
        waiter.reject(new NetworkError('timed out waiting to prepare agent shutdown'));
        continue;
      }
      // A fence already owns the stable file lock. Otherwise acquire it now so
      // a replacement daemon cannot start a mutation between prepare + SIGTERM.
      if (this.active?.fenced) {
        this.shutdownOwner = waiter.connectionId;
        this.shutdownCommitted = false;
        waiter.resolve();
        return;
      }
      this.shutdownPumping = true;
      try {
        const fileToken = await this.backend.acquire(waiter.deadline, {
          allowPersistentFence: true,
        });
        if (this.closed || this.daemonStopping || this.closedConnections.has(waiter.connectionId)) {
          await this.backend.release(fileToken);
          waiter.reject(
            new NetworkError(
              this.closed || this.daemonStopping
                ? 'mutation lease coordinator closed'
                : 'IPC connection closed while preparing agent shutdown',
            ),
          );
          // The shifted waiter is no longer visible to connectionClosed().
          // Continue here so another shutdown waiter (or the normal queue)
          // cannot be stranded until its independent timer fires.
          continue;
        }
        this.shutdownFileToken = fileToken;
        this.shutdownOwner = waiter.connectionId;
        this.shutdownCommitted = false;
        waiter.resolve();
      } catch (error) {
        waiter.reject(error instanceof Error ? error : new Error(String(error)));
      } finally {
        this.shutdownPumping = false;
      }
      if (!this.shutdownOwner) continue;
      return;
    }
    if (!this.shutdownOwner && !this.shutdownPumping) void this.pump();
  }
}

class NotUsableLeaseError extends NetworkError {
  constructor(operation: string) {
    super(`mutation workflow "${operation}" is fenced after an unconfirmed write`, {
      hint: 'run xgg logout, log in again, inspect live state, then retry',
    });
  }
}

class InMemoryBackend implements LeaseBackend {
  async acquire(
    _deadline: number,
    _options?: { allowPersistentFence?: boolean },
  ): Promise<undefined> {
    return undefined;
  }
  async markWriteStarted(_token: string | undefined): Promise<void> {}
  async release(
    _token: string | undefined,
    _options?: { clearPersistentFence?: boolean },
  ): Promise<void> {}
  async clearPersistentFences(): Promise<void> {}
  async close(): Promise<void> {}
}

interface FileTicketOwner {
  version: 3;
  host: string;
  pid: number;
  /** OS-observable process birth identity, used to reject PID reuse. */
  processStartId: string;
  token: string;
  createdAt: string;
}

interface FileTicket {
  owner: FileTicketOwner;
  number: number | undefined;
}

/**
 * Cross-process Lamport bakery lease.
 *
 * Every contender publishes an immutable UUID owner ticket and then a ticket
 * number. Holders are ordered by `(number, token)`. Crash recovery deletes only
 * that immutable UUID's files after verifying PID birth identity; it never
 * renames or removes a shared owner path, so a competing live generation cannot
 * be displaced by a stale observer (the classic three-party reclaim ABA).
 */
class FileBackend implements LeaseBackend {
  private ownedToken: string | undefined;
  private pendingToken: string | undefined;
  private closed = false;
  private readonly ticketsPath: string;
  private readonly ownProcessStartId: Promise<string>;

  constructor(
    private readonly host: string,
    private readonly baseDir: string,
    private readonly retryMs: number,
    private readonly identity: (pid: number) => Promise<string>,
    private readonly afterTicketPublished?: (token: string) => Promise<void>,
    private readonly beforeWriteFencePublished?: (token: string) => Promise<void>,
    private readonly beforeStaleTicketCleanup?: (token: string) => Promise<void>,
  ) {
    const key = canonicalGatewayKey(host);
    const hash = createHash('sha256').update(key).digest('hex').slice(0, 32);
    this.ticketsPath = join(baseDir, `mutation-${hash}.tickets`);
    this.ownProcessStartId = identity(process.pid);
  }

  async acquire(deadline: number, options?: { allowPersistentFence?: boolean }): Promise<string> {
    if (this.closed) throw new NetworkError('mutation lease backend is closed');
    await fs.mkdir(this.baseDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.ticketsPath, { recursive: true, mode: 0o700 });
    const ticketStat = await fs.lstat(this.ticketsPath);
    if (!ticketStat.isDirectory() || ticketStat.isSymbolicLink()) {
      throw new NetworkError('mutation lease ticket path is not a private directory');
    }
    const token = randomUUID();
    this.pendingToken = token;
    try {
      const owner: FileTicketOwner = {
        version: 3,
        host: canonicalGatewayKey(this.host),
        pid: process.pid,
        processStartId: await this.ownProcessStartId,
        token,
        createdAt: new Date().toISOString(),
      };
      await this.publishJson(this.ownerPath(token), owner);
      await this.afterTicketPublished?.(token);
      this.assertOpenBeforeDeadline(deadline);

      const number = await this.chooseTicketNumber(token, deadline);
      await this.publishJson(this.numberPath(token), { version: 1, token, number });

      while (Date.now() < deadline) {
        if (this.closed) throw new NetworkError('mutation lease backend is closed');
        let blocked = false;
        for (const ticket of await this.readTickets()) {
          if (ticket.owner.token === token) continue;
          if (!(await this.isOwnerAlive(ticket.owner))) {
            await this.beforeStaleTicketCleanup?.(ticket.owner.token);
            await this.removeTicketIfOwned(ticket.owner);
            continue;
          }
          if (
            ticket.number === undefined ||
            ticket.number < number ||
            (ticket.number === number && ticket.owner.token < token)
          ) {
            blocked = true;
            break;
          }
        }
        if (!blocked) {
          if (options?.allowPersistentFence !== true && (await this.hasPersistentFences())) {
            throw persistentFenceError();
          }
          this.assertOpenBeforeDeadline(deadline);
          this.pendingToken = undefined;
          this.ownedToken = token;
          return token;
        }
        await delay(Math.min(this.retryMs, Math.max(1, deadline - Date.now())));
      }
      throw waitTimeoutError('gateway mutation');
    } finally {
      if (this.ownedToken !== token) {
        if (this.pendingToken === token) this.pendingToken = undefined;
        await this.removeTicket(token);
      }
    }
  }

  async markWriteStarted(token: string | undefined): Promise<void> {
    if (!token || this.ownedToken !== token) {
      throw new NetworkError('cannot persist a write fence without owning the mutation ticket');
    }
    const path = this.fencePath(token);
    try {
      await this.beforeWriteFencePublished?.(token);
      await this.publishJson(path, {
        version: 1,
        host: canonicalGatewayKey(this.host),
        pid: process.pid,
        processStartId: await this.ownProcessStartId,
        token,
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // Multiple writes in one workflow race only with the same immutable
      // token. Any pre-existing path with a different payload fails closed.
      const parsed = JSON.parse(await fs.readFile(path, 'utf8')) as { token?: unknown };
      if (parsed.token !== token) throw new NetworkError('persistent mutation fence is malformed');
    }
  }

  async release(
    token: string | undefined,
    options?: { clearPersistentFence?: boolean },
  ): Promise<void> {
    if (!token || this.ownedToken !== token) return;
    if (options?.clearPersistentFence === true) await unlinkIfPresent(this.fencePath(token));
    this.ownedToken = undefined;
    await this.removeTicket(token);
  }

  async clearPersistentFences(): Promise<void> {
    let names: string[];
    try {
      names = await fs.readdir(this.ticketsPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    await Promise.all(
      names
        .filter((name) => /^fence-[0-9a-f-]+\.json$/i.test(name))
        .map((name) => unlinkIfPresent(join(this.ticketsPath, name))),
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const tokens = new Set([this.pendingToken, this.ownedToken].filter(isString));
    this.pendingToken = undefined;
    this.ownedToken = undefined;
    await Promise.all([...tokens].map((token) => this.removeTicket(token)));
  }

  private async chooseTicketNumber(token: string, deadline: number): Promise<number> {
    this.assertOpenBeforeDeadline(deadline);
    let maximum = 0;
    for (const ticket of await this.readTickets()) {
      if (ticket.owner.token === token) continue;
      if (!(await this.isOwnerAlive(ticket.owner))) {
        await this.beforeStaleTicketCleanup?.(ticket.owner.token);
        await this.removeTicketIfOwned(ticket.owner);
        continue;
      }
      if (ticket.number !== undefined) maximum = Math.max(maximum, ticket.number);
    }
    if (!Number.isSafeInteger(maximum + 1)) {
      throw new NetworkError('mutation lease ticket counter exhausted');
    }
    return maximum + 1;
  }

  private async readTickets(): Promise<FileTicket[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.ticketsPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const tickets: FileTicket[] = [];
    for (const name of names) {
      const match = /^owner-([0-9a-f-]+)\.json$/i.exec(name);
      if (!match?.[1]) continue;
      const owner = await this.readOwner(match[1]);
      if (!owner) continue;
      tickets.push({ owner, number: await this.readNumber(owner.token) });
    }
    return tickets;
  }

  private async readOwner(token: string): Promise<FileTicketOwner | undefined> {
    let parsed: Partial<FileTicketOwner>;
    try {
      parsed = JSON.parse(
        await fs.readFile(this.ownerPath(token), 'utf8'),
      ) as Partial<FileTicketOwner>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new NetworkError('mutation lease owner ticket is malformed');
    }
    if (
      parsed.version !== 3 ||
      parsed.host !== canonicalGatewayKey(this.host) ||
      !Number.isSafeInteger(parsed.pid) ||
      (parsed.pid as number) <= 0 ||
      typeof parsed.processStartId !== 'string' ||
      parsed.processStartId.length === 0 ||
      parsed.token !== token ||
      typeof parsed.createdAt !== 'string'
    ) {
      throw new NetworkError('mutation lease owner ticket is malformed');
    }
    return parsed as FileTicketOwner;
  }

  private async readNumber(token: string): Promise<number | undefined> {
    let parsed: { version?: unknown; token?: unknown; number?: unknown };
    try {
      parsed = JSON.parse(await fs.readFile(this.numberPath(token), 'utf8')) as typeof parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new NetworkError('mutation lease number ticket is malformed');
    }
    if (
      parsed.version !== 1 ||
      parsed.token !== token ||
      !Number.isSafeInteger(parsed.number) ||
      (parsed.number as number) <= 0
    ) {
      throw new NetworkError('mutation lease number ticket is malformed');
    }
    return parsed.number as number;
  }

  private async isOwnerAlive(owner: FileTicketOwner): Promise<boolean> {
    if (owner.processStartId === PROCESS_IDENTITY_UNAVAILABLE) return isProcessAlive(owner.pid);
    const observedStartId = await this.identity(owner.pid);
    if (observedStartId === PROCESS_IDENTITY_UNAVAILABLE) return isProcessAlive(owner.pid);
    return observedStartId === owner.processStartId;
  }

  private async removeTicketIfOwned(owner: FileTicketOwner): Promise<void> {
    const current = await this.readOwner(owner.token);
    if (
      !current ||
      current.token !== owner.token ||
      current.processStartId !== owner.processStartId
    ) {
      return;
    }
    await this.removeTicket(owner.token);
  }

  private async removeTicket(token: string): Promise<void> {
    await unlinkIfPresent(this.ownerPath(token));
    await unlinkIfPresent(this.numberPath(token));
  }

  private async publishJson(path: string, value: unknown): Promise<void> {
    const temporary = join(this.ticketsPath, `.claim-${process.pid}-${randomUUID()}.json`);
    try {
      await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
      // Publishing by hard-link is atomic and fails if the immutable ticket
      // name already exists; unlike rename it can never replace another owner.
      await fs.link(temporary, path);
    } finally {
      await unlinkIfPresent(temporary);
    }
  }

  private ownerPath(token: string): string {
    return join(this.ticketsPath, `owner-${token}.json`);
  }

  private numberPath(token: string): string {
    return join(this.ticketsPath, `number-${token}.json`);
  }

  private fencePath(token: string): string {
    return join(this.ticketsPath, `fence-${token}.json`);
  }

  private async hasPersistentFences(): Promise<boolean> {
    try {
      return (await fs.readdir(this.ticketsPath)).some((name) =>
        /^fence-[0-9a-f-]+\.json$/i.test(name),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private assertOpenBeforeDeadline(deadline: number): void {
    if (this.closed) throw new NetworkError('mutation lease backend is closed');
    if (Date.now() >= deadline) throw waitTimeoutError('gateway mutation');
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const PROCESS_IDENTITY_UNAVAILABLE = 'unavailable';

/**
 * Return a stable, cross-process-readable birth identity for `pid`.
 *
 * A numeric PID alone is not ownership: kernels reuse it. Linux exposes the
 * boot id plus `/proc/<pid>/stat` start ticks; macOS/BSD expose `lstart` via
 * `ps`; Windows exposes StartTime through PowerShell. Failure is conservative.
 */
async function processStartIdentity(pid: number): Promise<string> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return PROCESS_IDENTITY_UNAVAILABLE;
  if (process.platform === 'linux') {
    try {
      const [stat, bootId] = await Promise.all([
        fs.readFile(`/proc/${pid}/stat`, 'utf8'),
        fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
      ]);
      const closeParen = stat.lastIndexOf(')');
      if (closeParen < 0) return PROCESS_IDENTITY_UNAVAILABLE;
      // Fields after comm begin at field 3; starttime is field 22 => index 19.
      const fields = stat
        .slice(closeParen + 1)
        .trim()
        .split(/\s+/);
      const startTicks = fields[19];
      if (!startTicks) return PROCESS_IDENTITY_UNAVAILABLE;
      return `linux:${bootId.trim()}:${startTicks}`;
    } catch {
      return PROCESS_IDENTITY_UNAVAILABLE;
    }
  }
  if (process.platform === 'darwin' || process.platform === 'freebsd') {
    const output = await execFileOutput('/bin/ps', ['-o', 'lstart=', '-p', String(pid)]);
    return output ? `${process.platform}:${output}` : PROCESS_IDENTITY_UNAVAILABLE;
  }
  if (process.platform === 'win32') {
    const script = `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`;
    const output = await execFileOutput('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script,
    ]);
    return output ? `win32:${output}` : PROCESS_IDENTITY_UNAVAILABLE;
  }
  return PROCESS_IDENTITY_UNAVAILABLE;
}

function execFileOutput(file: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: 'utf8', timeout: 2_000 }, (error, stdout) => {
      if (error) {
        resolve(undefined);
        return;
      }
      const value = stdout.trim().replace(/\s+/g, ' ');
      resolve(value.length > 0 ? value : undefined);
    });
  });
}

function isString(value: string | undefined): value is string {
  return typeof value === 'string';
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await fs.unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function waitTimeoutError(operation: string): NetworkError {
  return new NetworkError(`timed out waiting for the per-gateway mutation lease (${operation})`, {
    hint: 'another xgg mutation is still running, or an unconfirmed write requires logout and re-login',
  });
}

function persistentFenceError(): NetworkError {
  return new NetworkError('gateway mutations are fenced after an unconfirmed daemon write', {
    hint: 'run xgg logout, log in again, inspect live state, then retry',
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Process-local fallback used by test/fake IPC servers. */
export function createInMemoryMutationLeaseCoordinator(): MutationLeaseCoordinator {
  return new Coordinator(new InMemoryBackend());
}

/** Production coordinator: process-local queue plus stable per-host filesystem ownership. */
export function createFileMutationLeaseCoordinator(input: {
  host: string;
  baseDir: string;
  retryMs?: number;
  /** Deterministic process-birth lookup seam for crash/PID-reuse tests. */
  _processStartIdentity?: (pid: number) => Promise<string>;
  /** Test-only barrier after an acquire publishes its choosing ticket. */
  _afterTicketPublished?: (token: string) => Promise<void>;
  /** Test-only barrier immediately before a durable write fence is published. */
  _beforeWriteFencePublished?: (token: string) => Promise<void>;
  /** Test-only barrier for controlled concurrent stale-ticket cleanup. */
  _beforeStaleTicketCleanup?: (token: string) => Promise<void>;
}): MutationLeaseCoordinator {
  return new Coordinator(
    new FileBackend(
      input.host,
      input.baseDir,
      input.retryMs ?? 25,
      input._processStartIdentity ?? processStartIdentity,
      input._afterTicketPublished,
      input._beforeWriteFencePublished,
      input._beforeStaleTicketCleanup,
    ),
  );
}
