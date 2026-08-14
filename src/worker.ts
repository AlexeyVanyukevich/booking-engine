import { loadConfig } from './config.js'
import { createDb } from './db/client.js'
import { sweepExpiredHolds, startHoldSweeper } from './modules/bookings/hold-sweeper.js'

/**
 * The second entrypoint. The same image serves three topologies:
 *
 *   node dist/src/server.js          API, sweeping on a timer inside it
 *   node dist/src/worker.js          sweep only, looping
 *   node dist/src/worker.js --once   one sweep, then exit
 *
 * The last is what lets an external scheduler — a Kubernetes CronJob, a systemd timer — own
 * the schedule without any new code. It is strictly better than having a scheduler call an
 * HTTP endpoint: the engine has no authentication, and a mutating internal route would be a
 * poor trade.
 */
const config = loadConfig(process.env)
const db = createDb(config.databaseUrl)

function log(level: 'info' | 'error', message: string, extra: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ level, msg: message, ...extra })}\n`)
}

if (process.argv.includes('--once')) {
  try {
    log('info', 'hold sweep complete', { expired: await sweepExpiredHolds(db) })
  } catch (error: unknown) {
    log('error', 'hold sweep failed', { err: String(error) })
    process.exitCode = 1
  } finally {
    await db.destroy()
  }
} else {
  // Not unref'd: the timer is the only reason this process exists.
  const sweeper = startHoldSweeper(
    db,
    config.holdSweepIntervalSeconds,
    {
      info: (expired) => log('info', 'expired stale holds', { expired }),
      error: (error) => log('error', 'hold sweep failed', { err: String(error) }),
    },
    { unref: false },
  )

  log('info', 'hold sweeper started', { intervalSeconds: config.holdSweepIntervalSeconds })

  const shutdown = () => {
    sweeper.stop()
    void db
      .destroy()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        log('error', 'shutdown failed', { err: String(error) })
        process.exit(1)
      })
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}
