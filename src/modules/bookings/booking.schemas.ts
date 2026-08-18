import { Type, type Static } from 'typebox'
import { Uuid } from '../resources/resource.schemas.js'

export const BookingParams = Type.Object({
  id: Type.String({ format: 'uuid', description: 'Booking id' }),
})
export type BookingParams = Static<typeof BookingParams>

// An offset (Z or ±HH:MM) is required, not merely expected: without one the instant is
// ambiguous, and the two places that read this string — the grid validator and the service's
// own interval parsing — would otherwise be free to resolve it in different zones.
const OFFSET_TIMESTAMP =
  '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2})?(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})$'

const StartTime = Type.String({
  minLength: 1,
  pattern: OFFSET_TIMESTAMP,
  description:
    'ISO-8601 timestamp. An offset (`Z` or `±HH:MM`) is required — without one the instant is ambiguous. Must fall on a slot boundary — the same grid `GET /availability` returns.',
  examples: ['2026-07-20T09:00:00+02:00'],
})

const EndTime = Type.String({
  minLength: 1,
  pattern: OFFSET_TIMESTAMP,
  description:
    'ISO-8601 timestamp. An offset (`Z` or `±HH:MM`) is required — without one the instant is ambiguous. Must fall on a slot boundary.',
  examples: ['2026-07-20T10:00:00+02:00'],
})

export const CreateBookingBody = Type.Object(
  {
    customer_id: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          'Opaque external identifier. The engine never interprets it. Optional: a caller keeping its own guest records need not hand one over, and a booking without it is invisible to `GET /bookings?customer_id=`. It still takes part in what an idempotency key stands for, so a replay that adds or drops it is refused.',
        examples: ['customer-42'],
      }),
    ),
    start_time: StartTime,
    end_time: EndTime,
    hold: Type.Optional(
      Type.Boolean({
        description:
          'When true the booking is created `held` and must be confirmed before `held_until` passes. Otherwise it is `confirmed` immediately.',
        examples: [true],
      }),
    ),
    hold_minutes: Type.Optional(
      Type.Integer({
        minimum: 1,
        description:
          'How long the hold lasts. Only valid together with `hold: true`; sent alone it is rejected rather than ignored.',
        examples: [10],
      }),
    ),
    idempotency_key: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 255,
        description:
          'Optional. Replaying the same key with the same booking returns the original with 200; the same key describing a different booking is rejected.',
        examples: ['order-8f2c'],
      }),
    ),
  },
  {
    additionalProperties: false,
    examples: [
      {
        customer_id: 'customer-42',
        start_time: '2026-07-20T09:00:00+02:00',
        end_time: '2026-07-20T10:00:00+02:00',
      },
    ],
  },
)
export type CreateBookingBody = Static<typeof CreateBookingBody>

export const BookingResponse = Type.Object(
  {
    id: Uuid,
    resource_id: Uuid,
    start_time: Type.String({ description: "ISO-8601 in the resource's timezone" }),
    end_time: Type.String(),
    status: Type.String({
      description: '`held` · `confirmed` · `cancelled` · `completed` · `no_show` · `expired`',
    }),
    customer_id: Type.Union([Type.String(), Type.Null()], {
      description: 'Null when the booking was created without one.',
    }),
    held_until: Type.Union([Type.String(), Type.Null()], {
      description: 'Set on `held` and `expired` rows, null everywhere else.',
    }),
  },
  {
    examples: [
      {
        id: '9c1f0b7a-3d5e-4a2b-8f6c-1e4d7a9b2c30',
        resource_id: '3f2b1c9e-6a1d-4f8b-9c2e-7d5a8b4e1f30',
        start_time: '2026-07-20T09:00:00+02:00',
        end_time: '2026-07-20T10:00:00+02:00',
        status: 'confirmed',
        customer_id: 'customer-42',
        held_until: null,
      },
    ],
  },
)
export type BookingResponse = Static<typeof BookingResponse>

export const RescheduleBookingBody = Type.Object(
  { start_time: StartTime, end_time: EndTime },
  {
    additionalProperties: false,
    examples: [{ start_time: '2026-07-20T11:00:00+02:00', end_time: '2026-07-20T12:00:00+02:00' }],
  },
)
export type RescheduleBookingBody = Static<typeof RescheduleBookingBody>

const RangeDate = (description: string, example: string) =>
  Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$', description, examples: [example] })

const StatusFilter = Type.Optional(
  Type.Union(
    [
      Type.Literal('held'),
      Type.Literal('confirmed'),
      Type.Literal('cancelled'),
      Type.Literal('completed'),
      Type.Literal('no_show'),
      Type.Literal('expired'),
    ],
    { description: 'Narrows the list to one status. Omitted, every status is returned.' },
  ),
)

export const ResourceBookingsQuery = Type.Object({
  from: RangeDate("First date, inclusive, in the resource's timezone", '2026-07-20'),
  to: RangeDate('Last date, exclusive', '2026-07-27'),
  status: StatusFilter,
})
export type ResourceBookingsQuery = Static<typeof ResourceBookingsQuery>

export const CustomerBookingsQuery = Type.Object({
  customer_id: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "Narrows the list to one customer. Omitted, every booking of the tenant inside the window is returned — the owner's calendar. It was once required because the query would otherwise be bounded only by the date window; under a tenant filter it is bounded by the tenant and the window, the same bound every other listing has.",
      examples: ['customer-42'],
    }),
  ),
  from: RangeDate('First date, inclusive, interpreted in UTC', '2026-07-20'),
  to: RangeDate('Last date, exclusive, interpreted in UTC', '2026-07-27'),
  status: StatusFilter,
})
export type CustomerBookingsQuery = Static<typeof CustomerBookingsQuery>

export const BookingListResponse = Type.Array(BookingResponse)
