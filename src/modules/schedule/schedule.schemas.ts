import { Type, type Static } from 'typebox'
import { TimeOfDay, Uuid } from '../resources/resource.schemas.js'

const DayOfWeek = Type.Integer({
  minimum: 0,
  maximum: 6,
  description: 'Monday = 0 … Sunday = 6. Note this matches neither Postgres nor JavaScript.',
  examples: [0, 6],
})

const WindowStart = Type.Union([TimeOfDay, Type.Null()], {
  description: 'Start of the window, or `null` on a day-based resource.',
})

const WindowEnd = Type.Union([TimeOfDay, Type.Null()], {
  description: 'End of the window, or `null` on a day-based resource. Must follow the start.',
})

export const ScheduleRuleInput = Type.Object(
  {
    day_of_week: DayOfWeek,
    start_time: WindowStart,
    end_time: WindowEnd,
  },
  { additionalProperties: false },
)
export type ScheduleRuleInput = Static<typeof ScheduleRuleInput>

export const ReplaceScheduleBody = Type.Array(ScheduleRuleInput, {
  description:
    'The complete schedule. Whatever is not in this list is deleted. An empty array means "never available".',
  examples: [
    [
      { day_of_week: 0, start_time: '09:00', end_time: '13:00' },
      { day_of_week: 0, start_time: '14:00', end_time: '17:00' },
    ],
    [
      { day_of_week: 0, start_time: null, end_time: null },
      { day_of_week: 1, start_time: null, end_time: null },
    ],
  ],
})
export type ReplaceScheduleBody = Static<typeof ReplaceScheduleBody>

export const ScheduleRuleResponse = Type.Object({
  id: Uuid,
  day_of_week: Type.Integer({ description: 'Monday = 0 … Sunday = 6' }),
  start_time: Type.Union([TimeOfDay, Type.Null()]),
  end_time: Type.Union([TimeOfDay, Type.Null()]),
})
export type ScheduleRuleResponse = Static<typeof ScheduleRuleResponse>

export const ScheduleResponse = Type.Array(ScheduleRuleResponse)
