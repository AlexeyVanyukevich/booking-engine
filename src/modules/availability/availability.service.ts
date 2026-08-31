import { assertValidRange } from '../../shared/range.js'
import { enumerateDates, formatTime, parseSlotDuration } from '../../shared/time.js'
import type { ActiveBooking, BookingRepository } from '../bookings/booking.repository.js'
import { countOccupying } from '../bookings/occupancy.js'
import type { ExceptionRepository } from '../exceptions/exception.repository.js'
import type { PoolRepository } from '../resources/pool.repository.js'
import type { ResourceRow } from '../resources/resource.repository.js'
import type { ResourceService } from '../resources/resource.service.js'
import type { ScheduleRepository } from '../schedule/schedule.repository.js'
import type { AvailabilityResponse } from './availability.schemas.js'
import { generateSlots, type Slot } from './slot-generator.js'
import { resolveWindows } from './window-resolver.js'

export class AvailabilityService {
  constructor(
    private readonly resources: ResourceService,
    private readonly schedule: ScheduleRepository,
    private readonly exceptions: ExceptionRepository,
    private readonly maxRangeDays: number,
    private readonly bookings: BookingRepository,
    private readonly pools: PoolRepository,
  ) {}

  async getAvailability(
    tenantId: string,
    resourceId: string,
    from: string,
    to: string,
  ): Promise<AvailabilityResponse> {
    const resource = await this.resources.loadOrFail(tenantId, resourceId)
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

    if (resource.concurrency_mode === 'pool') return this.computeForPool(resource, from, to)

    const [scheduleRows, exceptionRows] = await Promise.all([
      this.schedule.listByResource(resource.tenant_id, resource.id),
      this.exceptions.listInRange(resource.tenant_id, resource.id, from, to),
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

    const active = await this.bookings.activeInRange(resource.tenant_id, resource.id, first, last)

    return {
      slots: slots.map((slot) => ({
        ...slot,
        available: countOccupying(active, slot) < resource.capacity,
      })),
    }
  }

  /**
   * The union over the pool's active members: a slot is available when at least one of them
   * offers it and has no conflicting booking. Three queries whatever the member count —
   * members carry different schedules, so per-member windows genuinely have to be resolved,
   * but that does not need three round trips each.
   */
  private async computeForPool(
    pool: ResourceRow,
    from: string,
    to: string,
  ): Promise<AvailabilityResponse> {
    const members = await this.pools.listMembers(pool.tenant_id, pool.id, true)
    if (members.length === 0) return { slots: [] }

    const ids = members.map((member) => member.id)
    const dates = enumerateDates(from, to, pool.timezone)

    const [scheduleRows, exceptionRows] = await Promise.all([
      this.schedule.listByResourceIds(pool.tenant_id, ids),
      this.exceptions.listInRangeForResources(pool.tenant_id, ids, from, to),
    ])

    // Every member shares the pool's grid, so the slot list is the same for all of them and
    // only the windows differ. Offered-by-member is therefore a set of slot starts: the merge
    // below asks "does this member offer this start?" once per (slot, member) pair, and a
    // linear scan of the member's own slot list there made the whole computation quadratic in
    // the slot count. `PT30M` over `MAX_RANGE_DAYS` is 17,568 slots, so that S² term costs one
    // authenticated GET seconds of blocked event loop — which every other tenant on the
    // process waits out — for a result the same size either way.
    const everySlot = new Map<string, Slot>()
    const perMember: Array<{ member: ResourceRow; offered: Set<string> }> = []

    for (const member of members) {
      const slots = generateSlots({
        dates,
        windowsByDate: resolveWindows({
          dates,
          timezone: pool.timezone,
          scheduleRows: scheduleRows.filter((row) => row.resource_id === member.id),
          exceptionRows: exceptionRows.filter((row) => row.resource_id === member.id),
        }),
        timezone: pool.timezone,
        slotDuration: parseSlotDuration(pool.slot_duration),
        anchorTime: formatTime(pool.slot_anchor_time),
      })

      for (const slot of slots) everySlot.set(slot.start, slot)
      perMember.push({ member, offered: new Set(slots.map((slot) => slot.start)) })
    }

    if (everySlot.size === 0) return { slots: [] }

    const ordered = [...everySlot.values()].sort(
      (a, b) => Date.parse(a.start) - Date.parse(b.start),
    )
    const first = new Date(Math.min(...ordered.map((slot) => Date.parse(slot.start))))
    const last = new Date(Math.max(...ordered.map((slot) => Date.parse(slot.end))))
    const active = await this.bookings.activeInRangeForResources(pool.tenant_id, ids, first, last)

    // Keyed once for the same reason: re-filtering every active booking of every member, for
    // every slot, is the other factor in that product.
    const activeByMember = new Map<string, ActiveBooking[]>()
    for (const booking of active) {
      const mine = activeByMember.get(booking.resource_id)
      if (mine === undefined) activeByMember.set(booking.resource_id, [booking])
      else mine.push(booking)
    }
    const nothingBooked: ActiveBooking[] = []

    return {
      slots: ordered.map((slot) => ({
        ...slot,
        available: perMember.some(
          ({ member, offered }) =>
            offered.has(slot.start) &&
            countOccupying(activeByMember.get(member.id) ?? nothingBooked, slot) < member.capacity,
        ),
      })),
    }
  }
}
