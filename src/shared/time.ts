import { DateTime, Duration } from 'luxon'

export class InvalidDurationError extends Error {
  constructor(value: string) {
    super(`Invalid slot duration "${value}": expected P<n>D or PT[<n>H][<n>M] under 24 hours`)
    this.name = 'InvalidDurationError'
  }
}

export interface SlotDuration {
  /**
   * Canonical form, which may differ from the submitted string: `PT0H30M` normalizes to
   * `PT30M`. Postgres normalizes intervals on storage anyway, so canonicalizing on the way
   * in is what keeps a resource's reported duration identical to the one that was sent.
   */
  iso: string
  kind: 'day' | 'intraday'
  luxon: Duration
}

function canonicalIntraday(hours: number, minutes: number): string {
  const parts = [hours > 0 ? `${hours}H` : '', minutes > 0 ? `${minutes}M` : ''].join('')
  return `PT${parts}`
}

const DAY_PATTERN = /^P(\d+)D$/
const TIME_PATTERN = /^PT(?:(\d+)H)?(?:(\d+)M)?$/

const MAX_DAYS = 366

/**
 * The written form decides the kind: P1D means "anchor to anchor" — 23, 24 or 25 real hours
 * depending on DST — while PT24H would mean exactly 24 elapsed hours. Treating them as
 * interchangeable breaks day-based resources twice a year, so PT durations are capped below
 * 24 hours and never produce a day-based resource. A longer PT duration could not fit inside
 * an intraday window anyway.
 */
export function parseSlotDuration(value: string): SlotDuration {
  const dayMatch = DAY_PATTERN.exec(value)
  if (dayMatch) {
    const days = Number(dayMatch[1])
    if (days < 1 || days > MAX_DAYS) throw new InvalidDurationError(value)
    return { iso: `P${days}D`, kind: 'day', luxon: Duration.fromObject({ days }) }
  }

  const timeMatch = TIME_PATTERN.exec(value)
  if (timeMatch && (timeMatch[1] !== undefined || timeMatch[2] !== undefined)) {
    const hours = Number(timeMatch[1] ?? 0)
    const minutes = Number(timeMatch[2] ?? 0)
    const total = hours * 60 + minutes
    if (total < 1 || total >= 24 * 60) throw new InvalidDurationError(value)
    return {
      iso: canonicalIntraday(hours, minutes),
      kind: 'intraday',
      luxon: Duration.fromObject({ hours, minutes }),
    }
  }

  throw new InvalidDurationError(value)
}

/**
 * The engine's convention is Monday = 0 … Sunday = 6. Luxon uses Monday = 1 … Sunday = 7,
 * while Postgres EXTRACT(DOW) and JS getDay() both use Sunday = 0. This is the only place in
 * the codebase permitted to convert between them.
 */
export function dayOfWeekOf(dt: DateTime): number {
  return (dt.weekday + 6) % 7
}

export function formatTime(pgTime: string): string {
  return pgTime.slice(0, 5)
}

/** Half-open: `from` inclusive, `to` exclusive. */
export function enumerateDates(from: string, to: string, timezone: string): string[] {
  const dates: string[] = []
  let cursor = DateTime.fromISO(from, { zone: timezone }).startOf('day')
  const end = DateTime.fromISO(to, { zone: timezone }).startOf('day')

  while (cursor < end) {
    const iso = cursor.toISODate()
    if (iso) dates.push(iso)
    cursor = cursor.plus({ days: 1 })
  }

  return dates
}
