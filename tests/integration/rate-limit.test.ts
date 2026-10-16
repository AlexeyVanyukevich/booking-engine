import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateKey } from '../../src/modules/tenants/api-key.js'
import { TenantRepository } from '../../src/modules/tenants/tenant.repository.js'
import { TenantService } from '../../src/modules/tenants/tenant.service.js'
import { SCOPES } from '../../src/shared/scopes.js'
import {
  ADDRESS_A,
  ADDRESS_B,
  countedReplyCases,
  failureWindowCases,
  LIMITER_HEADER_NAMES,
  rateLimitScenarios,
  type Caller,
  type LimitedRequest,
} from '../fixtures/datasets/rate-limit.js'
import { buildTestApp, closeTestDb, getTestDb, resetDb, seedTenant } from './helpers.js'

beforeEach(resetDb)
afterAll(closeTestDb)

async function seedCallers(): Promise<Record<Caller, Record<string, string>>> {
  const { tenantId, authHeader } = await seedTenant()
  const service = new TenantService(new TenantRepository(getTestDb()))
  const { secret } = await service.issueKey(tenantId, 'second', [...SCOPES])
  const narrow = await service.issueKey(tenantId, 'narrow', ['bookings.read'])
  return {
    first: authHeader,
    second: { authorization: `Bearer ${secret}` },
    narrow: { authorization: `Bearer ${narrow.secret}` },
    malformed: { authorization: 'Bearer garbage' },
    unknown: { authorization: `Bearer ${generateKey().key}` },
    anonymous: {},
    forged: { authorization: ADDRESS_B },
  }
}

describe('the rate limits', () => {
  // Each case builds its own app: the limit differs per case, and the plugin counts in memory,
  // so a shared app would carry one case's requests into the next.
  it.each(rateLimitScenarios)('$name', async ({ config, requests, expected }) => {
    const callers = await seedCallers()
    const app = await buildTestApp(config)
    try {
      const statuses: number[] = []
      for (const request of requests) {
        const spec: LimitedRequest = typeof request === 'string' ? { caller: request } : request
        const { caller, from = ADDRESS_A, path = '/resources', forwardedFor } = spec
        const response = await app.inject({
          method: 'GET',
          url: path,
          remoteAddress: from,
          headers: {
            ...callers[caller],
            ...(forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor }),
          },
        })
        statuses.push(response.statusCode)
        if (response.statusCode === 429) {
          expect(response.json()).toEqual({ error: 'rate_limited', message: expect.any(String) })
          expect(response.headers['retry-after']).toMatch(/^[1-9]\d*$/)
          expect(Number(response.headers['retry-after'])).toBeLessThanOrEqual(60)
        }
      }
      expect(statuses).toEqual(expected)
    } finally {
      await app.close()
    }
  })
})

describe('the headers of a counted reply', () => {
  it.each(countedReplyCases)(
    '$name',
    async ({ caller, method, url, status, counted, config = {}, before = [] }) => {
      const callers = await seedCallers()
      const app = await buildTestApp(config)
      try {
        for (const earlier of before) {
          await app.inject({ method, url, remoteAddress: ADDRESS_A, headers: callers[earlier] })
        }
        const response = await app.inject({
          method,
          url,
          remoteAddress: ADDRESS_A,
          headers: callers[caller],
        })
        expect(response.statusCode).toBe(status)
        for (const header of LIMITER_HEADER_NAMES) {
          expect(response.headers[header] !== undefined, header).toBe(counted)
        }
      } finally {
        await app.close()
      }
    },
  )
})

describe('the failure window', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  // Only `Date` is faked: the plugin's store reads `Date.now()`, and the database driver and
  // Fastify keep their real timers.
  it.each(failureWindowCases)('$name', async ({ waitSeconds, expected }) => {
    const callers = await seedCallers()
    const app = await buildTestApp({ authFailuresPerMinute: 1 })
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const send = (caller: Caller) =>
        app.inject({
          method: 'GET',
          url: '/resources',
          remoteAddress: ADDRESS_A,
          headers: callers[caller],
        })
      expect((await send('malformed')).statusCode).toBe(401)
      vi.setSystemTime(Date.now() + waitSeconds * 1000)
      expect((await send('first')).statusCode).toBe(expected)
    } finally {
      await app.close()
    }
  })
})
