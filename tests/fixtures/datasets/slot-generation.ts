import type { AvailabilityWindow } from '../../../src/modules/availability/slot-generator.js'
import type { ExpectedSlot } from './availability-scenarios.js'

export interface SlotGenerationCase {
  name: string
  dates: string[]
  windows: Record<string, AvailabilityWindow[]>
  timezone?: string
  duration?: string
  anchor?: string
  expected: ExpectedSlot[]
}

const window = (start: string, end: string): AvailabilityWindow => ({ start, end })
const wholeDay: AvailabilityWindow = { start: null, end: null }

export const slotGenerationCases: SlotGenerationCase[] = [
  {
    name: 'slices a window into whole slots',
    dates: ['2026-07-20'],
    windows: { '2026-07-20': [window('09:00', '12:00')] },
    expected: [
      ['2026-07-20T09:00:00+02:00', '2026-07-20T10:00:00+02:00'],
      ['2026-07-20T10:00:00+02:00', '2026-07-20T11:00:00+02:00'],
      ['2026-07-20T11:00:00+02:00', '2026-07-20T12:00:00+02:00'],
    ],
  },
  {
    name: 'drops a trailing remainder shorter than one slot',
    dates: ['2026-07-20'],
    windows: { '2026-07-20': [window('09:00', '17:30')] },
    expected: [
      ['2026-07-20T09:00:00+02:00', '2026-07-20T10:00:00+02:00'],
      ['2026-07-20T10:00:00+02:00', '2026-07-20T11:00:00+02:00'],
      ['2026-07-20T11:00:00+02:00', '2026-07-20T12:00:00+02:00'],
      ['2026-07-20T12:00:00+02:00', '2026-07-20T13:00:00+02:00'],
      ['2026-07-20T13:00:00+02:00', '2026-07-20T14:00:00+02:00'],
      ['2026-07-20T14:00:00+02:00', '2026-07-20T15:00:00+02:00'],
      ['2026-07-20T15:00:00+02:00', '2026-07-20T16:00:00+02:00'],
      ['2026-07-20T16:00:00+02:00', '2026-07-20T17:00:00+02:00'],
    ],
  },
  {
    name: 'gives each window on a day its own grid',
    dates: ['2026-07-20'],
    windows: { '2026-07-20': [window('09:00', '11:00'), window('12:30', '14:30')] },
    expected: [
      ['2026-07-20T09:00:00+02:00', '2026-07-20T10:00:00+02:00'],
      ['2026-07-20T10:00:00+02:00', '2026-07-20T11:00:00+02:00'],
      ['2026-07-20T12:30:00+02:00', '2026-07-20T13:30:00+02:00'],
      ['2026-07-20T13:30:00+02:00', '2026-07-20T14:30:00+02:00'],
    ],
  },
  {
    name: 'yields nothing for a date with no windows',
    dates: ['2026-07-20'],
    windows: {},
    expected: [],
  },
  {
    name: 'yields nothing for a window shorter than one slot',
    dates: ['2026-07-20'],
    windows: { '2026-07-20': [window('09:00', '09:30')] },
    expected: [],
  },
  {
    name: 'yields nothing for a zero-length window',
    dates: ['2026-07-20'],
    windows: { '2026-07-20': [window('09:00', '09:00')] },
    expected: [],
  },
  {
    name: 'orders slots ascending even when the dates arrive out of order',
    dates: ['2026-07-21', '2026-07-20'],
    windows: {
      '2026-07-20': [window('09:00', '10:00')],
      '2026-07-21': [window('09:00', '10:00')],
    },
    expected: [
      ['2026-07-20T09:00:00+02:00', '2026-07-20T10:00:00+02:00'],
      ['2026-07-21T09:00:00+02:00', '2026-07-21T10:00:00+02:00'],
    ],
  },
  {
    name: 'orders slots ascending when windows on a day arrive out of order',
    dates: ['2026-07-20'],
    windows: { '2026-07-20': [window('14:00', '15:00'), window('09:00', '10:00')] },
    expected: [
      ['2026-07-20T09:00:00+02:00', '2026-07-20T10:00:00+02:00'],
      ['2026-07-20T14:00:00+02:00', '2026-07-20T15:00:00+02:00'],
    ],
  },
  {
    name: 'fills a window ending at the last minute of the day',
    dates: ['2026-07-20'],
    windows: { '2026-07-20': [window('22:00', '23:59')] },
    duration: 'PT30M',
    expected: [
      ['2026-07-20T22:00:00+02:00', '2026-07-20T22:30:00+02:00'],
      ['2026-07-20T22:30:00+02:00', '2026-07-20T23:00:00+02:00'],
      ['2026-07-20T23:00:00+02:00', '2026-07-20T23:30:00+02:00'],
    ],
  },
  {
    name: 'emits one anchor-to-anchor slot per day-based date',
    dates: ['2026-07-20', '2026-07-21'],
    windows: { '2026-07-20': [wholeDay], '2026-07-21': [wholeDay] },
    duration: 'P1D',
    anchor: '14:00',
    expected: [
      ['2026-07-20T14:00:00+02:00', '2026-07-21T14:00:00+02:00'],
      ['2026-07-21T14:00:00+02:00', '2026-07-22T14:00:00+02:00'],
    ],
  },
  {
    name: 'treats the default anchor as calendar days',
    dates: ['2026-07-20'],
    windows: { '2026-07-20': [wholeDay] },
    duration: 'P1D',
    expected: [['2026-07-20T00:00:00+02:00', '2026-07-21T00:00:00+02:00']],
  },
  {
    name: 'emits a multi-day slot for P7D',
    dates: ['2026-07-20'],
    windows: { '2026-07-20': [wholeDay] },
    duration: 'P7D',
    anchor: '16:00',
    expected: [['2026-07-20T16:00:00+02:00', '2026-07-27T16:00:00+02:00']],
  },
  {
    name: 'emits a multi-day slot spanning a transition',
    dates: ['2026-03-27'],
    windows: { '2026-03-27': [wholeDay] },
    duration: 'P7D',
    expected: [['2026-03-27T00:00:00+01:00', '2026-04-03T00:00:00+02:00']],
  },
]
