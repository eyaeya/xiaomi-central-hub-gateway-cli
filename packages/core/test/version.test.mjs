import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const packageMetadata = require('../package.json');

test('VERSION matches the installed core package version', async () => {
  const { VERSION } = await import('../dist/index.js');

  assert.equal(VERSION, packageMetadata.version);
});
