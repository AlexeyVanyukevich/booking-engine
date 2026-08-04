import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import type { Database } from './schema.js'

const PG_INTERVAL_OID = 1186
const PG_DATE_OID = 1082

// Read intervals and dates as raw strings. pg's default parsers turn an interval into an
// object and a date into a Date at the *process's* local midnight, which silently shifts
// the date whenever the server's zone differs from the resource's.
pg.types.setTypeParser(PG_INTERVAL_OID, (value: string) => value)
pg.types.setTypeParser(PG_DATE_OID, (value: string) => value)

/**
 * The returned instance owns its connection pool: `db.destroy()` closes it, and calling
 * `pool.end()` separately would throw. That is why no pool is handed back.
 */
export function createDb(databaseUrl: string): Kysely<Database> {
  const pool = new pg.Pool({ connectionString: databaseUrl })

  // Makes Postgres emit intervals as 'PT1H' / 'P1D' — the same grammar the API uses.
  pool.on('connect', (client) => {
    void client.query("SET intervalstyle = 'iso_8601'")
  })

  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
}
