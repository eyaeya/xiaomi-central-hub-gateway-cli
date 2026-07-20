import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  assertBackupPollOptions,
  downloadAndGenerateBackup,
  getBackupProgress,
} from '../resources/backup.js';
import type { ResourceDeps } from '../resources/index.js';
import type { Node } from '../schemas/rule.js';
import { type SessionStore, createStore } from '../session/index.js';

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

  // 2. download -> generate under the same production-path helper and one
  // mutation lease. The initial product progress poll above is intentionally
  // outside: it observes a prior operation without blocking unrelated writes.
  const { content } = await downloadAndGenerateBackup(
    { from: opts.from, backup: backupRef(product) },
    deps,
    { pollIntervalMs: pollInterval, pollTimeoutMs: pollTimeout },
  );

  // 3. Extract nodes matching target type
  const matched: Node[] = [];
  const rules = Array.isArray(content) ? content : content.rules;
  for (const rule of rules) {
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
