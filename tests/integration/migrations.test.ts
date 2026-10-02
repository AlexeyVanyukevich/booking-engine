import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { TIMEZONES } from '../fixtures/resources.js'
import { validDurations } from '../fixtures/datasets/durations.js'
import { SCOPES, type Scope } from '../../src/shared/scopes.js'
import { closeTestDb, getTestDb, resetDb, seedTenantId } from './helpers.js'

let tenantId: string

beforeEach(async () => {
  await resetDb()
  tenantId = await seedTenantId()
})
afterAll(closeTestDb)

async function insertResource(overrides: Record<string, unknown> = {}): Promise<string> {
  const row = await getTestDb()
    .insertInto('resources')
    .values({
      tenant_id: tenantId,
      timezone: TIMEZONES.warsaw,
      slot_duration: 'PT1H',
      concurrency_mode: 'exclusive',
      ...overrides,
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return row.id
}

describe('schema', () => {
  it.each(['resources', 'schedule', 'schedule_exceptions'])(
    'creates the %s table',
    async (table) => {
      const result = await sql<{ count: string }>`
      select count(*)::text as count from information_schema.tables
      where table_schema = 'public' and table_name = ${table}
    `.execute(getTestDb())
      expect(result.rows[0]!.count).toBe('1')
    },
  )

  it.each([
    ['resources', 'slot_duration', 'interval'],
    ['resources', 'slot_anchor_time', 'time without time zone'],
    ['resources', 'created_at', 'timestamp with time zone'],
    ['schedule', 'day_of_week', 'smallint'],
    ['schedule', 'start_time', 'time without time zone'],
    ['schedule_exceptions', 'date', 'date'],
  ])('stores %s.%s as %s', async (table, column, expectedType) => {
    const result = await sql<{ data_type: string }>`
      select data_type from information_schema.columns
      where table_schema = 'public' and table_name = ${table} and column_name = ${column}
    `.execute(getTestDb())
    expect(result.rows[0]?.data_type).toBe(expectedType)
  })
})

describe('type round-tripping', () => {
  it.each(validDurations)('returns $iso in canonical form', async ({ iso, canonical }) => {
    await insertResource({ slot_duration: iso })
    const row = await getTestDb()
      .selectFrom('resources')
      .select('slot_duration')
      .executeTakeFirstOrThrow()
    // Postgres normalizes intervals on storage; the service canonicalises before writing
    // so that what a caller submits is what a caller reads back.
    expect(row.slot_duration).toBe(canonical ?? iso)
  })

  it('keeps P1D and PT23H59M distinct', async () => {
    await insertResource({ slot_duration: 'P1D' })
    await insertResource({ slot_duration: 'PT23H59M' })

    const rows = await getTestDb()
      .selectFrom('resources')
      .select('slot_duration')
      .orderBy('slot_duration')
      .execute()
    expect(rows.map((row) => row.slot_duration).sort()).toEqual(['P1D', 'PT23H59M'])
  })

  it.each(['2026-01-01', '2026-06-15', '2026-12-31', '2028-02-29'])(
    'returns the date %s as a plain string',
    async (date) => {
      // A zone far from UTC is where a Date-based parser would shift the day.
      const resourceId = await insertResource({ timezone: TIMEZONES.auckland })
      await getTestDb()
        .insertInto('schedule_exceptions')
        .values({
          tenant_id: tenantId,
          resource_id: resourceId,
          date,
          start_time: null,
          end_time: null,
        })
        .execute()

      const row = await getTestDb()
        .selectFrom('schedule_exceptions')
        .select('date')
        .executeTakeFirstOrThrow()
      expect(row.date).toBe(date)
    },
  )

  it('returns times as HH:MM:SS strings', async () => {
    const resourceId = await insertResource()
    await getTestDb()
      .insertInto('schedule')
      .values({
        tenant_id: tenantId,
        resource_id: resourceId,
        day_of_week: 0,
        start_time: '09:00',
        end_time: '17:00',
      })
      .execute()

    const row = await getTestDb()
      .selectFrom('schedule')
      .select(['start_time', 'end_time'])
      .executeTakeFirstOrThrow()
    expect(row.start_time).toBe('09:00:00')
    expect(row.end_time).toBe('17:00:00')
  })
})

describe('constraints', () => {
  it.each([
    { name: 'a capacity of zero', values: { capacity: 0 }, constraint: /capacity_positive/ },
    { name: 'a negative capacity', values: { capacity: -5 }, constraint: /capacity_positive/ },
    {
      name: 'an unknown concurrency mode',
      values: { concurrency_mode: 'whatever' },
      constraint: /concurrency_mode_valid/,
    },
  ])('rejects $name on resources', async ({ values, constraint }) => {
    await expect(insertResource(values)).rejects.toThrow(constraint)
  })

  it.each([
    {
      name: 'only the start time set',
      values: { day_of_week: 0, start_time: '09:00', end_time: null },
      constraint: /times_both_or_neither/,
    },
    {
      name: 'only the end time set',
      values: { day_of_week: 0, start_time: null, end_time: '17:00' },
      constraint: /times_both_or_neither/,
    },
    {
      name: 'an end time before the start',
      values: { day_of_week: 0, start_time: '17:00', end_time: '09:00' },
      constraint: /times_ordered/,
    },
    {
      name: 'a weekday below the range',
      values: { day_of_week: -1, start_time: null, end_time: null },
      constraint: /day_of_week_range/,
    },
    {
      name: 'a weekday above the range',
      values: { day_of_week: 7, start_time: null, end_time: null },
      constraint: /day_of_week_range/,
    },
  ])('rejects $name on schedule', async ({ values, constraint }) => {
    const resourceId = await insertResource()
    await expect(
      getTestDb()
        .insertInto('schedule')
        .values({ tenant_id: tenantId, resource_id: resourceId, ...values })
        .execute(),
    ).rejects.toThrow(constraint)
  })

  it('rejects a second exception on the same date', async () => {
    const resourceId = await insertResource()
    const values = {
      tenant_id: tenantId,
      resource_id: resourceId,
      date: '2026-07-20',
      start_time: null,
      end_time: null,
    }
    await getTestDb().insertInto('schedule_exceptions').values(values).execute()

    await expect(
      getTestDb().insertInto('schedule_exceptions').values(values).execute(),
    ).rejects.toThrow(/resource_date_unique/)
  })

  it('allows the same date on different resources', async () => {
    const first = await insertResource()
    const second = await insertResource()

    for (const resourceId of [first, second]) {
      await getTestDb()
        .insertInto('schedule_exceptions')
        .values({
          tenant_id: tenantId,
          resource_id: resourceId,
          date: '2026-07-20',
          start_time: null,
          end_time: null,
        })
        .execute()
    }

    expect(await getTestDb().selectFrom('schedule_exceptions').selectAll().execute()).toHaveLength(
      2,
    )
  })

  it.each(['schedule', 'schedule_exceptions'] as const)(
    'rejects a %s row referencing no resource',
    async (table) => {
      const orphan =
        table === 'schedule'
          ? { day_of_week: 0, start_time: null, end_time: null }
          : { date: '2026-07-20', start_time: null, end_time: null }

      await expect(
        getTestDb()
          .insertInto(table)
          .values({
            tenant_id: tenantId,
            resource_id: '00000000-0000-0000-0000-000000000000',
            ...orphan,
          } as never)
          .execute(),
      ).rejects.toThrow(/foreign key|violates/i)
    },
  )

  it('cascades deletion to schedule and exceptions', async () => {
    const resourceId = await insertResource()
    await getTestDb()
      .insertInto('schedule')
      .values({
        tenant_id: tenantId,
        resource_id: resourceId,
        day_of_week: 0,
        start_time: '09:00',
        end_time: '17:00',
      })
      .execute()
    await getTestDb()
      .insertInto('schedule_exceptions')
      .values({
        tenant_id: tenantId,
        resource_id: resourceId,
        date: '2026-07-20',
        start_time: null,
        end_time: null,
      })
      .execute()

    await getTestDb().deleteFrom('resources').where('id', '=', resourceId).execute()

    expect(await getTestDb().selectFrom('schedule').selectAll().execute()).toHaveLength(0)
    expect(await getTestDb().selectFrom('schedule_exceptions').selectAll().execute()).toHaveLength(
      0,
    )
  })
})

describe('defaults', () => {
  it('applies every column default', async () => {
    await insertResource()
    const row = await getTestDb().selectFrom('resources').selectAll().executeTakeFirstOrThrow()

    expect(row.is_active).toBe(true)
    expect(row.capacity).toBe(1)
    expect(row.slot_anchor_time).toBe('00:00:00')
    expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(row.created_at).toBeInstanceOf(Date)
    expect(row.updated_at).toBeInstanceOf(Date)
  })

  it('generates a distinct id per row', async () => {
    const ids = await Promise.all([insertResource(), insertResource(), insertResource()])
    expect(new Set(ids).size).toBe(3)
  })
})

describe('002_bookings', () => {
  it('creates the exclusion constraint that prevents overlapping bookings', async () => {
    const { rows } = await sql<{ conname: string }>`
      select conname from pg_constraint where conname = 'bookings_no_overlap'
    `.execute(getTestDb())
    expect(rows).toHaveLength(1)
  })

  it('refuses two active bookings that overlap on one resource', async () => {
    const db = getTestDb()
    const resource = await db
      .insertInto('resources')
      .values({
        tenant_id: tenantId,
        timezone: 'Europe/Warsaw',
        slot_duration: 'PT1H',
        concurrency_mode: 'exclusive',
      })
      .returning('id')
      .executeTakeFirstOrThrow()

    const booking = (start: string, end: string) => ({
      tenant_id: tenantId,
      resource_id: resource.id,
      start_time: start,
      end_time: end,
      status: 'confirmed' as const,
      customer_id: 'c-1',
      held_until: null,
      concurrency_mode: 'exclusive' as const,
    })

    await db
      .insertInto('bookings')
      .values(booking('2026-07-20T09:00:00Z', '2026-07-20T10:00:00Z'))
      .execute()

    await expect(
      db
        .insertInto('bookings')
        .values(booking('2026-07-20T09:30:00Z', '2026-07-20T10:30:00Z'))
        .execute(),
    ).rejects.toThrow(/bookings_no_overlap/)
  })

  it('accepts two bookings that merely touch', async () => {
    const db = getTestDb()
    const resource = await db
      .insertInto('resources')
      .values({
        tenant_id: tenantId,
        timezone: 'Europe/Warsaw',
        slot_duration: 'PT1H',
        concurrency_mode: 'exclusive',
      })
      .returning('id')
      .executeTakeFirstOrThrow()

    await db
      .insertInto('bookings')
      .values([
        {
          tenant_id: tenantId,
          resource_id: resource.id,
          start_time: '2026-07-20T09:00:00Z',
          end_time: '2026-07-20T10:00:00Z',
          status: 'confirmed',
          customer_id: 'c-1',
          held_until: null,
          concurrency_mode: 'exclusive',
        },
        {
          tenant_id: tenantId,
          resource_id: resource.id,
          start_time: '2026-07-20T10:00:00Z',
          end_time: '2026-07-20T11:00:00Z',
          status: 'confirmed',
          customer_id: 'c-2',
          held_until: null,
          concurrency_mode: 'exclusive',
        },
      ])
      .execute()

    const { rows } = await sql<{ count: string }>`select count(*) from bookings`.execute(db)
    expect(rows[0]!.count).toBe('2')
  })

  it('lets two overlapping shared bookings coexist', async () => {
    const db = getTestDb()
    const resource = await db
      .insertInto('resources')
      .values({
        tenant_id: tenantId,
        timezone: 'Europe/Warsaw',
        slot_duration: 'PT1H',
        concurrency_mode: 'shared',
        capacity: 2,
      })
      .returning('id')
      .executeTakeFirstOrThrow()

    // The exclusion constraint must not govern these rows: their invariant is a count,
    // enforced in the service under the row lock.
    await db
      .insertInto('bookings')
      .values([
        {
          tenant_id: tenantId,
          resource_id: resource.id,
          start_time: '2026-07-20T09:00:00Z',
          end_time: '2026-07-20T10:00:00Z',
          status: 'confirmed',
          customer_id: 'c-1',
          held_until: null,
          concurrency_mode: 'shared',
        },
        {
          tenant_id: tenantId,
          resource_id: resource.id,
          start_time: '2026-07-20T09:00:00Z',
          end_time: '2026-07-20T10:00:00Z',
          status: 'confirmed',
          customer_id: 'c-2',
          held_until: null,
          concurrency_mode: 'shared',
        },
      ])
      .execute()

    const { rows } = await sql<{ count: string }>`select count(*) from bookings`.execute(db)
    expect(rows[0]!.count).toBe('2')
  })

  it('still refuses two overlapping exclusive bookings', async () => {
    const db = getTestDb()
    const resource = await db
      .insertInto('resources')
      .values({
        tenant_id: tenantId,
        timezone: 'Europe/Warsaw',
        slot_duration: 'PT1H',
        concurrency_mode: 'exclusive',
      })
      .returning('id')
      .executeTakeFirstOrThrow()

    const booking = (customer: string) => ({
      tenant_id: tenantId,
      resource_id: resource.id,
      start_time: '2026-07-20T09:00:00Z',
      end_time: '2026-07-20T10:00:00Z',
      status: 'confirmed' as const,
      customer_id: customer,
      held_until: null,
      concurrency_mode: 'exclusive' as const,
    })

    await db.insertInto('bookings').values(booking('c-1')).execute()
    await expect(db.insertInto('bookings').values(booking('c-2')).execute()).rejects.toThrow(
      /bookings_no_overlap/,
    )
  })

  it('requires held_until exactly on held and expired rows', async () => {
    const db = getTestDb()
    const resource = await db
      .insertInto('resources')
      .values({
        tenant_id: tenantId,
        timezone: 'UTC',
        slot_duration: 'PT1H',
        concurrency_mode: 'exclusive',
      })
      .returning('id')
      .executeTakeFirstOrThrow()

    await expect(
      db
        .insertInto('bookings')
        .values({
          tenant_id: tenantId,
          resource_id: resource.id,
          start_time: '2026-07-20T09:00:00Z',
          end_time: '2026-07-20T10:00:00Z',
          status: 'confirmed',
          customer_id: 'c-1',
          held_until: '2026-07-20T08:00:00Z',
          concurrency_mode: 'exclusive',
        })
        .execute(),
    ).rejects.toThrow(/bookings_held_until_matches_status/)
  })

  it('refuses to delete a resource that has bookings', async () => {
    const db = getTestDb()
    const resource = await db
      .insertInto('resources')
      .values({
        tenant_id: tenantId,
        timezone: 'UTC',
        slot_duration: 'PT1H',
        concurrency_mode: 'exclusive',
      })
      .returning('id')
      .executeTakeFirstOrThrow()

    await db
      .insertInto('bookings')
      .values({
        tenant_id: tenantId,
        resource_id: resource.id,
        start_time: '2026-07-20T09:00:00Z',
        end_time: '2026-07-20T10:00:00Z',
        status: 'cancelled',
        customer_id: 'c-1',
        held_until: null,
        concurrency_mode: 'exclusive',
      })
      .execute()

    await expect(
      db.deleteFrom('resources').where('id', '=', resource.id).execute(),
    ).rejects.toThrow()
  })
})

describe('tenancy', () => {
  it.each(['tenants', 'api_keys'])('creates the %s table', async (table) => {
    const result = await sql<{ count: string }>`
      select count(*)::text as count from information_schema.tables
      where table_schema = 'public' and table_name = ${table}
    `.execute(getTestDb())
    expect(result.rows[0]!.count).toBe('1')
  })

  it('puts a non-null tenant_id on all four owned tables', async () => {
    const columns = await sql<{ table_name: string; is_nullable: string }>`
      select table_name, is_nullable from information_schema.columns
      where table_schema = 'public' and column_name = 'tenant_id'
        and table_name in ('resources', 'schedule', 'schedule_exceptions', 'bookings')
    `.execute(getTestDb())

    expect(Object.fromEntries(columns.rows.map((r) => [r.table_name, r.is_nullable]))).toEqual({
      resources: 'NO',
      schedule: 'NO',
      schedule_exceptions: 'NO',
      bookings: 'NO',
    })
  })

  it('makes customer_id nullable', async () => {
    const column = await sql<{ is_nullable: string }>`
      select is_nullable from information_schema.columns
      where table_name = 'bookings' and column_name = 'customer_id'
    `.execute(getTestDb())
    expect(column.rows[0]?.is_nullable).toBe('YES')
  })

  // The check constraint and src/shared/scopes.ts are two copies of one list. This is what
  // fails when they drift.
  it('permits exactly the scopes the code knows', async () => {
    const db = getTestDb()

    await expect(
      db
        .insertInto('api_keys')
        .values({
          tenant_id: tenantId,
          name: 'all',
          key_prefix: 'probe001',
          key_hash: 'x',
          scopes: [...SCOPES],
        })
        .execute(),
    ).resolves.toBeDefined()

    await expect(
      db
        .insertInto('api_keys')
        .values({
          tenant_id: tenantId,
          name: 'bogus',
          key_prefix: 'probe002',
          key_hash: 'x',
          scopes: ['bookings.destroy'] as unknown as Scope[],
        })
        .execute(),
    ).rejects.toThrow()
  })

  it('refuses a key with no scopes at all', async () => {
    await expect(
      getTestDb()
        .insertInto('api_keys')
        .values({
          tenant_id: tenantId,
          name: 'empty',
          key_prefix: 'probe003',
          key_hash: 'x',
          scopes: [],
        })
        .execute(),
    ).rejects.toThrow()
  })

  // The guarantee the composite foreign keys exist for. One typed insert per table, because
  // `insertInto` over a union of table names cannot type the columns each one needs.
  const insertFor = {
    schedule: (tenant_id: string, resource_id: string) =>
      getTestDb()
        .insertInto('schedule')
        .values({ tenant_id, resource_id, day_of_week: 0, start_time: '09:00', end_time: '17:00' })
        .execute(),
    schedule_exceptions: (tenant_id: string, resource_id: string) =>
      getTestDb()
        .insertInto('schedule_exceptions')
        .values({ tenant_id, resource_id, date: '2026-09-01', start_time: null, end_time: null })
        .execute(),
    bookings: (tenant_id: string, resource_id: string) =>
      getTestDb()
        .insertInto('bookings')
        .values({
          tenant_id,
          resource_id,
          start_time: '2026-09-01T09:00:00Z',
          end_time: '2026-09-01T10:00:00Z',
          status: 'confirmed',
          customer_id: 'c-1',
          held_until: null,
          concurrency_mode: 'exclusive',
        })
        .execute(),
  }

  it.each(['schedule', 'schedule_exceptions', 'bookings'] as const)(
    'refuses a %s row whose tenant disagrees with its resource',
    async (table) => {
      const other = await seedTenantId('other')
      const resourceId = await insertResource()
      await expect(insertFor[table](other, resourceId)).rejects.toThrow()
    },
  )
})

describe('004_pools', () => {
  it('accepts a member whose pool is in the same tenant', async () => {
    const poolId = await insertResource({ concurrency_mode: 'pool' })
    const memberId = await insertResource({ pool_id: poolId })
    const row = await getTestDb()
      .selectFrom('resources')
      .select('pool_id')
      .where('id', '=', memberId)
      .executeTakeFirstOrThrow()
    expect(row.pool_id).toBe(poolId)
  })

  it('refuses a member whose pool belongs to another tenant', async () => {
    const otherTenant = await seedTenantId('other tenant')
    const poolId = await insertResource({ concurrency_mode: 'pool', tenant_id: otherTenant })
    await expect(insertResource({ pool_id: poolId })).rejects.toThrow(/resources_pool_fk/)
  })

  it('refuses a row that points at itself', async () => {
    const id = await insertResource({})
    await expect(
      getTestDb().updateTable('resources').set({ pool_id: id }).where('id', '=', id).execute(),
    ).rejects.toThrow(/resources_pool_not_self/)
  })

  it('refuses to delete a pool that still has members', async () => {
    const poolId = await insertResource({ concurrency_mode: 'pool' })
    await insertResource({ pool_id: poolId })
    await expect(
      getTestDb().deleteFrom('resources').where('id', '=', poolId).execute(),
    ).rejects.toThrow(/resources_pool_fk/)
  })
})
