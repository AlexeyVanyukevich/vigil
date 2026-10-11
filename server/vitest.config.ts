import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globalSetup: ['./tests/integration/global-setup.ts'],
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    pool: 'forks',
    // One database, truncated between cases.
    fileParallelism: false,
  },
})
