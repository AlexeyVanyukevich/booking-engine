import { sql, type Expression, type Kysely, type Transaction } from 'kysely'
import type { BookingStatus, ConcurrencyMode, Database } from '../../db/schema.js'
import { resourceColumns, type ResourceRow } from '../resources/resource.repository.js'

export type Trx = Transaction<Database>

/**
 * The hold deadline, computed by Postgres rather than by this process. Every comparison
 * against `held_until` is already database-side; computing the deadline on Node's clock made
 * a hold's real duration `minutes ± skew` between the two. Behind enough skew a hold is born
 * expired — a 201 whose `confirm` answers 410 — and ahead of it a hold outlives
 * `MAX_HOLD_MINUTES`, which the configuration claims to enforce. Both failures are silent.
 */
export function holdExpiry(minutes: number): Expression<Date> {
  return sql<Date>`now() + make_interval(mins => ${minutes})`
}

/** `updated_at` follows `created_at`: written by the database, so the two are comparable. */
function now(): Expression<Date> {
  return sql<Date>`now()`
}

export interface BookingRow {
  id: string
  resource_id: string
  start_time: Date
  end_time: Date
  status: BookingStatus
  customer_id: string | null
  concurrency_mode: ConcurrencyMode
  held_until: Date | null
  idempotency_key: string | null
}

/** A booking together with the timezone its timestamps must be rendered in. */
export interface BookingWithZone extends BookingRow {
  timezone: string
}

export interface NewBooking {
  tenant_id: string
  resource_id: string
  start_time: Date
  end_time: Date
  status: BookingStatus
  customer_id: string | null
  concurrency_mode: ConcurrencyMode
  /** A literal instant, or a database-side expression such as `holdExpiry()`. */
  held_until: Date | Expression<Date> | null
  idempotency_key: string | null
}

export interface ActiveBooking {
  id: string
  start_time: Date
  end_time: Date
}

export interface ListFilter {
  tenantId: string
  resourceId?: string | undefined
  customerId?: string | undefined
  from: Date
  to: Date
  status?: BookingStatus | undefined
}

const columns = [
  'id',
  'resource_id',
  'start_time',
  'end_time',
  'status',
  'customer_id',
  'concurrency_mode',
  'held_until',
  'idempotency_key',
] as const

