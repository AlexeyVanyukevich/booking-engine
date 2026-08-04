import { Type, type Static } from 'typebox'

export const AvailabilityQuery = Type.Object({
  from: Type.String({
    pattern: '^\\d{4}-\\d{2}-\\d{2}$',
    description: 'First date, inclusive',
    examples: ['2026-07-20'],
  }),
  to: Type.String({
    pattern: '^\\d{4}-\\d{2}-\\d{2}$',
    description: 'Last date, exclusive — no slot will start on this date',
    examples: ['2026-07-23'],
  }),
})
export type AvailabilityQuery = Static<typeof AvailabilityQuery>

export const AvailabilitySlot = Type.Object({
  start: Type.String({
    description: "ISO-8601 with the resource's offset",
    examples: ['2026-07-20T14:00:00+02:00'],
  }),
  end: Type.String({ examples: ['2026-07-21T14:00:00+02:00'] }),
  available: Type.Boolean({
    description:
      'Always `true` until bookings land in spec 2. The field ships now so the contract does not change then.',
  }),
})
export type AvailabilitySlot = Static<typeof AvailabilitySlot>

export const AvailabilityResponse = Type.Object(
  { slots: Type.Array(AvailabilitySlot) },
  {
    examples: [
      {
        slots: [
          {
            start: '2026-07-20T14:00:00+02:00',
            end: '2026-07-21T14:00:00+02:00',
            available: true,
          },
        ],
      },
    ],
  },
)
export type AvailabilityResponse = Static<typeof AvailabilityResponse>
