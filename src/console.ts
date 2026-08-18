import { buildConsoleApp } from './console-app.js'
import { loadConfig } from './config.js'
import { createDb } from './db/client.js'

const config = loadConfig(process.env)
const db = createDb(config.databaseUrl)
const app = await buildConsoleApp({ config, db })

app.addHook('onClose', async () => {
  await db.destroy()
})

try {
  // 127.0.0.1, hard-coded and deliberately not configurable. Key issuance here is
  // unauthenticated, which is safe only while the port is unreachable from anywhere else, so
  // there is no environment variable that can be set wrong. Exposing this is exposing the
  // ability to mint an all-scopes key for any tenant in the database.
  await app.listen({ port: config.consolePort, host: '127.0.0.1' })
} catch (error) {
  app.log.error(error)
  process.exit(1)
}
