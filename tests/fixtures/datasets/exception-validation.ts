export interface ExceptionBodyCase {
  name: string
  kind: 'intraday' | 'day'
  body: Record<string, unknown>
}

export interface RejectedExceptionCase extends ExceptionBodyCase {
  expectedError: string
}

export const acceptedExceptions: ExceptionBodyCase[] = [
  {
    name: 'altered hours on an intraday resource',
    kind: 'intraday',
    body: { start_time: '10:00', end_time: '14:00' },
  },
  {
    name: 'altered hours covering the whole day',
    kind: 'intraday',
    body: { start_time: '00:00', end_time: '23:59' },
  },
  {
    name: 'a one-minute window',
    kind: 'intraday',
    body: { start_time: '09:00', end_time: '09:01' },
  },
  {
    name: 'a day off on an intraday resource',
    kind: 'intraday',
    body: { start_time: null, end_time: null },
  },
  {
    name: 'a day off on a day-based resource',
    kind: 'day',
    body: { start_time: null, end_time: null },
  },
]

export const rejectedExceptions: RejectedExceptionCase[] = [
  {
    name: 'altered hours on a day-based resource, which has no hours to alter',
    kind: 'day',
    body: { start_time: '10:00', end_time: '14:00' },
    expectedError: 'schedule_shape_mismatch',
  },
  {
    name: 'only the start time set',
    kind: 'intraday',
    body: { start_time: '10:00', end_time: null },
    expectedError: 'validation_error',
  },
  {
    name: 'only the end time set',
    kind: 'intraday',
    body: { start_time: null, end_time: '14:00' },
    expectedError: 'validation_error',
  },
  {
    name: 'a window ending before it starts',
    kind: 'intraday',
    body: { start_time: '17:00', end_time: '10:00' },
    expectedError: 'validation_error',
  },
  {
    name: 'a window crossing midnight',
    kind: 'intraday',
    body: { start_time: '22:00', end_time: '02:00' },
    expectedError: 'validation_error',
  },
  {
    name: 'a zero-length window',
    kind: 'intraday',
    body: { start_time: '10:00', end_time: '10:00' },
    expectedError: 'validation_error',
  },
  {
    name: 'a time with seconds',
    kind: 'intraday',
    body: { start_time: '10:00:00', end_time: '14:00' },
    expectedError: 'validation_error',
  },
  {
    name: 'an hour past the end of the day',
    kind: 'intraday',
    body: { start_time: '24:00', end_time: '25:00' },
    expectedError: 'validation_error',
  },
  {
    name: 'a missing end time',
    kind: 'intraday',
    body: { start_time: '10:00' },
    expectedError: 'validation_error',
  },
  {
    name: 'an unknown field',
    kind: 'intraday',
    body: { start_time: null, end_time: null, reason: 'holiday' },
    expectedError: 'validation_error',
  },
]

/** Path parameters that must be rejected before the handler runs. */
export const malformedExceptionDates = [
  '20-07-2026',
  '2026-7-20',
  '20260720',
  'tomorrow',
  '2026-07',
] as const

/** Dates that parse but describe no real day. */
export const impossibleExceptionDates = ['2026-02-30', '2026-13-01', '2027-02-29'] as const
