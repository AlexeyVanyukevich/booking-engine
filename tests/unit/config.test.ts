import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config.js'

const valid = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
  PORT: '4000',
  LOG_LEVEL: 'debug',
  MAX_RANGE_DAYS: '90',
}

describe('loadConfig', () => {
  it('parses a fully specified environment', () => {
    expect(loadConfig(valid)).toEqual({
      databaseUrl: 'postgres://user:pass@localhost:5432/db',
      port: 4000,
      logLevel: 'debug',
      maxRangeDays: 90,
      defaultHoldMinutes: 10,
      maxHoldMinutes: 60,
      holdSweepIntervalSeconds: 60,
      holdSweepEnabled: true,
      consolePort: 3001,
      rateLimitPerMinute: 600,
    })
  })

  it('applies defaults for optional variables', () => {
    const config = loadConfig({ DATABASE_URL: valid.DATABASE_URL })
    expect(config).toEqual({
      databaseUrl: valid.DATABASE_URL,
      port: 3000,
      logLevel: 'info',
      maxRangeDays: 366,
      defaultHoldMinutes: 10,
      maxHoldMinutes: 60,
      holdSweepIntervalSeconds: 60,
      holdSweepEnabled: true,
      consolePort: 3001,
      rateLimitPerMinute: 600,
    })
  })

  it('throws when DATABASE_URL is missing', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/)
  })

  it('throws when PORT is not a number', () => {
    expect(() => loadConfig({ ...valid, PORT: 'http' })).toThrow(/PORT/)
  })

  it('throws when MAX_RANGE_DAYS is zero or negative', () => {
    expect(() => loadConfig({ ...valid, MAX_RANGE_DAYS: '0' })).toThrow(/MAX_RANGE_DAYS/)
  })
})

const base = { DATABASE_URL: 'postgres://localhost/test' }

it('defaults the hold and sweep settings', () => {
  const config = loadConfig({ ...base })
  expect(config.defaultHoldMinutes).toBe(10)
  expect(config.maxHoldMinutes).toBe(60)
  expect(config.holdSweepIntervalSeconds).toBe(60)
  expect(config.holdSweepEnabled).toBe(true)
})

it('reads the hold settings from the environment', () => {
  const config = loadConfig({
    ...base,
    DEFAULT_HOLD_MINUTES: '5',
    MAX_HOLD_MINUTES: '120',
    HOLD_SWEEP_INTERVAL_SECONDS: '30',
    HOLD_SWEEP_ENABLED: 'false',
  })
  expect(config.defaultHoldMinutes).toBe(5)
  expect(config.maxHoldMinutes).toBe(120)
  expect(config.holdSweepIntervalSeconds).toBe(30)
  expect(config.holdSweepEnabled).toBe(false)
})

it.each(['yes', '1', 'TRUE', ''])('rejects %s as a boolean flag', (raw) => {
  // An empty string is the exception: it means "unset" and falls back, like the others.
  if (raw === '') {
    expect(loadConfig({ ...base, HOLD_SWEEP_ENABLED: raw }).holdSweepEnabled).toBe(true)
    return
  }
  expect(() => loadConfig({ ...base, HOLD_SWEEP_ENABLED: raw })).toThrow(/HOLD_SWEEP_ENABLED/)
})

it('defaults the console port and the per-key rate limit', () => {
  const config = loadConfig(base)
  expect(config.consolePort).toBe(3001)
  expect(config.rateLimitPerMinute).toBe(600)
})

it('reads the console port and the rate limit from the environment', () => {
  const config = loadConfig({ ...base, CONSOLE_PORT: '4001', RATE_LIMIT_PER_MINUTE: '60' })
  expect(config.consolePort).toBe(4001)
  expect(config.rateLimitPerMinute).toBe(60)
})

it.each([
  ['CONSOLE_PORT', '0'],
  ['CONSOLE_PORT', 'nope'],
  ['RATE_LIMIT_PER_MINUTE', '-1'],
])('rejects %s=%s', (key, value) => {
  expect(() => loadConfig({ ...base, [key]: value })).toThrow(new RegExp(key))
})
