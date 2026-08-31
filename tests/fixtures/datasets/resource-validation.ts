import { TIMEZONES, type ResourcePayload } from '../resources.js'

export interface ResourceCase {
  name: string
  overrides: Record<string, unknown>
}

export interface RejectedResourceCase extends ResourceCase {
  expectedError: string
}

export interface AcceptedResourceCase extends ResourceCase {
  /** Fields the created resource must report back */
  expected: Partial<ResourcePayload> & Record<string, unknown>
}

export const acceptedResources: AcceptedResourceCase[] = [
  {
    name: 'an hourly resource, defaults applied',
    overrides: {},
    expected: {
      timezone: TIMEZONES.warsaw,
      slot_duration: 'PT1H',
      slot_anchor_time: '00:00',
      capacity: 1,
      concurrency_mode: 'exclusive',
      is_active: true,
    },
  },
  {
    name: 'a day-based resource with a 14:00 anchor',
    overrides: { slot_duration: 'P1D', slot_anchor_time: '14:00' },
    expected: { slot_duration: 'P1D', slot_anchor_time: '14:00' },
  },
  {
    name: 'a day-based resource keeping the midnight anchor',
    overrides: { slot_duration: 'P1D' },
    expected: { slot_duration: 'P1D', slot_anchor_time: '00:00' },
  },
  {
    name: 'a weekly resource',
    overrides: { slot_duration: 'P7D', slot_anchor_time: '16:00' },
    expected: { slot_duration: 'P7D', slot_anchor_time: '16:00' },
  },
  {
    name: 'a shared resource with capacity above one',
    overrides: { concurrency_mode: 'shared', capacity: 12 },
    expected: { concurrency_mode: 'shared', capacity: 12 },
  },
  {
    name: 'a shared resource with capacity of exactly one',
    overrides: { concurrency_mode: 'shared', capacity: 1 },
    expected: { concurrency_mode: 'shared', capacity: 1 },
  },
  {
    name: 'an exclusive resource stating capacity 1 explicitly',
    overrides: { concurrency_mode: 'exclusive', capacity: 1 },
    expected: { concurrency_mode: 'exclusive', capacity: 1 },
  },
  {
    name: 'a resource in a zone with a half-hour offset',
    overrides: { timezone: TIMEZONES.kolkata },
    expected: { timezone: TIMEZONES.kolkata },
  },
  {
    name: 'a resource in UTC',
    overrides: { timezone: TIMEZONES.utc },
    expected: { timezone: TIMEZONES.utc },
  },
  {
    name: 'a resource in a legacy named zone that still carries DST rules',
    overrides: { timezone: 'CET' },
    expected: { timezone: 'CET' },
  },
  {
    name: 'a duration with a redundant zero component, stored canonically',
    overrides: { slot_duration: 'PT0H30M' },
    expected: { slot_duration: 'PT30M' },
  },
  {
    name: 'a resource in a southern-hemisphere zone',
    overrides: { timezone: TIMEZONES.auckland },
    expected: { timezone: TIMEZONES.auckland },
  },
  {
    name: 'the shortest allowed slot',
    overrides: { slot_duration: 'PT1M' },
    expected: { slot_duration: 'PT1M' },
  },
  {
    name: 'the longest allowed intraday slot',
    overrides: { slot_duration: 'PT23H59M' },
    expected: { slot_duration: 'PT23H59M' },
  },
  {
    name: 'an anchor at the last minute of the day',
    overrides: { slot_duration: 'P1D', slot_anchor_time: '23:59' },
    expected: { slot_anchor_time: '23:59' },
  },
]

