import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { TIMEZONES } from '../fixtures/resources.js'
import { validDurations } from '../fixtures/datasets/durations.js'
import { closeTestDb, getTestDb, resetDb } from './helpers.js'

beforeEach(resetDb)
afterAll(closeTestDb)

async function insertResource(overrides: Record<string, unknown> = {}): Promise<string> {
  const row = await getTestDb()
    .insertInto('resources')
    .values({
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
        .values({ resource_id: resourceId, date, start_time: null, end_time: null })
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
      .values({ resource_id: resourceId, day_of_week: 0, start_time: '09:00', end_time: '17:00' })
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
        .values({ resource_id: resourceId, ...values })
        .execute(),
    ).rejects.toThrow(constraint)
  })

  it('rejects a second exception on the same date', async () => {
    const resourceId = await insertResource()
    const values = { resource_id: resourceId, date: '2026-07-20', start_time: null, end_time: null }
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
        .values({ resource_id: resourceId, date: '2026-07-20', start_time: null, end_time: null })
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
          .values({ resource_id: '00000000-0000-0000-0000-000000000000', ...orphan } as never)
          .execute(),
      ).rejects.toThrow(/foreign key|violates/i)
    },
  )

  it('cascades deletion to schedule and exceptions', async () => {
    const resourceId = await insertResource()
    await getTestDb()
      .insertInto('schedule')
      .values({ resource_id: resourceId, day_of_week: 0, start_time: '09:00', end_time: '17:00' })
      .execute()
    await getTestDb()
      .insertInto('schedule_exceptions')
      .values({ resource_id: resourceId, date: '2026-07-20', start_time: null, end_time: null })
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
