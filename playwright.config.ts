import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/ui',
  testMatch: '**/*.spec.ts',
  globalSetup: './tests/ui/global-setup.ts',
  // One database and one server: the specs share them and must not race each other.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 30_000,
  reporter: [['list']],
  use: { trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
