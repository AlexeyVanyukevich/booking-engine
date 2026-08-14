import { DateTime } from 'luxon'
import { dayOfWeekOf, formatTime } from '../../shared/time.js'
import type { ExceptionRow } from '../exceptions/exception.repository.js'
import type { ScheduleRow } from '../schedule/schedule.repository.js'
import type { AvailabilityWindow } from './slot-generator.js'

export interface ResolveWindowsInput {
  /** 'YYYY-MM-DD' dates, in the resource's timezone */
  dates: string[]
  timezone: string
  scheduleRows: ScheduleRow[]
  exceptionRows: ExceptionRow[]
}

/**
 * Dates to the windows they offer. Pure — the rows arrive already loaded, so both the
 * availability endpoint and booking validation get the same answer from one implementation.
 *
 * A date absent from the map offers nothing, which is how a day off and an unscheduled
 * weekday are represented alike.
 */
export function resolveWindows(input: ResolveWindowsInput): Map<string, AvailabilityWindow[]> {
  const windowsByWeekday = new Map<number, AvailabilityWindow[]>()
  for (const row of input.scheduleRows) {
    const bucket = windowsByWeekday.get(row.day_of_week) ?? []
    bucket.push({
      start: row.start_time === null ? null : formatTime(row.start_time),
      end: row.end_time === null ? null : formatTime(row.end_time),
    })
    windowsByWeekday.set(row.day_of_week, bucket)
  }

  const exceptionsByDate = new Map(input.exceptionRows.map((row) => [row.date, row]))
  const windowsByDate = new Map<string, AvailabilityWindow[]>()

  for (const date of input.dates) {
    const exception = exceptionsByDate.get(date)

    if (exception) {
      // A day off (both times null) contributes no windows. Altered hours replace the
      // weekly schedule for this date entirely; they never merge with it.
      if (exception.start_time !== null && exception.end_time !== null) {
        windowsByDate.set(date, [
          { start: formatTime(exception.start_time), end: formatTime(exception.end_time) },
        ])
      }
      continue
    }

    const weekday = dayOfWeekOf(DateTime.fromISO(date, { zone: input.timezone }))
    const windows = windowsByWeekday.get(weekday)
    if (windows) windowsByDate.set(date, windows)
  }

  return windowsByDate
}
