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
import { seal, type SealedSuite } from './types.js'

/**
 * The one place that has to change when a new area of behaviour appears: a suite file and a
 * line here. The smoke runner stays untouched.
 *
 * Order matters only for readability of the output.
 */
export const suites: readonly SealedSuite[] = [
  seal(acceptedResourcesSuite),
  seal(rejectedResourcesSuite),
  seal(acceptedPatchesSuite),
  seal(rejectedPatchesSuite),
  seal(acceptedSchedulesSuite),
  seal(rejectedSchedulesSuite),
  seal(malformedSchedulesSuite),
  seal(nonArrayScheduleBodiesSuite),
  seal(acceptedExceptionsSuite),
  seal(rejectedExceptionsSuite),
  seal(availabilitySuite),
  seal(rejectedBookingsSuite),
  seal(bookingCapacitySuite),
  seal(bookingTransitionsSuite),
  seal(poolMembershipSuite),
  seal(poolMembershipAcceptedSuite),
  seal(poolBookingSuite),
  seal(poolDeletionSuite),
  seal(notFoundSuite),
  seal(unknownRouteSuite),
]

export { isSkipped, seal, skip } from './types.js'
export type { CaseResult, Check, SealedSuite, Skipped, Suite, SuiteContext } from './types.js'
