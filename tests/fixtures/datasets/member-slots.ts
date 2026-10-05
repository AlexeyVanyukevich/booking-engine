import type { ExceptionRow } from '../../../src/modules/exceptions/exception.repository.js'
import type { ScheduleRow } from '../../../src/modules/schedule/schedule.repository.js'

export type MemberScheduleRow = ScheduleRow & { resource_id: string }
export type MemberExceptionRow = ExceptionRow & { resource_id: string }

/** A weekly window for one member. `null` times make the whole day, for a day-based grid. */
export const windowFor = (
  member: string,
  day: number,
  start: string | null,
  end: string | null,
): MemberScheduleRow => ({
  id: `s-${member}-${day}-${start ?? 'day'}`,
  resource_id: member,
  day_of_week: day,
  start_time: start === null ? null : `${start}:00`,
  end_time: end === null ? null : `${end}:00`,
})

export const dayOffFor = (member: string, date: string): MemberExceptionRow => ({
  id: `e-${member}-${date}`,
  resource_id: member,
  date,
  start_time: null,
  end_time: null,
})

export interface MemberSlotsCase {
  name: string
  memberIds: string[]
  dates: string[]
  timezone: string
  slotDuration: string
  anchorTime: string
  scheduleRows: MemberScheduleRow[]
  exceptionRows: MemberExceptionRow[]
  /** Per member, its slots as [start, end]. */
  expected: Record<string, Array<[string, string]>>
}

const MONDAY = 0
const monday = '2026-07-20'
const intraday = { timezone: 'Europe/Warsaw', slotDuration: 'PT1H', anchorTime: '00:00' }

/**
 * 2026-07-20 is a Monday, day_of_week 0 under the engine's convention. Warsaw is on +02:00 that
 * day, as the other July datasets in this directory record.
 */
export const memberSlotsCases: MemberSlotsCase[] = [
  {
    name: 'each member gets only its own windows',
    memberIds: ['a', 'b'],
    dates: [monday],
    ...intraday,
    scheduleRows: [
      windowFor('a', MONDAY, '09:00', '11:00'),
      windowFor('b', MONDAY, '13:00', '14:00'),
    ],
    exceptionRows: [],
    expected: {
      a: [
        ['2026-07-20T09:00:00+02:00', '2026-07-20T10:00:00+02:00'],
        ['2026-07-20T10:00:00+02:00', '2026-07-20T11:00:00+02:00'],
      ],
      b: [['2026-07-20T13:00:00+02:00', '2026-07-20T14:00:00+02:00']],
    },
  },
  {
    name: 'a member with no rows gets no slots',
    memberIds: ['a', 'c'],
    dates: [monday],
    ...intraday,
    scheduleRows: [windowFor('a', MONDAY, '09:00', '10:00')],
    exceptionRows: [],
    expected: {
      a: [['2026-07-20T09:00:00+02:00', '2026-07-20T10:00:00+02:00']],
      c: [],
    },
  },
  {
    name: 'a day off on one member leaves the other untouched',
    memberIds: ['a', 'b'],
    dates: [monday],
    ...intraday,
    scheduleRows: [
      windowFor('a', MONDAY, '09:00', '10:00'),
      windowFor('b', MONDAY, '09:00', '10:00'),
    ],
    exceptionRows: [dayOffFor('a', monday)],
    expected: {
      a: [],
      b: [['2026-07-20T09:00:00+02:00', '2026-07-20T10:00:00+02:00']],
    },
  },
]
