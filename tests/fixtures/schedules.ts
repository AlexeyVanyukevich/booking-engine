/** Monday = 0 … Sunday = 6, matching the engine's convention. */
export const WEEKDAYS = {
  monday: 0,
  tuesday: 1,
  wednesday: 2,
  thursday: 3,
  friday: 4,
  saturday: 5,
  sunday: 6,
} as const

export const ALL_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const

export interface ScheduleRule {
  day_of_week: number
  start_time: string | null
  end_time: string | null
}

/** One intraday window on one weekday. `null, null` produces a whole-day rule. */
export function aWindow(dayOfWeek: number, start: string | null, end: string | null): ScheduleRule {
  return { day_of_week: dayOfWeek, start_time: start, end_time: end }
}

/** The same intraday window repeated on several weekdays. */
export function windowsOn(days: readonly number[], start: string, end: string): ScheduleRule[] {
  return days.map((day) => aWindow(day, start, end))
}

/** A whole-day rule, the shape a day-based resource requires. */
export function aWholeDay(dayOfWeek: number): ScheduleRule {
  return { day_of_week: dayOfWeek, start_time: null, end_time: null }
}

/** Whole-day rules for every weekday — a hotel room bookable any night. */
export function everyDay(): ScheduleRule[] {
  return ALL_WEEKDAYS.map(aWholeDay)
}

export function wholeDaysOn(days: readonly number[]): ScheduleRule[] {
  return days.map(aWholeDay)
}

export interface ExceptionInput {
  date: string
  start_time: string | null
  end_time: string | null
}

export function alteredHours(date: string, start: string, end: string): ExceptionInput {
  return { date, start_time: start, end_time: end }
}

export function aDayOff(date: string): ExceptionInput {
  return { date, start_time: null, end_time: null }
}
