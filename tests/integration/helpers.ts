import { inject } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { sql, type Kysely } from 'kysely'
import { buildApp } from '../../src/app.js'
import type { AppConfig } from '../../src/config.js'
import { createDb } from '../../src/db/client.js'
import type { Database } from '../../src/db/schema.js'
import { TenantRepository } from '../../src/modules/tenants/tenant.repository.js'
import { TenantService } from '../../src/modules/tenants/tenant.service.js'
import { SCOPES } from '../../src/shared/scopes.js'
import { recordContract } from './contract.js'

let cached: Kysely<Database> | undefined

export function getTestDb(): Kysely<Database> {
  cached ??= createDb(inject('databaseUrl'))
  return cached
}

export async function closeTestDb(): Promise<void> {
  await cached?.destroy()
  cached = undefined
}

export async function resetDb(): Promise<void> {
  await sql`truncate table bookings, schedule_exceptions, schedule, resources, api_keys, tenants restart identity cascade`.execute(
    getTestDb(),
  )
}

/**
 * A tenant to hang rows off. Every owned table carries a NOT NULL `tenant_id`, so a suite that
 * inserts a resource directly needs one of these first.
 */
export async function seedTenantId(name = 'test tenant'): Promise<string> {
  const row = await getTestDb()
    .insertInto('tenants')
    .values({ name })
    .returning('id')
    .executeTakeFirstOrThrow()
  return row.id
}

export async function buildTestApp(
  overrides: Partial<AppConfig> = {},
  db: Kysely<Database> = getTestDb(),
): Promise<FastifyInstance> {
  const app = await buildApp({
    config: {
      port: 0,
      logLevel: 'silent',
      maxRangeDays: 366,
      defaultHoldMinutes: 10,
      maxHoldMinutes: 60,
      holdSweepIntervalSeconds: 60,
      holdSweepEnabled: false,
      consolePort: 3001,
      // High enough that a suite firing hundreds of requests in one minute is not throttled;
      // the limiter's own behaviour is asserted in tests/integration/rate-limit.test.ts.
      rateLimitPerMinute: 100_000,
      ...overrides,
    },
    db,
  })
  // Before `ready()`: the route plugins load then, so a root hook added now reaches them all.
  recordContract(app)
  await app.ready()
  return app
}

/**
 * A tenant and a key holding every scope: the default for suites that are not about
 * authentication. Spread `authHeader` into every `app.inject` call.
 */
export async function seedTenant(): Promise<{
  tenantId: string
  authHeader: Record<string, string>
}> {
  const service = new TenantService(new TenantRepository(getTestDb()))
  const tenant = await service.createTenant('test tenant')
  const { secret } = await service.issueKey(tenant.id, 'test', [...SCOPES])
  return { tenantId: tenant.id, authHeader: { authorization: `Bearer ${secret}` } }
}

let currentTenantId: string | undefined
let currentAuthorization: string | undefined

/**
 * Truncate, then put back the one tenant and the one all-scopes key the API suites work
 * through. They assert engine behaviour, not authentication, so the key is plumbing: paired
 * with `withAuthorization` in the transport, not one of their cases changes.
 */
export async function resetDbWithTenant(): Promise<void> {
  await resetDb()
  const { tenantId, authHeader } = await seedTenant()
  currentTenantId = tenantId
  currentAuthorization = authHeader.authorization
}

export function testAuthorization(): string | undefined {
  return currentAuthorization
}

export function testTenantId(): string {
  if (currentTenantId === undefined) throw new Error('Call resetDbWithTenant() first')
  return currentTenantId
}
