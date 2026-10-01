import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, closeTestDb, getTestDb, resetDb } from './helpers.js'
import { TenantRepository } from '../../src/modules/tenants/tenant.repository.js'
import { TenantService } from '../../src/modules/tenants/tenant.service.js'
import { SCOPES } from '../../src/shared/scopes.js'

let app: FastifyInstance

beforeAll(async () => {
  app = await buildTestApp()
})
beforeEach(resetDb)
afterAll(async () => {
  await app.close()
  await closeTestDb()
})

async function tenantWithKey(name: string): Promise<Record<string, string>> {
  const service = new TenantService(new TenantRepository(getTestDb()))
  const tenant = await service.createTenant(name)
  const { secret } = await service.issueKey(tenant.id, 'test', [...SCOPES])
  return { authorization: `Bearer ${secret}` }
}

const ABSENT = '00000000-0000-4000-8000-000000000000'

const resourceBody = {
  timezone: 'Europe/Warsaw',
  slot_duration: 'P1D',
  slot_anchor_time: '15:00',
  capacity: 1,
  concurrency_mode: 'exclusive',
}

const everyDay = [0, 1, 2, 3, 4, 5, 6].map((day_of_week) => ({
  day_of_week,
  start_time: null,
  end_time: null,
}))

async function createResource(headers: Record<string, string>): Promise<string> {
  const created = await app.inject({
    method: 'POST',
    url: '/resources',
    headers,
    payload: resourceBody,
  })
  expect(created.statusCode).toBe(201)
  return created.json().id as string
}

async function bookableResource(headers: Record<string, string>): Promise<string> {
  const id = await createResource(headers)
  await app.inject({ method: 'PUT', url: `/resources/${id}/schedule`, headers, payload: everyDay })
  return id
}

const NIGHT = {
  start_time: '2026-09-01T15:00:00+02:00',
  end_time: '2026-09-02T15:00:00+02:00',
}

