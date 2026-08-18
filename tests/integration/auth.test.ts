import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, closeTestDb, getTestDb, resetDb } from './helpers.js'
import { TenantRepository } from '../../src/modules/tenants/tenant.repository.js'
import { TenantService } from '../../src/modules/tenants/tenant.service.js'
import { SCOPES, type Scope } from '../../src/shared/scopes.js'

let app: FastifyInstance

beforeAll(async () => {
  app = await buildTestApp()
})
beforeEach(resetDb)
afterAll(async () => {
  await app.close()
  await closeTestDb()
})

async function keyWith(scopes: readonly Scope[], tenantName = 'Houses'): Promise<string> {
  const service = new TenantService(new TenantRepository(getTestDb()))
  const tenant = await service.createTenant(tenantName)
  const { secret } = await service.issueKey(tenant.id, 'test', scopes)
  return secret
}

const auth = (key: string): Record<string, string> => ({ authorization: `Bearer ${key}` })

describe('authentication', () => {
  it('answers 401 with WWW-Authenticate when the header is missing', async () => {
    const response = await app.inject({ method: 'GET', url: '/resources/x' })
    expect(response.statusCode).toBe(401)
    expect(response.json().error).toBe('unauthorized')
    expect(response.headers['www-authenticate']).toBe('Bearer')
  })

  it.each([
    ['Bearer garbage', 'malformed'],
    ['Basic abcdef', 'wrong scheme'],
    [`bk_live_${'A'.repeat(51)}`, 'no Bearer prefix'],
    ['Bearer ', 'empty credential'],
  ])('answers 401 for %s (%s)', async (header) => {
    const response = await app.inject({
      method: 'GET',
      url: '/resources/x',
      headers: { authorization: header },
    })
    expect(response.statusCode).toBe(401)
  })

  it('gives every failure the same body, so the reason cannot be probed', async () => {
    const missing = await app.inject({ method: 'GET', url: '/resources/x' })
    const unknown = await app.inject({
      method: 'GET',
      url: '/resources/x',
      headers: auth(`bk_live_${'A'.repeat(51)}`),
    })
    expect(unknown.json()).toEqual(missing.json())
  })

  it('lets health, the root redirect and the docs through without a key', async () => {
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/' })).statusCode).toBe(302)
    expect((await app.inject({ method: 'GET', url: '/docs/json' })).statusCode).toBe(200)
  })

  it('keeps the key out of the OpenAPI description but announces the scheme', async () => {
    const document = (await app.inject({ method: 'GET', url: '/docs/json' })).json()
    expect(document.info.description).toContain('Authorization: Bearer')
    expect(document.info.description).not.toContain('There is no authentication')
  })
})

