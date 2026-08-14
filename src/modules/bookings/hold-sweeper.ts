import { sql, type Kysely } from 'kysely'
import type { Database } from '../../db/schema.js'

/**
 * A stable constant, so every sweeper in every process contends for the same lock. Changing
 * it lets two sweepers run at once, which is harmless but pointless.
 *
 * Exported so the test that stands in for a second sweeper takes this lock rather than a
 * copy of its value: if the constant ever changes, that test fails loudly instead of quietly
 * ceasing to exercise contention.
 */
export const SWEEP_LOCK_KEY = 20260805

export interface Sweeper {
  stop: () => void
}

export interface SweepLogger {
  info: (count: number) => void
  error: (error: unknown) => void
}

/**
 * Moves holds whose `held_until` has passed into `expired`, and returns how many.
 *
 * This is hygiene, not correctness. Every write transaction already sweeps the resource it
 * is about to touch, so a slot is never refused because a dead hold is still sitting on it.
 * What this adds is that listings stop reporting `held` on dead rows, and that resources
 * nobody is booking do not accumulate them.
 *
 * The advisory lock is what makes deployment topology free: any number of API processes,
 * worker processes and one-shot runs may sweep at once, and exactly one takes the lock per
 * tick. It is transaction-scoped rather than session-scoped, because a session-scoped lock
 * goes back into the connection pool still held — and with a transaction-mode pooler in
 * front it would be handed to another client.
 *
 * `status` alone changes: `held_until` stays as the record of when the hold lapsed, and the
 * CHECK constraint requires it on an `expired` row.
 */
export async function sweepExpiredHolds(db: Kysely<Database>): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const lock = await sql<{ locked: boolean }>`
      select pg_try_advisory_xact_lock(${SWEEP_LOCK_KEY}) as locked
    `.execute(trx)

    if (lock.rows[0]?.locked !== true) return 0

    // Locked in id order, the same order the per-resource sweep in `BookingRepository` uses.
    // The two are eligible for different indexes, so without a shared order they can take the
    // same two rows in opposite orders and deadlock.
    const result = await trx
      .updateTable('bookings')
      .set({ status: 'expired', updated_at: sql<Date>`now()` })
      .where('id', 'in', (eb) =>
        eb
          .selectFrom('bookings')
          .select('id')
          .where('status', '=', 'held')
          .where('held_until', '<=', sql<Date>`now()`)
          .orderBy('id')
          .forUpdate(),
      )
      .executeTakeFirst()

    return Number(result.numUpdatedRows)
  })
}

/**
 * `unref` decides whether the timer keeps the process alive. Inside the API process it must
 * not — the HTTP server owns the lifetime. Inside the dedicated worker it must, because the
 * timer is the only reason that process exists.
 */
export function startHoldSweeper(
  db: Kysely<Database>,
  intervalSeconds: number,
  logger: SweepLogger,
  options: { unref: boolean },
): Sweeper {
  const timer = setInterval(() => {
    void sweepExpiredHolds(db).then(
      (count) => {
        if (count > 0) logger.info(count)
      },
      (error: unknown) => logger.error(error),
    )
  }, intervalSeconds * 1000)

  if (options.unref) timer.unref()

  return { stop: () => clearInterval(timer) }
}
