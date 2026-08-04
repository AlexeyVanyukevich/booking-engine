export interface ResourcePayload {
  timezone: string
  slot_duration: string
  concurrency_mode: 'exclusive' | 'shared' | 'pool'
  capacity?: number
  slot_anchor_time?: string
}

export const TIMEZONES = {
  /** Northern hemisphere DST, whole-hour offsets */
  warsaw: 'Europe/Warsaw',
  /** DST on different dates than Europe */
  newYork: 'America/New_York',
  /** Southern hemisphere: DST ends in April and starts in September */
  auckland: 'Pacific/Auckland',
  /** Half-hour offsets on both sides of a DST transition */
  adelaide: 'Australia/Adelaide',
  /** Half-hour offset, no DST at all */
  kolkata: 'Asia/Kolkata',
  /** No offset, no DST */
  utc: 'UTC',
} as const

/**
 * Builds a resource payload from a base, so a test states only the field it cares about.
 * Never share a mutable literal between tests — always go through this.
 */
export function aResource(overrides: Partial<ResourcePayload> = {}): ResourcePayload {
  return {
    timezone: TIMEZONES.warsaw,
    slot_duration: 'PT1H',
    concurrency_mode: 'exclusive',
    ...overrides,
  }
}

/** An hourly intraday resource — a doctor, a tennis court. */
export function anIntradayResource(overrides: Partial<ResourcePayload> = {}): ResourcePayload {
  return aResource(overrides)
}

/** A nightly resource whose day starts at 14:00 — a hotel room. */
export function aDayBasedResource(overrides: Partial<ResourcePayload> = {}): ResourcePayload {
  return aResource({ slot_duration: 'P1D', slot_anchor_time: '14:00', ...overrides })
}

/** A shared resource with room for several concurrent bookings — a group class. */
export function aSharedResource(overrides: Partial<ResourcePayload> = {}): ResourcePayload {
  return aResource({ concurrency_mode: 'shared', capacity: 12, ...overrides })
}
