import { assertValidRange } from '../../shared/range.js'
import { enumerateDates, formatTime, parseSlotDuration } from '../../shared/time.js'
import type { BookingRepository } from '../bookings/booking.repository.js'
import { countOccupying } from '../bookings/occupancy.js'
import type { ExceptionRepository } from '../exceptions/exception.repository.js'
import type { ResourceRow } from '../resources/resource.repository.js'
import type { ResourceService } from '../resources/resource.service.js'
import type { ScheduleRepository } from '../schedule/schedule.repository.js'
import type { AvailabilityResponse } from './availability.schemas.js'
import { generateSlots } from './slot-generator.js'
import { resolveWindows } from './window-resolver.js'

export class AvailabilityService {
  constructor(
    private readonly resources: ResourceService,
    private readonly schedule: ScheduleRepository,
    private readonly exceptions: ExceptionRepository,
    private readonly maxRangeDays: number,
    private readonly bookings: BookingRepository,
  ) {}

  async getAvailability(
    resourceId: string,
    from: string,
    to: string,
  ): Promise<AvailabilityResponse> {
    const resource = await this.resources.loadOrFail(resourceId)
    return this.computeForResource(resource, from, to)
  }

  /**
   * The core takes an already-loaded resource so a caller holding several of them — a pool
   * in spec 3, assembling its availability as the union over its members — does not reload
   * each one.
   */
  async computeForResource(
    resource: ResourceRow,
    from: string,
    to: string,
  ): Promise<AvailabilityResponse> {
    assertValidRange(from, to, this.maxRangeDays)

    // An inactive resource exists but is not bookable: 404 would be wrong, and returning
    // slots would be misleading.
    if (!resource.is_active) return { slots: [] }

    const [scheduleRows, exceptionRows] = await Promise.all([
      this.schedule.listByResource(resource.id),
      this.exceptions.listInRange(resource.id, from, to),
    ])

    const dates = enumerateDates(from, to, resource.timezone)

    const slots = generateSlots({
      dates,
      windowsByDate: resolveWindows({
        dates,
        timezone: resource.timezone,
        scheduleRows,
        exceptionRows,
      }),
      timezone: resource.timezone,
      slotDuration: parseSlotDuration(resource.slot_duration),
      anchorTime: formatTime(resource.slot_anchor_time),
    })

    if (slots.length === 0) return { slots: [] }

    // The window is taken from the slots themselves rather than from the date range: a
    // day-based slot anchored at 14:00 extends past the last requested date.
    const first = new Date(Math.min(...slots.map((slot) => Date.parse(slot.start))))
    const last = new Date(Math.max(...slots.map((slot) => Date.parse(slot.end))))

    const active = await this.bookings.activeInRange(resource.id, first, last)

    return {
      slots: slots.map((slot) => ({
        ...slot,
        available: countOccupying(active, slot) < resource.capacity,
      })),
    }
  }
}
