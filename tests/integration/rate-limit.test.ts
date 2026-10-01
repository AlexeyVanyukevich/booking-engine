import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { TenantRepository } from '../../src/modules/tenants/tenant.repository.js'
import { TenantService } from '../../src/modules/tenants/tenant.service.js'
import { SCOPES } from '../../src/shared/scopes.js'
import { rateLimitScenarios, type Caller } from '../fixtures/datasets/rate-limit.js'
import { buildTestApp, closeTestDb, getTestDb, resetDb, seedTenant } from './helpers.js'

beforeEach(resetDb)
afterAll(closeTestDb)

async function seedCallers(): Promise<Record<Caller, Record<string, string>>> {
  const { tenantId, authHeader } = await seedTenant()
  const service = new TenantService(new TenantRepository(getTestDb()))
  const { secret } = await service.issueKey(tenantId, 'second', [...SCOPES])
  return {
    first: authHeader,
    second: { authorization: `Bearer ${secret}` },
    malformed: { authorization: 'Bearer garbage' },
    anonymous: {},
  }
}

describe('the per-key rate limit', () => {
  // Each case builds its own app: the limit differs per case, and the plugin counts in memory,
  // so a shared app would carry one case's requests into the next.
  it.each(rateLimitScenarios)('$name', async ({ limit, requests, expected }) => {
    const callers = await seedCallers()
    const app = await buildTestApp({ rateLimitPerMinute: limit })
    try {
      const statuses: number[] = []
      for (const caller of requests) {
        const response = await app.inject({
          method: 'GET',
          url: '/resources',
          headers: callers[caller],
        })
        statuses.push(response.statusCode)
        if (response.statusCode === 429) {
          expect(response.json()).toEqual({ error: 'rate_limited', message: expect.any(String) })
          expect(response.headers['retry-after']).toMatch(/^[1-9]\d*$/)
        }
      }
      expect(statuses).toEqual(expected)
    } finally {
      await app.close()
    }
  })
})
