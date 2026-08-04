import { inject } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { sql, type Kysely } from 'kysely'
import { buildApp } from '../../src/app.js'
import { createDb } from '../../src/db/client.js'
import type { Database } from '../../src/db/schema.js'

let cached: Kysely<Database> | undefined

export function getTestDb(): Kysely<Database> {
  cached ??= createDb(inject('databaseUrl'))
  return cached
}

export async function closeTestDb(): Promise<void> {
  await cached?.destroy()
  cached = undefined
}

export async function resetDb(): Promise<void> {
  await sql`truncate table schedule_exceptions, schedule, resources restart identity cascade`.execute(
    getTestDb(),
  )
}

export async function buildTestApp(): Promise<FastifyInstance> {
  const app = buildApp({
    config: { databaseUrl: inject('databaseUrl'), port: 0, logLevel: 'silent', maxRangeDays: 366 },
    db: getTestDb(),
  })
  await app.ready()
  return app
}
