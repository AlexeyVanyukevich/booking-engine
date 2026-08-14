import { describe, expect, it } from 'vitest'
import { checkAgainstGrid, gridDatesFor } from '../../src/modules/bookings/booking-validator.js'

/** An hourly grid on 2026-07-20 in Europe/Warsaw, 09:00 to 12:00. */
const hourly = [
  { start: '2026-07-20T09:00:00+02:00', end: '2026-07-20T10:00:00+02:00' },
  { start: '2026-07-20T10:00:00+02:00', end: '2026-07-20T11:00:00+02:00' },
  { start: '2026-07-20T11:00:00+02:00', end: '2026-07-20T12:00:00+02:00' },
]

/** A split day: 09:00–10:00 and then 14:00–15:00, with a gap between them. */
const split = [
  { start: '2026-07-20T09:00:00+02:00', end: '2026-07-20T10:00:00+02:00' },
  { start: '2026-07-20T14:00:00+02:00', end: '2026-07-20T15:00:00+02:00' },
]

describe('checkAgainstGrid', () => {
  it('accepts a single slot', () => {
    const result = checkAgainstGrid(
      hourly,
      '2026-07-20T09:00:00+02:00',
      '2026-07-20T10:00:00+02:00',
    )
    expect(result).toEqual({ ok: true, slots: [hourly[0]] })
  })

  it('accepts a contiguous run of three', () => {
    const result = checkAgainstGrid(
      hourly,
      '2026-07-20T09:00:00+02:00',
      '2026-07-20T12:00:00+02:00',
    )
    expect(result.ok).toBe(true)
    expect(result.ok && result.slots).toHaveLength(3)
  })

  it('accepts the same instants written with a different offset', () => {
    // 07:00Z is 09:00+02:00. The check must compare moments, not strings.
    const result = checkAgainstGrid(hourly, '2026-07-20T07:00:00Z', '2026-07-20T08:00:00Z')
    expect(result.ok).toBe(true)
  })

  it('rejects an end that is not after the start', () => {
    const result = checkAgainstGrid(
      hourly,
      '2026-07-20T09:00:00+02:00',
      '2026-07-20T09:00:00+02:00',
    )
    expect(result).toEqual({ ok: false, error: 'invalid_interval' })
  })

  it('rejects a start one minute off the grid', () => {
    const result = checkAgainstGrid(
      hourly,
      '2026-07-20T09:01:00+02:00',
      '2026-07-20T10:01:00+02:00',
    )
    expect(result).toEqual({ ok: false, error: 'invalid_slot_boundary' })
  })

  it('rejects an end that lands inside a slot', () => {
    const result = checkAgainstGrid(
      hourly,
      '2026-07-20T09:00:00+02:00',
      '2026-07-20T09:30:00+02:00',
    )
    expect(result).toEqual({ ok: false, error: 'invalid_slot_boundary' })
  })

  it('rejects an end past the last offered slot', () => {
    const result = checkAgainstGrid(
      hourly,
      '2026-07-20T11:00:00+02:00',
      '2026-07-20T13:00:00+02:00',
    )
    expect(result).toEqual({ ok: false, error: 'outside_schedule' })
  })

  it('rejects a run that crosses a gap in the schedule', () => {
    const result = checkAgainstGrid(split, '2026-07-20T09:00:00+02:00', '2026-07-20T15:00:00+02:00')
    expect(result).toEqual({ ok: false, error: 'outside_schedule' })
  })

  it('rejects anything against an empty grid', () => {
    const result = checkAgainstGrid([], '2026-07-20T09:00:00+02:00', '2026-07-20T10:00:00+02:00')
    expect(result).toEqual({ ok: false, error: 'invalid_slot_boundary' })
  })

  it('accepts two nights that span a spring-forward transition', () => {
    // Warsaw springs forward on 2026-03-29. Anchored at 14:00, the first night is 23 real
    // hours and the second is 24, so the stay is 47 hours — and exactly two slots.
    const nights = [
      { start: '2026-03-28T14:00:00+01:00', end: '2026-03-29T14:00:00+02:00' },
      { start: '2026-03-29T14:00:00+02:00', end: '2026-03-30T14:00:00+02:00' },
    ]
    const result = checkAgainstGrid(
      nights,
      '2026-03-28T14:00:00+01:00',
      '2026-03-30T14:00:00+02:00',
    )
    expect(result.ok).toBe(true)
    expect(result.ok && result.slots).toHaveLength(2)
  })

  it('rejects the same stay expressed as 48 elapsed hours', () => {
    const nights = [
      { start: '2026-03-28T14:00:00+01:00', end: '2026-03-29T14:00:00+02:00' },
      { start: '2026-03-29T14:00:00+02:00', end: '2026-03-30T14:00:00+02:00' },
    ]
    // 2026-03-28T14:00+01:00 plus 48 hours is 2026-03-30T15:00+02:00 — off the grid.
    const result = checkAgainstGrid(
      nights,
      '2026-03-28T14:00:00+01:00',
      '2026-03-30T15:00:00+02:00',
    )
    expect(result).toEqual({ ok: false, error: 'outside_schedule' })
  })

  it('sorts an unordered grid before walking it', () => {
    const result = checkAgainstGrid(
      [hourly[2]!, hourly[0]!, hourly[1]!],
      '2026-07-20T09:00:00+02:00',
      '2026-07-20T12:00:00+02:00',
    )
    expect(result.ok).toBe(true)
  })
})

describe('gridDatesFor', () => {
  it('reaches one day back, so a small anchor still finds its grid', () => {
    // With an anchor of 02:00 the slot belonging to the 20th runs until the 21st at 02:00,
    // so a booking starting on the 21st at 01:00 lives on the previous date's grid.
    expect(
      gridDatesFor('2026-07-21T01:00:00+02:00', '2026-07-21T02:00:00+02:00', 'Europe/Warsaw'),
    ).toEqual(['2026-07-20', '2026-07-21'])
  })

  it('excludes the date the interval merely ends on', () => {
    expect(
      gridDatesFor('2026-07-20T09:00:00+02:00', '2026-07-21T00:00:00+02:00', 'Europe/Warsaw'),
    ).toEqual(['2026-07-19', '2026-07-20'])
  })

  it('covers every date a multi-night stay touches', () => {
    expect(
      gridDatesFor('2026-07-20T14:00:00+02:00', '2026-07-23T14:00:00+02:00', 'Europe/Warsaw'),
    ).toEqual(['2026-07-19', '2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23'])
  })
})
