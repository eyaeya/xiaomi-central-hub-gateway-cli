import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  assertBackupPollOptions,
  downloadBackup,
  extractBackupProgressId,
  generateBackup,
  getBackupProgress,
} from '../resources/backup.js';
import type { ResourceDeps } from '../resources/index.js';
import type { BackupProgressResponse } from '../schemas/backup.js';
import type { Node } from '../schemas/rule.js';
import { type SessionStore, createStore } from '../session/index.js';
import { notConfirmedAfterAcknowledgement } from '../transport/confirmation.js';
import { NotConfirmedError } from '../transport/errors.js';
import { withMutationWorkflow } from './agent-call.js';

export interface CodexProduct {
  type: string;
  variant: 'minimal' | 'full';
  progressId: number;
  did: string;
  ts: string;
  fileName: string;
}

export interface HarvestResult {
  type: string;
  variant: 'minimal' | 'full';
  filePath: string;
  nodeCount: number;
}

export interface HarvestOpts {
  baseUrl: string;
  outDir: string;
  from: string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  /** Optional session store for embedding/tests; it never changes lease semantics. */
  store?: SessionStore;
}

export async function harvestBaseline(
  product: CodexProduct,
  opts: HarvestOpts,
): Promise<HarvestResult> {
  assertBackupPollOptions(opts);
  const store = opts.store ?? createStore({});
  const deps: ResourceDeps = { baseUrl: opts.baseUrl, store };
  const pollInterval = opts.pollIntervalMs ?? 1000;
  const pollTimeout = opts.pollTimeoutMs ?? 60_000;

  // 1. Poll progress to 100
  let done = false;
  const deadline = Date.now() + pollTimeout;
  while (Date.now() < deadline) {
    const p = await getBackupProgress({ from: opts.from, progressId: product.progressId }, deps);
    if (p.progress >= 100) {
      done = true;
      break;
    }
    await sleep(pollInterval);
  }
  if (!done) {
    throw new Error(
      `harvestBaseline: progress polling timed out after ${pollTimeout}ms (progressId=${product.progressId})`,
    );
  }

  // 2. download -> generate. generateBackup consumes gateway cache state that
  // the preceding download materialises, so real calls keep both operations on
  // one pinned daemon connection under one workflow lease. The initial product
  // progress poll above is intentionally outside: it observes a prior operation
  // and can be long-running without blocking unrelated gateway mutations.
  const downloadAndGenerate = async () => {
    const download = await downloadBackup({ from: opts.from, backup: backupRef(product) }, deps);
    const progressId = extractBackupProgressId(download);
    // Unlike restore, download uses an empty/no-progress response for
    // synchronous cache completion. Poll only when the gateway supplies a
    // non-zero asynchronous handle.
    if (progressId === null && !isExactEmptyObject(download)) {
      throw new NotConfirmedError(
        'backup download was accepted without enough progress metadata to confirm cache completion',
        {
          operation: 'harvest-baseline.download',
          from: opts.from,
          response: download,
        },
      );
    }
    if (progressId !== null && progressId !== 0) {
      const downloadDeadline = Date.now() + pollTimeout;
      for (;;) {
        let progress: BackupProgressResponse;
        try {
          progress = await getBackupProgress({ from: opts.from, progressId }, deps);
        } catch (error) {
          throw notConfirmedAfterAcknowledgement(
            error,
            'backup download was acknowledged but cache completion could not be confirmed',
            {
              operation: 'harvest-baseline.download',
              phase: 'progress-confirmation',
              from: opts.from,
              progressId,
              hint: 'log out, log in again, and inspect backup state before retrying',
            },
          );
        }
        if (progress.progress >= 100) break;
        if (Date.now() >= downloadDeadline) {
          throw new NotConfirmedError(
            `backup download polling timed out after ${pollTimeout}ms (progressId=${progressId}, last=${progress.progress})`,
            {
              operation: 'harvest-baseline.download',
              from: opts.from,
              progressId,
              lastProgress: progress.progress,
              pollTimeoutMs: pollTimeout,
            },
          );
        }
        await sleep(pollInterval);
      }
    }
    return generateBackup({ from: opts.from, backup: backupRef(product) }, deps);
  };
  const content = await withMutationWorkflow(
    {
      baseUrl: deps.baseUrl,
      store: deps.store,
      operation: `harvest-baseline:${product.type}:${product.variant}`,
    },
    downloadAndGenerate,
  );

  // 3. Extract nodes matching target type
  const matched: Node[] = [];
  for (const rule of content.rules) {
    for (const node of rule.nodes) {
      if (node.type === product.type) matched.push(node);
    }
  }

  // 4. Write to disk
  const filePath = resolve(opts.outDir, `${product.type}-${product.variant}.json`);
  const payload = { type: product.type, variant: product.variant, nodes: matched };
  await mkdir(opts.outDir, { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  return { type: product.type, variant: product.variant, filePath, nodeCount: matched.length };
}

function backupRef(p: CodexProduct) {
  return { did: p.did, ts: p.ts, fileName: p.fileName };
}

function isExactEmptyObject(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}
