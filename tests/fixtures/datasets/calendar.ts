/**
 * Weekday mapping cases. The engine uses Monday = 0 while Luxon uses Monday = 1 and both
 * Postgres EXTRACT(DOW) and JS getDay() use Sunday = 0, so this table is the guard against a
 * bug that would otherwise only appear on one day of the week.
 *
 * The dates below are a full ISO week starting Monday 2026-07-20.
 */
export interface WeekdayCase {
  date: string
  name: string
  /** Engine convention: Monday = 0 … Sunday = 6 */
  dayOfWeek: number
  /** Luxon convention, asserted so a library change cannot pass silently */
  luxonWeekday: number
  /** Postgres EXTRACT(DOW) and JS getDay() convention */
  sundayZero: number
}

export const weekdayCases: WeekdayCase[] = [
  { date: '2026-07-20', name: 'Monday', dayOfWeek: 0, luxonWeekday: 1, sundayZero: 1 },
  { date: '2026-07-21', name: 'Tuesday', dayOfWeek: 1, luxonWeekday: 2, sundayZero: 2 },
  { date: '2026-07-22', name: 'Wednesday', dayOfWeek: 2, luxonWeekday: 3, sundayZero: 3 },
  { date: '2026-07-23', name: 'Thursday', dayOfWeek: 3, luxonWeekday: 4, sundayZero: 4 },
  { date: '2026-07-24', name: 'Friday', dayOfWeek: 4, luxonWeekday: 5, sundayZero: 5 },
  { date: '2026-07-25', name: 'Saturday', dayOfWeek: 5, luxonWeekday: 6, sundayZero: 6 },
  { date: '2026-07-26', name: 'Sunday', dayOfWeek: 6, luxonWeekday: 7, sundayZero: 0 },
]

/** A second week, in a leap year and across a month boundary, to catch off-by-one arithmetic. */
export const leapYearWeekdayCases: WeekdayCase[] = [
  { date: '2028-02-28', name: 'Monday', dayOfWeek: 0, luxonWeekday: 1, sundayZero: 1 },
  { date: '2028-02-29', name: 'Tuesday', dayOfWeek: 1, luxonWeekday: 2, sundayZero: 2 },
  { date: '2028-03-01', name: 'Wednesday', dayOfWeek: 2, luxonWeekday: 3, sundayZero: 3 },
]

export interface DateEnumerationCase {
  name: string
  from: string
  to: string
  zone: string
  expected: string[]
}

export const dateEnumerationCases: DateEnumerationCase[] = [
  {
    name: 'is half-open on the upper bound',
    from: '2026-07-20',
    to: '2026-07-23',
    zone: 'Europe/Warsaw',
    expected: ['2026-07-20', '2026-07-21', '2026-07-22'],
  },
  {
    name: 'yields nothing when the bounds coincide',
    from: '2026-07-20',
    to: '2026-07-20',
    zone: 'Europe/Warsaw',
    expected: [],
  },
  {
    name: 'yields a single date for a one-day range',
    from: '2026-07-20',
    to: '2026-07-21',
    zone: 'Europe/Warsaw',
    expected: ['2026-07-20'],
  },
  {
    name: 'neither skips nor repeats across a spring-forward transition',
    from: '2026-03-28',
    to: '2026-03-31',
    zone: 'Europe/Warsaw',
    expected: ['2026-03-28', '2026-03-29', '2026-03-30'],
  },
  {
    name: 'neither skips nor repeats across a fall-back transition',
    from: '2026-10-24',
    to: '2026-10-27',
    zone: 'Europe/Warsaw',
    expected: ['2026-10-24', '2026-10-25', '2026-10-26'],
  },
  {
    name: 'crosses a month boundary',
    from: '2026-01-30',
    to: '2026-02-02',
    zone: 'UTC',
    expected: ['2026-01-30', '2026-01-31', '2026-02-01'],
  },
  {
    name: 'crosses a year boundary',
    from: '2026-12-30',
    to: '2027-01-02',
    zone: 'UTC',
    expected: ['2026-12-30', '2026-12-31', '2027-01-01'],
  },
  {
    name: 'includes the leap day',
    from: '2028-02-28',
    to: '2028-03-02',
    zone: 'UTC',
    expected: ['2028-02-28', '2028-02-29', '2028-03-01'],
  },
  {
    name: 'works in a zone with a half-hour offset',
    from: '2026-07-20',
    to: '2026-07-22',
    zone: 'Asia/Kolkata',
    expected: ['2026-07-20', '2026-07-21'],
  },
  {
    name: 'works in a southern-hemisphere zone across its autumn transition',
    from: '2026-04-04',
    to: '2026-04-07',
    zone: 'Pacific/Auckland',
    expected: ['2026-04-04', '2026-04-05', '2026-04-06'],
  },
]

export interface RangeCase {
  name: string
  from: string
  to: string
  maxDays: number
  /** undefined means the range is valid */
  expectedMessage?: RegExp
}

export const rangeCases: RangeCase[] = [
  { name: 'a normal week', from: '2026-07-20', to: '2026-07-27', maxDays: 366 },
  { name: 'a single day', from: '2026-07-20', to: '2026-07-21', maxDays: 366 },
  { name: 'exactly at the limit', from: '2026-01-01', to: '2026-01-08', maxDays: 7 },
  { name: 'a full non-leap year', from: '2026-01-01', to: '2027-01-01', maxDays: 366 },
  {
    name: 'inverted bounds',
    from: '2026-07-27',
    to: '2026-07-20',
    maxDays: 366,
    expectedMessage: /after/i,
  },
  {
    name: 'coinciding bounds',
    from: '2026-07-20',
    to: '2026-07-20',
    maxDays: 366,
    expectedMessage: /after/i,
  },
  {
    name: 'one day over the limit',
    from: '2026-01-01',
    to: '2026-01-09',
    maxDays: 7,
    expectedMessage: /7 days/,
  },
  {
    name: 'far over the limit',
    from: '2026-01-01',
    to: '2028-01-01',
    maxDays: 366,
    expectedMessage: /366 days/,
  },
  {
    name: 'a day-first date',
    from: '20-07-2026',
    to: '2026-07-27',
    maxDays: 366,
    expectedMessage: /date/i,
  },
  {
    name: 'a nonsense upper bound',
    from: '2026-07-20',
    to: 'tomorrow',
    maxDays: 366,
    expectedMessage: /date/i,
  },
  {
    name: 'an impossible calendar date',
    from: '2026-02-30',
    to: '2026-03-05',
    maxDays: 366,
    expectedMessage: /date/i,
  },
]
