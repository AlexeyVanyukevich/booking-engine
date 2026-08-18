import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { Api } from '../fixtures/api.js'
import { withAuthorization, injectTransport } from '../fixtures/transport.js'
import { unknownUuid } from '../fixtures/ids.js'
import { aResource, aSharedResource } from '../fixtures/resources.js'
import { WEEKDAYS, aWindow, everyDay, windowsOn } from '../fixtures/schedules.js'
import {
  availabilityScenarios,
  type AvailabilityScenario,
} from '../fixtures/datasets/availability-scenarios.js'
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

interface Slot {
  start: string
  end: string
  available: boolean
}

async function runScenario(scenario: AvailabilityScenario) {
  const id = await api.givenResource(scenario.resource)
  await api.givenSchedule(id, scenario.schedule)
  if (scenario.exceptions) await api.givenExceptions(id, scenario.exceptions)
  if (scenario.deactivate) await api.patchResource(id, { is_active: false })
  return api.getAvailability(id, scenario.from, scenario.to)
}

describe('GET /resources/:id/availability', () => {
  it.each(availabilityScenarios)('$name', async (scenario) => {
    const response = await runScenario(scenario)
    expect(response.statusCode).toBe(200)
    expect(response.json().slots.map((slot: Slot) => [slot.start, slot.end])).toEqual(
      scenario.expected,
    )
  })

  it.each(availabilityScenarios)('marks every slot available in $name', async (scenario) => {
    const response = await runScenario(scenario)
    for (const slot of response.json().slots as Slot[]) {
      // These scenarios create no bookings, so nothing has been subtracted.
      expect(slot.available).toBe(true)
    }
  })

  it.each(availabilityScenarios)('returns slots in ascending order in $name', async (scenario) => {
    const response = await runScenario(scenario)
    const starts = (response.json().slots as Slot[]).map((slot) => Date.parse(slot.start))
    expect(starts).toEqual([...starts].sort((a, b) => a - b))
  })

  it.each(availabilityScenarios)(
    'never ends a slot before it starts in $name',
    async (scenario) => {
      const response = await runScenario(scenario)
      for (const slot of response.json().slots as Slot[]) {
        expect(Date.parse(slot.end)).toBeGreaterThan(Date.parse(slot.start))
      }
    },
  )

  it('is unaffected by repeating the request', async () => {
    const id = await api.givenResource(aResource())
    await api.givenSchedule(id, [aWindow(WEEKDAYS.monday, '09:00', '12:00')])

    const first = await api.getAvailability(id, '2026-07-20', '2026-07-21')
    const second = await api.getAvailability(id, '2026-07-20', '2026-07-21')
    expect(second.json()).toEqual(first.json())
  })

  it('reflects a schedule change immediately', async () => {
    const id = await api.givenResource(aResource())
    await api.givenSchedule(id, [aWindow(WEEKDAYS.monday, '09:00', '12:00')])
    expect((await api.getAvailability(id, '2026-07-20', '2026-07-21')).json().slots).toHaveLength(3)

    await api.givenSchedule(id, [aWindow(WEEKDAYS.monday, '09:00', '10:00')])
    expect((await api.getAvailability(id, '2026-07-20', '2026-07-21')).json().slots).toHaveLength(1)
  })

  it('reflects reactivation', async () => {
    const id = await api.givenResource(aResource())
    await api.givenSchedule(id, [aWindow(WEEKDAYS.monday, '09:00', '12:00')])
    await api.patchResource(id, { is_active: false })
    expect((await api.getAvailability(id, '2026-07-20', '2026-07-21')).json().slots).toEqual([])

    await api.patchResource(id, { is_active: true })
    expect((await api.getAvailability(id, '2026-07-20', '2026-07-21')).json().slots).toHaveLength(3)
  })

  it('keeps resources independent', async () => {
    const busy = await api.givenResource(aResource())
    const idle = await api.givenResource(aResource())
    await api.givenSchedule(busy, windowsOn([0, 1, 2, 3, 4, 5, 6], '09:00', '10:00'))

    expect((await api.getAvailability(idle, '2026-07-20', '2026-07-27')).json().slots).toEqual([])
  })

  it('handles a range at the configured maximum width', async () => {
    const id = await api.givenResource(aResource({ slot_duration: 'P1D' }))
    await api.givenSchedule(id, everyDay())

    const response = await api.getAvailability(id, '2026-01-01', '2027-01-01')
    expect(response.statusCode).toBe(200)
    expect(response.json().slots).toHaveLength(365)
  })

  it.each([
    { name: 'an inverted range', from: '2026-07-21', to: '2026-07-20' },
    { name: 'a range with equal bounds', from: '2026-07-20', to: '2026-07-20' },
    { name: 'an over-wide range', from: '2026-01-01', to: '2028-01-01' },
  ])('rejects $name', async ({ from, to }) => {
    const id = await api.givenResource(aResource())
    const response = await api.getAvailability(id, from, to)
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('invalid_range')
  })

  it.each(['20-07-2026', 'tomorrow', '2026-07'])('rejects the malformed date %s', async (from) => {
    const id = await api.givenResource(aResource())
    const response = await api.getAvailability(id, from, '2026-08-01')
    expect(response.statusCode).toBe(400)
  })

  it('returns 404 for an unknown resource', async () => {
    const response = await api.getAvailability(unknownUuid(), '2026-07-20', '2026-07-21')
    expect(response.statusCode).toBe(404)
    expect(response.json().error).toBe('not_found')
  })
})

