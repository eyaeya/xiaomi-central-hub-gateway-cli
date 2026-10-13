import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    workspace: './vitest.cloud.workspace.ts',
  },
});
