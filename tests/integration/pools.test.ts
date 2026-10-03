import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Api } from '../fixtures/api.js'
import {
  withAuthorization,
  injectTransport,
  type TransportResponse,
} from '../fixtures/transport.js'
import {
  rejectedMemberships,
  rejectedPoolGridPatches,
} from '../fixtures/datasets/pool-membership.js'
import {
  poolAvailabilityCases,
  wholeWeek,
  type PoolAvailabilityCase,
} from '../fixtures/datasets/pool-availability.js'
import { dayAfter, fallBacks } from '../fixtures/datasets/dst.js'
import { sql } from 'kysely'
import { WEEKDAYS, aWindow } from '../fixtures/schedules.js'
import {
  buildTestApp,
  closeTestDb,
  getTestDb,
  resetDbWithTenant,
  testAuthorization,
} from './helpers.js'
import type {
  AvailabilityResponse,
  BookingResponse,
  ErrorResponse,
  ResourceResponse,
  ScheduleResponse,
} from '../fixtures/bodies.js'

let api: Api
let close: () => Promise<void>

beforeAll(async () => {
  const app = await buildTestApp()
  api = new Api(withAuthorization(injectTransport(app), testAuthorization))
  close = async () => {
    await app.close()
  }
})

beforeEach(resetDbWithTenant)

afterAll(async () => {
  await close()
  await closeTestDb()
})

const poolBase = {
  timezone: 'Europe/Warsaw',
  slot_duration: 'P1D',
  slot_anchor_time: '14:00',
  concurrency_mode: 'pool' as const,
}
const memberBase = { ...poolBase, concurrency_mode: 'exclusive' as const }

/** One day-based slot on the pool's own grid — 2026-07-20 is a Monday. */
const night = {
  start_time: '2026-07-20T14:00:00+02:00',
  end_time: '2026-07-21T14:00:00+02:00',
}

/** As `bookings.test.ts`'s own `expireHold`: backdated against the database's clock. */
async function expireHold(id: string): Promise<void> {
  await getTestDb()
    .updateTable('bookings')
    .set({ held_until: sql<Date>`now() - interval '1 minute'` })
    .where('id', '=', id)
    .execute()
}

interface Slot {
  start: string
  end: string
  available: boolean
}

/** A pool plus one member per entry, each with its own windows, days off and active flag. */
async function aPoolWith(
  members: PoolAvailabilityCase['members'],
): Promise<{ id: string; memberIds: string[] }> {
  const pool = (await api.createResource(poolBase)).json<ResourceResponse>()
  const memberIds: string[] = []

  for (const spec of members) {
    const member = (
      await api.createResource({ ...memberBase, pool_id: pool.id })
    ).json<ResourceResponse>()

    await api.putSchedule(
      member.id,
      spec.windows.map(([day_of_week, start_time, end_time]) => ({
        day_of_week,
        start_time,
        end_time,
      })),
    )

    for (const date of spec.daysOff ?? []) {
      await api.putException(member.id, { date, start_time: null, end_time: null })
    }

    // Last, so the schedule writes above are not refused on an inactive resource.
    if (spec.active === false) await api.patchResource(member.id, { is_active: false })

    memberIds.push(member.id)
  }

  return { id: pool.id, memberIds }
}

