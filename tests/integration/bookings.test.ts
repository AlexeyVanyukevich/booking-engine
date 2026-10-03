import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { Api } from '../fixtures/api.js'
import {
  withAuthorization,
  injectTransport,
  type TransportResponse,
} from '../fixtures/transport.js'
import { unknownUuid } from '../fixtures/ids.js'
import { aResource, aSharedResource, type ResourcePayload } from '../fixtures/resources.js'
import { WEEKDAYS, aWindow, everyDay, wholeDaysOn } from '../fixtures/schedules.js'
import { rejectedBookings } from '../fixtures/datasets/booking-validation.js'
import { bookingTransitions, type StartingState } from '../fixtures/datasets/booking-transitions.js'
import type { Trx } from '../../src/modules/bookings/booking.repository.js'
import {
  buildTestApp,
  closeTestDb,
  getTestDb,
  resetDbWithTenant,
  testAuthorization,
} from './helpers.js'
import type {
  AvailabilityResponse,
  BookingListResponse,
  BookingResponse,
  ErrorResponse,
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

/** 2026-07-20 is a Monday. An hourly Warsaw resource open 09:00–12:00 that day. */
async function anHourlyResource(overrides = {}): Promise<string> {
  const id = await api.givenResource(aResource(overrides))
  await api.givenSchedule(id, [aWindow(WEEKDAYS.monday, '09:00', '12:00')])
  return id
}

const at = (hour: string) => `2026-07-20T${hour}:00+02:00`

/**
 * `held_until` is compared against Postgres's `now()`, so faking timers in Node changes
 * nothing. Backdating relative to the database's own clock — rather than sending a literal
 * computed from Node's `Date.now()` — keeps this deterministic even when the two clocks
 * disagree (e.g. Docker Desktop's VM clock drifting after the host sleeps).
 */
async function expireHold(id: string): Promise<void> {
  await getTestDb()
    .updateTable('bookings')
    .set({ held_until: sql<Date>`now() - interval '1 minute'` })
    .where('id', '=', id)
    .execute()
}

describe('POST /resources/:id/bookings', () => {
  it('creates a confirmed booking on a slot boundary', async () => {
    const id = await anHourlyResource()
    const response = await api.createBooking(id, {
      customer_id: 'c-1',
      start_time: at('09:00'),
      end_time: at('10:00'),
    })

    expect(response.statusCode).toBe(201)
    expect(response.json<BookingResponse>()).toMatchObject({
      resource_id: id,
      status: 'confirmed',
      customer_id: 'c-1',
      start_time: at('09:00'),
      end_time: at('10:00'),
      held_until: null,
    })
  })

  it('creates a booking spanning a contiguous run of slots', async () => {
    const id = await anHourlyResource()
    const response = await api.createBooking(id, {
      customer_id: 'c-1',
      start_time: at('09:00'),
      end_time: at('12:00'),
    })
    expect(response.statusCode).toBe(201)
  })

  it('creates a hold with an expiry', async () => {
    const id = await anHourlyResource()
    const response = await api.createBooking(id, {
      customer_id: 'c-1',
      start_time: at('09:00'),
      end_time: at('10:00'),
      hold: true,
      hold_minutes: 15,
    })

    expect(response.statusCode).toBe(201)
    expect(response.json<BookingResponse>().status).toBe('held')
    // `held_until` is now computed by Postgres, so this compares two clocks. Fifteen minutes
    // of headroom makes that safe: only skew on that scale could flip it, and skew that large
    // is the failure this comparison would be right to report.
    expect(Date.parse(response.json<BookingResponse>().held_until ?? '')).toBeGreaterThan(
      Date.now(),
    )
  })

  it('rejects hold_minutes without hold', async () => {
    const id = await anHourlyResource()
    const response = await api.createBooking(id, {
      customer_id: 'c-1',
      start_time: at('09:00'),
      end_time: at('10:00'),
      hold_minutes: 15,
    })
    expect(response.statusCode).toBe(400)
    expect(response.json<ErrorResponse>().error).toBe('validation_error')
  })

  it('rejects a hold longer than the configured maximum', async () => {
    const id = await anHourlyResource()
    const response = await api.createBooking(id, {
      customer_id: 'c-1',
      start_time: at('09:00'),
      end_time: at('10:00'),
      hold: true,
      hold_minutes: 600,
    })
    expect(response.statusCode).toBe(400)
  })

  // The cases live in the dataset, per the testing conventions: extending coverage is a
  // row there, and the smoke suite of Task 13 reads the same table.
  it.each(rejectedBookings)('rejects $name', async (rejected) => {
    const id = await anHourlyResource()
    const response = await api.createBooking(id, {
      customer_id: 'c-1',
      start_time: rejected.start_time,
      end_time: rejected.end_time,
    })
    expect(response.statusCode).toBe(rejected.status)
    expect(response.json<ErrorResponse>().error).toBe(rejected.error)
  })

  it('refuses a second booking overlapping the first', async () => {
    const id = await anHourlyResource()
    await api.givenBooking(id, {
      customer_id: 'c-1',
      start_time: at('09:00'),
      end_time: at('11:00'),
    })

    const response = await api.createBooking(id, {
      customer_id: 'c-2',
      start_time: at('10:00'),
      end_time: at('11:00'),
    })
    expect(response.statusCode).toBe(409)
    expect(response.json<ErrorResponse>().error).toBe('slot_unavailable')
  })

  it('accepts a booking that merely touches another', async () => {
    const id = await anHourlyResource()
    await api.givenBooking(id, {
      customer_id: 'c-1',
      start_time: at('09:00'),
      end_time: at('10:00'),
    })

    const response = await api.createBooking(id, {
      customer_id: 'c-2',
      start_time: at('10:00'),
      end_time: at('11:00'),
    })
    expect(response.statusCode).toBe(201)
  })

  it('frees a slot whose hold has expired, without waiting for any worker', async () => {
    const id = await anHourlyResource()
    const held = await api.givenBooking(id, {
      customer_id: 'c-1',
      start_time: at('09:00'),
      end_time: at('10:00'),
      hold: true,
    })
    await expireHold(held)

    const response = await api.createBooking(id, {
      customer_id: 'c-2',
      start_time: at('09:00'),
      end_time: at('10:00'),
    })
    expect(response.statusCode).toBe(201)

    // The stale hold was moved out of `held` by the sweep inside the same transaction.
    expect((await api.getBooking(held)).json<BookingResponse>().status).toBe('expired')
  })

  it('still refuses a slot whose hold is live', async () => {
    const id = await anHourlyResource()
    await api.givenBooking(id, {
      customer_id: 'c-1',
      start_time: at('09:00'),
      end_time: at('10:00'),
      hold: true,
    })

    const response = await api.createBooking(id, {
      customer_id: 'c-2',
      start_time: at('09:00'),
      end_time: at('10:00'),
    })
    expect(response.statusCode).toBe(409)
  })

  it('refuses to book an inactive resource', async () => {
    const id = await anHourlyResource()
    await api.patchResource(id, { is_active: false })

    const response = await api.createBooking(id, {
      customer_id: 'c-1',
      start_time: at('09:00'),
      end_time: at('10:00'),
    })
    expect(response.statusCode).toBe(409)
    expect(response.json<ErrorResponse>().error).toBe('resource_inactive')
  })

  it('rejects an unknown field in the body', async () => {
    const id = await anHourlyResource()
    const response = await api.createBooking(id, {
      customer_id: 'c-1',
      start_time: at('09:00'),
      end_time: at('10:00'),
      notes: 'a domain field that must not reach the engine',
    })
    expect(response.statusCode).toBe(400)
  })

  it('returns 404 for an unknown resource', async () => {
    const response = await api.createBooking(unknownUuid(), {
      customer_id: 'c-1',
      start_time: at('09:00'),
      end_time: at('10:00'),
    })
    expect(response.statusCode).toBe(404)
  })

  // Without a required offset, the grid validator and the service's own interval parsing are
  // free to resolve an ambiguous string in different zones — see booking.schemas.ts.
  it('rejects a start_time with no offset', async () => {
    const id = await anHourlyResource()
    const response = await api.createBooking(id, {
      customer_id: 'c-1',
      start_time: '2026-07-20T09:00:00',
      end_time: at('10:00'),
    })
    expect(response.statusCode).toBe(400)
  })

  it('rejects an end_time with no offset', async () => {
    const id = await anHourlyResource()
    const response = await api.createBooking(id, {
      customer_id: 'c-1',
      start_time: at('09:00'),
      end_time: '2026-07-20T10:00:00',
    })
    expect(response.statusCode).toBe(400)
  })

  it('accepts a Z-suffixed timestamp and renders it back in the resource offset', async () => {
    const id = await anHourlyResource()
    // Warsaw is +02:00 in July, so 07:00Z is the same instant as 09:00 local.
    const response = await api.createBooking(id, {
      customer_id: 'c-1',
      start_time: '2026-07-20T07:00:00Z',
      end_time: '2026-07-20T08:00:00Z',
    })
    expect(response.statusCode).toBe(201)
    expect(response.json<BookingResponse>()).toMatchObject({
      start_time: at('09:00'),
      end_time: at('10:00'),
    })
  })
})

describe('GET /bookings/:id', () => {
  it('reads a booking back', async () => {
    const id = await anHourlyResource()
    const booking = await api.givenBooking(id, {
      customer_id: 'c-1',
      start_time: at('09:00'),
      end_time: at('10:00'),
    })

    const response = await api.getBooking(booking)
    expect(response.statusCode).toBe(200)
    expect(response.json<BookingResponse>().id).toBe(booking)
  })

  it('returns 404 for an unknown booking', async () => {
    const response = await api.getBooking(unknownUuid())
    expect(response.statusCode).toBe(404)
    expect(response.json<ErrorResponse>().error).toBe('not_found')
  })

  it('never leaks the idempotency key', async () => {
    const id = await anHourlyResource()
    const booking = await api.givenBooking(id, {
      customer_id: 'c-1',
      start_time: at('09:00'),
      end_time: at('10:00'),
      idempotency_key: 'k-1',
    })

    expect((await api.getBooking(booking)).json<BookingResponse>()).not.toHaveProperty(
      'idempotency_key',
    )
  })
})

/** A shared Warsaw resource, hourly, open 09:00–12:00 on Monday 2026-07-20. */
async function aSharedHourlyResource(capacity: number): Promise<string> {
  const id = await api.givenResource(aSharedResource({ capacity }))
  await api.givenSchedule(id, [aWindow(WEEKDAYS.monday, '09:00', '12:00')])
  return id
}

describe('shared capacity', () => {
  it('accepts bookings up to capacity on one slot', async () => {
    const id = await aSharedHourlyResource(2)
    await api.givenBooking(id, {
      customer_id: 'c-1',
      start_time: at('09:00'),
      end_time: at('10:00'),
    })

    const response = await api.createBooking(id, {
      customer_id: 'c-2',
      start_time: at('09:00'),
      end_time: at('10:00'),
    })
    expect(response.statusCode).toBe(201)
  })

  it('refuses the booking that would exceed capacity', async () => {
    const id = await aSharedHourlyResource(2)
    await api.givenBooking(id, {
      customer_id: 'c-1',
      start_time: at('09:00'),
      end_time: at('10:00'),
    })
    await api.givenBooking(id, {
      customer_id: 'c-2',
      start_time: at('09:00'),
      end_time: at('10:00'),
    })

    const response = await api.createBooking(id, {
      customer_id: 'c-3',
      start_time: at('09:00'),
      end_time: at('10:00'),
    })
    expect(response.statusCode).toBe(409)
    expect(response.json<ErrorResponse>().error).toBe('slot_unavailable')
  })

  it('counts occupancy per slot, not per overlapping booking', async () => {
    // Capacity 2. One booking on the first slot, one on the third, none on the middle.
    // A booking across all three leaves every slot at 2 or fewer, so it must be accepted —
    // counting bookings that merely overlap the requested interval would give 2 and refuse.
    const id = await aSharedHourlyResource(2)
    await api.givenBooking(id, {
      customer_id: 'c-1',
      start_time: at('09:00'),
      end_time: at('10:00'),
    })
    await api.givenBooking(id, {
      customer_id: 'c-2',
      start_time: at('11:00'),
      end_time: at('12:00'),
    })

    const response = await api.createBooking(id, {
      customer_id: 'c-3',
      start_time: at('09:00'),
      end_time: at('12:00'),
    })
    expect(response.statusCode).toBe(201)
  })

  it('refuses when any single slot in the run is full', async () => {
    const id = await aSharedHourlyResource(1)
    await api.givenBooking(id, {
      customer_id: 'c-1',
      start_time: at('11:00'),
      end_time: at('12:00'),
    })

    const response = await api.createBooking(id, {
      customer_id: 'c-2',
      start_time: at('09:00'),
      end_time: at('12:00'),
    })
    expect(response.statusCode).toBe(409)
  })

  // Every other case here counts `confirmed` rows. A hold is the other half of the rule: it
  // occupies capacity while it is live and gives it back once it lapses, and on a `shared`
  // resource no exclusion constraint stands behind that — the count is the whole mechanism.
  it('counts a live hold against capacity', async () => {
    const id = await aSharedHourlyResource(1)
    await api.givenBooking(id, {
      customer_id: 'c-1',
      start_time: at('09:00'),
      end_time: at('10:00'),
      hold: true,
    })

    const response = await api.createBooking(id, {
      customer_id: 'c-2',
      start_time: at('09:00'),
      end_time: at('10:00'),
    })
    expect(response.statusCode).toBe(409)
    expect(response.json<ErrorResponse>().error).toBe('slot_unavailable')
  })

  it('frees the capacity a lapsed hold was occupying', async () => {
    const id = await aSharedHourlyResource(1)
    const held = await api.givenBooking(id, {
      customer_id: 'c-1',
      start_time: at('09:00'),
      end_time: at('10:00'),
      hold: true,
    })
    await expireHold(held)

    const response = await api.createBooking(id, {
      customer_id: 'c-2',
      start_time: at('09:00'),
      end_time: at('10:00'),
    })
    expect(response.statusCode).toBe(201)
    expect((await api.getBooking(held)).json<BookingResponse>().status).toBe('expired')
  })

  it('ignores cancelled bookings when counting', async () => {
    const id = await aSharedHourlyResource(1)
    const booking = await api.givenBooking(id, {
      customer_id: 'c-1',
      start_time: at('09:00'),
      end_time: at('10:00'),
    })
    await getTestDb()
      .updateTable('bookings')
      .set({ status: 'cancelled', held_until: null })
      .where('id', '=', booking)
      .execute()

    const response = await api.createBooking(id, {
      customer_id: 'c-2',
      start_time: at('09:00'),
      end_time: at('10:00'),
    })
    expect(response.statusCode).toBe(201)
  })

  it('lets exactly one of two concurrent requests take the last unit', async () => {
    const id = await aSharedHourlyResource(1)

    // Both promises are started before either is awaited, so the contention at the
    // database is real: one transaction holds the resource row while the other waits.
    const [first, second] = await Promise.all([
      api.createBooking(id, { customer_id: 'c-1', start_time: at('09:00'), end_time: at('10:00') }),
      api.createBooking(id, { customer_id: 'c-2', start_time: at('09:00'), end_time: at('10:00') }),
    ])

    expect([first.statusCode, second.statusCode].sort()).toEqual([201, 409])
  })
})

/**
 * A `P2D` resource scheduled on consecutive dates does not produce a partition: the slot for
 * the 20th is `[20th, 22nd)` and the slot for the 21st is `[21st, 23rd)`, and they share the
 * 21st. Occupancy therefore has to be counted as overlap per slot — under containment a
 * booking on the first slot scores zero against the second, and the engine admits two live
 * overlapping bookings on a resource with room for one.
 */
describe('a self-overlapping day grid', () => {
  const day = (date: string) => `2026-07-${date}T00:00:00+02:00`

  async function aTwoDayResource(overrides: Partial<ResourcePayload>): Promise<string> {
    const id = await api.givenResource(aResource({ slot_duration: 'P2D', ...overrides }))
    await api.givenSchedule(id, everyDay())
    return id
  }

  it('refuses a shared booking that overlaps an existing one on a shifted slot', async () => {
    const id = await aTwoDayResource({ concurrency_mode: 'shared', capacity: 1 })
    await api.givenBooking(id, { customer_id: 'c-1', start_time: day('20'), end_time: day('22') })

    // Nothing catches this at the database: `bookings_no_overlap` excludes `shared` rows.
    const response = await api.createBooking(id, {
      customer_id: 'c-2',
      start_time: day('21'),
      end_time: day('23'),
    })
    expect(response.statusCode).toBe(409)
    expect(response.json<ErrorResponse>().error).toBe('slot_unavailable')
  })

  it('still accepts a shared booking on a slot that shares no day', async () => {
    const id = await aTwoDayResource({ concurrency_mode: 'shared', capacity: 1 })
    await api.givenBooking(id, { customer_id: 'c-1', start_time: day('20'), end_time: day('22') })

    const response = await api.createBooking(id, {
      customer_id: 'c-2',
      start_time: day('22'),
      end_time: day('24'),
    })
    expect(response.statusCode).toBe(201)
  })

  it('reports the contested slot unavailable, agreeing with the exclusion constraint', async () => {
    // On `exclusive` the write is already refused by `bookings_no_overlap`. Availability has
    // to say the same, or "anything offered is bookable" stops being true.
    const id = await aTwoDayResource({ concurrency_mode: 'exclusive' })
    await api.givenBooking(id, { customer_id: 'c-1', start_time: day('20'), end_time: day('22') })

    const slots = (
      await api.getAvailability(id, '2026-07-20', '2026-07-22')
    ).json<AvailabilityResponse>().slots
    const contested = slots.find((slot: { start: string }) => slot.start === day('21'))
    expect(contested).toBeDefined()
    expect(contested?.available).toBe(false)

    const refused = await api.createBooking(id, {
      customer_id: 'c-2',
      start_time: day('21'),
      end_time: day('23'),
    })
    expect(refused.statusCode).toBe(409)
  })
})

/**
 * The resource is read twice: once before the write transaction opens, and once inside it
 * under the row lock. Only the second read can see a change that commits in between, so the
 * decision has to be made on that one.
 *
 * Each case holds the resource row locked while it changes it, starts the booking, gives it
 * long enough to block on the lock, and only then commits. The booking therefore reaches its
 * own `SELECT … FOR UPDATE` with the old value already stale.
 */
describe('a resource changed while a booking is in flight', () => {
  async function whileLocked(
    id: string,
    change: (trx: Trx) => Promise<unknown>,
    request: () => Promise<TransportResponse>,
  ): Promise<TransportResponse> {
    const pending: Array<Promise<TransportResponse>> = []

    await getTestDb()
      .transaction()
      .execute(async (trx) => {
        await trx.selectFrom('resources').select('id').where('id', '=', id).forUpdate().execute()
        await change(trx)
        pending.push(request())
        // Long enough for the request to read the resource and then block on the lock.
        await new Promise((resolve) => setTimeout(resolve, 150))
      })

    return pending[0]!
  }

  it('refuses the booking when the resource was retired', async () => {
    const id = await aSharedHourlyResource(1)

    const response = await whileLocked(
      id,
      (trx) =>
        trx.updateTable('resources').set({ is_active: false }).where('id', '=', id).execute(),
      () =>
        api.createBooking(id, {
          customer_id: 'c-1',
          start_time: at('09:00'),
          end_time: at('10:00'),
        }),
    )

    expect(response.statusCode).toBe(409)
    expect(response.json<ErrorResponse>().error).toBe('resource_inactive')
  })

  it('counts against the capacity the resource has now, not the one it had', async () => {
    const id = await aSharedHourlyResource(3)
    await api.givenBooking(id, {
      customer_id: 'c-1',
      start_time: at('09:00'),
      end_time: at('10:00'),
    })

    const response = await whileLocked(
      id,
      (trx) => trx.updateTable('resources').set({ capacity: 1 }).where('id', '=', id).execute(),
      () =>
        api.createBooking(id, {
          customer_id: 'c-2',
          start_time: at('09:00'),
          end_time: at('10:00'),
        }),
    )

    expect(response.statusCode).toBe(409)
    expect(response.json<ErrorResponse>().error).toBe('slot_unavailable')
  })
})

describe('idempotency', () => {
  const payload = {
    customer_id: 'c-1',
    start_time: at('09:00'),
    end_time: at('10:00'),
    idempotency_key: 'order-1',
  }

  it('creates once and replays with 200', async () => {
    const id = await anHourlyResource()

    const first = await api.createBooking(id, payload)
    expect(first.statusCode).toBe(201)

    const second = await api.createBooking(id, payload)
    expect(second.statusCode).toBe(200)
    expect(second.json<BookingResponse>().id).toBe(first.json<BookingResponse>().id)
  })

  it('rejects the same key describing a different booking', async () => {
    const id = await anHourlyResource()
    await api.createBooking(id, payload)

    const response = await api.createBooking(id, { ...payload, end_time: at('11:00') })
    expect(response.statusCode).toBe(409)
    expect(response.json<ErrorResponse>().error).toBe('idempotency_key_reused')
  })

  it('rejects the same key for a different customer', async () => {
    const id = await anHourlyResource()
    await api.createBooking(id, payload)

    const response = await api.createBooking(id, { ...payload, customer_id: 'c-2' })
    expect(response.statusCode).toBe(409)
  })

  it('ignores the hold flag when comparing a replay', async () => {
    // hold and hold_minutes describe how the booking was made, not what it is, and
    // hold_minutes has already become a held_until by the time a replay arrives.
    const id = await anHourlyResource()
    const first = await api.createBooking(id, { ...payload, hold: true, hold_minutes: 20 })
    expect(first.statusCode).toBe(201)

    const second = await api.createBooking(id, { ...payload, hold: true, hold_minutes: 5 })
    expect(second.statusCode).toBe(200)
    expect(second.json<BookingResponse>().id).toBe(first.json<BookingResponse>().id)
  })

  it('keeps keys separate per resource', async () => {
    const one = await anHourlyResource()
    const two = await anHourlyResource()

    expect((await api.createBooking(one, payload)).statusCode).toBe(201)
    expect((await api.createBooking(two, payload)).statusCode).toBe(201)
  })

  it('does not make keyless bookings collide', async () => {
    const id = await aSharedHourlyResource(3)
    const keyless = { customer_id: 'c-1', start_time: at('09:00'), end_time: at('10:00') }

    expect((await api.createBooking(id, keyless)).statusCode).toBe(201)
    expect((await api.createBooking(id, { ...keyless, customer_id: 'c-2' })).statusCode).toBe(201)
  })

  it('replays with 200 on a full shared resource instead of failing capacity', async () => {
    // Capacity 1, so the resource is full after the first booking. A larger capacity would
    // let a non-replay slip through and take the second place, passing for the wrong reason.
    const id = await aSharedHourlyResource(1)

    const first = await api.createBooking(id, payload)
    expect(first.statusCode).toBe(201)

    const second = await api.createBooking(id, payload)
    expect(second.statusCode).toBe(200)
    expect(second.json<BookingResponse>().id).toBe(first.json<BookingResponse>().id)
  })

  it('still refuses a different key on that same full shared resource', async () => {
    // Proves the 200 above comes from the key matching, not merely from the resource
    // already being busy.
    const id = await aSharedHourlyResource(1)
    await api.createBooking(id, payload)

    const response = await api.createBooking(id, { ...payload, idempotency_key: 'order-2' })
    expect(response.statusCode).toBe(409)
    expect(response.json<ErrorResponse>().error).toBe('slot_unavailable')
  })

  it('returns one booking when two identical requests race', async () => {
    const id = await anHourlyResource()

    const [first, second] = await Promise.all([
      api.createBooking(id, payload),
      api.createBooking(id, payload),
    ])

    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 201])
    expect(first.json<BookingResponse>().id).toBe(second.json<BookingResponse>().id)
  })
})

