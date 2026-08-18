import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import type { AddressInfo } from 'node:net'
import { buildApp } from '../../src/app.js'
import { buildConsoleApp } from '../../src/console-app.js'
import { loadConfig } from '../../src/config.js'
import { createDb } from '../../src/db/client.js'
import { runMigrations } from '../../src/db/migrate.js'

let container: StartedPostgreSqlContainer

/**
 * Mirrors tests/integration/global-setup.ts, but starts **both** apps: the most valuable UI
 * case issues a key in the console and then uses it against the data plane, which means both
 * have to be listening. Ports are ephemeral and handed to the specs through the environment,
 * because playwright.config.ts is evaluated before this runs and cannot know them.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  container = await new PostgreSqlContainer('postgres:16-alpine').start()
  const databaseUrl = container.getConnectionUri()

  const migrationDb = createDb(databaseUrl)
  try {
    await runMigrations(migrationDb)
  } finally {
    await migrationDb.destroy()
  }

  const db = createDb(databaseUrl)
  const config = loadConfig({
    DATABASE_URL: databaseUrl,
    LOG_LEVEL: 'silent',
    HOLD_SWEEP_ENABLED: 'false',
    // High enough that a whole spec file's traffic is never throttled.
    RATE_LIMIT_PER_MINUTE: '100000',
  })

  const consoleApp = await buildConsoleApp({ config, db })
  const dataApp = await buildApp({ config, db })

  await consoleApp.listen({ port: 0, host: '127.0.0.1' })
  await dataApp.listen({ port: 0, host: '127.0.0.1' })

  const consolePort = (consoleApp.server.address() as AddressInfo).port
  const dataPort = (dataApp.server.address() as AddressInfo).port

  process.env.DATABASE_URL = databaseUrl
  process.env.CONSOLE_URL = `http://127.0.0.1:${consolePort}`
  process.env.DATA_PLANE_URL = `http://127.0.0.1:${dataPort}`

  return async () => {
    await consoleApp.close()
    await dataApp.close()
    await db.destroy()
    await container.stop()
  }
}
