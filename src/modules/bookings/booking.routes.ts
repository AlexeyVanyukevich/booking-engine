import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { md } from '../../shared/docs.js'
import { ExceptionRepository } from '../exceptions/exception.repository.js'
import { ResourceRepository } from '../resources/resource.repository.js'
import { ErrorResponse, ResourceParams } from '../resources/resource.schemas.js'
import { ResourceService } from '../resources/resource.service.js'
import { ScheduleRepository } from '../schedule/schedule.repository.js'
import { BookingRepository } from './booking.repository.js'
import {
  BookingListResponse,
  BookingParams,
  BookingResponse,
  CreateBookingBody,
  CustomerBookingsQuery,
  RescheduleBookingBody,
  ResourceBookingsQuery,
} from './booking.schemas.js'
import { BookingService } from './booking.service.js'

export const bookingRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const service = new BookingService(
    new BookingRepository(app.db),
    new ResourceService(new ResourceRepository(app.db)),
    new ScheduleRepository(app.db),
    new ExceptionRepository(app.db),
    {
      defaultHoldMinutes: app.config.defaultHoldMinutes,
      maxHoldMinutes: app.config.maxHoldMinutes,
      maxRangeDays: app.config.maxRangeDays,
    },
  )

  app.post(
    '/resources/:id/bookings',
    {
      schema: {
        tags: ['Bookings'],
        summary: 'Book a run of slots',
        description: md(
          'The requested interval must equal a **contiguous run of the slots `GET /availability` returns** for that period. Anything offered is bookable, anything bookable was offered — one definition, one implementation.',
          [
            '`400 invalid_slot_boundary` — a start or end that is not on the grid.',
            '`400 outside_schedule` — the slots run out, or a gap interrupts them, before the requested end.',
            '`409 slot_unavailable` — the slots are offered, but capacity for them is taken.',
            '`200` instead of `201` — an idempotency key replayed an existing booking.',
          ],
          'Without `hold`, the booking is `confirmed` immediately. With `hold: true` it is `held` until `held_until`, and `POST /bookings/:id/confirm` must arrive before then.',
          'A booking in the past is accepted: the engine reads no clock, availability offers past slots, and back-dated entry is a legitimate administrative action.',
        ),
        params: ResourceParams,
        body: CreateBookingBody,
        response: {
          200: BookingResponse,
          201: BookingResponse,
          400: ErrorResponse,
          404: ErrorResponse,
          409: ErrorResponse,
          503: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const result = await service.create(request.params.id, request.body)
      return reply.status(result.created ? 201 : 200).send(result.booking)
    },
  )

  app.get(
    '/bookings/:id',
    {
      schema: {
        tags: ['Bookings'],
        summary: 'Read a booking',
        params: BookingParams,
        response: { 200: BookingResponse, 404: ErrorResponse },
      },
    },
    async (request) => service.getById(request.params.id),
  )

  app.post(
    '/bookings/:id/confirm',
    {
      schema: {
        tags: ['Bookings'],
        summary: 'Confirm a held booking',
        description: md(
          'Turns a `held` booking into a `confirmed` one, provided `held_until` has not passed.',
          'Confirming an already-confirmed booking is a successful no-op, so a retry after a network timeout does not fail. A hold that ran out answers `410 hold_expired` rather than `409`, because the caller needs to tell the two apart.',
        ),
        params: BookingParams,
        response: {
          200: BookingResponse,
          404: ErrorResponse,
          409: ErrorResponse,
          410: ErrorResponse,
          503: ErrorResponse,
        },
      },
    },
    async (request) => service.apply(request.params.id, 'confirm'),
  )

  app.post(
    '/bookings/:id/cancel',
    {
      schema: {
        tags: ['Bookings'],
        summary: 'Cancel a booking',
        description:
          'Allowed from `held` and `confirmed`, and a no-op when the booking is already cancelled. The slots become available again immediately.',
        params: BookingParams,
        response: {
          200: BookingResponse,
          404: ErrorResponse,
          409: ErrorResponse,
          503: ErrorResponse,
        },
      },
    },
    async (request) => service.apply(request.params.id, 'cancel'),
  )

  app.post(
    '/bookings/:id/complete',
    {
      schema: {
        tags: ['Bookings'],
        summary: 'Mark a booking as completed',
        description:
          'Allowed from `confirmed`. Completion is never automatic: an engine that completed bookings once their end time passed would make `no_show` unreachable, and only the caller can tell the two apart.',
        params: BookingParams,
        response: {
          200: BookingResponse,
          404: ErrorResponse,
          409: ErrorResponse,
          503: ErrorResponse,
        },
      },
    },
    async (request) => service.apply(request.params.id, 'complete'),
  )

  app.post(
    '/bookings/:id/no-show',
    {
      schema: {
        tags: ['Bookings'],
        summary: 'Mark a booking as a no-show',
        description: 'Allowed from `confirmed`.',
        params: BookingParams,
        response: {
          200: BookingResponse,
          404: ErrorResponse,
          409: ErrorResponse,
          503: ErrorResponse,
        },
      },
    },
    async (request) => service.apply(request.params.id, 'no-show'),
  )

  app.post(
    '/bookings/:id/reschedule',
    {
      schema: {
        tags: ['Bookings'],
        summary: 'Move a booking to a different run of slots',
        description: md(
          'Allowed from `held` and `confirmed`, and the booking keeps its id and its status. The new interval is validated against the grid exactly as a new booking would be.',
          'If the new slots are unavailable the original booking is left untouched — the check and the move happen in one transaction.',
        ),
        params: BookingParams,
        body: RescheduleBookingBody,
        response: {
          200: BookingResponse,
          400: ErrorResponse,
          404: ErrorResponse,
          409: ErrorResponse,
          503: ErrorResponse,
        },
      },
    },
    async (request) => service.reschedule(request.params.id, request.body),
  )

  app.get(
    '/resources/:id/bookings',
    {
      schema: {
        tags: ['Bookings'],
        summary: 'List the bookings of one resource',
        description: md(
          "The window is required and interpreted in the resource's own timezone, like availability and exceptions. A booking is included when its interval overlaps it.",
          'There is no pagination: the window is bounded by `MAX_RANGE_DAYS`, which is the bound the rest of the engine relies on.',
        ),
        params: ResourceParams,
        querystring: ResourceBookingsQuery,
        response: { 200: BookingListResponse, 400: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (request) => service.listForResource(request.params.id, request.query),
  )

  app.get(
    '/bookings',
    {
      schema: {
        tags: ['Bookings'],
        summary: "List one customer's bookings across resources",
        description: md(
          '`customer_id` is required: without it the query would be bounded only by the date window, across every resource in the system.',
          '**The window is interpreted in UTC here**, not in a resource timezone — the results span resources in different zones and none of them outranks the others. Each returned timestamp is still rendered in its own resource zone.',
        ),
        querystring: CustomerBookingsQuery,
        response: { 200: BookingListResponse, 400: ErrorResponse },
      },
    },
    async (request) => service.listForCustomer(request.query),
  )
}
