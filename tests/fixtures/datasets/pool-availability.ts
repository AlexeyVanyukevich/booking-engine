export interface PoolAvailabilityCase {
  name: string
  /** One entry per member: its weekly windows, its day-off dates, and whether it is active. */
  members: Array<{
    windows: Array<[day: number, start: string | null, end: string | null]>
    daysOff?: string[]
    active?: boolean
  }>
  from: string
  to: string
  /** Slot starts that must come back `available: true`, in order. */
  availableStarts: string[]
  /** Slot starts that must come back, but `available: false`. */
  unavailableStarts?: string[]
}

export const wholeWeek: Array<[number, null, null]> = [0, 1, 2, 3, 4, 5, 6].map((d) => [
  d,
  null,
  null,
])

export const poolAvailabilityCases: PoolAvailabilityCase[] = [
  {
    name: 'a slot one member offers is offered by the pool',
    members: [{ windows: [[0, null, null]] }, { windows: [] }],
    from: '2026-07-20',
    to: '2026-07-21',
    availableStarts: ['2026-07-20T14:00:00+02:00'],
  },
  {
    name: 'a day off on one member is covered by the other',
    members: [{ windows: wholeWeek, daysOff: ['2026-07-21'] }, { windows: wholeWeek }],
    from: '2026-07-20',
    to: '2026-07-23',
    availableStarts: [
      '2026-07-20T14:00:00+02:00',
      '2026-07-21T14:00:00+02:00',
      '2026-07-22T14:00:00+02:00',
    ],
  },
  {
    name: 'a day off on every member removes the slot entirely',
    members: [
      { windows: wholeWeek, daysOff: ['2026-07-21'] },
      { windows: wholeWeek, daysOff: ['2026-07-21'] },
    ],
    from: '2026-07-21',
    to: '2026-07-22',
    availableStarts: [],
  },
  {
    name: 'an inactive member does not contribute',
    members: [{ windows: wholeWeek, active: false }, { windows: [] }],
    from: '2026-07-20',
    to: '2026-07-21',
    availableStarts: [],
  },
  {
    name: 'a pool with no members offers nothing',
    members: [],
    from: '2026-07-20',
    to: '2026-07-21',
    availableStarts: [],
  },
]