/** Creates a booking on 09:00–10:00 and puts it into the requested starting state. */
async function aBookingIn(state: StartingState): Promise<string> {
  const resource = await anHourlyResource()
  const wantsHold = state === 'held' || state === 'held_expired' || state === 'expired'

  const id = await api.givenBooking(resource, {
    customer_id: 'c-1',
    start_time: at('09:00'),
    end_time: at('10:00'),
    ...(wantsHold ? { hold: true } : {}),
  })

  if (state === 'held_expired' || state === 'expired') await expireHold(id)
  // `expired` is the swept form of the same row; `held_expired` is the unswept one.
  if (state === 'expired') {
    await getTestDb()
      .updateTable('bookings')
      .set({ status: 'expired' })
      .where('id', '=', id)
      .execute()
  }
  if (state === 'cancelled' || state === 'completed' || state === 'no_show') {
    await getTestDb()
      .updateTable('bookings')
      .set({ status: state, held_until: null })
      .where('id', '=', id)
      .execute()
  }

  return id
}

describe('the booking lifecycle', () => {
  it.each(bookingTransitions)('$action from $from', async (transition) => {
    const id = await aBookingIn(transition.from)
    const response = await api.bookingAction(id, transition.action)

    expect(response.statusCode).toBe(transition.status)
    if (transition.becomes) expect(response.json<BookingResponse>().status).toBe(transition.becomes)
    if (transition.error) expect(response.json<ErrorResponse>().error).toBe(transition.error)
  })

  it('clears held_until when a hold is confirmed', async () => {
    const id = await aBookingIn('held')
    const response = await api.bookingAction(id, 'confirm')
    expect(response.json<BookingResponse>().held_until).toBeNull()
  })

  it('clears held_until when a hold is cancelled', async () => {
    const id = await aBookingIn('held')
    const response = await api.bookingAction(id, 'cancel')
    expect(response.json<BookingResponse>().held_until).toBeNull()
  })

  it('frees the slot once a booking is cancelled', async () => {
    const resource = await anHourlyResource()
    const id = await api.givenBooking(resource, {
      customer_id: 'c-1',
      start_time: at('09:00'),
      end_time: at('10:00'),
    })
    await api.bookingAction(id, 'cancel')

    const response = await api.createBooking(resource, {
      customer_id: 'c-2',
      start_time: at('09:00'),
      end_time: at('10:00'),
    })
    expect(response.statusCode).toBe(201)
  })

  it('reports the current status when it refuses a transition', async () => {
    const id = await aBookingIn('completed')
    const response = await api.bookingAction(id, 'cancel')
    expect(response.json<ErrorResponse>().details).toMatchObject({ status: 'completed' })
  })

  it('returns 404 for an unknown booking', async () => {
    const response = await api.bookingAction(unknownUuid(), 'confirm')
    expect(response.statusCode).toBe(404)
  })

  it('lets exactly one of two conflicting actions win, never both', async () => {
    const id = await aBookingIn('confirmed')

    // Both promises are started before either is awaited, so the contention at the
    // database is real: one transaction holds the booking row while the other waits, and
    // the loser must see the winner's committed status rather than overwriting it.
    const [cancel, complete] = await Promise.all([
      api.bookingAction(id, 'cancel'),
      api.bookingAction(id, 'complete'),
    ])

    expect([cancel.statusCode, complete.statusCode].sort()).toEqual([200, 409])

    const winner = cancel.statusCode === 200 ? 'cancelled' : 'completed'
    const final = await api.getBooking(id)
    expect(final.json<BookingResponse>().status).toBe(winner)
  })
})

