import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // No `globalSetup` yet. It names a file Task 2 creates, and vitest fails to start when the
    // path does not resolve — which would leave `./run check` red at the end of this task.
    // Task 2 adds the line in the same step that writes the file.
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    pool: 'forks',
    // One database, truncated between cases.
    fileParallelism: false,
  },
})
