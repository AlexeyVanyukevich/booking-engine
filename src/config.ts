/**
 * Everything `buildApp` itself reads. The connection string is deliberately not part of it:
 * the app never connects — an entrypoint creates the database handle and passes it in — and
 * leaving it out is what lets the OpenAPI generator build the app without inventing a URL for
 * a pool nobody opens.
 */
export interface AppConfig {
  port: number
  logLevel: string
  maxRangeDays: number
  defaultHoldMinutes: number
  maxHoldMinutes: number
  holdSweepIntervalSeconds: number
  holdSweepEnabled: boolean
  consolePort: number
  rateLimitPerMinute: number
}

export interface Config extends AppConfig {
  databaseUrl: string
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
  return { databaseUrl: requireString(env, 'DATABASE_URL'), ...loadAppConfig(env) }
}

/**
 * The half with defaults, separated so a caller that opens no connection needs no connection
 * string. `loadConfig` is the only other caller; splitting the two is what keeps the defaults
 * stated once, so a changed default reaches every reader of them.
 */
export function loadAppConfig(env: NodeJS.ProcessEnv): AppConfig {
  return {
    port: positiveInt(env, 'PORT', 3000),
    logLevel: env.LOG_LEVEL?.trim() || 'info',
    maxRangeDays: positiveInt(env, 'MAX_RANGE_DAYS', 366),
    defaultHoldMinutes: positiveInt(env, 'DEFAULT_HOLD_MINUTES', 10),
    maxHoldMinutes: positiveInt(env, 'MAX_HOLD_MINUTES', 60),
    holdSweepIntervalSeconds: positiveInt(env, 'HOLD_SWEEP_INTERVAL_SECONDS', 60),
    holdSweepEnabled: booleanFlag(env, 'HOLD_SWEEP_ENABLED', true),
    // There is deliberately no CONSOLE_HOST. The console issues keys without authentication,
    // which is safe only while it is unreachable from outside, so the bind address is
    // hard-coded to 127.0.0.1 in src/console.ts rather than left to a deployment to get wrong.
    consolePort: positiveInt(env, 'CONSOLE_PORT', 3001),
    rateLimitPerMinute: positiveInt(env, 'RATE_LIMIT_PER_MINUTE', 600),
  }
}
