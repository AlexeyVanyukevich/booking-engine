import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Api } from '../fixtures/api.js'
import { withAuthorization, injectTransport } from '../fixtures/transport.js'
import { rejectedMemberships } from '../fixtures/datasets/pool-membership.js'
import {
  poolAvailabilityCases,
  wholeWeek,
  type PoolAvailabilityCase,
} from '../fixtures/datasets/pool-availability.js'
import { buildTestApp, closeTestDb, resetDbWithTenant, testAuthorization } from './helpers.js'

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

  // Depends on Task 6 (booking a pool). Un-skipped there.
  it.skip('marks a slot unavailable once every member is booked', async () => {
    const pool = await aPoolWith([{ windows: wholeWeek }, { windows: wholeWeek }])
    const night = {
      start_time: '2026-07-20T14:00:00+02:00',
      end_time: '2026-07-21T14:00:00+02:00',
    }
    expect((await api.createBooking(pool.id, night)).statusCode).toBe(201)
    expect(
      (await api.getAvailability(pool.id, '2026-07-20', '2026-07-21')).json().slots[0].available,
    ).toBe(true)
    expect((await api.createBooking(pool.id, night)).statusCode).toBe(201)
    expect(
      (await api.getAvailability(pool.id, '2026-07-20', '2026-07-21')).json().slots[0].available,
    ).toBe(false)
  })
})