export const rejectedResources: RejectedResourceCase[] = [
  {
    name: 'an unknown IANA timezone',
    overrides: { timezone: 'Mars/Olympus' },
    expectedError: 'validation_error',
  },
  {
    name: 'a fixed offset written where a zone belongs',
    overrides: { timezone: '+02:00' },
    expectedError: 'validation_error',
  },
  {
    name: 'a negative fixed offset',
    overrides: { timezone: '-05:00' },
    expectedError: 'validation_error',
  },
  {
    name: 'a compact fixed offset',
    overrides: { timezone: '+0200' },
    expectedError: 'validation_error',
  },
  { name: 'an empty timezone', overrides: { timezone: '' }, expectedError: 'validation_error' },
  {
    name: 'a fixed 24-hour duration, which is not a calendar day',
    overrides: { slot_duration: 'PT24H' },
    expectedError: 'validation_error',
  },
  {
    name: 'a duration in months',
    overrides: { slot_duration: 'P1M' },
    expectedError: 'validation_error',
  },
  {
    name: 'a duration mixing days and hours',
    overrides: { slot_duration: 'P1DT2H' },
    expectedError: 'validation_error',
  },
  {
    name: 'a zero-length duration',
    overrides: { slot_duration: 'PT0M' },
    expectedError: 'validation_error',
  },
  {
    name: 'a duration beyond the ceiling',
    overrides: { slot_duration: 'P367D' },
    expectedError: 'validation_error',
  },
  {
    name: 'exclusive mode with capacity above one',
    overrides: { concurrency_mode: 'exclusive', capacity: 3 },
    expectedError: 'validation_error',
  },
  {
    name: 'a capacity of zero',
    overrides: { concurrency_mode: 'shared', capacity: 0 },
    expectedError: 'validation_error',
  },
  {
    name: 'a negative capacity',
    overrides: { concurrency_mode: 'shared', capacity: -1 },
    expectedError: 'validation_error',
  },
  {
    name: 'a fractional capacity',
    overrides: { concurrency_mode: 'shared', capacity: 2.5 },
    expectedError: 'validation_error',
  },
  {
    name: 'pool mode with capacity above one',
    overrides: { concurrency_mode: 'pool', capacity: 3 },
    expectedError: 'validation_error',
  },
  {
    name: 'an unknown concurrency mode',
    overrides: { concurrency_mode: 'whatever' },
    expectedError: 'validation_error',
  },
  {
    name: 'a non-default anchor on an intraday resource',
    overrides: { slot_duration: 'PT30M', slot_anchor_time: '14:00' },
    expectedError: 'validation_error',
  },
  {
    name: 'an anchor with seconds',
    overrides: { slot_duration: 'P1D', slot_anchor_time: '14:00:00' },
    expectedError: 'validation_error',
  },
  {
    name: 'an anchor past the end of the day',
    overrides: { slot_duration: 'P1D', slot_anchor_time: '24:00' },
    expectedError: 'validation_error',
  },
  {
    name: 'an unknown field',
    overrides: { colour: 'blue' },
    expectedError: 'validation_error',
  },
]

export interface PatchCase {
  name: string
  /** Resource to create first */
  create?: Record<string, unknown>
  patch: Record<string, unknown>
}

export interface AcceptedPatchCase extends PatchCase {
  expected: Record<string, unknown>
}

export interface RejectedPatchCase extends PatchCase {
  expectedError: string
}

export const acceptedPatches: AcceptedPatchCase[] = [
  {
    name: 'changes the slot duration',
    patch: { slot_duration: 'PT30M' },
    expected: { slot_duration: 'PT30M' },
  },
  { name: 'deactivates the resource', patch: { is_active: false }, expected: { is_active: false } },
  {
    name: 'reactivates the resource',
    create: { concurrency_mode: 'shared', capacity: 2 },
    patch: { is_active: true },
    expected: { is_active: true },
  },
  {
    name: 'raises the capacity of a shared resource',
    create: { concurrency_mode: 'shared', capacity: 2 },
    patch: { capacity: 20 },
    expected: { capacity: 20 },
  },
  {
    name: 'moves the anchor of a day-based resource',
    create: { slot_duration: 'P1D', slot_anchor_time: '14:00' },
    patch: { slot_anchor_time: '15:00' },
    expected: { slot_anchor_time: '15:00' },
  },
  {
    name: 'turns an intraday resource into a day-based one',
    patch: { slot_duration: 'P1D', slot_anchor_time: '14:00' },
    expected: { slot_duration: 'P1D', slot_anchor_time: '14:00' },
  },
  {
    name: 'accepts an empty patch',
    patch: {},
    expected: { slot_duration: 'PT1H' },
  },
  {
    name: 'changes several fields at once',
    patch: { slot_duration: 'PT15M', is_active: false },
    expected: { slot_duration: 'PT15M', is_active: false },
  },
]

export const rejectedPatches: RejectedPatchCase[] = [
  {
    name: 'changing the timezone',
    patch: { timezone: 'Europe/Berlin' },
    expectedError: 'validation_error',
  },
  {
    name: 'changing the concurrency mode',
    patch: { concurrency_mode: 'shared' },
    expectedError: 'validation_error',
  },
  { name: 'changing the id', patch: { id: 'anything' }, expectedError: 'validation_error' },
  {
    name: 'an unknown field',
    patch: { colour: 'blue' },
    expectedError: 'validation_error',
  },
  {
    name: 'a duration that leaves the existing anchor invalid',
    create: { slot_duration: 'P1D', slot_anchor_time: '14:00' },
    patch: { slot_duration: 'PT1H' },
    expectedError: 'validation_error',
  },
  {
    name: 'an anchor an intraday resource may not have',
    patch: { slot_anchor_time: '14:00' },
    expectedError: 'validation_error',
  },
  {
    name: 'raising capacity above one on an exclusive resource',
    patch: { capacity: 5 },
    expectedError: 'validation_error',
  },
  {
    name: 'a capacity of zero',
    create: { concurrency_mode: 'shared', capacity: 4 },
    patch: { capacity: 0 },
    expectedError: 'validation_error',
  },
  {
    name: 'a malformed duration',
    patch: { slot_duration: 'PT24H' },
    expectedError: 'validation_error',
  },
]
