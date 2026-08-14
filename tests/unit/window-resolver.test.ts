import { describe, expect, it } from 'vitest'
import { resolveWindows } from '../../src/modules/availability/window-resolver.js'

const scheduleRow = (day: number, start: string | null, end: string | null) => ({
  id: `s-${day}-${start ?? 'null'}`,
  day_of_week: day,
  start_time: start,
  end_time: end,
})

const exceptionRow = (date: string, start: string | null, end: string | null) => ({
  id: `e-${date}`,
  date,
  start_time: start,
  end_time: end,
})

// 2026-07-20 is a Monday, so day_of_week 0 under the engine's convention.
describe('resolveWindows', () => {
  it('applies the weekly rule for the weekday', () => {
    const windows = resolveWindows({
      dates: ['2026-07-20'],
      timezone: 'Europe/Warsaw',
      scheduleRows: [scheduleRow(0, '09:00:00', '17:00:00')],
      exceptionRows: [],
    })
    expect(windows.get('2026-07-20')).toEqual([{ start: '09:00', end: '17:00' }])
  })

  it('lets an exception replace the weekly schedule entirely', () => {
    const windows = resolveWindows({
      dates: ['2026-07-20'],
      timezone: 'Europe/Warsaw',
      scheduleRows: [scheduleRow(0, '09:00:00', '17:00:00')],
      exceptionRows: [exceptionRow('2026-07-20', '12:00:00', '14:00:00')],
    })
    expect(windows.get('2026-07-20')).toEqual([{ start: '12:00', end: '14:00' }])
  })

  it('yields nothing for a day off', () => {
    const windows = resolveWindows({
      dates: ['2026-07-20'],
      timezone: 'Europe/Warsaw',
      scheduleRows: [scheduleRow(0, '09:00:00', '17:00:00')],
      exceptionRows: [exceptionRow('2026-07-20', null, null)],
    })
    expect(windows.has('2026-07-20')).toBe(false)
  })

  it('keeps both windows of a split day', () => {
    const windows = resolveWindows({
      dates: ['2026-07-20'],
      timezone: 'Europe/Warsaw',
      scheduleRows: [
        scheduleRow(0, '09:00:00', '12:00:00'),
        scheduleRow(0, '13:00:00', '17:00:00'),
      ],
      exceptionRows: [],
    })
    expect(windows.get('2026-07-20')).toEqual([
      { start: '09:00', end: '12:00' },
      { start: '13:00', end: '17:00' },
    ])
  })

  it('passes null times through for a day-based resource', () => {
    const windows = resolveWindows({
      dates: ['2026-07-20'],
      timezone: 'Europe/Warsaw',
      scheduleRows: [scheduleRow(0, null, null)],
      exceptionRows: [],
    })
    expect(windows.get('2026-07-20')).toEqual([{ start: null, end: null }])
  })

  it('yields nothing for a weekday with no rule', () => {
    const windows = resolveWindows({
      dates: ['2026-07-21'],
      timezone: 'Europe/Warsaw',
      scheduleRows: [scheduleRow(0, '09:00:00', '17:00:00')],
      exceptionRows: [],
    })
    expect(windows.has('2026-07-21')).toBe(false)
  })
})