describe('availability reflects bookings', () => {
  const at = (hour: string) => `2026-07-20T${hour}:00+02:00`

  async function anHourlyResource(overrides = {}): Promise<string> {
    const id = await api.givenResource(aResource(overrides))
    await api.givenSchedule(id, [aWindow(WEEKDAYS.monday, '09:00', '12:00')])
    return id
  }

  it('marks a booked slot unavailable and leaves the others alone', async () => {
    const id = await anHourlyResource()
    await api.createBooking(id, {
      customer_id: 'c-1',
      start_time: at('10:00'),
      end_time: at('11:00'),
    })

    const slots = (await api.getAvailability(id, '2026-07-20', '2026-07-21')).json().slots
    expect(slots.map((slot: Slot) => slot.available)).toEqual([true, false, true])
  })

  it('marks every slot of a multi-slot booking unavailable', async () => {
    const id = await anHourlyResource()
    await api.createBooking(id, {
      customer_id: 'c-1',
      start_time: at('09:00'),
      end_time: at('11:00'),
    })

    const slots = (await api.getAvailability(id, '2026-07-20', '2026-07-21')).json().slots
    expect(slots.map((slot: Slot) => slot.available)).toEqual([false, false, true])
  })

  it('keeps a shared slot available until capacity is reached', async () => {
    const id = await api.givenResource(aSharedResource({ capacity: 2 }))
    await api.givenSchedule(id, [aWindow(WEEKDAYS.monday, '09:00', '12:00')])

    await api.createBooking(id, {
      customer_id: 'c-1',
      start_time: at('09:00'),
      end_time: at('10:00'),
    })
    expect(
      (await api.getAvailability(id, '2026-07-20', '2026-07-21')).json().slots[0].available,
    ).toBe(true)

    await api.createBooking(id, {
      customer_id: 'c-2',
      start_time: at('09:00'),
      end_time: at('10:00'),
    })
    expect(
      (await api.getAvailability(id, '2026-07-20', '2026-07-21')).json().slots[0].available,
    ).toBe(false)
  })

  it('counts a live hold against availability', async () => {
    const id = await anHourlyResource()
    await api.createBooking(id, {
      customer_id: 'c-1',
      start_time: at('09:00'),
      end_time: at('10:00'),
      hold: true,
    })

    const slots = (await api.getAvailability(id, '2026-07-20', '2026-07-21')).json().slots
    expect(slots[0].available).toBe(false)
  })

  it('ignores an expired hold without waiting for a sweep', async () => {
    const id = await anHourlyResource()
    const booking = await api.givenBooking(id, {
      customer_id: 'c-1',
      start_time: at('09:00'),
      end_time: at('10:00'),
      hold: true,
    })
    // Backdated relative to the database's own clock — see expireHold in bookings.test.ts.
    await getTestDb()
      .updateTable('bookings')
      .set({ held_until: sql<Date>`now() - interval '1 minute'` })
      .where('id', '=', booking)
      .execute()

    // The row is still `held` in the table; the read filters it by predicate.
    const slots = (await api.getAvailability(id, '2026-07-20', '2026-07-21')).json().slots
    expect(slots[0].available).toBe(true)
  })

  it('ignores cancelled bookings', async () => {
    const id = await anHourlyResource()
    const booking = await api.givenBooking(id, {
      customer_id: 'c-1',
      start_time: at('09:00'),
      end_time: at('10:00'),
    })
    await api.bookingAction(booking, 'cancel')

    const slots = (await api.getAvailability(id, '2026-07-20', '2026-07-21')).json().slots
    expect(slots[0].available).toBe(true)
  })
})
