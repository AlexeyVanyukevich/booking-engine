/**
 * The response bodies a test may read, derived from the schemas the server serialises with.
 * A test names one in `response.json<T>()`, so a field it reads that the contract does not
 * have fails to compile. `src/` exports a type beside some schemas and not others; this file
 * gives every one a type under the schema's own name.
 */
import type { Static } from 'typebox'
import type { AvailabilityResponse } from '../../src/modules/availability/availability.schemas.js'
import type {
  BookingListResponse as BookingListSchema,
  BookingResponse,
} from '../../src/modules/bookings/booking.schemas.js'
import type {
  ExceptionListResponse as ExceptionListSchema,
  ExceptionResponse,
} from '../../src/modules/exceptions/exception.schemas.js'
import type {
  ErrorResponse as ErrorSchema,
  ResourceListResponse as ResourceListSchema,
  ResourceResponse,
} from '../../src/modules/resources/resource.schemas.js'
import type {
  ScheduleResponse as ScheduleSchema,
  ScheduleRuleResponse,
} from '../../src/modules/schedule/schedule.schemas.js'

export type {
  AvailabilityResponse,
  BookingResponse,
  ExceptionResponse,
  ResourceResponse,
  ScheduleRuleResponse,
}
export type BookingListResponse = Static<typeof BookingListSchema>
export type ExceptionListResponse = Static<typeof ExceptionListSchema>
export type ErrorResponse = Static<typeof ErrorSchema>
export type ResourceListResponse = Static<typeof ResourceListSchema>
export type ScheduleResponse = Static<typeof ScheduleSchema>
