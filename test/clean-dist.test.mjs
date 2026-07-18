import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const cleanScript = join(repositoryRoot, 'scripts', 'clean-dist.mjs');

test('clean-dist removes only the package dist directory', async (t) => {
  const packageRoot = await mkdtemp(join(tmpdir(), 'xgg-clean-dist-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(packageRoot, { force: true, recursive: true });
  });

  await mkdir(join(packageRoot, 'dist'), { recursive: true });
  await writeFile(join(packageRoot, 'dist', '__stale_sentinel__.js'), 'stale');
  await writeFile(join(packageRoot, 'keep.txt'), 'keep');

  const result = spawnSync(process.execPath, [cleanScript], {
    cwd: packageRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(readFile(join(packageRoot, 'dist', '__stale_sentinel__.js')), {
    code: 'ENOENT',
  });
  assert.equal(await readFile(join(packageRoot, 'keep.txt'), 'utf8'), 'keep');
});

test('both published packages clean before build and build before pack', async () => {
  for (const packageName of ['core', 'cli']) {
    const manifest = JSON.parse(
      await readFile(join(repositoryRoot, 'packages', packageName, 'package.json'), 'utf8'),
    );
    assert.match(manifest.scripts.build, /^node \.\.\/\.\.\/scripts\/clean-dist\.mjs && /);
    assert.equal(manifest.scripts.prepack, 'pnpm build');
  }
});
