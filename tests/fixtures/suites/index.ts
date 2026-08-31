import { availabilitySuite } from './availability.js'
import { bookingCapacitySuite, bookingTransitionsSuite, rejectedBookingsSuite } from './bookings.js'
import { acceptedExceptionsSuite, rejectedExceptionsSuite } from './exceptions.js'
import { notFoundSuite, unknownRouteSuite } from './not-found.js'
import {
  poolBookingSuite,
  poolDeletionSuite,
  poolMembershipAcceptedSuite,
  poolMembershipSuite,
} from './pools.js'
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
 * The one place that has to change when a new area of behaviour appears: a suite file and a
 * line here. The smoke runner stays untouched.
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
  rejectedBookingsSuite,
  bookingCapacitySuite,
  bookingTransitionsSuite,
  poolMembershipSuite,
  poolMembershipAcceptedSuite,
  poolBookingSuite,
  poolDeletionSuite,
  notFoundSuite,
  unknownRouteSuite,
]

export { isSkipped, skip } from './types.js'
export type { CaseResult, Skipped, Suite, SuiteContext } from './types.js'
