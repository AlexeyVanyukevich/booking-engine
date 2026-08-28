import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Api } from '../fixtures/api.js'
import { withAuthorization, injectTransport } from '../fixtures/transport.js'
import { rejectedMemberships } from '../fixtures/datasets/pool-membership.js'
import {
  poolAvailabilityCases,
  wholeWeek,
  type PoolAvailabilityCase,
} from '../fixtures/datasets/pool-availability.js'
import { dayAfter, fallBacks } from '../fixtures/datasets/dst.js'
import { sql } from 'kysely'
import {
  buildTestApp,
  closeTestDb,
  getTestDb,
  resetDbWithTenant,
  testAuthorization,
} from './helpers.js'

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
  const pool = (await api.createResource(poolBase)).json()
  const memberIds: string[] = []

  for (const spec of members) {
    const member = (await api.createResource({ ...memberBase, pool_id: pool.id })).json()

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
    const pool = (await api.createResource(poolBase)).json()
    const member = await api.createResource({ ...memberBase, pool_id: pool.id })
    expect(member.statusCode).toBe(201)
    expect(member.json().pool_id).toBe(pool.id)
  })

  it.each(rejectedMemberships)('refuses when $name', async ({ member, pool, rule }) => {
    const created = (await api.createResource({ ...poolBase, ...pool })).json()
    const response = await api.createResource({ ...memberBase, ...member, pool_id: created.id })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('invalid_pool_membership')
    expect(response.json().details).toMatchObject({ rule })
  })

  it('refuses a pool created with a capacity other than 1', async () => {
    const response = await api.createResource({ ...poolBase, capacity: 3 })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('validation_error')
  })

  it('lets a member leave its pool', async () => {
    const pool = (await api.createResource(poolBase)).json()
    const member = (await api.createResource({ ...memberBase, pool_id: pool.id })).json()
    const patched = await api.patchResource(member.id, { pool_id: null })
    expect(patched.statusCode).toBe(200)
    expect(patched.json().pool_id).toBeNull()
  })

  it('refuses to delete a pool that still has members', async () => {
    const pool = (await api.createResource(poolBase)).json()
    await api.createResource({ ...memberBase, pool_id: pool.id })
    const response = await api.deleteResource(pool.id)
    expect(response.statusCode).toBe(409)
    expect(response.json().error).toBe('pool_has_members')
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
    const pool = (await api.createResource(poolBase)).json()
    const response = await call(pool.id)
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('validation_error')
    expect(response.json().message).toMatch(/pool/i)
  })

  it('still serves a schedule read on a pool, as an empty list', async () => {
    const pool = (await api.createResource(poolBase)).json()
    expect((await api.getSchedule(pool.id)).json()).toEqual([])
  })

  it.each(poolAvailabilityCases)('$name', async (scenario) => {
    const pool = await aPoolWith(scenario.members)
    const slots = (await api.getAvailability(pool.id, scenario.from, scenario.to)).json().slots
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
    ).json()
    const member = (
      await api.createResource({
        timezone: warsawFallBack.zone,
        slot_duration: 'PT30M',
        concurrency_mode: 'exclusive',
        pool_id: pool.id,
      })
    ).json()

    // A window straddling the transition instant: local 01:00-04:00 covers the repeated
    // 02:00-03:00 hour, which real time walks through twice at two different offsets.
    await api.putException(member.id, {
      date: warsawFallBack.date,
      start_time: '01:00',
      end_time: '04:00',
    })

    const slots = (
      await api.getAvailability(pool.id, warsawFallBack.date, dayAfter(warsawFallBack.date))
    ).json().slots as Slot[]
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
      (await api.getAvailability(pool.id, '2026-07-20', '2026-07-21')).json().slots[0].available,
    ).toBe(true)
    expect((await api.createBooking(pool.id, night)).statusCode).toBe(201)
    expect(
      (await api.getAvailability(pool.id, '2026-07-20', '2026-07-21')).json().slots[0].available,
    ).toBe(false)
  })

  describe('booking a pool', () => {
    it('books a member and reports the member as resource_id', async () => {
      const pool = await aPoolWith([{ windows: wholeWeek }])
      const response = await api.createBooking(pool.id, night)
      expect(response.statusCode).toBe(201)
      expect(response.json().resource_id).toBe(pool.memberIds[0])
    })

    it('answers outside_schedule when no member offers the run', async () => {
      const pool = await aPoolWith([{ windows: [] }])
      const response = await api.createBooking(pool.id, night)
      expect(response.statusCode).toBe(400)
      expect(response.json().error).toBe('outside_schedule')
    })

    it('answers slot_unavailable when every member that offers it is taken', async () => {
      const pool = await aPoolWith([{ windows: wholeWeek }])
      expect((await api.createBooking(pool.id, night)).statusCode).toBe(201)
      const second = await api.createBooking(pool.id, night)
      expect(second.statusCode).toBe(409)
      expect(second.json().error).toBe('slot_unavailable')
    })

    it('gives two concurrent bookings different members', async () => {
      const pool = await aPoolWith([{ windows: wholeWeek }, { windows: wholeWeek }])
      const [a, b] = await Promise.all([
        api.createBooking(pool.id, night),
        api.createBooking(pool.id, night),
      ])
      expect([a.statusCode, b.statusCode].sort()).toEqual([201, 201])
      expect(a.json().resource_id).not.toBe(b.json().resource_id)
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
      ).json()
      await expireHold(held.id)
      expect((await api.createBooking(pool.id, night)).statusCode).toBe(201)
    })
  })
})
