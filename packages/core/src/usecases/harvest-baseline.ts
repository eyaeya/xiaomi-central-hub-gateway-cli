import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { downloadBackup, generateBackup, getBackupProgress } from '../resources/backup.js';
import type { ResourceDeps } from '../resources/index.js';
import type { Node } from '../schemas/rule.js';
import { createStore } from '../session/index.js';

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
}

interface InjectedDeps {
  getBackupProgress: typeof getBackupProgress;
  downloadBackup: typeof downloadBackup;
  generateBackup: typeof generateBackup;
}

export async function harvestBaseline(
  product: CodexProduct,
  opts: HarvestOpts & { _injected?: InjectedDeps },
): Promise<HarvestResult> {
  const store = createStore({});
  const deps: ResourceDeps = { baseUrl: opts.baseUrl, store };
  const api = opts._injected ?? { getBackupProgress, downloadBackup, generateBackup };
  const pollInterval = opts.pollIntervalMs ?? 1000;
  const pollTimeout = opts.pollTimeoutMs ?? 60_000;

  // 1. Poll progress to 100
  let done = false;
  const deadline = Date.now() + pollTimeout;
  while (Date.now() < deadline) {
    const p = await api.getBackupProgress(
      { from: opts.from, progressId: product.progressId },
      deps,
    );
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

  // 2. download -> generate
  await api.downloadBackup({ from: opts.from, backup: backupRef(product) }, deps);
  const content = await api.generateBackup({ from: opts.from, backup: backupRef(product) }, deps);

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
