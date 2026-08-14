import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { md } from '../../shared/docs.js'
import { BookingRepository } from '../bookings/booking.repository.js'
import { ExceptionRepository } from '../exceptions/exception.repository.js'
import { ResourceRepository } from '../resources/resource.repository.js'
import { ErrorResponse, ResourceParams } from '../resources/resource.schemas.js'
import { ResourceService } from '../resources/resource.service.js'
import { ScheduleRepository } from '../schedule/schedule.repository.js'
import { AvailabilityQuery, AvailabilityResponse } from './availability.schemas.js'
import { AvailabilityService } from './availability.service.js'

export const availabilityRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const service = new AvailabilityService(
    new ResourceService(new ResourceRepository(app.db)),
    new ScheduleRepository(app.db),
    new ExceptionRepository(app.db),
    app.config.maxRangeDays,
    new BookingRepository(app.db),
  )

  app.get(
    '/resources/:id/availability',
    {
      schema: {
        tags: ['Availability'],
        summary: 'Compute the slots a resource offers in a date range',
        description: md(
          'For each date in the half-open range the engine resolves the available windows and slices them into slots:',
          [
            '1. An exception for the date **replaces** the weekly schedule; both times null means a day off and the date yields nothing.',
            '2. Otherwise the weekly rules for that weekday apply.',
            '3. Each window is sliced from its start — or from `slot_anchor_time` on a day-based resource — stepping by `slot_duration`. A remainder shorter than one slot is dropped, so 09:00–17:30 with hourly slots yields eight.',
          ],
          "All arithmetic runs in the resource's local time. A `P1D` slot therefore spans 23, 24 or 25 real hours across a daylight-saving transition while still running anchor to anchor — try `from=2026-03-28&to=2026-03-31` on a Warsaw resource.",
          'An inactive resource returns an empty list rather than 404: it exists, but is not bookable.',
          '`available` is false once a slot is at capacity. Held bookings count until their hold expires — a read never waits for the background sweep.',
        ),
        params: ResourceParams,
        querystring: AvailabilityQuery,
        response: { 200: AvailabilityResponse, 400: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (request) =>
      service.getAvailability(request.params.id, request.query.from, request.query.to),
  )
}
