import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { SWEEP_LOCK_KEY, sweepExpiredHolds } from '../../src/modules/bookings/hold-sweeper.js'
import { closeTestDb, getTestDb, resetDb } from './helpers.js'

beforeEach(resetDb)
afterAll(closeTestDb)

/** A resource and one hold, whose expiry is placed relative to the database's clock. */
async function aHold(expiresInSeconds: number): Promise<string> {
  const db = getTestDb()
  const resource = await db
    .insertInto('resources')
    .values({
      timezone: 'Europe/Warsaw',
      slot_duration: sql`interval 'PT1H'`,
      concurrency_mode: 'exclusive',
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  const booking = await db
    .insertInto('bookings')
    .values({
      resource_id: resource.id,
      start_time: '2026-07-20T09:00:00Z',
      end_time: '2026-07-20T10:00:00Z',
      status: 'held',
      customer_id: 'c-1',
      concurrency_mode: 'exclusive',
      held_until: sql<Date>`now() + interval '1 second' * ${expiresInSeconds}`,
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  return booking.id
}

async function statusOf(id: string): Promise<string> {
  const row = await getTestDb()
    .selectFrom('bookings')
    .select('status')
    .where('id', '=', id)
    .executeTakeFirstOrThrow()
  return row.status
}

describe('sweepExpiredHolds', () => {
  it('expires a hold whose time has passed', async () => {
    const id = await aHold(-60)
    expect(await sweepExpiredHolds(getTestDb())).toBe(1)
    expect(await statusOf(id)).toBe('expired')
  })

  it('leaves a live hold alone', async () => {
    const id = await aHold(600)
    expect(await sweepExpiredHolds(getTestDb())).toBe(0)
    expect(await statusOf(id)).toBe('held')
  })

  it('keeps held_until on the expired row', async () => {
    // It is the only record of when the hold lapsed, and the CHECK constraint requires it.
    const id = await aHold(-60)
    await sweepExpiredHolds(getTestDb())

    const row = await getTestDb()
      .selectFrom('bookings')
      .select('held_until')
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
    expect(row.held_until).not.toBeNull()
  })

  it('is idempotent', async () => {
    await aHold(-60)
    expect(await sweepExpiredHolds(getTestDb())).toBe(1)
    expect(await sweepExpiredHolds(getTestDb())).toBe(0)
  })

  it('does no work while another sweeper holds the lock', async () => {
    const db = getTestDb()
    const id = await aHold(-60)

    await db.transaction().execute(async (trx) => {
      // This transaction stands in for another instance mid-sweep. It uses its own
      // connection, so the call below sees the lock taken and returns immediately.
      await sql`select pg_try_advisory_xact_lock(${SWEEP_LOCK_KEY})`.execute(trx)
      expect(await sweepExpiredHolds(db)).toBe(0)
    })

    expect(await statusOf(id)).toBe('held')
    // Once the lock is released, the same call does the work.
    expect(await sweepExpiredHolds(db)).toBe(1)
  })

  it('sweeps across resources in one pass', async () => {
    await aHold(-60)
    await aHold(-60)
    expect(await sweepExpiredHolds(getTestDb())).toBe(2)
  })
})