describe('tenant isolation', () => {
  it("answers 404 — never 403 — on another tenant's resource, everywhere", async () => {
    const a = await tenantWithKey('A')
    const b = await tenantWithKey('B')
    const id = await createResource(a)

    const paths = [
      `/resources/${id}`,
      `/resources/${id}/schedule`,
      `/resources/${id}/exceptions?from=2026-09-01&to=2026-09-08`,
      `/resources/${id}/availability?from=2026-09-01&to=2026-09-08`,
      `/resources/${id}/bookings?from=2026-09-01&to=2026-09-08`,
    ]

    for (const path of paths) {
      const foreign = await app.inject({ method: 'GET', url: path, headers: b })
      const missing = await app.inject({
        method: 'GET',
        url: path.replace(id, ABSENT),
        headers: b,
      })
      expect(foreign.statusCode, path).toBe(404)
      // Identical once the echoed id is masked, so the wording cannot be used to tell
      // "someone else's" from "nobody's". The id itself is no disclosure: the caller sent it.
      const mask = (body: { error: string; message: string }, id: string) => ({
        ...body,
        message: body.message.replace(id, '<id>'),
      })
      expect(mask(foreign.json(), id), path).toEqual(mask(missing.json(), ABSENT))
    }
  })

  it("refuses to modify another tenant's resource", async () => {
    const a = await tenantWithKey('A')
    const b = await tenantWithKey('B')
    const id = await createResource(a)

    const attempts = [
      { method: 'PATCH' as const, url: `/resources/${id}`, payload: { capacity: 2 } },
      { method: 'DELETE' as const, url: `/resources/${id}` },
      { method: 'PUT' as const, url: `/resources/${id}/schedule`, payload: everyDay },
      {
        method: 'PUT' as const,
        url: `/resources/${id}/exceptions/2026-09-01`,
        payload: { start_time: null, end_time: null },
      },
      {
        method: 'DELETE' as const,
        url: `/resources/${id}/exceptions/2026-09-01`,
      },
    ]

    for (const attempt of attempts) {
      const response = await app.inject({ ...attempt, headers: b })
      expect(response.statusCode, `${attempt.method} ${attempt.url}`).toBe(404)
    }

    // And the resource is untouched.
    const still = await app.inject({ method: 'GET', url: `/resources/${id}`, headers: a })
    expect(still.json().capacity).toBe(1)
  })

  it("cannot book another tenant's resource", async () => {
    const a = await tenantWithKey('A')
    const b = await tenantWithKey('B')
    const id = await bookableResource(a)

    const response = await app.inject({
      method: 'POST',
      url: `/resources/${id}/bookings`,
      headers: b,
      payload: { customer_id: 'guest-1', ...NIGHT },
    })
    expect(response.statusCode).toBe(404)
  })

  it("cannot read or move another tenant's booking", async () => {
    const a = await tenantWithKey('A')
    const b = await tenantWithKey('B')
    const id = await bookableResource(a)

    const booking = await app.inject({
      method: 'POST',
      url: `/resources/${id}/bookings`,
      headers: a,
      payload: { customer_id: 'guest-1', ...NIGHT },
    })
    expect(booking.statusCode).toBe(201)
    const bookingId = booking.json().id as string

    const attempts = [
      { method: 'GET' as const, url: `/bookings/${bookingId}` },
      { method: 'POST' as const, url: `/bookings/${bookingId}/cancel` },
      { method: 'POST' as const, url: `/bookings/${bookingId}/complete` },
      { method: 'POST' as const, url: `/bookings/${bookingId}/no-show` },
      {
        method: 'POST' as const,
        url: `/bookings/${bookingId}/reschedule`,
        payload: { start_time: '2026-09-03T15:00:00+02:00', end_time: '2026-09-04T15:00:00+02:00' },
      },
    ]

    for (const attempt of attempts) {
      const response = await app.inject({ ...attempt, headers: b })
      expect(response.statusCode, `${attempt.method} ${attempt.url}`).toBe(404)
    }

    // Still confirmed, and still owned by A.
    const mine = await app.inject({ method: 'GET', url: `/bookings/${bookingId}`, headers: a })
    expect(mine.json().status).toBe('confirmed')
  })

  it('lists only its own bookings, by customer and across the tenant', async () => {
    const a = await tenantWithKey('A')
    const b = await tenantWithKey('B')
    const id = await bookableResource(a)
    await app.inject({
      method: 'POST',
      url: `/resources/${id}/bookings`,
      headers: a,
      payload: { customer_id: 'guest-1', ...NIGHT },
    })

    const url = '/bookings?customer_id=guest-1&from=2026-09-01&to=2026-09-08'
    expect((await app.inject({ method: 'GET', url, headers: a })).json()).toHaveLength(1)
    expect((await app.inject({ method: 'GET', url, headers: b })).json()).toEqual([])
  })

  it('does not let one tenant block another tenant slot', async () => {
    // Two resources with the same times, one per tenant: neither exclusion constraint nor
    // capacity may leak across the boundary.
    const a = await tenantWithKey('A')
    const b = await tenantWithKey('B')
    const idA = await bookableResource(a)
    const idB = await bookableResource(b)

    for (const [headers, id] of [
      [a, idA],
      [b, idB],
    ] as const) {
      const response = await app.inject({
        method: 'POST',
        url: `/resources/${id}/bookings`,
        headers,
        payload: { customer_id: 'guest-1', ...NIGHT },
      })
      expect(response.statusCode).toBe(201)
    }
  })

  it('stamps every written row with the caller tenant', async () => {
    const a = await tenantWithKey('A')
    const id = await bookableResource(a)
    await app.inject({
      method: 'PUT',
      url: `/resources/${id}/exceptions/2026-09-05`,
      headers: a,
      payload: { start_time: null, end_time: null },
    })
    await app.inject({
      method: 'POST',
      url: `/resources/${id}/bookings`,
      headers: a,
      payload: { customer_id: 'guest-1', ...NIGHT },
    })

    const db = getTestDb()
    const owner = await db
      .selectFrom('resources')
      .select('tenant_id')
      .where('id', '=', id)
      .executeTakeFirstOrThrow()

    for (const table of ['schedule', 'schedule_exceptions', 'bookings'] as const) {
      const rows = await db.selectFrom(table).select('tenant_id').execute()
      expect(rows.length, table).toBeGreaterThan(0)
      for (const row of rows) expect(row.tenant_id, table).toBe(owner.tenant_id)
    }
  })
})
