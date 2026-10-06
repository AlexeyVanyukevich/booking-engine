import { Type, type Static } from 'typebox'

export const TimeOfDay = Type.String({
  pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$',
  description: 'Time of day as HH:MM, 24-hour',
  examples: ['09:00', '14:00'],
})

export const Uuid = Type.String({ format: 'uuid' })

const Timezone = Type.String({
  minLength: 1,
  description:
    'Named IANA zone. A fixed offset such as `+02:00` is rejected: it carries no daylight-saving rules, so a resource stored that way would be an hour off for half the year.',
  examples: ['Europe/Warsaw', 'UTC', 'America/New_York'],
})

// The generator keeps only the first example of each field, and Swagger UI composes the
// pre-filled body out of them. They are ordered so that composition is a valid request —
// the hotel from the README: nightly slots anchored at 14:00.
const SlotDuration = Type.String({
  minLength: 2,
  description:
    'Restricted ISO-8601: `P<n>D`, or `PT[<n>H][<n>M]` under 24 hours. `P1D` (anchor to anchor, DST-aware) and `PT24H` (exactly 24 elapsed hours, rejected) are not interchangeable. The written form is what makes a resource day-based. Other valid values: `PT30M`, `PT1H`, `PT1H30M`, `P7D`.',
  examples: ['P1D', 'PT30M', 'PT1H', 'PT1H30M', 'P7D'],
})

const SlotAnchorTime = Type.String({
  pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$',
  description:
    "Where a day-based resource's day begins — a hotel with 14:00 check-in sets `14:00`. Must stay at `00:00` for intraday resources, where a non-default value is rejected rather than ignored.",
  examples: ['14:00', '00:00'],
})

const Capacity = Type.Integer({
  minimum: 1,
  description: 'Concurrent bookings allowed per slot. Must be 1 when the mode is `exclusive`.',
  examples: [1, 12],
})

const ConcurrencyMode = Type.Union(
  [Type.Literal('exclusive'), Type.Literal('shared'), Type.Literal('pool')],
  {
    description:
      '`exclusive` — one booking per slot. `shared` — up to `capacity` per slot. `pool` — a group of interchangeable resources; a booking against it lands on a member. Members carry `pool_id` and must be `exclusive`.',
    examples: ['exclusive'],
  },
)

const PoolId = Type.String({
  format: 'uuid',
  description:
    'The pool this resource belongs to. The target must be a resource with `concurrency_mode: "pool"`, in the same tenant, and must share this resource\'s timezone, slot_duration and slot_anchor_time.',
})

export const ResourceParams = Type.Object({
  id: Type.String({ format: 'uuid', description: 'Resource id' }),
})
export type ResourceParams = Static<typeof ResourceParams>

export const CreateResourceBody = Type.Object(
  {
    timezone: Timezone,
    slot_duration: SlotDuration,
    slot_anchor_time: Type.Optional(SlotAnchorTime),
    capacity: Type.Optional(Capacity),
    concurrency_mode: ConcurrencyMode,
    pool_id: Type.Optional(PoolId),
  },
  {
    additionalProperties: false,
    examples: [
      {
        timezone: 'Europe/Warsaw',
        slot_duration: 'P1D',
        slot_anchor_time: '14:00',
        concurrency_mode: 'exclusive',
      },
    ],
  },
)
export type CreateResourceBody = Static<typeof CreateResourceBody>

/**
 * `additionalProperties: false` is what turns an attempt to change `timezone` or
 * `concurrency_mode` into a 400 instead of a silently ignored field.
 */
export const UpdateResourceBody = Type.Object(
  {
    slot_duration: Type.Optional(SlotDuration),
    slot_anchor_time: Type.Optional(SlotAnchorTime),
    capacity: Type.Optional(Capacity),
    is_active: Type.Optional(
      Type.Boolean({
        description: 'Soft-disable. An inactive resource returns an empty slot list.',
      }),
    ),
    pool_id: Type.Optional(Type.Union([PoolId, Type.Null()])),
  },
  { additionalProperties: false, examples: [{ is_active: false }] },
)
export type UpdateResourceBody = Static<typeof UpdateResourceBody>

export const ResourceResponse = Type.Object(
  {
    id: Uuid,
    timezone: Type.String(),
    slot_duration: Type.String({
      description: 'Canonical form — `PT0H30M` is reported back as `PT30M`.',
    }),
    slot_anchor_time: TimeOfDay,
    capacity: Type.Integer(),
    concurrency_mode: Type.String(),
    is_active: Type.Boolean(),
    pool_id: Type.Union([Uuid, Type.Null()]),
  },
  {
    examples: [
      {
        id: '3f2b1c9e-6a1d-4f8b-9c2e-7d5a8b4e1f30',
        timezone: 'Europe/Warsaw',
        slot_duration: 'P1D',
        slot_anchor_time: '14:00',
        capacity: 1,
        concurrency_mode: 'exclusive',
        is_active: true,
        pool_id: null,
      },
    ],
  },
)
export type ResourceResponse = Static<typeof ResourceResponse>

export const ResourceListQuery = Type.Object(
  {
    is_active: Type.Optional(
      Type.Boolean({
        description: 'Narrows the list. Omitted, both active and inactive resources are returned.',
      }),
    ),
  },
  { additionalProperties: false },
)
export type ResourceListQuery = Static<typeof ResourceListQuery>

export const ResourceListResponse = Type.Array(ResourceResponse)
