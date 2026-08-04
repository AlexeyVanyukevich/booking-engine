import { describe, expect, it } from 'vitest'
import { DateTime } from 'luxon'
import {
  generateSlots,
  type AvailabilityWindow,
  type GenerateSlotsInput,
  type Slot,
} from '../../src/modules/availability/slot-generator.js'
import { parseSlotDuration } from '../../src/shared/time.js'
import { dstTransitions, zonesWithoutDst } from '../fixtures/datasets/dst.js'
import { slotGenerationCases } from '../fixtures/datasets/slot-generation.js'

function build(overrides: Partial<GenerateSlotsInput> = {}): GenerateSlotsInput {
  return {
    dates: ['2026-07-20'],
    windowsByDate: new Map([['2026-07-20', [{ start: '09:00', end: '12:00' }]]]),
    timezone: 'Europe/Warsaw',
    slotDuration: parseSlotDuration('PT1H'),
    anchorTime: '00:00',
    ...overrides,
  }
}

function asPairs(slots: Slot[]): Array<[string, string]> {
  return slots.map((slot) => [slot.start, slot.end])
}

function realHours(slot: Slot): number {
  return DateTime.fromISO(slot.end).diff(DateTime.fromISO(slot.start), 'hours').hours
}

const wholeDay: AvailabilityWindow = { start: null, end: null }

describe('generateSlots', () => {
  it.each(slotGenerationCases)(
    '$name',
    ({ dates, windows, timezone, duration, anchor, expected }) => {
      const slots = generateSlots(
        build({
          dates,
          windowsByDate: new Map(Object.entries(windows)),
          timezone: timezone ?? 'Europe/Warsaw',
          slotDuration: parseSlotDuration(duration ?? 'PT1H'),
          anchorTime: anchor ?? '00:00',
        }),
      )
      expect(asPairs(slots)).toEqual(expected)
    },
  )

  it('produces slots that abut without gaps or overlaps', () => {
    const slots = generateSlots(
      build({ windowsByDate: new Map([['2026-07-20', [{ start: '09:00', end: '17:00' }]]]) }),
    )
    for (let i = 1; i < slots.length; i += 1) {
      expect(slots[i]!.start).toBe(slots[i - 1]!.end)
    }
  })

  it('never emits a slot reaching past its window', () => {
    const slots = generateSlots(
      build({
        slotDuration: parseSlotDuration('PT45M'),
        windowsByDate: new Map([['2026-07-20', [{ start: '09:00', end: '12:00' }]]]),
      }),
    )
    const windowEnd = DateTime.fromISO('2026-07-20T12:00', { zone: 'Europe/Warsaw' })
    for (const slot of slots) {
      expect(DateTime.fromISO(slot.end) <= windowEnd).toBe(true)
    }
  })

  it('is pure: the same input twice gives the same output', () => {
    const input = build()
    expect(generateSlots(input)).toEqual(generateSlots(input))
  })

  it('does not mutate its input', () => {
    const input = build()
    const dates = [...input.dates]
    const windowCount = input.windowsByDate.get('2026-07-20')!.length
    generateSlots(input)
    expect(input.dates).toEqual(dates)
    expect(input.windowsByDate.get('2026-07-20')).toHaveLength(windowCount)
  })

  it('returns nothing when given no dates', () => {
    expect(generateSlots(build({ dates: [], windowsByDate: new Map() }))).toEqual([])
  })
})

/**
 * Driven entirely by `data/dst-transitions.json`, so covering another zone means adding a row
 * to the dataset rather than writing another test.
 */
describe('generateSlots across real DST transitions', () => {
  it.each(dstTransitions)(
    'a calendar day on $date in $zone lasts $hours real hours ($kind)',
    ({ zone, date, hours }) => {
      const slots = generateSlots(
        build({
          dates: [date],
          windowsByDate: new Map([[date, [wholeDay]]]),
          timezone: zone,
          slotDuration: parseSlotDuration('P1D'),
        }),
      )
      expect(slots).toHaveLength(1)
      expect(realHours(slots[0]!)).toBe(hours)
    },
  )

  it.each(dstTransitions)(
    'a day on $date in $zone starts at the offset the dataset records',
    ({ zone, date, offsetBefore, offsetAfter }) => {
      const slots = generateSlots(
        build({
          dates: [date],
          windowsByDate: new Map([[date, [wholeDay]]]),
          timezone: zone,
          slotDuration: parseSlotDuration('P1D'),
        }),
      )
      expect(slots[0]!.start).toContain(offsetBefore)
      expect(slots[0]!.end).toContain(offsetAfter)
    },
  )

  it.each(dstTransitions)(
    'a 14:00 anchor stays at 14:00 local on both sides of $date in $zone',
    ({ zone, date }) => {
      const previous = DateTime.fromISO(date, { zone }).minus({ days: 1 }).toISODate()!
      const slots = generateSlots(
        build({
          dates: [previous, date],
          windowsByDate: new Map([
            [previous, [wholeDay]],
            [date, [wholeDay]],
          ]),
          timezone: zone,
          slotDuration: parseSlotDuration('P1D'),
          anchorTime: '14:00',
        }),
      )

      expect(slots).toHaveLength(2)
      for (const slot of slots) {
        expect(DateTime.fromISO(slot.start).setZone(zone).toFormat('HH:mm')).toBe('14:00')
      }
      // Consecutive nights remain contiguous even though one of them is not 24 hours long.
      expect(slots[0]!.end).toBe(slots[1]!.start)
    },
  )

  it.each(dstTransitions)(
    'an intraday grid on $date in $zone neither drifts nor duplicates',
    ({ zone, date }) => {
      const slots = generateSlots(
        build({
          dates: [date],
          windowsByDate: new Map([[date, [{ start: '09:00', end: '12:00' }]]]),
          timezone: zone,
        }),
      )
      expect(
        slots.map((slot) => DateTime.fromISO(slot.start).setZone(zone).toFormat('HH:mm')),
      ).toEqual(['09:00', '10:00', '11:00'])
    },
  )

  it.each(zonesWithoutDst)('a calendar day in %s always lasts 24 hours', (zone) => {
    for (const date of ['2026-03-29', '2026-10-25', '2026-07-20']) {
      const slots = generateSlots(
        build({
          dates: [date],
          windowsByDate: new Map([[date, [wholeDay]]]),
          timezone: zone,
          slotDuration: parseSlotDuration('P1D'),
        }),
      )
      expect(realHours(slots[0]!)).toBe(24)
    }
  })
})
