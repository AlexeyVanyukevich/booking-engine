import { fileURLToPath } from 'node:url'
import type { Kysely } from 'kysely'
import { Migrator } from 'kysely/migration'
import { loadConfig } from '../config.js'
import { createDb } from './client.js'
import { migrations } from './migrations/index.js'
import type { Database } from './schema.js'

export async function runMigrations(db: Kysely<Database>): Promise<void> {
  const migrator = new Migrator({
    db,
    provider: { getMigrations: async () => migrations },
  })

  const { error, results } = await migrator.migrateToLatest()

  for (const result of results ?? []) {
    if (result.status === 'Error') {
      throw new Error(`Migration "${result.migrationName}" failed`)
    }
  }

  if (error) throw error
}

// Executed only when run directly: `npm run migrate`
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadConfig(process.env)
  const db = createDb(config.databaseUrl)
  try {
    await runMigrations(db)
    console.log('migrations applied')
  } finally {
    await db.destroy()
  }
}
