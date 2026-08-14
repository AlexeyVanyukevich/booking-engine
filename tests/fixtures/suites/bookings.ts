import { rejectedBookings, type RejectedBooking } from '../datasets/booking-validation.js'
import {
  bookingTransitions,
  type StartingState,
  type TransitionCase,
} from '../datasets/booking-transitions.js'
import { aResource, aSharedResource } from '../resources.js'
import { WEEKDAYS, aWindow } from '../schedules.js'
import type { Skipped, Suite, SuiteContext } from './types.js'
import { expectStatus, skip } from './types.js'

const at = (hour: string) => `2026-07-20T${hour}:00+02:00`

/** An hourly Warsaw resource open 09:00–12:00 on Monday 2026-07-20. */
async function hourlyResource(context: SuiteContext, capacity?: number): Promise<string> {
  const payload = capacity === undefined ? aResource() : aSharedResource({ capacity })
  const id = await context.newResource(payload)
  await context.api.givenSchedule(id, [aWindow(WEEKDAYS.monday, '09:00', '12:00')])
  return id
}

export const rejectedBookingsSuite: Suite<RejectedBooking> = {
  name: 'Bookings — rejected intervals',
  cases: rejectedBookings,
  describe: (rejected) => rejected.name,
  run: async (context, rejected) => {
    const id = await hourlyResource(context)
    const response = await context.api.createBooking(id, {
      customer_id: 'smoke',
      start_time: rejected.start_time,
      end_time: rejected.end_time,
    })

    const status = expectStatus(response, rejected.status)
    if (status) return status

    const actual = response.json()?.error
    return actual === rejected.error ? null : `expected error "${rejected.error}", got "${actual}"`
  },
}

export const bookingTransitionsSuite: Suite<TransitionCase> = {
  name: 'Bookings — lifecycle transitions',
  cases: bookingTransitions,
  describe: (transition) => `${transition.action} from ${transition.from}`,
  run: async (context, transition) => {
    const setup = await putIntoState(context, transition.from)
    if (typeof setup !== 'string') return setup

    const response = await context.api.bookingAction(setup, transition.action)

    const status = expectStatus(response, transition.status)
    if (status) return status

    if (transition.becomes && response.json()?.status !== transition.becomes) {
      return `expected status "${transition.becomes}", got "${response.json()?.status}"`
    }
    if (transition.error && response.json()?.error !== transition.error) {
      return `expected error "${transition.error}", got "${response.json()?.error}"`
    }
    return null
  },
}

/**
 * The smoke run talks HTTP only — it has no database handle — so the states it can reach are
 * the ones the API itself produces. `held_expired` and `expired` are reached with a one-minute
 * hold, which the run cannot wait out, so those rows are covered by the integration suite
 * instead. They are reported as skips rather than passes: a check that never ran must not be
 * counted as one that did.
 */
async function putIntoState(
  context: SuiteContext,
  state: StartingState,
): Promise<string | Skipped> {
  if (state === 'held_expired' || state === 'expired') {
    return skip(`a "${state}" booking needs a hold to lapse, which this run cannot wait out`)
  }

  const resource = await hourlyResource(context)
  const wantsHold = state === 'held'

  const id = await context.api.givenBooking(resource, {
    customer_id: 'smoke',
    start_time: at('09:00'),
    end_time: at('10:00'),
    ...(wantsHold ? { hold: true } : {}),
  })

  if (state === 'cancelled') await context.api.bookingAction(id, 'cancel')
  if (state === 'completed') await context.api.bookingAction(id, 'complete')
  if (state === 'no_show') await context.api.bookingAction(id, 'no-show')

  return id
}

interface CapacityCase {
  name: string
  capacity: number
  existing: Array<[string, string]>
  request: [string, string]
  status: number
}

const capacityCases: readonly CapacityCase[] = [
  {
    name: 'a second booking on an exclusive slot is refused',
    capacity: 1,
    existing: [[at('09:00'), at('10:00')]],
    request: [at('09:00'), at('10:00')],
    status: 409,
  },
  {
    name: 'a touching booking is accepted',
    capacity: 1,
    existing: [[at('09:00'), at('10:00')]],
    request: [at('10:00'), at('11:00')],
    status: 201,
  },
  {
    name: 'a shared slot accepts up to capacity',
    capacity: 2,
    existing: [[at('09:00'), at('10:00')]],
    request: [at('09:00'), at('10:00')],
    status: 201,
  },
  {
    name: 'a shared slot refuses the booking past capacity',
    capacity: 2,
    existing: [
      [at('09:00'), at('10:00')],
      [at('09:00'), at('10:00')],
    ],
    request: [at('09:00'), at('10:00')],
    status: 409,
  },
  {
    name: 'occupancy is counted per slot, not per overlapping booking',
    capacity: 2,
    existing: [
      [at('09:00'), at('10:00')],
      [at('11:00'), at('12:00')],
    ],
    request: [at('09:00'), at('12:00')],
    status: 201,
  },
]

export const bookingCapacitySuite: Suite<CapacityCase> = {
  name: 'Bookings — capacity',
  cases: capacityCases,
  describe: (capacityCase) => capacityCase.name,
  run: async (context, capacityCase) => {
    const id = await hourlyResource(context, capacityCase.capacity)

    for (const [start, end] of capacityCase.existing) {
      const response = await context.api.createBooking(id, {
        customer_id: `smoke-${start}-${Math.random()}`,
        start_time: start,
        end_time: end,
      })
      if (response.statusCode !== 201) {
        return `setup failed: expected 201, got ${response.statusCode}: ${response.body.slice(0, 200)}`
      }
    }

    const response = await context.api.createBooking(id, {
      customer_id: 'smoke-subject',
      start_time: capacityCase.request[0],
      end_time: capacityCase.request[1],
    })
    return expectStatus(response, capacityCase.status)
  },
}
