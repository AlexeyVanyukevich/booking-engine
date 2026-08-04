import { availabilitySuite } from './availability.js'
import { acceptedExceptionsSuite, rejectedExceptionsSuite } from './exceptions.js'
import { notFoundSuite, unknownRouteSuite } from './not-found.js'
import {
  acceptedPatchesSuite,
  acceptedResourcesSuite,
  rejectedPatchesSuite,
  rejectedResourcesSuite,
} from './resources.js'
import {
  acceptedSchedulesSuite,
  malformedSchedulesSuite,
  nonArrayScheduleBodiesSuite,
  rejectedSchedulesSuite,
} from './schedule.js'
import type { Suite } from './types.js'

/**
 * The one place that has to change when a new area of behaviour appears. Bookings in spec 2
 * mean a `suites/bookings.ts` and a line here — the smoke runner stays untouched.
 *
 * Order matters only for readability of the output.
 */
export const suites: Array<Suite<any>> = [
  acceptedResourcesSuite,
  rejectedResourcesSuite,
  acceptedPatchesSuite,
  rejectedPatchesSuite,
  acceptedSchedulesSuite,
  rejectedSchedulesSuite,
  malformedSchedulesSuite,
  nonArrayScheduleBodiesSuite,
  acceptedExceptionsSuite,
  rejectedExceptionsSuite,
  availabilitySuite,
  notFoundSuite,
  unknownRouteSuite,
]

export type { Suite, SuiteContext } from './types.js'
