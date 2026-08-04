import { describe, expect, it } from 'vitest'
import { validateScheduleSet } from '../../src/modules/schedule/schedule.service.js'
import { AppError } from '../../src/shared/errors.js'
import { parseSlotDuration, type SlotDuration } from '../../src/shared/time.js'
import { acceptedSchedules, rejectedSchedules } from '../fixtures/datasets/schedule-validation.js'

const durations: Record<'intraday' | 'day', SlotDuration> = {
  intraday: parseSlotDuration('PT1H'),
  day: parseSlotDuration('P1D'),
}

describe('validateScheduleSet', () => {
  it.each(acceptedSchedules)('accepts $name', ({ kind, rules }) => {
    expect(() => validateScheduleSet(rules, durations[kind])).not.toThrow()
  })

  it.each(rejectedSchedules)(
    'rejects $name with $expectedError',
    ({ kind, rules, expectedError }) => {
      try {
        validateScheduleSet(rules, durations[kind])
        expect.unreachable('expected validateScheduleSet to throw')
      } catch (error) {
        expect(error).toBeInstanceOf(AppError)
        expect((error as AppError).code).toBe(expectedError)
      }
    },
  )

  it.each(rejectedSchedules)(
    'names the offending weekday when rejecting $name',
    ({ kind, rules }) => {
      try {
        validateScheduleSet(rules, durations[kind])
        expect.unreachable('expected validateScheduleSet to throw')
      } catch (error) {
        expect((error as AppError).details).toHaveProperty('day_of_week')
      }
    },
  )

  it('validates every weekday independently', () => {
    // An overlap on Friday must be caught even when Monday through Thursday are fine.
    const rules = [
      { day_of_week: 0, start_time: '09:00', end_time: '17:00' },
      { day_of_week: 1, start_time: '09:00', end_time: '17:00' },
      { day_of_week: 2, start_time: '09:00', end_time: '17:00' },
      { day_of_week: 3, start_time: '09:00', end_time: '17:00' },
      { day_of_week: 4, start_time: '09:00', end_time: '12:00' },
      { day_of_week: 4, start_time: '11:00', end_time: '17:00' },
    ]
    expect(() => validateScheduleSet(rules, durations.intraday)).toThrow(/overlap/i)
  })

  it('does not mutate the submitted rules', () => {
    const rules = [
      { day_of_week: 0, start_time: '14:00', end_time: '17:00' },
      { day_of_week: 0, start_time: '09:00', end_time: '12:00' },
    ]
    const before = structuredClone(rules)
    validateScheduleSet(rules, durations.intraday)
    expect(rules).toEqual(before)
  })
})
