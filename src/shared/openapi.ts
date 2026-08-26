import type { Kysely } from 'kysely'
import { buildApp } from '../app.js'
import { loadAppConfig } from '../config.js'
import type { Database } from '../db/schema.js'

/**
 * Each route plugin hands the app's database to its repositories, which hold it until a
 * request arrives and query through it then. Generating the document calls no handler, so no
 * query is ever built and nothing here is ever dereferenced — which is why describing an API
 * needs neither a connection pool nor a URL invented for one that would never be opened.
 *
 * The cast is what says that. Were a route ever to query while registering, this would fail
 * on the missing method rather than quietly trying to reach a database that isn't there.
 */
const unusedDatabase = {} as Kysely<Database>

/**
 * The whole document is produced from the schemas the routes validate against, so it cannot
 * drift from the behaviour — but two of its fields also read configuration: the server URL
 * carries `PORT`, and the range rule in the description carries `MAX_RANGE_DAYS`. A committed
 * file has to be the same wherever it is generated, so the generator reads an **empty
 * environment** rather than the ambient one: a developer with `PORT=3100` in their `.env`
 * would otherwise produce a spurious diff.
 *
 * Taking the defaults from `loadAppConfig` rather than restating them is what keeps the two in
 * step — a changed default reaches the document without anyone remembering it should.
 */
export async function generateOpenApiDocument(): Promise<Record<string, unknown>> {
  const config = {
    ...loadAppConfig({}),
    // The generator writes to stdout; a startup line from Fastify would end up in the file.
    logLevel: 'silent',
  }

  const app = await buildApp({ config, db: unusedDatabase })
  try {
    // The generator collects routes as they are registered, so the document is only complete
    // once every plugin has loaded.
    await app.ready()
    return app.swagger() as Record<string, unknown>
  } finally {
    await app.close()
  }
}

/**
 * One serializer, used by the script that writes the file and by the test that checks it, so
 * a regeneration is a no-op whenever the contract has not changed. `openapi.json` is in
 * `.prettierignore` for the same reason: Prettier packs short arrays onto one line, which
 * would fight this and make every regeneration a diff.
 */
export function serializeOpenApiDocument(document: Record<string, unknown>): string {
  return `${JSON.stringify(document, null, 2)}\n`
}