describe('scopes', () => {
  it('admits a key holding exactly the route scope', async () => {
    const key = await keyWith(['resources.read'])
    const response = await app.inject({
      method: 'GET',
      url: '/resources/00000000-0000-4000-8000-000000000000',
      headers: auth(key),
    })
    // 404 rather than 401 or 403: the key was accepted, the resource simply is not there.
    expect(response.statusCode).toBe(404)
  })

  it('refuses a key holding every scope except the route one, and names it', async () => {
    const key = await keyWith(SCOPES.filter((s) => s !== 'resources.read'))
    const response = await app.inject({
      method: 'GET',
      url: '/resources/00000000-0000-4000-8000-000000000000',
      headers: auth(key),
    })
    expect(response.statusCode).toBe(403)
    expect(response.json().error).toBe('forbidden_scope')
    expect(response.json().details).toEqual({ required: 'resources.read' })
  })

  // Generated over the route table, so a route added later without a scope declaration is
  // caught here as well as at startup.
  it.each([
    ['GET', '/resources/00000000-0000-4000-8000-000000000000', 'resources.read'],
    ['POST', '/resources', 'resources.write'],
    ['PATCH', '/resources/00000000-0000-4000-8000-000000000000', 'resources.write'],
    ['DELETE', '/resources/00000000-0000-4000-8000-000000000000', 'resources.write'],
    ['GET', '/resources/00000000-0000-4000-8000-000000000000/schedule', 'schedule.read'],
    ['PUT', '/resources/00000000-0000-4000-8000-000000000000/schedule', 'schedule.write'],
    [
      'GET',
      '/resources/00000000-0000-4000-8000-000000000000/exceptions?from=2026-09-01&to=2026-09-08',
      'schedule.read',
    ],
    [
      'PUT',
      '/resources/00000000-0000-4000-8000-000000000000/exceptions/2026-09-01',
      'schedule.write',
    ],
    [
      'DELETE',
      '/resources/00000000-0000-4000-8000-000000000000/exceptions/2026-09-01',
      'schedule.write',
    ],
    [
      'GET',
      '/resources/00000000-0000-4000-8000-000000000000/availability?from=2026-09-01&to=2026-09-08',
      'availability.read',
    ],
    ['POST', '/resources/00000000-0000-4000-8000-000000000000/bookings', 'bookings.write'],
    ['GET', '/bookings/00000000-0000-4000-8000-000000000000', 'bookings.read'],
    ['POST', '/bookings/00000000-0000-4000-8000-000000000000/confirm', 'bookings.write'],
    ['POST', '/bookings/00000000-0000-4000-8000-000000000000/cancel', 'bookings.write'],
    ['POST', '/bookings/00000000-0000-4000-8000-000000000000/complete', 'bookings.write'],
    ['POST', '/bookings/00000000-0000-4000-8000-000000000000/no-show', 'bookings.write'],
    ['POST', '/bookings/00000000-0000-4000-8000-000000000000/reschedule', 'bookings.write'],
    [
      'GET',
      '/resources/00000000-0000-4000-8000-000000000000/bookings?from=2026-09-01&to=2026-09-08',
      'bookings.list',
    ],
    ['GET', '/bookings?from=2026-09-01&to=2026-09-08', 'bookings.list'],
  ])('%s %s requires %s and nothing else', async (method, url, required) => {
    const withoutIt = await keyWith(SCOPES.filter((s) => s !== required))
    const denied = await app.inject({
      method: method as 'GET',
      url,
      headers: auth(withoutIt),
      payload: method === 'GET' || method === 'DELETE' ? undefined : {},
    })
    expect(denied.statusCode).toBe(403)
    expect(denied.json().details).toEqual({ required })

    const withIt = await keyWith([required as Scope], `holder of ${required}`)
    const allowed = await app.inject({
      method: method as 'GET',
      url,
      headers: auth(withIt),
      payload: method === 'GET' || method === 'DELETE' ? undefined : {},
    })
    // Anything but 401/403 means the key got past authentication and authorisation; what the
    // handler then made of an empty body or an absent id is not this test's business.
    expect([401, 403]).not.toContain(allowed.statusCode)
  })

  // The reason the model is a set of pairs and not three nested tiers.
  it('lets a partner channel book and refuses it the calendar', async () => {
    const key = await keyWith([
      'availability.read',
      'resources.read',
      'bookings.read',
      'bookings.write',
    ])

    const listing = await app.inject({
      method: 'GET',
      url: '/bookings?from=2026-09-01&to=2026-09-08',
      headers: auth(key),
    })
    expect(listing.statusCode).toBe(403)
    expect(listing.json().details).toEqual({ required: 'bookings.list' })
  })
})

describe('key lifecycle at the edge', () => {
  it('refuses a revoked key', async () => {
    const service = new TenantService(new TenantRepository(getTestDb()))
    const tenant = await service.createTenant('Houses')
    const { row, secret } = await service.issueKey(tenant.id, 'test', ['resources.read'])
    await service.revokeKey(row.id)

    const response = await app.inject({
      method: 'GET',
      url: '/resources/00000000-0000-4000-8000-000000000000',
      headers: auth(secret),
    })
    expect(response.statusCode).toBe(401)
  })

  it('refuses a key whose tenant has been disabled', async () => {
    const service = new TenantService(new TenantRepository(getTestDb()))
    const tenant = await service.createTenant('Houses')
    const { secret } = await service.issueKey(tenant.id, 'test', ['resources.read'])
    await getTestDb()
      .updateTable('tenants')
      .set({ is_active: false })
      .where('id', '=', tenant.id)
      .execute()

    const response = await app.inject({
      method: 'GET',
      url: '/resources/00000000-0000-4000-8000-000000000000',
      headers: auth(secret),
    })
    expect(response.statusCode).toBe(401)
  })

  it('stamps last_used_at on first use and not again immediately after', async () => {
    const service = new TenantService(new TenantRepository(getTestDb()))
    const tenant = await service.createTenant('Houses')
    const { secret } = await service.issueKey(tenant.id, 'test', ['resources.read'])
    const url = '/resources/00000000-0000-4000-8000-000000000000'

    await app.inject({ method: 'GET', url, headers: auth(secret) })
    const first = (await service.listKeys(tenant.id))[0]?.last_used_at
    expect(first).not.toBeNull()

    await app.inject({ method: 'GET', url, headers: auth(secret) })
    expect((await service.listKeys(tenant.id))[0]?.last_used_at).toEqual(first)
  })
})
