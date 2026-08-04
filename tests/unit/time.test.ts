import { describe, expect, it } from 'vitest'
import { DateTime } from 'luxon'
import {
  dayOfWeekOf,
  enumerateDates,
  formatTime,
  parseSlotDuration,
} from '../../src/shared/time.js'
import {
  dateEnumerationCases,
  leapYearWeekdayCases,
  weekdayCases,
} from '../fixtures/datasets/calendar.js'
import {
  invalidDurations,
  validDayDurations,
  validDurations,
  validIntradayDurations,
} from '../fixtures/datasets/durations.js'

describe('parseSlotDuration', () => {
  it.each(validIntradayDurations)('accepts the intraday duration $iso', ({ iso, minutes }) => {
    const parsed = parseSlotDuration(iso)
    expect(parsed.kind).toBe('intraday')
    expect(parsed.luxon.as('minutes')).toBe(minutes)
  })

  it.each(validDayDurations)('accepts the day-based duration $iso', ({ iso, days }) => {
    const parsed = parseSlotDuration(iso)
    expect(parsed.kind).toBe('day')
    expect(parsed.luxon.as('days')).toBe(days)
  })

  it.each(validDurations)('canonicalises $iso', ({ iso, canonical }) => {
    // Postgres normalizes intervals on storage, so canonicalising here is what keeps a
    // resource's reported duration identical to the one that was submitted.
    expect(parseSlotDuration(iso).iso).toBe(canonical ?? iso)
  })

  it('canonicalisation is idempotent', () => {
    for (const { iso } of validDurations) {
      const once = parseSlotDuration(iso).iso
      expect(parseSlotDuration(once).iso).toBe(once)
    }
  })

  it.each(invalidDurations)('rejects $iso — $reason', ({ iso }) => {
    expect(() => parseSlotDuration(iso)).toThrow(/duration/i)
  })

  it('keeps P1D and PT24H apart, since only one of them is a calendar day', () => {
    expect(parseSlotDuration('P1D').kind).toBe('day')
    expect(() => parseSlotDuration('PT24H')).toThrow()
  })

  it('names the offending value in the error message', () => {
    expect(() => parseSlotDuration('P1M')).toThrow(/P1M/)
  })
})

describe('dayOfWeekOf', () => {
  it.each(weekdayCases)('maps $date ($name) to $dayOfWeek', ({ date, dayOfWeek }) => {
    expect(dayOfWeekOf(DateTime.fromISO(date, { zone: 'Europe/Warsaw' }))).toBe(dayOfWeek)
  })

  it.each(leapYearWeekdayCases)(
    'maps $date ($name) to $dayOfWeek around the leap day',
    ({ date, dayOfWeek }) => {
      expect(dayOfWeekOf(DateTime.fromISO(date, { zone: 'UTC' }))).toBe(dayOfWeek)
    },
  )

  it.each(weekdayCases)(
    'differs from the Luxon and Sunday-zero conventions on $name as the dataset records',
    ({ date, dayOfWeek, luxonWeekday, sundayZero }) => {
      const dt = DateTime.fromISO(date, { zone: 'Europe/Warsaw' })
      // Pin the conventions this helper translates between, so a library change or a
      // "simplification" back to getDay() cannot slip through unnoticed.
      expect(dt.weekday).toBe(luxonWeekday)
      expect(new Date(`${date}T12:00:00Z`).getUTCDay()).toBe(sundayZero)
      expect(dayOfWeekOf(dt)).toBe(dayOfWeek)
    },
  )

  it.each(weekdayCases)('is stable across timezones for $name', ({ date, dayOfWeek }) => {
    for (const zone of ['UTC', 'Pacific/Auckland', 'America/New_York', 'Asia/Kolkata']) {
      expect(dayOfWeekOf(DateTime.fromISO(date, { zone }))).toBe(dayOfWeek)
    }
  })
})

describe('formatTime', () => {
  it.each([
    ['00:00:00', '00:00'],
    ['09:00:00', '09:00'],
    ['09:30:00', '09:30'],
    ['14:00:00', '14:00'],
    ['23:45:00', '23:45'],
    ['23:59:00', '23:59'],
  ])('trims %s to %s', (stored, expected) => {
    expect(formatTime(stored)).toBe(expected)
  })

  it('leaves an already trimmed value alone', () => {
    expect(formatTime('09:00')).toBe('09:00')
  })
})

describe('enumerateDates', () => {
  it.each(dateEnumerationCases)('$name', ({ from, to, zone, expected }) => {
    expect(enumerateDates(from, to, zone)).toEqual(expected)
  })

  it('produces as many dates as the range is wide', () => {
    expect(enumerateDates('2026-01-01', '2027-01-01', 'UTC')).toHaveLength(365)
    expect(enumerateDates('2028-01-01', '2029-01-01', 'UTC')).toHaveLength(366)
  })
})
