import { describe, expect, it } from 'vitest'
import { countOccupying } from '../../src/modules/bookings/occupancy.js'
import type { Slot } from '../../src/modules/availability/slot-generator.js'

const slot: Slot = { start: '2026-07-20T10:00:00+02:00', end: '2026-07-20T11:00:00+02:00' }

function booking(start: string, end: string) {
  return { start_time: new Date(start), end_time: new Date(end) }
}

describe('countOccupying', () => {
  it('counts a booking that exactly matches the slot', () => {
    const bookings = [booking('2026-07-20T10:00:00+02:00', '2026-07-20T11:00:00+02:00')]
    expect(countOccupying(bookings, slot)).toBe(1)
  })

  it('counts a booking that strictly contains the slot', () => {
    const bookings = [booking('2026-07-20T09:00:00+02:00', '2026-07-20T12:00:00+02:00')]
    expect(countOccupying(bookings, slot)).toBe(1)
  })

  it('excludes a booking that ends exactly at the slot start', () => {
    const bookings = [booking('2026-07-20T09:00:00+02:00', '2026-07-20T10:00:00+02:00')]
    expect(countOccupying(bookings, slot)).toBe(0)
  })

  it('excludes a booking that starts exactly at the slot end', () => {
    const bookings = [booking('2026-07-20T11:00:00+02:00', '2026-07-20T12:00:00+02:00')]
    expect(countOccupying(bookings, slot)).toBe(0)
  })

  it('counts a booking strictly inside the slot', () => {
    // Unreachable on a grid-aligned booking, and counted anyway: the rule is overlap, and a
    // partial cover that scored zero would be an overbooking admitted in silence.
    const bookings = [booking('2026-07-20T10:15:00+02:00', '2026-07-20T10:45:00+02:00')]
    expect(countOccupying(bookings, slot)).toBe(1)
  })

  it('returns zero for an empty list', () => {
    expect(countOccupying([], slot)).toBe(0)
  })

  it('counts several occupying bookings independently', () => {
    const bookings = [
      booking('2026-07-20T10:00:00+02:00', '2026-07-20T11:00:00+02:00'),
      booking('2026-07-20T09:00:00+02:00', '2026-07-20T12:00:00+02:00'),
    ]
    expect(countOccupying(bookings, slot)).toBe(2)
  })

  // A grid is not always a partition. A `P2D` resource scheduled on consecutive dates emits
  // one two-day slot per date, so the slot for the 20th and the slot for the 21st share the
  // 21st. A booking on the first must count against the second, or `assertCapacity` reads
  // zero and admits an overlapping booking that no constraint would catch.
  describe('on a self-overlapping grid', () => {
    const twentieth: Slot = {
      start: '2026-07-20T00:00:00+02:00',
      end: '2026-07-22T00:00:00+02:00',
    }
    const twentyFirst: Slot = {
      start: '2026-07-21T00:00:00+02:00',
      end: '2026-07-23T00:00:00+02:00',
    }

    it('counts a two-day booking against the slot it half-covers', () => {
      const bookings = [booking('2026-07-20T00:00:00+02:00', '2026-07-22T00:00:00+02:00')]
      expect(countOccupying(bookings, twentieth)).toBe(1)
      expect(countOccupying(bookings, twentyFirst)).toBe(1)
    })

    it('still leaves a slot that shares no day untouched', () => {
      const bookings = [booking('2026-07-23T00:00:00+02:00', '2026-07-25T00:00:00+02:00')]
      expect(countOccupying(bookings, twentieth)).toBe(0)
      expect(countOccupying(bookings, twentyFirst)).toBe(0)
    })
  })
})
