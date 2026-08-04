import { DateTime } from 'luxon'
import { assertValidRange } from '../../shared/range.js'
import { dayOfWeekOf, enumerateDates, formatTime, parseSlotDuration } from '../../shared/time.js'
import type { ExceptionRepository } from '../exceptions/exception.repository.js'
import type { ResourceService } from '../resources/resource.service.js'
import type { ScheduleRepository } from '../schedule/schedule.repository.js'
import type { AvailabilityResponse } from './availability.schemas.js'
import { generateSlots, type AvailabilityWindow } from './slot-generator.js'

export class AvailabilityService {
  constructor(
    private readonly resources: ResourceService,
    private readonly schedule: ScheduleRepository,
    private readonly exceptions: ExceptionRepository,
    private readonly maxRangeDays: number,
  ) {}

  async getAvailability(
    resourceId: string,
    from: string,
    to: string,
  ): Promise<AvailabilityResponse> {
    const resource = await this.resources.loadOrFail(resourceId)
    assertValidRange(from, to, this.maxRangeDays)

    // An inactive resource exists but is not bookable: 404 would be wrong, and returning
    // slots would be misleading.
    if (!resource.is_active) return { slots: [] }

    const [scheduleRows, exceptionRows] = await Promise.all([
      this.schedule.listByResource(resourceId),
      this.exceptions.listInRange(resourceId, from, to),
    ])

    const windowsByWeekday = new Map<number, AvailabilityWindow[]>()
    for (const row of scheduleRows) {
      const bucket = windowsByWeekday.get(row.day_of_week) ?? []
      bucket.push({
        start: row.start_time === null ? null : formatTime(row.start_time),
        end: row.end_time === null ? null : formatTime(row.end_time),
      })
      windowsByWeekday.set(row.day_of_week, bucket)
    }

    const exceptionsByDate = new Map(exceptionRows.map((row) => [row.date, row]))

    const dates = enumerateDates(from, to, resource.timezone)
    const windowsByDate = new Map<string, AvailabilityWindow[]>()

    for (const date of dates) {
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

      const weekday = dayOfWeekOf(DateTime.fromISO(date, { zone: resource.timezone }))
      const windows = windowsByWeekday.get(weekday)
      if (windows) windowsByDate.set(date, windows)
    }

    const slots = generateSlots({
      dates,
      windowsByDate,
      timezone: resource.timezone,
      slotDuration: parseSlotDuration(resource.slot_duration),
      anchorTime: formatTime(resource.slot_anchor_time),
    })

    // Every slot is free: bookings arrive in spec 2. The field ships now so that adding them
    // changes behaviour without changing the contract.
    return { slots: slots.map((slot) => ({ ...slot, available: true })) }
  }
}
