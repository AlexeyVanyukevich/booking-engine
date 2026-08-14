/**
 * Intervals the engine must refuse, against an hourly Warsaw resource open 09:00–12:00 on
 * Monday 2026-07-20. Extending coverage means adding a row here.
 */
export interface RejectedBooking {
  name: string
  start_time: string
  end_time: string
  status: number
  error: string
}

const at = (hour: string) => `2026-07-20T${hour}:00+02:00`

export const rejectedBookings: readonly RejectedBooking[] = [
  {
    name: 'a start half an hour off the grid',
    start_time: at('09:30'),
    end_time: at('10:30'),
    status: 400,
    error: 'invalid_slot_boundary',
  },
  {
    name: 'an end landing inside a slot',
    start_time: at('09:00'),
    end_time: at('09:30'),
    status: 400,
    error: 'invalid_slot_boundary',
  },
  {
    name: 'a run extending past the window',
    start_time: at('11:00'),
    end_time: at('13:00'),
    status: 400,
    error: 'outside_schedule',
  },
  {
    name: 'a start before the window opens',
    start_time: at('08:00'),
    end_time: at('09:00'),
    status: 400,
    error: 'invalid_slot_boundary',
  },
  {
    name: 'an inverted interval',
    start_time: at('10:00'),
    end_time: at('09:00'),
    status: 400,
    error: 'invalid_interval',
  },
  {
    name: 'a zero-length interval',
    start_time: at('09:00'),
    end_time: at('09:00'),
    status: 400,
    error: 'invalid_interval',
  },
  {
    // 2026-07-21 is a Tuesday; only Monday is scheduled.
    name: 'a date the resource does not work',
    start_time: '2026-07-21T09:00:00+02:00',
    end_time: '2026-07-21T10:00:00+02:00',
    status: 400,
    error: 'invalid_slot_boundary',
  },
]
