import { defineConfig } from 'vitest/config'

// No global setup, no container, no database. If this suite ever needs one, the package has
// grown a dependency on the server it is not allowed to have.
export default defineConfig({
  test: { include: ['tests/**/*.test.ts'] },
})
