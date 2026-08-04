import { Type, type Static } from 'typebox'
import { TimeOfDay, Uuid } from '../resources/resource.schemas.js'

export const IsoDate = Type.String({
  pattern: '^\\d{4}-\\d{2}-\\d{2}$',
  description: "Calendar date, interpreted in the resource's timezone",
  examples: ['2026-07-20'],
})

export const ExceptionParams = Type.Object({
  id: Type.String({ format: 'uuid', description: 'Resource id' }),
  date: IsoDate,
})
export type ExceptionParams = Static<typeof ExceptionParams>

export const ExceptionRangeQuery = Type.Object({
  from: Type.String({
    pattern: '^\\d{4}-\\d{2}-\\d{2}$',
    description: 'First date, inclusive',
    examples: ['2026-07-20'],
  }),
  to: Type.String({
    pattern: '^\\d{4}-\\d{2}-\\d{2}$',
    description: 'Last date, exclusive — nothing on this date is returned',
    examples: ['2026-07-27'],
  }),
})
export type ExceptionRangeQuery = Static<typeof ExceptionRangeQuery>

export const PutExceptionBody = Type.Object(
  {
    start_time: Type.Union([TimeOfDay, Type.Null()], {
      description: 'Both times `null` means a day off.',
    }),
    end_time: Type.Union([TimeOfDay, Type.Null()]),
  },
  {
    additionalProperties: false,
    examples: [
      { start_time: '10:00', end_time: '14:00' },
      { start_time: null, end_time: null },
    ],
  },
)
export type PutExceptionBody = Static<typeof PutExceptionBody>

export const ExceptionResponse = Type.Object({
  id: Uuid,
  date: IsoDate,
  start_time: Type.Union([TimeOfDay, Type.Null()]),
  end_time: Type.Union([TimeOfDay, Type.Null()]),
})
export type ExceptionResponse = Static<typeof ExceptionResponse>

export const ExceptionListResponse = Type.Array(ExceptionResponse)
