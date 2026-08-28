import type { Kysely } from 'kysely'
import type { Database } from '../../db/schema.js'
import type { Trx } from '../bookings/booking.repository.js'
import { resourceColumns, type ResourceRow } from './resource.repository.js'

export class PoolRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /** Members in the order selection prefers them: stable, and independent of contention. */
  async listMembers(tenantId: string, poolId: string, activeOnly: boolean): Promise<ResourceRow[]> {
    let query = this.db
      .selectFrom('resources')
      .select(resourceColumns)
      .where('tenant_id', '=', tenantId)
      .where('pool_id', '=', poolId)
      .orderBy('created_at')
      .orderBy('id')
    if (activeOnly) query = query.where('is_active', '=', true)
    return query.execute()
  }

  /**
   * Claims one member that has no active booking overlapping the interval, in a stable order.
   *
   * `SKIP LOCKED` is the whole concurrency story for the mode: two requests arriving together
   * take different rows and neither waits, and a request arriving when one member is left
   * finds it locked, skips it, and returns nothing rather than blocking. There is no retry
   * loop — `bookings_no_overlap` remains the backstop, as spec 2 left it.
   */
  async claimMember(
    trx: Trx,
    tenantId: string,
    candidateIds: string[],
    start: Date,
    end: Date,
  ): Promise<string | undefined> {
    if (candidateIds.length === 0) return undefined

    const row = await trx
      .selectFrom('resources')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('id', 'in', candidateIds)
      .where('is_active', '=', true)
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('bookings')
              .select('bookings.id')
              .whereRef('bookings.resource_id', '=', 'resources.id')
              .where('bookings.status', 'in', ['held', 'confirmed'])
              .where('bookings.start_time', '<', end)
              .where('bookings.end_time', '>', start),
          ),
        ),
      )
      .orderBy('created_at')
      .orderBy('id')
      .forUpdate()
      .skipLocked()
      .limit(1)
      .executeTakeFirst()

    return row?.id
  }
}
