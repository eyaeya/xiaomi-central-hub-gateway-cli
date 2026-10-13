import { fileURLToPath } from 'node:url';
import { defineWorkspace } from 'vitest/config';

// Test the current TypeScript sources, never a possibly stale dist/ from an earlier build.
const resolve = {
  alias: {
    '@eyaeya/xgg-core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
  },
};

export default defineWorkspace([
  {
    resolve,
    test: {
      name: 'core',
      root: './packages/core',
      include: ['tests/unit/cloud/**/*.test.ts'],
    },
  },
  {
    resolve,
    test: {
      name: 'core-contract',
      root: './packages/core',
      include: ['tests/contract/cloud*.test.ts', 'tests/contract/rule-logs.test.ts'],
    },
  },
  {
    resolve,
    test: {
      name: 'cli',
      root: './packages/cli',
      include: [
        'tests/unit/commands/cloud*.test.ts',
        'tests/unit/commands/rule-logs-follow.test.ts',
      ],
    },
  },
]);
