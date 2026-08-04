import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { createDb } from '../../src/db/client.js'
import { runMigrations } from '../../src/db/migrate.js'

let container: StartedPostgreSqlContainer

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string
  }
}

/**
 * Typed structurally rather than against a Vitest export: the name of the global-setup
 * context type has moved between major versions, and `provide` is all this file needs.
 */
interface GlobalSetupContext {
  provide: <K extends 'databaseUrl'>(key: K, value: string) => void
}

export async function setup({ provide }: GlobalSetupContext): Promise<void> {
  container = await new PostgreSqlContainer('postgres:16-alpine').start()
  const databaseUrl = container.getConnectionUri()

  const db = createDb(databaseUrl)
  try {
    await runMigrations(db)
  } finally {
    await db.destroy()
  }

  provide('databaseUrl', databaseUrl)
}

export async function teardown(): Promise<void> {
  await container?.stop()
}
