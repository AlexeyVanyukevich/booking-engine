import { DateTime } from 'luxon'
import type { Slot } from '../availability/slot-generator.js'

export type BookingGridError = 'invalid_interval' | 'invalid_slot_boundary' | 'outside_schedule'

export type GridCheck = { ok: true; slots: Slot[] } | { ok: false; error: BookingGridError }

/**
 * Comparisons are on instants, never on strings: two ISO-8601 strings carrying different
 * offsets do not order lexicographically by the moment they denote, and mixing the two
 * produces a bug that only appears across a daylight-saving transition.
 */
function millis(iso: string): number {
  return DateTime.fromISO(iso).toMillis()
}

/**
 * Pure: no database access, no clock reads.
 *
 * The requested interval must equal a contiguous run of the slots the engine offers.
 * Booking and availability then share one definition — anything offered is bookable,
 * anything bookable was offered — and there is one implementation of the grid rather than
 * two that can drift apart.
 */
export function checkAgainstGrid(slots: Slot[], startIso: string, endIso: string): GridCheck {
  const start = millis(startIso)
  const end = millis(endIso)

  if (!(end > start)) return { ok: false, error: 'invalid_interval' }

  const ordered = [...slots].sort((a, b) => millis(a.start) - millis(b.start))
  const first = ordered.findIndex((slot) => millis(slot.start) === start)
  if (first === -1) return { ok: false, error: 'invalid_slot_boundary' }

  const covered: Slot[] = []
  let cursor = start

  for (let i = first; i < ordered.length; i += 1) {
    const slot = ordered[i]!
    // The run has been broken by a gap in the schedule.
    if (millis(slot.start) !== cursor) break

    covered.push(slot)
    cursor = millis(slot.end)

    if (cursor === end) return { ok: true, slots: covered }
    // The grid stepped over the requested end: it is not on a boundary.
    if (cursor > end) return { ok: false, error: 'invalid_slot_boundary' }
  }

  // The offered slots ran out, or a gap interrupted them, before reaching the end.
  return { ok: false, error: 'outside_schedule' }
}

/**
 * The local dates whose grids can contain the requested interval.
 *
 * It deliberately reaches one day further back than the start date. With an anchor of, say,
 * 02:00, the slot belonging to date D runs until D+1 at 02:00, so a booking starting at
 * D+1 01:00 belongs to the previous date's grid. One extra date costs nothing and removes
 * the whole class of anchor-related edge cases.
 */
export function gridDatesFor(startIso: string, endIso: string, timezone: string): string[] {
  const first = DateTime.fromISO(startIso, { zone: timezone }).startOf('day').minus({ days: 1 })
  // The last slot starts strictly before the end, so the end date itself only matters when
  // the interval extends into it.
  const last = DateTime.fromISO(endIso, { zone: timezone })
    .minus({ milliseconds: 1 })
    .startOf('day')

  const dates: string[] = []
  for (let cursor = first; cursor <= last; cursor = cursor.plus({ days: 1 })) {
    const iso = cursor.toISODate()
    if (iso) dates.push(iso)
  }
  return dates
}
