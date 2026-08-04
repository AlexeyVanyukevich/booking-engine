import { DateTime } from 'luxon'
import { InvalidRangeError } from './errors.js'

/** Ranges are half-open: `from` inclusive, `to` exclusive. */
export function assertValidRange(from: string, to: string, maxRangeDays: number): void {
  const start = DateTime.fromISO(from, { zone: 'utc' })
  const end = DateTime.fromISO(to, { zone: 'utc' })

  if (!start.isValid || !end.isValid) {
    throw new InvalidRangeError('from and to must be valid YYYY-MM-DD dates', { from, to })
  }

  if (end <= start) {
    throw new InvalidRangeError('to must be after from', { from, to })
  }

  const days = end.diff(start, 'days').days
  if (days > maxRangeDays) {
    throw new InvalidRangeError(`Range must not exceed ${maxRangeDays} days`, { from, to, days })
  }
}
