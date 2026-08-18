import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/ui',
  // Vitest collects `tests/**/*.test.ts`, so the `.spec.ts` extension keeps the two runners
  // apart with no change to vitest.config.ts.
  testMatch: '**/*.spec.ts',
  globalSetup: './tests/ui/global-setup.ts',
  // One database, truncated between cases — the same reason vitest.config.ts sets
  // fileParallelism: false.
  workers: 1,
  fullyParallel: false,
  timeout: 30_000,
  reporter: process.env.CI ? 'github' : 'list',
  use: { trace: 'on-first-retry' },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    {
      // Holds the no-JavaScript property in place: if the console ever comes to depend on a
      // script, this project fails. Firefox and WebKit are not run — this is a local admin
      // tool for one operator, and three engines would triple the time for no product risk.
      name: 'chromium-nojs',
      use: { browserName: 'chromium', javaScriptEnabled: false },
      testIgnore: '**/clipboard.spec.ts',
    },
  ],
})
