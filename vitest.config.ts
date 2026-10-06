import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globalSetup: ['./tests/integration/global-setup.ts'],
    // Fails any test whose replies their route does not declare — see tests/integration/contract.ts.
    setupFiles: ['./tests/integration/contract.setup.ts'],
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    pool: 'forks',
    // Integration tests share one database and truncate between cases, so they must
    // not run concurrently with each other.
    fileParallelism: false,
  },
})
