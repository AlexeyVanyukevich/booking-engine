import { WEEKDAYS, aWholeDay, aWindow, windowsOn, type ScheduleRule } from '../schedules.js'

export interface ScheduleCase {
  name: string
  /** 'intraday' resources use PT durations, 'day' resources use P<n>D */
  kind: 'intraday' | 'day'
  rules: ScheduleRule[]
}

export interface RejectedScheduleCase extends ScheduleCase {
  expectedError: string
}

export const acceptedSchedules: ScheduleCase[] = [
  { name: 'an empty schedule, meaning never available', kind: 'intraday', rules: [] },
  {
    name: 'one window on one weekday',
    kind: 'intraday',
    rules: [aWindow(WEEKDAYS.monday, '09:00', '17:00')],
  },
  {
    name: 'the same window on every weekday',
    kind: 'intraday',
    rules: windowsOn([0, 1, 2, 3, 4, 5, 6], '09:00', '17:00'),
  },
  {
    name: 'two disjoint windows on one weekday',
    kind: 'intraday',
    rules: [aWindow(WEEKDAYS.monday, '09:00', '12:00'), aWindow(WEEKDAYS.monday, '13:00', '17:00')],
  },
  {
    name: 'two windows that merely touch',
    kind: 'intraday',
    rules: [aWindow(WEEKDAYS.monday, '09:00', '12:00'), aWindow(WEEKDAYS.monday, '12:00', '17:00')],
  },
  {
    name: 'three windows on one weekday',
    kind: 'intraday',
    rules: [
      aWindow(WEEKDAYS.monday, '08:00', '10:00'),
      aWindow(WEEKDAYS.monday, '11:00', '13:00'),
      aWindow(WEEKDAYS.monday, '14:00', '16:00'),
    ],
  },
  {
    name: 'windows submitted out of chronological order',
    kind: 'intraday',
    rules: [aWindow(WEEKDAYS.monday, '14:00', '17:00'), aWindow(WEEKDAYS.monday, '09:00', '12:00')],
  },
  {
    name: 'identical windows on different weekdays',
    kind: 'intraday',
    rules: [
      aWindow(WEEKDAYS.monday, '09:00', '17:00'),
      aWindow(WEEKDAYS.tuesday, '09:00', '17:00'),
    ],
  },
  {
    name: 'a window spanning almost the whole day',
    kind: 'intraday',
    rules: [aWindow(WEEKDAYS.monday, '00:00', '23:59')],
  },
  {
    name: 'a one-minute window',
    kind: 'intraday',
    rules: [aWindow(WEEKDAYS.monday, '09:00', '09:01')],
  },
  { name: 'a single whole-day rule', kind: 'day', rules: [aWholeDay(WEEKDAYS.monday)] },
  {
    name: 'whole-day rules for every weekday',
    kind: 'day',
    rules: [0, 1, 2, 3, 4, 5, 6].map(aWholeDay),
  },
  { name: 'an empty schedule on a day-based resource', kind: 'day', rules: [] },
]

