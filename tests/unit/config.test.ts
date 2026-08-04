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
    })
  })

  it('applies defaults for optional variables', () => {
    const config = loadConfig({ DATABASE_URL: valid.DATABASE_URL })
    expect(config).toEqual({
      databaseUrl: valid.DATABASE_URL,
      port: 3000,
      logLevel: 'info',
      maxRangeDays: 366,
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