describe('POST /bookings/:id/reschedule', () => {
  it('moves a confirmed booking, keeping its id and status', async () => {
    const resource = await anHourlyResource()
    const id = await api.givenBooking(resource, {
      customer_id: 'c-1',
      start_time: at('09:00'),
      end_time: at('10:00'),
    })

    const response = await api.rescheduleBooking(id, {
      start_time: at('11:00'),
      end_time: at('12:00'),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json<BookingResponse>()).toMatchObject({
      id,
      status: 'confirmed',
      start_time: at('11:00'),
      end_time: at('12:00'),
    })
  })

  it('keeps a hold a hold', async () => {
    const resource = await anHourlyResource()
    const id = await api.givenBooking(resource, {
      customer_id: 'c-1',
      start_time: at('09:00'),
      end_time: at('10:00'),
      hold: true,
    })

    const response = await api.rescheduleBooking(id, {
      start_time: at('11:00'),
      end_time: at('12:00'),
    })
    expect(response.json<BookingResponse>().status).toBe('held')
    expect(response.json<BookingResponse>().held_until).not.toBeNull()
  })

  it('does not block itself when the interval is unchanged', async () => {
    const resource = await anHourlyResource()
    const id = await api.givenBooking(resource, {
      customer_id: 'c-1',
      start_time: at('09:00'),
      end_time: at('10:00'),
    })

    const response = await api.rescheduleBooking(id, {
      start_time: at('09:00'),
      end_time: at('10:00'),
    })
    expect(response.statusCode).toBe(200)
  })

  it('does not block itself in shared mode either', async () => {
    const resource = await aSharedHourlyResource(1)
    const id = await api.givenBooking(resource, {
      customer_id: 'c-1',
      start_time: at('09:00'),
      end_time: at('10:00'),
    })

    const response = await api.rescheduleBooking(id, {
      start_time: at('09:00'),
      end_time: at('11:00'),
    })
    expect(response.statusCode).toBe(200)
  })

  it('refuses a move onto a taken slot', async () => {
    const resource = await anHourlyResource()
    const id = await api.givenBooking(resource, {
      customer_id: 'c-1',
      start_time: at('09:00'),
      end_time: at('10:00'),
    })
    await api.givenBooking(resource, {
      customer_id: 'c-2',
      start_time: at('11:00'),
      end_time: at('12:00'),
    })

    const response = await api.rescheduleBooking(id, {
      start_time: at('11:00'),
      end_time: at('12:00'),
    })
    expect(response.statusCode).toBe(409)
    expect(response.json<ErrorResponse>().error).toBe('slot_unavailable')
  })

  // The refusal above comes from the exclusion constraint, since the resource is `exclusive`.
  // On a `shared` one the same answer has to come from `assertCapacity` instead, with the
  // moving booking excluded from its own count.
  it('refuses a move onto a full slot of a shared resource', async () => {
    const resource = await aSharedHourlyResource(1)
    const id = await api.givenBooking(resource, {
      customer_id: 'c-1',
      start_time: at('09:00'),
      end_time: at('10:00'),
    })
    await api.givenBooking(resource, {
      customer_id: 'c-2',
      start_time: at('11:00'),
      end_time: at('12:00'),
    })

    const response = await api.rescheduleBooking(id, {
      start_time: at('11:00'),
      end_time: at('12:00'),
    })
    expect(response.statusCode).toBe(409)
    expect(response.json<ErrorResponse>().error).toBe('slot_unavailable')

    expect((await api.getBooking(id)).json<BookingResponse>()).toMatchObject({
      start_time: at('09:00'),
    })
  })

  it('leaves the original booking untouched when the move is refused', async () => {
    const resource = await anHourlyResource()
    const id = await api.givenBooking(resource, {
      customer_id: 'c-1',
      start_time: at('09:00'),
      end_time: at('10:00'),
    })
    await api.givenBooking(resource, {
      customer_id: 'c-2',
      start_time: at('11:00'),
      end_time: at('12:00'),
    })

    await api.rescheduleBooking(id, { start_time: at('11:00'), end_time: at('12:00') })

    expect((await api.getBooking(id)).json<BookingResponse>()).toMatchObject({
      start_time: at('09:00'),
      end_time: at('10:00'),
    })
  })

  it('refuses a target off the grid', async () => {
    const resource = await anHourlyResource()
    const id = await api.givenBooking(resource, {
      customer_id: 'c-1',
      start_time: at('09:00'),
      end_time: at('10:00'),
    })

    const response = await api.rescheduleBooking(id, {
      start_time: at('09:30'),
      end_time: at('10:30'),
    })
    expect(response.statusCode).toBe(400)
    expect(response.json<ErrorResponse>().error).toBe('invalid_slot_boundary')
  })

  it.each(['cancelled', 'completed', 'no_show'] as const)(
    'refuses to move a %s booking',
    async (status) => {
      const id = await aBookingIn(status)
      const response = await api.rescheduleBooking(id, {
        start_time: at('11:00'),
        end_time: at('12:00'),
      })
      expect(response.statusCode).toBe(409)
      expect(response.json<ErrorResponse>().error).toBe('invalid_state_transition')
    },
  )

  it('returns 404 for an unknown booking', async () => {
    const response = await api.rescheduleBooking(unknownUuid(), {
      start_time: at('11:00'),
      end_time: at('12:00'),
    })
    expect(response.statusCode).toBe(404)
  })
})

describe('listings', () => {
  async function threeBookings(): Promise<{ resource: string; ids: string[] }> {
    const resource = await anHourlyResource()
    const ids = [
      await api.givenBooking(resource, {
        customer_id: 'c-1',
        start_time: at('09:00'),
        end_time: at('10:00'),
      }),
      await api.givenBooking(resource, {
        customer_id: 'c-2',
        start_time: at('10:00'),
        end_time: at('11:00'),
      }),
      await api.givenBooking(resource, {
        customer_id: 'c-1',
        start_time: at('11:00'),
        end_time: at('12:00'),
      }),
    ]
    return { resource, ids }
  }

  it('lists the bookings of a resource in ascending order', async () => {
    const { resource } = await threeBookings()

    const response = await api.listResourceBookings(resource, '?from=2026-07-20&to=2026-07-21')
    expect(response.statusCode).toBe(200)

    const starts = response
      .json<BookingListResponse>()
      .map((booking: { start_time: string }) => booking.start_time)
    expect(starts).toEqual([at('09:00'), at('10:00'), at('11:00')])
  })

  it('excludes bookings outside the window', async () => {
    const { resource } = await threeBookings()

    const response = await api.listResourceBookings(resource, '?from=2026-07-21&to=2026-07-22')
    expect(response.json<BookingListResponse>()).toEqual([])
  })

  // Both cases below use a P1D resource so a booking can straddle a date boundary: one
  // day-slot sits inside the window, the other outside it. Neither booking is contained by
  // the window, so a containment filter (start >= from AND end <= to) would wrongly drop
  // both — only the overlap predicate (start < to AND end > from) keeps them.
  it('includes a booking that starts before the window and reaches into it', async () => {
    const resource = await api.givenResource(aResource({ slot_duration: 'P1D' }))
    await api.givenSchedule(resource, wholeDaysOn([WEEKDAYS.sunday, WEEKDAYS.monday]))
    // Sunday 2026-07-19 + Monday 2026-07-20: starts a day before the window opens, ends
    // exactly at its close.
    await api.givenBooking(resource, {
      customer_id: 'c-1',
      start_time: '2026-07-19T00:00:00+02:00',
      end_time: '2026-07-21T00:00:00+02:00',
    })

    const response = await api.listResourceBookings(resource, '?from=2026-07-20&to=2026-07-21')
    expect(response.json<BookingListResponse>()).toHaveLength(1)
  })

  it('includes a booking that starts inside the window and reaches past it', async () => {
    const resource = await api.givenResource(aResource({ slot_duration: 'P1D' }))
    await api.givenSchedule(resource, wholeDaysOn([WEEKDAYS.monday, WEEKDAYS.tuesday]))
    // Monday 2026-07-20 + Tuesday 2026-07-21: starts exactly when the window opens, ends a
    // day after it closes.
    await api.givenBooking(resource, {
      customer_id: 'c-1',
      start_time: '2026-07-20T00:00:00+02:00',
      end_time: '2026-07-22T00:00:00+02:00',
    })

    const response = await api.listResourceBookings(resource, '?from=2026-07-20&to=2026-07-21')
    expect(response.json<BookingListResponse>()).toHaveLength(1)
  })

  it('filters by status', async () => {
    const { resource, ids } = await threeBookings()
    await api.bookingAction(ids[0]!, 'cancel')

    expect(
      (
        await api.listResourceBookings(resource, '?from=2026-07-20&to=2026-07-21&status=cancelled')
      ).json<BookingListResponse>(),
    ).toHaveLength(1)
    expect(
      (
        await api.listResourceBookings(resource, '?from=2026-07-20&to=2026-07-21&status=confirmed')
      ).json<BookingListResponse>(),
    ).toHaveLength(2)
  })

  it('lists a customer across resources', async () => {
    const one = await anHourlyResource()
    const two = await anHourlyResource()
    await api.givenBooking(one, {
      customer_id: 'c-1',
      start_time: at('09:00'),
      end_time: at('10:00'),
    })
    await api.givenBooking(two, {
      customer_id: 'c-1',
      start_time: at('09:00'),
      end_time: at('10:00'),
    })
    await api.givenBooking(one, {
      customer_id: 'c-2',
      start_time: at('10:00'),
      end_time: at('11:00'),
    })

    const response = await api.listCustomerBookings(
      '?customer_id=c-1&from=2026-07-20&to=2026-07-21',
    )
    expect(response.statusCode).toBe(200)
    expect(response.json<BookingListResponse>()).toHaveLength(2)
  })

  // Once required, because the query would otherwise be bounded only by the date window
  // across every resource in the system. Under a tenant filter it is bounded by the tenant
  // and the window, so the requirement bought nothing and cost the owner's calendar.
  it('no longer requires customer_id on the customer listing', async () => {
    const response = await api.listCustomerBookings('?from=2026-07-20&to=2026-07-21')
    expect(response.statusCode).toBe(200)
  })

  it.each([
    { name: 'the resource listing', query: '?from=2026-07-20' },
    { name: 'the resource listing without a window', query: '' },
  ])('requires both bounds on $name', async ({ query }) => {
    const resource = await anHourlyResource()
    const response = await api.listResourceBookings(resource, query)
    expect(response.statusCode).toBe(400)
  })

  it.each([
    { name: 'an inverted range', query: '?from=2026-07-21&to=2026-07-20' },
    { name: 'an over-wide range', query: '?from=2026-01-01&to=2028-01-01' },
  ])('rejects $name', async ({ query }) => {
    const resource = await anHourlyResource()
    const response = await api.listResourceBookings(resource, query)
    expect(response.statusCode).toBe(400)
    expect(response.json<ErrorResponse>().error).toBe('invalid_range')
  })

  it('returns 404 for an unknown resource', async () => {
    const response = await api.listResourceBookings(unknownUuid(), '?from=2026-07-20&to=2026-07-21')
    expect(response.statusCode).toBe(404)
  })

  it('renders each timestamp in its own resource timezone', async () => {
    const warsaw = await anHourlyResource()
    const auckland = await api.givenResource(aResource({ timezone: 'Pacific/Auckland' }))
    await api.givenSchedule(auckland, [aWindow(WEEKDAYS.monday, '09:00', '12:00')])

    await api.givenBooking(warsaw, {
      customer_id: 'c-1',
      start_time: at('09:00'),
      end_time: at('10:00'),
    })
    await api.givenBooking(auckland, {
      customer_id: 'c-1',
      start_time: '2026-07-20T09:00:00+12:00',
      end_time: '2026-07-20T10:00:00+12:00',
    })

    const response = await api.listCustomerBookings(
      '?customer_id=c-1&from=2026-07-19&to=2026-07-21',
    )
    const offsets = response
      .json<BookingListResponse>()
      .map((booking: { start_time: string }) => booking.start_time.slice(-6))
    expect(new Set(offsets)).toEqual(new Set(['+02:00', '+12:00']))
  })
})

describe('a booking without a customer', () => {
  const slot = { start_time: at('09'), end_time: at('10') }

  it('is accepted and reports customer_id as null', async () => {
    const id = await anHourlyResource()
    const response = await api.createBooking(id, slot)

    expect(response.statusCode).toBe(201)
    // Present and null, not absent: a caller reading the field should not have to tell
    // "no customer" from "field missing from this version of the API".
    expect(response.json<BookingResponse>()).toHaveProperty('customer_id', null)
  })

  it('is invisible to a customer filter', async () => {
    const id = await anHourlyResource()
    await api.givenBooking(id, slot)

    const response = await api.listCustomerBookings(
      '?customer_id=c-1&from=2026-07-20&to=2026-07-21',
    )
    expect(response.json<BookingListResponse>()).toEqual([])
  })

  it('still appears in the tenant-wide listing', async () => {
    const id = await anHourlyResource()
    await api.givenBooking(id, slot)

    const response = await api.listCustomerBookings('?from=2026-07-20&to=2026-07-21')
    expect(response.statusCode).toBe(200)
    expect(response.json<BookingListResponse>()).toHaveLength(1)
    expect(response.json<BookingListResponse>()[0]?.customer_id).toBeNull()
  })

  it('and the resource listing too', async () => {
    const id = await anHourlyResource()
    await api.givenBooking(id, slot)

    const response = await api.listResourceBookings(id, '?from=2026-07-20&to=2026-07-21')
    expect(response.json<BookingListResponse>()).toHaveLength(1)
  })

  it('does not exempt the tenant-wide listing from the range bound', async () => {
    const response = await api.listCustomerBookings('?from=2026-01-01&to=2028-01-01')
    expect(response.statusCode).toBe(400)
    expect(response.json<ErrorResponse>().error).toBe('invalid_range')
  })

  it('still refuses a blank customer_id when one is sent', async () => {
    const id = await anHourlyResource()
    const response = await api.createBooking(id, { customer_id: '', ...slot })
    expect(response.statusCode).toBe(400)
  })
})

describe('idempotency across a null customer', () => {
  const slot = { start_time: at('09'), end_time: at('10') }

  it('replays when the original and the retry both omit the customer', async () => {
    const id = await anHourlyResource()
    const body = { ...slot, idempotency_key: 'k1' }

    const first = await api.createBooking(id, body)
    const second = await api.createBooking(id, body)

    expect(first.statusCode).toBe(201)
    expect(second.statusCode).toBe(200)
    expect(second.json<BookingResponse>().id).toBe(first.json<BookingResponse>().id)
  })

  // `undefined` and `null` must not read as two different customers, and a customer that
  // appears or disappears describes a different booking under the same key.
  it.each([
    ['adds a customer the original did not have', {}, { customer_id: 'c-1' }],
    ['drops the customer the original had', { customer_id: 'c-1' }, {}],
    ['changes the customer', { customer_id: 'c-1' }, { customer_id: 'c-2' }],
  ])('refuses a replay that %s', async (_name, original, retry) => {
    const id = await anHourlyResource()
    await api.givenBooking(id, { ...slot, ...original, idempotency_key: 'k2' })

    const response = await api.createBooking(id, { ...slot, ...retry, idempotency_key: 'k2' })
    expect(response.statusCode).toBe(409)
    expect(response.json<ErrorResponse>().error).toBe('idempotency_key_reused')
  })
})