describe('pools', () => {
  it('accepts a member that matches its pool', async () => {
    const pool = (await api.createResource(poolBase)).json<ResourceResponse>()
    const member = await api.createResource({ ...memberBase, pool_id: pool.id })
    expect(member.statusCode).toBe(201)
    expect(member.json<ResourceResponse>().pool_id).toBe(pool.id)
  })

  it.each(rejectedMemberships)('refuses when $name', async ({ member, pool, rule }) => {
    const created = (await api.createResource({ ...poolBase, ...pool })).json<ResourceResponse>()
    const response = await api.createResource({ ...memberBase, ...member, pool_id: created.id })
    expect(response.statusCode).toBe(400)
    expect(response.json<ErrorResponse>().error).toBe('invalid_pool_membership')
    expect(response.json<ErrorResponse>().details).toMatchObject({ rule })
  })

  /**
   * The same dataset through `PATCH`. Membership is mutable — spec 3 §3 explains why — so the
   * four rules have to hold on the patch path as well as on create, and the rows above were
   * only ever driven through `POST`. The joining resource is created standalone first and then
   * repointed, since `concurrency_mode` and `timezone` cannot be patched.
   */
  it.each(rejectedMemberships)(
    'refuses a patch joining a pool when $name',
    async ({ member, pool, rule }) => {
      const created = (await api.createResource({ ...poolBase, ...pool })).json<ResourceResponse>()
      const joining = (
        await api.createResource({ ...memberBase, ...member })
      ).json<ResourceResponse>()
      const response = await api.patchResource(joining.id, { pool_id: created.id })
      expect(response.statusCode).toBe(400)
      expect(response.json<ErrorResponse>().error).toBe('invalid_pool_membership')
      expect(response.json<ErrorResponse>().details).toMatchObject({ rule })
    },
  )

  /**
   * Rule 4 read from the pool's side. The grid invariant is consulted from two different rows —
   * `computeForPool` generates slots with the pool's duration and anchor, while the booking path
   * validates against the member's — so a pool free to move its own grid can advertise a slot it
   * then refuses to book.
   */
  it.each(rejectedPoolGridPatches)(
    'refuses a patch to a pool that has members when $name',
    async ({ patch, fields }) => {
      const pool = (await api.createResource(poolBase)).json<ResourceResponse>()
      await api.createResource({ ...memberBase, pool_id: pool.id })

      const response = await api.patchResource(pool.id, patch)
      expect(response.statusCode).toBe(400)
      expect(response.json<ErrorResponse>().error).toBe('invalid_pool_membership')
      expect(response.json<ErrorResponse>().details).toMatchObject({
        rule: 'grid',
        fields,
        pool_id: pool.id,
      })
    },
  )

  it.each(rejectedPoolGridPatches)(
    'accepts the same patch on a pool with no members when $name',
    async ({ patch }) => {
      const pool = (await api.createResource(poolBase)).json<ResourceResponse>()
      expect((await api.patchResource(pool.id, patch)).statusCode).toBe(200)
    },
  )

  /** An inactive member can be reactivated, so it still holds the pool's grid in place. */
  it('refuses a grid patch on a pool whose only member is inactive', async () => {
    const pool = (await api.createResource(poolBase)).json<ResourceResponse>()
    const member = (
      await api.createResource({ ...memberBase, pool_id: pool.id })
    ).json<ResourceResponse>()
    await api.patchResource(member.id, { is_active: false })

    const response = await api.patchResource(pool.id, { slot_duration: 'P7D' })
    expect(response.statusCode).toBe(400)
    expect(response.json<ErrorResponse>().error).toBe('invalid_pool_membership')
  })

  /** A patch that leaves the grid alone is not a membership question at all. */
  it('still accepts a non-grid patch on a pool that has members', async () => {
    const pool = (await api.createResource(poolBase)).json<ResourceResponse>()
    await api.createResource({ ...memberBase, pool_id: pool.id })
    expect((await api.patchResource(pool.id, { is_active: false })).statusCode).toBe(200)
  })

  it('refuses a pool created with a capacity other than 1', async () => {
    const response = await api.createResource({ ...poolBase, capacity: 3 })
    expect(response.statusCode).toBe(400)
    expect(response.json<ErrorResponse>().error).toBe('validation_error')
  })

  it('lets a member leave its pool', async () => {
    const pool = (await api.createResource(poolBase)).json<ResourceResponse>()
    const member = (
      await api.createResource({ ...memberBase, pool_id: pool.id })
    ).json<ResourceResponse>()
    const patched = await api.patchResource(member.id, { pool_id: null })
    expect(patched.statusCode).toBe(200)
    expect(patched.json<ResourceResponse>().pool_id).toBeNull()
  })

  it('refuses to delete a pool that still has members', async () => {
    const pool = (await api.createResource(poolBase)).json<ResourceResponse>()
    await api.createResource({ ...memberBase, pool_id: pool.id })
    const response = await api.deleteResource(pool.id)
    expect(response.statusCode).toBe(409)
    expect(response.json<ErrorResponse>().error).toBe('pool_has_members')
  })

  it.each([
    {
      name: 'a schedule',
      call: (id: string) =>
        api.putSchedule(id, [{ day_of_week: 0, start_time: null, end_time: null }]),
    },
    {
      name: 'an exception',
      call: (id: string) =>
        api.putException(id, { date: '2026-09-01', start_time: null, end_time: null }),
    },
  ])('refuses $name on a pool', async ({ call }) => {
    const pool = (await api.createResource(poolBase)).json<ResourceResponse>()
    const response = await call(pool.id)
    expect(response.statusCode).toBe(400)
    expect(response.json<ErrorResponse>().error).toBe('validation_error')
    expect(response.json<ErrorResponse>().message).toMatch(/pool/i)
  })

  it('still serves a schedule read on a pool, as an empty list', async () => {
    const pool = (await api.createResource(poolBase)).json<ResourceResponse>()
    expect((await api.getSchedule(pool.id)).json<ScheduleResponse>()).toEqual([])
  })

  it.each(poolAvailabilityCases)('$name', async (scenario) => {
    const pool = await aPoolWith(scenario.members)
    const slots = (
      await api.getAvailability(pool.id, scenario.from, scenario.to)
    ).json<AvailabilityResponse>().slots
    expect(slots.filter((s: Slot) => s.available).map((s: Slot) => s.start)).toEqual(
      scenario.availableStarts,
    )
  })

  /**
   * Regression for the pool merge step sorting slot starts by their ISO-8601 *string* rather
   * than the instant they denote. During a fall-back transition an intraday window straddling
   * the ambiguous hour produces two slots with the same local wall-clock label at different
   * offsets — e.g. `02:00+02:00` and `02:00+01:00` — and `'+01:00' < '+02:00'` lexicographically
   * even though the `+02:00` instant comes first in real time. A single-resource query never
   * shows this: `generateSlots` already sorts by instant. A pool does, because `computeForPool`
   * merges each member's (correctly-sorted) slots into a map and re-sorts the result.
   *
   * The transition date and offsets come from `dst-transitions.json` — see
   * `docs/conventions.md` on deriving facts about the outside world from the tz database rather
   * than memory — not hardcoded here.
   */
  it("orders a pool's slots by the instant each denotes, not by the offset digits in its ISO string", async () => {
    const warsawFallBack = fallBacks.find((t) => t.zone === 'Europe/Warsaw')!

    const pool = (
      await api.createResource({
        timezone: warsawFallBack.zone,
        slot_duration: 'PT30M',
        concurrency_mode: 'pool',
      })
    ).json<ResourceResponse>()
    const member = (
      await api.createResource({
        timezone: warsawFallBack.zone,
        slot_duration: 'PT30M',
        concurrency_mode: 'exclusive',
        pool_id: pool.id,
      })
    ).json<ResourceResponse>()

    // A window straddling the transition instant: local 01:00-04:00 covers the repeated
    // 02:00-03:00 hour, which real time walks through twice at two different offsets.
    await api.putException(member.id, {
      date: warsawFallBack.date,
      start_time: '01:00',
      end_time: '04:00',
    })

    const slots = (
      await api.getAvailability(pool.id, warsawFallBack.date, dayAfter(warsawFallBack.date))
    ).json<AvailabilityResponse>().slots as Slot[]
    const starts = slots.map((slot) => slot.start)

    // Not vacuous: the ambiguous hour really did produce slots at both offsets.
    expect(starts.some((s) => s.endsWith(warsawFallBack.offsetBefore))).toBe(true)
    expect(starts.some((s) => s.endsWith(warsawFallBack.offsetAfter))).toBe(true)

    expect(starts).toEqual([...starts].sort((a, b) => Date.parse(a) - Date.parse(b)))
  })

  it('marks a slot unavailable once every member is booked', async () => {
    const pool = await aPoolWith([{ windows: wholeWeek }, { windows: wholeWeek }])
    expect((await api.createBooking(pool.id, night)).statusCode).toBe(201)
    expect(
      (await api.getAvailability(pool.id, '2026-07-20', '2026-07-21')).json<AvailabilityResponse>()
        .slots[0]?.available,
    ).toBe(true)
    expect((await api.createBooking(pool.id, night)).statusCode).toBe(201)
    expect(
      (await api.getAvailability(pool.id, '2026-07-20', '2026-07-21')).json<AvailabilityResponse>()
        .slots[0]?.available,
    ).toBe(false)
  })

  describe('booking a pool', () => {
    it('books a member and reports the member as resource_id', async () => {
      const pool = await aPoolWith([{ windows: wholeWeek }])
      const response = await api.createBooking(pool.id, night)
      expect(response.statusCode).toBe(201)
      expect(response.json<BookingResponse>().resource_id).toBe(pool.memberIds[0])
    })

    /**
     * A member with no windows at all never starts a slot anywhere — the pool has to answer
     * as that member would for a single-resource booking (`invalid_slot_boundary`, matching
     * TC-BK-R04 "a date the resource does not work"), not `outside_schedule`: nothing here was
     * ever offered to begin with, so there is no run to say "not fully offered".
     */
    it('answers invalid_slot_boundary when no member ever has a slot starting there', async () => {
      const pool = await aPoolWith([{ windows: [] }])
      const response = await api.createBooking(pool.id, night)
      expect(response.statusCode).toBe(400)
      expect(response.json<ErrorResponse>().error).toBe('invalid_slot_boundary')
    })

    it('answers slot_unavailable when every member that offers it is taken', async () => {
      const pool = await aPoolWith([{ windows: wholeWeek }])
      expect((await api.createBooking(pool.id, night)).statusCode).toBe(201)
      const second = await api.createBooking(pool.id, night)
      expect(second.statusCode).toBe(409)
      expect(second.json<ErrorResponse>().error).toBe('slot_unavailable')
    })

    it('gives two concurrent bookings different members', async () => {
      const pool = await aPoolWith([{ windows: wholeWeek }, { windows: wholeWeek }])
      const [a, b] = await Promise.all([
        api.createBooking(pool.id, night),
        api.createBooking(pool.id, night),
      ])
      expect([a.statusCode, b.statusCode].sort()).toEqual([201, 201])
      expect(a.json<BookingResponse>().resource_id).not.toBe(b.json<BookingResponse>().resource_id)
    })

    it('gives the last free member to exactly one of two racing requests', async () => {
      const pool = await aPoolWith([{ windows: wholeWeek }])
      const [a, b] = await Promise.all([
        api.createBooking(pool.id, night),
        api.createBooking(pool.id, night),
      ])
      expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409])
    })

    it('frees a member whose hold has expired, without waiting for the sweeper', async () => {
      const pool = await aPoolWith([{ windows: wholeWeek }])
      const held = (
        await api.createBooking(pool.id, { ...night, hold: true, hold_minutes: 10 })
      ).json<BookingResponse>()
      await expireHold(held.id)
      expect((await api.createBooking(pool.id, night)).statusCode).toBe(201)
    })

    /**
     * A pool answers as its members do (`docs/conventions.md`'s `invalid_slot_boundary` vs
     * `outside_schedule` distinction, applied to a set of members rather than one resource):
     * `09:30-10:30` is off the hourly grid entirely — no member's schedule ever starts a slot
     * there — while `11:00-13:00` starts on a boundary the member's window offers, but the
     * window (09:00-12:00) does not cover the whole run.
     */
    describe('a pool whose one member is open Mon 09:00-12:00, hourly', () => {
      async function anHourlyPool(): Promise<{ id: string }> {
        const pool = (
          await api.createResource({
            timezone: 'Europe/Warsaw',
            slot_duration: 'PT1H',
            concurrency_mode: 'pool',
          })
        ).json<ResourceResponse>()
        const member = (
          await api.createResource({
            timezone: 'Europe/Warsaw',
            slot_duration: 'PT1H',
            concurrency_mode: 'exclusive',
            pool_id: pool.id,
          })
        ).json<ResourceResponse>()
        await api.putSchedule(member.id, [aWindow(WEEKDAYS.monday, '09:00', '12:00')])
        return { id: pool.id }
      }

      it('answers invalid_slot_boundary for a start off the grid', async () => {
        const pool = await anHourlyPool()
        const response = await api.createBooking(pool.id, {
          start_time: '2026-07-20T09:30:00+02:00',
          end_time: '2026-07-20T10:30:00+02:00',
        })
        expect(response.statusCode).toBe(400)
        expect(response.json<ErrorResponse>().error).toBe('invalid_slot_boundary')
      })

      it('answers outside_schedule for a run starting on the grid but extending past the window', async () => {
        const pool = await anHourlyPool()
        const response = await api.createBooking(pool.id, {
          start_time: '2026-07-20T11:00:00+02:00',
          end_time: '2026-07-20T13:00:00+02:00',
        })
        expect(response.statusCode).toBe(400)
        expect(response.json<ErrorResponse>().error).toBe('outside_schedule')
      })
    })
  })

  describe('idempotency across a pool', () => {
    it('replays an idempotency key against a pool to the same booking', async () => {
      const pool = await aPoolWith([{ windows: wholeWeek }, { windows: wholeWeek }])
      const first = await api.createBooking(pool.id, { ...night, idempotency_key: 'k-1' })
      const second = await api.createBooking(pool.id, { ...night, idempotency_key: 'k-1' })
      expect(first.statusCode).toBe(201)
      expect(second.statusCode).toBe(200)
      expect(second.json<BookingResponse>().id).toBe(first.json<BookingResponse>().id)
    })

    it('does not create a second booking on another member when a key is replayed concurrently', async () => {
      const pool = await aPoolWith([{ windows: wholeWeek }, { windows: wholeWeek }])
      const [a, b] = await Promise.all([
        api.createBooking(pool.id, { ...night, idempotency_key: 'k-2' }),
        api.createBooking(pool.id, { ...night, idempotency_key: 'k-2' }),
      ])
      expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201])
      expect(a.json<BookingResponse>().id).toBe(b.json<BookingResponse>().id)
    })

    it('refuses a replayed key describing a different booking', async () => {
      const pool = await aPoolWith([{ windows: wholeWeek }])
      await api.createBooking(pool.id, { ...night, idempotency_key: 'k-3' })
      const other = await api.createBooking(pool.id, {
        ...night,
        customer_id: 'someone-else',
        idempotency_key: 'k-3',
      })
      expect(other.statusCode).toBe(409)
      expect(other.json<ErrorResponse>().error).toBe('idempotency_key_reused')
    })
  })

  /**
   * The pool counterpart of `bookings.test.ts`'s "a resource changed while a booking is in
   * flight". `createInPool` reads `pool.is_active` near the top and then walks the members one
   * at a time before its transaction opens; a `PATCH` retiring the pool commits inside that
   * window, and only the row read inside the transaction can see it.
   *
   * The request carries an idempotency key because that is what makes the in-transaction read a
   * `SELECT … FOR UPDATE` — §5.3's parent-before-member lock. Without a key the pool row is read
   * unlocked, so there is nothing for this test to block on and nothing to serialize against.
   */
  describe('a pool changed while a booking is in flight', () => {
    it('refuses the booking when the pool was retired', async () => {
      const pool = await aPoolWith([{ windows: wholeWeek }])
      const pending: Array<Promise<TransportResponse>> = []

      await getTestDb()
        .transaction()
        .execute(async (trx) => {
          await trx
            .selectFrom('resources')
            .select('id')
            .where('id', '=', pool.id)
            .forUpdate()
            .execute()
          await trx
            .updateTable('resources')
            .set({ is_active: false })
            .where('id', '=', pool.id)
            .execute()
          pending.push(api.createBooking(pool.id, { ...night, idempotency_key: 'k-4' }))
          // Long enough for the request to read the pool, scan the members and then block on
          // the lock. The update above is still uncommitted, so the reads it makes on the way
          // there all see an active pool.
          await new Promise((resolve) => setTimeout(resolve, 150))
        })

      const response = await pending[0]!
      expect(response.statusCode).toBe(409)
      expect(response.json<ErrorResponse>().error).toBe('resource_inactive')

      // Not just refused: nothing landed on a member of a retired pool.
      const rows = await getTestDb().selectFrom('bookings').select('id').execute()
      expect(rows).toEqual([])
    })
  })
})