export const rejectedSchedules: RejectedScheduleCase[] = [
  {
    name: 'overlapping windows on one weekday',
    kind: 'intraday',
    rules: [aWindow(WEEKDAYS.monday, '09:00', '13:00'), aWindow(WEEKDAYS.monday, '12:00', '17:00')],
    expectedError: 'schedule_overlap',
  },
  {
    name: 'one window fully containing another',
    kind: 'intraday',
    rules: [aWindow(WEEKDAYS.monday, '09:00', '18:00'), aWindow(WEEKDAYS.monday, '12:00', '13:00')],
    expectedError: 'schedule_overlap',
  },
  {
    name: 'two identical windows on one weekday',
    kind: 'intraday',
    rules: [aWindow(WEEKDAYS.monday, '09:00', '17:00'), aWindow(WEEKDAYS.monday, '09:00', '17:00')],
    expectedError: 'schedule_overlap',
  },
  {
    name: 'an overlap hidden among valid weekdays',
    kind: 'intraday',
    rules: [
      aWindow(WEEKDAYS.monday, '09:00', '17:00'),
      aWindow(WEEKDAYS.friday, '09:00', '13:00'),
      aWindow(WEEKDAYS.friday, '10:00', '11:00'),
    ],
    expectedError: 'schedule_overlap',
  },
  {
    name: 'null times on an intraday resource',
    kind: 'intraday',
    rules: [aWholeDay(WEEKDAYS.monday)],
    expectedError: 'schedule_shape_mismatch',
  },
  {
    name: 'set times on a day-based resource',
    kind: 'day',
    rules: [aWindow(WEEKDAYS.monday, '09:00', '17:00')],
    expectedError: 'schedule_shape_mismatch',
  },
  {
    name: 'two whole-day rules on one weekday',
    kind: 'day',
    rules: [aWholeDay(WEEKDAYS.monday), aWholeDay(WEEKDAYS.monday)],
    expectedError: 'schedule_shape_mismatch',
  },
  {
    name: 'a window ending before it starts',
    kind: 'intraday',
    rules: [aWindow(WEEKDAYS.monday, '17:00', '09:00')],
    expectedError: 'validation_error',
  },
  {
    name: 'a window crossing midnight',
    kind: 'intraday',
    rules: [aWindow(WEEKDAYS.monday, '22:00', '02:00')],
    expectedError: 'validation_error',
  },
  {
    name: 'a zero-length window',
    kind: 'intraday',
    rules: [aWindow(WEEKDAYS.monday, '09:00', '09:00')],
    expectedError: 'validation_error',
  },
  {
    name: 'only the start time set',
    kind: 'intraday',
    rules: [{ day_of_week: WEEKDAYS.monday, start_time: '09:00', end_time: null }],
    expectedError: 'validation_error',
  },
  {
    name: 'only the end time set',
    kind: 'intraday',
    rules: [{ day_of_week: WEEKDAYS.monday, start_time: null, end_time: '17:00' }],
    expectedError: 'validation_error',
  },
]

/** Rejected by the JSON schema before any business rule runs. */
export const malformedSchedules: Array<{ name: string; rules: unknown[] }> = [
  {
    name: 'a weekday below the range',
    rules: [{ day_of_week: -1, start_time: null, end_time: null }],
  },
  {
    name: 'a weekday above the range',
    rules: [{ day_of_week: 7, start_time: null, end_time: null }],
  },
  {
    name: 'a fractional weekday',
    rules: [{ day_of_week: 1.5, start_time: '09:00', end_time: '17:00' }],
  },
  {
    name: 'a weekday given as a string',
    rules: [{ day_of_week: 'monday', start_time: '09:00', end_time: '17:00' }],
  },
  { name: 'a missing weekday', rules: [{ start_time: '09:00', end_time: '17:00' }] },
  {
    name: 'a time with seconds',
    rules: [{ day_of_week: 0, start_time: '09:00:00', end_time: '17:00' }],
  },
  {
    name: 'an hour past the end of the day',
    rules: [{ day_of_week: 0, start_time: '24:00', end_time: '25:00' }],
  },
  {
    name: 'a minute past sixty',
    rules: [{ day_of_week: 0, start_time: '09:60', end_time: '17:00' }],
  },
  {
    name: 'an unknown field',
    rules: [{ day_of_week: 0, start_time: '09:00', end_time: '17:00', note: 'lunch' }],
  },
]

/** Bodies that are not a list of rules at all. */
export const nonArrayScheduleBodies: Array<{ name: string; body: unknown }> = [
  { name: 'an object', body: { day_of_week: 0, start_time: '09:00', end_time: '17:00' } },
  { name: 'a string', body: 'monday 09:00-17:00' },
  { name: 'a number', body: 42 },
  { name: 'null', body: null },
]