export class BookingRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * The shape of every write that contends for capacity.
   *
   * The sweep is the correctness mechanism, not the background worker: a hold sitting at
   * `status = 'held'` keeps blocking the exclusion constraint until something moves it, so
   * freeing a slot and taking it have to be one atomic operation. The worker only exists so
   * that listings and untouched resources do not accumulate dead rows.
   *
   * `lockResource` is true only for modes whose invariant spans more than one row. An
   * `exclusive` resource is carried by the exclusion constraint alone, which is atomic at
   * READ COMMITTED and needs no lock.
   *
   * The resource row is read here and handed to `work`, and that row — not the one the
   * service loaded before the transaction opened — is what a decision must be made on. A
   * concurrent `PATCH` lowering `capacity` from 3 to 1, or setting `is_active: false`,
   * commits between the two reads, and only the second one sees it. `undefined` means the
   * resource was deleted in that same window.
   */
  async inWriteTransaction<T>(
    tenantId: string,
    resourceId: string,
    lockResource: boolean,
    work: (trx: Trx, resource: ResourceRow | undefined) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      const query = trx
        .selectFrom('resources')
        .select(resourceColumns)
        .where('tenant_id', '=', tenantId)
        .where('id', '=', resourceId)
      const resource = await (lockResource ? query.forUpdate() : query).executeTakeFirst()

      // Rows are locked in id order rather than in whatever order the planner scans them.
      // This sweep and the global one in `hold-sweeper.ts` are eligible for different indexes
      // — `bookings_resource_start_idx` orders by `start_time`, `bookings_held_until_idx` by
      // `held_until` — and an UPDATE locks rows as it meets them. Two expired holds that sort
      // differently under those two keys could therefore be taken in opposite orders by a
      // request and the background sweeper, which is a deadlock. One shared order removes it.
      await trx
        .updateTable('bookings')
        .set({ status: 'expired', updated_at: now() })
        .where('id', 'in', (eb) =>
          eb
            .selectFrom('bookings')
            .select('id')
            .where('resource_id', '=', resourceId)
            .where('status', '=', 'held')
            .where('held_until', '<=', sql<Date>`now()`)
            .orderBy('id')
            .forUpdate(),
        )
        .execute()

      return work(trx, resource)
    })
  }

  /**
   * The pool equivalent. Two differences, both load-bearing.
   *
   * The in-transaction sweep runs across the pool's **members**, not the pool row: an expired
   * hold on a member still blocks it until something moves it out of `held`, and selection
   * would otherwise skip a member that is in fact free — the exact failure spec 2's inline
   * sweep exists to prevent, one level down.
   *
   * The pool row is locked only when the caller asks, which is only when an idempotency key
   * is present. Capacity is derived rather than counted, so nothing else needs it.
   */
  async inPoolWriteTransaction<T>(
    tenantId: string,
    poolId: string,
    lockPool: boolean,
    work: (trx: Trx, pool: ResourceRow | undefined) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      const query = trx
        .selectFrom('resources')
        .select(resourceColumns)
        .where('tenant_id', '=', tenantId)
        .where('id', '=', poolId)
      const pool = await (lockPool ? query.forUpdate() : query).executeTakeFirst()

      // `FOR UPDATE OF bookings` keeps the lock off the joined `resources` rows — without it
      // Postgres locks both sides, and a concurrent PATCH on a member would contend needlessly.
      await trx
        .updateTable('bookings')
        .set({ status: 'expired', updated_at: now() })
        .where('id', 'in', (eb) =>
          eb
            .selectFrom('bookings')
            .select('bookings.id')
            .innerJoin('resources', 'resources.id', 'bookings.resource_id')
            .where('resources.pool_id', '=', poolId)
            .where('bookings.status', '=', 'held')
            .where('bookings.held_until', '<=', sql<Date>`now()`)
            .orderBy('bookings.id')
            .forUpdate('bookings'),
        )
        .execute()

      return work(trx, pool)
    })
  }

  async insert(trx: Trx, values: NewBooking): Promise<BookingRow> {
    return trx.insertInto('bookings').values(values).returning(columns).executeTakeFirstOrThrow()
  }

  /**
   * Bookings that still hold capacity and overlap the interval. Callers run inside
   * `inWriteTransaction`, where the sweep has already run, so a `held` row here is live.
   */
  async activeOverlapping(
    trx: Trx,
    tenantId: string,
    resourceId: string,
    start: Date,
    end: Date,
    excludeId?: string,
  ): Promise<ActiveBooking[]> {
    let query = trx
      .selectFrom('bookings')
      .select(['id', 'start_time', 'end_time'])
      .where('tenant_id', '=', tenantId)
      .where('resource_id', '=', resourceId)
      .where('status', 'in', ['held', 'confirmed'])
      .where('start_time', '<', end)
      .where('end_time', '>', start)

    if (excludeId !== undefined) query = query.where('id', '!=', excludeId)
    return query.execute()
  }

  /**
   * Bookings that hold capacity over the window. A `held` row whose `held_until` has passed
   * is excluded by predicate, so a read never waits for a sweep or a worker.
   */
  async activeInRange(
    tenantId: string,
    resourceId: string,
    start: Date,
    end: Date,
  ): Promise<ActiveBooking[]> {
    return this.db
      .selectFrom('bookings')
      .select(['id', 'start_time', 'end_time'])
      .where('tenant_id', '=', tenantId)
      .where('resource_id', '=', resourceId)
      .where('start_time', '<', end)
      .where('end_time', '>', start)
      .where((eb) =>
        eb.or([
          eb('status', '=', 'confirmed'),
          eb.and([eb('status', '=', 'held'), eb('held_until', '>', sql<Date>`now()`)]),
        ]),
      )
      .execute()
  }

  /** Same rows as `activeInRange`, batched over several members and carrying `resource_id`. */
  async activeInRangeForResources(
    tenantId: string,
    resourceIds: string[],
    start: Date,
    end: Date,
  ): Promise<Array<ActiveBooking & { resource_id: string }>> {
    if (resourceIds.length === 0) return []
    return this.db
      .selectFrom('bookings')
      .select(['id', 'resource_id', 'start_time', 'end_time'])
      .where('tenant_id', '=', tenantId)
      .where('resource_id', 'in', resourceIds)
      .where('start_time', '<', end)
      .where('end_time', '>', start)
      .where((eb) =>
        eb.or([
          eb('status', '=', 'confirmed'),
          eb.and([eb('status', '=', 'held'), eb('held_until', '>', sql<Date>`now()`)]),
        ]),
      )
      .execute()
  }

  async findByIdempotencyKey(
    trx: Trx,
    tenantId: string,
    resourceId: string,
    key: string,
  ): Promise<BookingRow | undefined> {
    return trx
      .selectFrom('bookings')
      .select(columns)
      .where('tenant_id', '=', tenantId)
      .where('resource_id', '=', resourceId)
      .where('idempotency_key', '=', key)
      .executeTakeFirst()
  }

  /**
   * The replay lookup for a pool. It joins through `resources` because the caller sent the
   * pool id and the booking carries a member id — the key spans the pool, while the unique
   * index spans only `(resource_id, idempotency_key)`.
   *
   * Correct only under the pool row lock its caller takes: without it, two concurrent replays
   * both miss here, claim different members, and both insert. That lock is the one place in
   * the engine where a parent is held before a member, which is the ordering conventions.md
   * records so that pools do not discover it as an intermittent deadlock.
   */
  async findByPoolIdempotencyKey(
    trx: Trx,
    tenantId: string,
    poolId: string,
    key: string,
  ): Promise<BookingRow | undefined> {
    return trx
      .selectFrom('bookings')
      .innerJoin('resources', (join) =>
        join
          .onRef('resources.id', '=', 'bookings.resource_id')
          .onRef('resources.tenant_id', '=', 'bookings.tenant_id'),
      )
      .select(columns.map((column) => `bookings.${column}` as const))
      .where('bookings.tenant_id', '=', tenantId)
      .where('resources.pool_id', '=', poolId)
      .where('bookings.idempotency_key', '=', key)
      .executeTakeFirst()
  }

  /**
   * Returns undefined when a concurrent request already claimed the key. The conflict target
   * names the unique index explicitly, so an exclusion violation still raises rather than
   * being swallowed as a no-op.
   */
  async insertIfKeyFree(trx: Trx, values: NewBooking): Promise<BookingRow | undefined> {
    return trx
      .insertInto('bookings')
      .values(values)
      .onConflict((oc) => oc.columns(['resource_id', 'idempotency_key']).doNothing())
      .returning(columns)
      .executeTakeFirst()
  }

  /**
   * Locked: the caller reads the current status, decides in application code, then writes
   * it back, and that whole sequence has to be atomic. Without the lock, two conflicting
   * actions on the same booking can both read the same starting status, block on each
   * other's row lock only at the write, and the loser's write still matches on `id` alone —
   * overwriting the winner's terminal status instead of being refused.
   */
  async findIn(trx: Trx, tenantId: string, id: string): Promise<BookingRow | undefined> {
    return trx
      .selectFrom('bookings')
      .select(columns)
      .where('tenant_id', '=', tenantId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst()
  }

  async setStatus(
    trx: Trx,
    id: string,
    status: BookingStatus,
    heldUntil: Date | null,
  ): Promise<BookingRow> {
    return trx
      .updateTable('bookings')
      .set({ status, held_until: heldUntil, updated_at: now() })
      .where('id', '=', id)
      .returning(columns)
      .executeTakeFirstOrThrow()
  }

  async updateTimes(trx: Trx, id: string, start: Date, end: Date): Promise<BookingRow> {
    return trx
      .updateTable('bookings')
      .set({ start_time: start, end_time: end, updated_at: now() })
      .where('id', '=', id)
      .returning(columns)
      .executeTakeFirstOrThrow()
  }

  async findById(tenantId: string, id: string): Promise<BookingWithZone | undefined> {
    return this.db
      .selectFrom('bookings')
      .innerJoin('resources', 'resources.id', 'bookings.resource_id')
      .select([
        'bookings.id',
        'bookings.resource_id',
        'bookings.start_time',
        'bookings.end_time',
        'bookings.status',
        'bookings.customer_id',
        'bookings.concurrency_mode',
        'bookings.held_until',
        'bookings.idempotency_key',
        'resources.timezone',
      ])
      .where('bookings.tenant_id', '=', tenantId)
      .where('bookings.id', '=', id)
      .executeTakeFirst()
  }

  /** Bookings whose interval overlaps the window, oldest first. */
  async list(filter: ListFilter): Promise<BookingWithZone[]> {
    let query = this.db
      .selectFrom('bookings')
      .innerJoin('resources', 'resources.id', 'bookings.resource_id')
      .select([
        'bookings.id',
        'bookings.resource_id',
        'bookings.start_time',
        'bookings.end_time',
        'bookings.status',
        'bookings.customer_id',
        'bookings.concurrency_mode',
        'bookings.held_until',
        'bookings.idempotency_key',
        'resources.timezone',
      ])
      .where('bookings.tenant_id', '=', filter.tenantId)
      .where('bookings.start_time', '<', filter.to)
      .where('bookings.end_time', '>', filter.from)
      .orderBy('bookings.start_time')

    if (filter.resourceId !== undefined) {
      query = query.where('bookings.resource_id', '=', filter.resourceId)
    }
    if (filter.customerId !== undefined) {
      query = query.where('bookings.customer_id', '=', filter.customerId)
    }
    if (filter.status !== undefined) query = query.where('bookings.status', '=', filter.status)

    return query.execute()
  }
}
