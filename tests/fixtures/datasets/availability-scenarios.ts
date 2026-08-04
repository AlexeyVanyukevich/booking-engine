import { TIMEZONES, aResource, type ResourcePayload } from '../resources.js'
import {
  WEEKDAYS,
  aDayOff,
  aWholeDay,
  aWindow,
  alteredHours,
  everyDay,
  windowsOn,
  type ExceptionInput,
  type ScheduleRule,
} from '../schedules.js'

/** A slot as [start, end], both ISO-8601 with offset. */
export type ExpectedSlot = [string, string]

export interface AvailabilityScenario {
  name: string
  resource: ResourcePayload
  schedule: ScheduleRule[]
  exceptions?: ExceptionInput[]
  deactivate?: boolean
  from: string
  to: string
  expected: ExpectedSlot[]
}

/**
 * 2026-07-20 is a Monday. Offsets below were derived from the tz database rather than written
 * from memory; see `data/dst-transitions.json`.
 */
export const availabilityScenarios: AvailabilityScenario[] = [
  {
    name: 'hourly slots inside a single window',
    resource: aResource(),
    schedule: [aWindow(WEEKDAYS.monday, '09:00', '12:00')],
    from: '2026-07-20',
    to: '2026-07-21',
    expected: [
      ['2026-07-20T09:00:00+02:00', '2026-07-20T10:00:00+02:00'],
      ['2026-07-20T10:00:00+02:00', '2026-07-20T11:00:00+02:00'],
      ['2026-07-20T11:00:00+02:00', '2026-07-20T12:00:00+02:00'],
    ],
  },
  {
    name: 'a trailing remainder shorter than one slot is dropped',
    resource: aResource({ slot_duration: 'PT1H30M' }),
    schedule: [aWindow(WEEKDAYS.monday, '09:00', '13:00')],
    from: '2026-07-20',
    to: '2026-07-21',
    expected: [
      ['2026-07-20T09:00:00+02:00', '2026-07-20T10:30:00+02:00'],
      ['2026-07-20T10:30:00+02:00', '2026-07-20T12:00:00+02:00'],
    ],
  },
  {
    name: 'a window shorter than one slot yields nothing',
    resource: aResource(),
    schedule: [aWindow(WEEKDAYS.monday, '09:00', '09:30')],
    from: '2026-07-20',
    to: '2026-07-21',
    expected: [],
  },
  {
    name: 'a window exactly one slot long yields one slot',
    resource: aResource(),
    schedule: [aWindow(WEEKDAYS.monday, '09:00', '10:00')],
    from: '2026-07-20',
    to: '2026-07-21',
    expected: [['2026-07-20T09:00:00+02:00', '2026-07-20T10:00:00+02:00']],
  },
  {
    name: 'two windows on one day each start their own grid',
    resource: aResource(),
    schedule: [
      aWindow(WEEKDAYS.monday, '09:00', '11:00'),
      aWindow(WEEKDAYS.monday, '14:00', '16:00'),
    ],
    from: '2026-07-20',
    to: '2026-07-21',
    expected: [
      ['2026-07-20T09:00:00+02:00', '2026-07-20T10:00:00+02:00'],
      ['2026-07-20T10:00:00+02:00', '2026-07-20T11:00:00+02:00'],
      ['2026-07-20T14:00:00+02:00', '2026-07-20T15:00:00+02:00'],
      ['2026-07-20T15:00:00+02:00', '2026-07-20T16:00:00+02:00'],
    ],
  },
  {
    name: 'a grid offset from the hour is preserved',
    resource: aResource({ slot_duration: 'PT30M' }),
    schedule: [aWindow(WEEKDAYS.monday, '09:15', '10:15')],
    from: '2026-07-20',
    to: '2026-07-21',
    expected: [
      ['2026-07-20T09:15:00+02:00', '2026-07-20T09:45:00+02:00'],
      ['2026-07-20T09:45:00+02:00', '2026-07-20T10:15:00+02:00'],
    ],
  },
  {
    name: 'Sunday is weekday six, not zero',
    resource: aResource(),
    schedule: [aWindow(WEEKDAYS.sunday, '09:00', '10:00')],
    from: '2026-07-20',
    to: '2026-07-27',
    expected: [['2026-07-26T09:00:00+02:00', '2026-07-26T10:00:00+02:00']],
  },
  {
    name: 'Monday is weekday zero',
    resource: aResource(),
    schedule: [aWindow(WEEKDAYS.monday, '09:00', '10:00')],
    from: '2026-07-20',
    to: '2026-07-27',
    expected: [['2026-07-20T09:00:00+02:00', '2026-07-20T10:00:00+02:00']],
  },
  {
    name: 'a full week of identical windows',
    resource: aResource(),
    schedule: windowsOn([0, 1, 2, 3, 4, 5, 6], '09:00', '10:00'),
    from: '2026-07-20',
    to: '2026-07-27',
    expected: [
      ['2026-07-20T09:00:00+02:00', '2026-07-20T10:00:00+02:00'],
      ['2026-07-21T09:00:00+02:00', '2026-07-21T10:00:00+02:00'],
      ['2026-07-22T09:00:00+02:00', '2026-07-22T10:00:00+02:00'],
      ['2026-07-23T09:00:00+02:00', '2026-07-23T10:00:00+02:00'],
      ['2026-07-24T09:00:00+02:00', '2026-07-24T10:00:00+02:00'],
      ['2026-07-25T09:00:00+02:00', '2026-07-25T10:00:00+02:00'],
      ['2026-07-26T09:00:00+02:00', '2026-07-26T10:00:00+02:00'],
    ],
  },
  {
    name: 'the range is half-open, so nothing lands on the `to` date',
    resource: aResource(),
    schedule: windowsOn([0, 1], '09:00', '10:00'),
    from: '2026-07-20',
    to: '2026-07-21',
    expected: [['2026-07-20T09:00:00+02:00', '2026-07-20T10:00:00+02:00']],
  },
  {
    name: 'no schedule yields no slots',
    resource: aResource(),
    schedule: [],
    from: '2026-07-20',
    to: '2026-07-27',
    expected: [],
  },
  {
    name: 'an inactive resource yields no slots',
    resource: aResource(),
    schedule: [aWindow(WEEKDAYS.monday, '09:00', '12:00')],
    deactivate: true,
    from: '2026-07-20',
    to: '2026-07-21',
    expected: [],
  },

  // ── Exceptions ──────────────────────────────────────────────────────────────
  {
    name: 'an exception replaces the weekly schedule for its date',
    resource: aResource(),
    schedule: [aWindow(WEEKDAYS.monday, '09:00', '12:00')],
    exceptions: [alteredHours('2026-07-20', '15:00', '17:00')],
    from: '2026-07-20',
    to: '2026-07-21',
    expected: [
      ['2026-07-20T15:00:00+02:00', '2026-07-20T16:00:00+02:00'],
      ['2026-07-20T16:00:00+02:00', '2026-07-20T17:00:00+02:00'],
    ],
  },
  {
    name: 'an exception never merges with the weekly schedule',
    resource: aResource(),
    schedule: [
      aWindow(WEEKDAYS.monday, '09:00', '10:00'),
      aWindow(WEEKDAYS.monday, '11:00', '12:00'),
    ],
    exceptions: [alteredHours('2026-07-20', '15:00', '16:00')],
    from: '2026-07-20',
    to: '2026-07-21',
    expected: [['2026-07-20T15:00:00+02:00', '2026-07-20T16:00:00+02:00']],
  },
  {
    name: 'a day off removes the day entirely',
    resource: aResource(),
    schedule: [aWindow(WEEKDAYS.monday, '09:00', '12:00')],
    exceptions: [aDayOff('2026-07-20')],
    from: '2026-07-20',
    to: '2026-07-21',
    expected: [],
  },
  {
    name: 'a day off affects only its own date',
    resource: aResource(),
    schedule: windowsOn([0, 1], '09:00', '10:00'),
    exceptions: [aDayOff('2026-07-20')],
    from: '2026-07-20',
    to: '2026-07-22',
    expected: [['2026-07-21T09:00:00+02:00', '2026-07-21T10:00:00+02:00']],
  },
  {
    name: 'an exception on a day with no weekly schedule adds availability',
    resource: aResource(),
    schedule: [],
    exceptions: [alteredHours('2026-07-20', '09:00', '11:00')],
    from: '2026-07-20',
    to: '2026-07-21',
    expected: [
      ['2026-07-20T09:00:00+02:00', '2026-07-20T10:00:00+02:00'],
      ['2026-07-20T10:00:00+02:00', '2026-07-20T11:00:00+02:00'],
    ],
  },
  {
    name: 'exceptions outside the queried range are ignored',
    resource: aResource(),
    schedule: windowsOn([0, 1], '09:00', '10:00'),
    exceptions: [aDayOff('2026-07-27')],
    from: '2026-07-20',
    to: '2026-07-22',
    expected: [
      ['2026-07-20T09:00:00+02:00', '2026-07-20T10:00:00+02:00'],
      ['2026-07-21T09:00:00+02:00', '2026-07-21T10:00:00+02:00'],
    ],
  },

  // ── Day-based resources ─────────────────────────────────────────────────────
  {
    name: 'a hotel night runs from anchor to anchor',
    resource: aResource({ slot_duration: 'P1D', slot_anchor_time: '14:00' }),
    schedule: everyDay(),
    from: '2026-07-20',
    to: '2026-07-23',
    expected: [
      ['2026-07-20T14:00:00+02:00', '2026-07-21T14:00:00+02:00'],
      ['2026-07-21T14:00:00+02:00', '2026-07-22T14:00:00+02:00'],
      ['2026-07-22T14:00:00+02:00', '2026-07-23T14:00:00+02:00'],
    ],
  },
  {
    name: 'the default anchor gives calendar days',
    resource: aResource({ slot_duration: 'P1D' }),
    schedule: everyDay(),
    from: '2026-07-20',
    to: '2026-07-22',
    expected: [
      ['2026-07-20T00:00:00+02:00', '2026-07-21T00:00:00+02:00'],
      ['2026-07-21T00:00:00+02:00', '2026-07-22T00:00:00+02:00'],
    ],
  },
  {
    name: 'a weekly slot spans seven days from its anchor',
    resource: aResource({ slot_duration: 'P7D', slot_anchor_time: '16:00' }),
    schedule: [aWholeDay(WEEKDAYS.monday)],
    from: '2026-07-20',
    to: '2026-07-21',
    expected: [['2026-07-20T16:00:00+02:00', '2026-07-27T16:00:00+02:00']],
  },
  {
    name: 'a day-based resource honours a day off',
    resource: aResource({ slot_duration: 'P1D', slot_anchor_time: '14:00' }),
    schedule: everyDay(),
    exceptions: [aDayOff('2026-07-21')],
    from: '2026-07-20',
    to: '2026-07-23',
    expected: [
      ['2026-07-20T14:00:00+02:00', '2026-07-21T14:00:00+02:00'],
      ['2026-07-22T14:00:00+02:00', '2026-07-23T14:00:00+02:00'],
    ],
  },
  {
    name: 'a day-based resource available only on weekends',
    resource: aResource({ slot_duration: 'P1D' }),
    schedule: [aWholeDay(WEEKDAYS.saturday), aWholeDay(WEEKDAYS.sunday)],
    from: '2026-07-20',
    to: '2026-07-27',
    expected: [
      ['2026-07-25T00:00:00+02:00', '2026-07-26T00:00:00+02:00'],
      ['2026-07-26T00:00:00+02:00', '2026-07-27T00:00:00+02:00'],
    ],
  },

  // ── Daylight saving, all offsets derived from the tz database ───────────────
  {
    name: 'Warsaw spring forward: the transition day is 23 real hours, anchor unmoved',
    resource: aResource({ slot_duration: 'P1D' }),
    schedule: everyDay(),
    from: '2026-03-28',
    to: '2026-03-31',
    expected: [
      ['2026-03-28T00:00:00+01:00', '2026-03-29T00:00:00+01:00'],
      ['2026-03-29T00:00:00+01:00', '2026-03-30T00:00:00+02:00'],
      ['2026-03-30T00:00:00+02:00', '2026-03-31T00:00:00+02:00'],
    ],
  },
  {
    name: 'Warsaw fall back: the transition day is 25 real hours',
    resource: aResource({ slot_duration: 'P1D' }),
    schedule: everyDay(),
    from: '2026-10-24',
    to: '2026-10-27',
    expected: [
      ['2026-10-24T00:00:00+02:00', '2026-10-25T00:00:00+02:00'],
      ['2026-10-25T00:00:00+02:00', '2026-10-26T00:00:00+01:00'],
      ['2026-10-26T00:00:00+01:00', '2026-10-27T00:00:00+01:00'],
    ],
  },
  {
    name: 'a 14:00 hotel anchor stays at 14:00 local across a transition',
    resource: aResource({ slot_duration: 'P1D', slot_anchor_time: '14:00' }),
    schedule: everyDay(),
    from: '2026-03-28',
    to: '2026-03-31',
    expected: [
      ['2026-03-28T14:00:00+01:00', '2026-03-29T14:00:00+02:00'],
      ['2026-03-29T14:00:00+02:00', '2026-03-30T14:00:00+02:00'],
      ['2026-03-30T14:00:00+02:00', '2026-03-31T14:00:00+02:00'],
    ],
  },
  {
    name: 'an intraday grid does not drift on a transition day',
    resource: aResource(),
    schedule: everyDayWindow('09:00', '12:00'),
    from: '2026-03-29',
    to: '2026-03-30',
    expected: [
      ['2026-03-29T09:00:00+02:00', '2026-03-29T10:00:00+02:00'],
      ['2026-03-29T10:00:00+02:00', '2026-03-29T11:00:00+02:00'],
      ['2026-03-29T11:00:00+02:00', '2026-03-29T12:00:00+02:00'],
    ],
  },
  {
    name: 'New York transitions on a different date than Europe',
    resource: aResource({ timezone: TIMEZONES.newYork }),
    schedule: everyDayWindow('09:00', '11:00'),
    from: '2026-03-08',
    to: '2026-03-09',
    expected: [
      ['2026-03-08T09:00:00-04:00', '2026-03-08T10:00:00-04:00'],
      ['2026-03-08T10:00:00-04:00', '2026-03-08T11:00:00-04:00'],
    ],
  },
  {
    name: 'Auckland falls back in April, being in the southern hemisphere',
    resource: aResource({ timezone: TIMEZONES.auckland, slot_duration: 'P1D' }),
    schedule: everyDay(),
    from: '2026-04-04',
    to: '2026-04-07',
    expected: [
      ['2026-04-04T00:00:00+13:00', '2026-04-05T00:00:00+13:00'],
      ['2026-04-05T00:00:00+13:00', '2026-04-06T00:00:00+12:00'],
      ['2026-04-06T00:00:00+12:00', '2026-04-07T00:00:00+12:00'],
    ],
  },
  {
    name: 'Adelaide keeps half-hour offsets on both sides of a transition',
    resource: aResource({ timezone: TIMEZONES.adelaide, slot_duration: 'P1D' }),
    schedule: everyDay(),
    from: '2026-10-03',
    to: '2026-10-06',
    expected: [
      ['2026-10-03T00:00:00+09:30', '2026-10-04T00:00:00+09:30'],
      ['2026-10-04T00:00:00+09:30', '2026-10-05T00:00:00+10:30'],
      ['2026-10-05T00:00:00+10:30', '2026-10-06T00:00:00+10:30'],
    ],
  },
  {
    name: 'Kolkata keeps a half-hour offset all year, having no DST',
    resource: aResource({ timezone: TIMEZONES.kolkata }),
    schedule: [aWindow(WEEKDAYS.monday, '09:00', '11:00')],
    from: '2026-07-20',
    to: '2026-07-21',
    expected: [
      ['2026-07-20T09:00:00+05:30', '2026-07-20T10:00:00+05:30'],
      ['2026-07-20T10:00:00+05:30', '2026-07-20T11:00:00+05:30'],
    ],
  },
  {
    name: 'UTC renders as Z rather than +00:00',
    resource: aResource({ timezone: TIMEZONES.utc }),
    schedule: [aWindow(WEEKDAYS.monday, '09:00', '11:00')],
    from: '2026-07-20',
    to: '2026-07-21',
    expected: [
      ['2026-07-20T09:00:00Z', '2026-07-20T10:00:00Z'],
      ['2026-07-20T10:00:00Z', '2026-07-20T11:00:00Z'],
    ],
  },
]

function everyDayWindow(start: string, end: string): ScheduleRule[] {
  return windowsOn([0, 1, 2, 3, 4, 5, 6], start, end)
}
