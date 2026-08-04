import { DateTime } from 'luxon'
import type { SlotDuration } from '../../shared/time.js'

export interface AvailabilityWindow {
  /** 'HH:MM', or null for a day-based resource where the anchor supplies the start */
  start: string | null
  /** 'HH:MM', or null for a day-based resource where the slot itself supplies the end */
  end: string | null
}

export interface GenerateSlotsInput {
  /** 'YYYY-MM-DD' dates, in the resource's timezone */
  dates: string[]
  windowsByDate: Map<string, AvailabilityWindow[]>
  timezone: string
  slotDuration: SlotDuration
  /** 'HH:MM' */
  anchorTime: string
}

export interface Slot {
  /** ISO-8601 with offset */
  start: string
  end: string
}

function at(date: string, time: string, timezone: string): DateTime {
  return DateTime.fromISO(`${date}T${time}`, { zone: timezone })
}

function toIso(dt: DateTime): string {
  const iso = dt.toISO({ suppressMilliseconds: true })
  if (!iso) throw new Error(`Could not format ${dt.toString()} as ISO-8601`)
  return iso
}

/**
 * Pure: no database access, no clock reads. Every local-time computation goes through Luxon
 * with the resource's zone, so a day-based slot naturally spans 23, 24 or 25 real hours
 * across a DST transition while still running from local anchor to local anchor.
 */
export function generateSlots(input: GenerateSlotsInput): Slot[] {
  const slots: Slot[] = []

  for (const date of input.dates) {
    const windows = input.windowsByDate.get(date) ?? []

    for (const window of windows) {
      let cursor = at(date, window.start ?? input.anchorTime, input.timezone)

      // A window with no end time is day-based: it is exactly one slot long.
      const windowEnd =
        window.end === null
          ? cursor.plus(input.slotDuration.luxon)
          : at(date, window.end, input.timezone)

      while (cursor.plus(input.slotDuration.luxon) <= windowEnd) {
        const end = cursor.plus(input.slotDuration.luxon)
        slots.push({ start: toIso(cursor), end: toIso(end) })
        cursor = end
      }
    }
  }

  // Sorting on the instant rather than the string: ISO-8601 strings with different offsets
  // do not compare lexicographically by the moment they denote.
  return slots.sort(
    (a, b) => DateTime.fromISO(a.start).toMillis() - DateTime.fromISO(b.start).toMillis(),
  )
}
