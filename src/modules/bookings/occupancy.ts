import type { Slot } from '../availability/slot-generator.js'

/**
 * How many active bookings occupy one slot. The count is taken **per slot**: counting
 * overlaps with the whole requested interval instead would be wrong on a multi-slot booking —
 * two bookings touching opposite ends of a range would report the middle as occupied when no
 * single slot is. The per-slot loop in the callers is what keeps those two apart, and the
 * predicate below leaves it untouched.
 *
 * A booking counts against a slot when it **overlaps** it, not when it contains it. The
 * difference is invisible while the grid is a partition: there a grid-aligned booking that
 * overlaps a slot also covers it entirely, so the two rules agree. What used to be implicit
 * is that a grid need not be a partition. A `P<n>D` resource with `n > 1` scheduled on
 * consecutive dates emits one `n`-day slot per date, so its slots share days — `[20th, 22nd)`
 * and `[21st, 23rd)` are both offered. Against such a grid containment under-counts: a
 * booking that half-covers a slot scores zero, which admits a second live booking on a full
 * `shared` resource and makes availability report an `exclusive` slot free that the exclusion
 * constraint would refuse. Overlap fails closed on both.
 *
 * Pure: no database access, no clock reads. The parameter is structural rather than the
 * repository's row type so neither the write path (`assertCapacity`) nor the read path
 * (`AvailabilityService`) has to depend on the other's shape — only on this one rule.
 */
export function countOccupying(
  bookings: ReadonlyArray<{ start_time: Date; end_time: Date }>,
  slot: Slot,
): number {
  const slotStart = Date.parse(slot.start)
  const slotEnd = Date.parse(slot.end)

  return bookings.filter(
    (booking) => booking.start_time.getTime() < slotEnd && booking.end_time.getTime() > slotStart,
  ).length
}
