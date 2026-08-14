export interface Config {
  databaseUrl: string
  port: number
  logLevel: string
  maxRangeDays: number
  defaultHoldMinutes: number
  maxHoldMinutes: number
  holdSweepIntervalSeconds: number
  holdSweepEnabled: boolean
}

function requireString(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]
  if (value === undefined || value.trim() === '') {
    throw new Error(`Invalid configuration: ${key} is required`)
  }
  return value
}

function positiveInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]
  if (raw === undefined || raw.trim() === '') return fallback

  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid configuration: ${key} must be a positive integer, got "${raw}"`)
  }
  return value
}

function booleanFlag(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key]?.trim()
  if (raw === undefined || raw === '') return fallback
  if (raw === 'true') return true
  if (raw === 'false') return false
  throw new Error(`Invalid configuration: ${key} must be "true" or "false", got "${raw}"`)
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  return {
    databaseUrl: requireString(env, 'DATABASE_URL'),
    port: positiveInt(env, 'PORT', 3000),
    logLevel: env.LOG_LEVEL?.trim() || 'info',
    maxRangeDays: positiveInt(env, 'MAX_RANGE_DAYS', 366),
    defaultHoldMinutes: positiveInt(env, 'DEFAULT_HOLD_MINUTES', 10),
    maxHoldMinutes: positiveInt(env, 'MAX_HOLD_MINUTES', 60),
    holdSweepIntervalSeconds: positiveInt(env, 'HOLD_SWEEP_INTERVAL_SECONDS', 60),
    holdSweepEnabled: booleanFlag(env, 'HOLD_SWEEP_ENABLED', true),
  }
}
