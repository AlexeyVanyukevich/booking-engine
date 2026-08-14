import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { createDb } from './db/client.js'
import { startHoldSweeper } from './modules/bookings/hold-sweeper.js'

const config = loadConfig(process.env)
const db = createDb(config.databaseUrl)
const app = buildApp({ config, db })

// Leaving this on by default is deliberate. A dead worker is an invisible failure —
// correctness does not depend on it, requests keep being served, nothing alerts — so the
// API timers stay on and the separate worker service becomes an optimisation rather than a
// dependency. The advisory lock means running both costs nothing.
const sweeper = config.holdSweepEnabled
  ? startHoldSweeper(
      db,
      config.holdSweepIntervalSeconds,
      {
        info: (expired) => app.log.debug({ expired }, 'expired stale holds'),
        error: (error) => app.log.error({ err: error }, 'hold sweep failed'),
      },
      { unref: true },
    )
  : undefined

app.addHook('onClose', async () => {
  sweeper?.stop()
  await db.destroy()
})

try {
  await app.listen({ port: config.port, host: '0.0.0.0' })
} catch (error) {
  app.log.error(error)
  process.exit(1)
}
