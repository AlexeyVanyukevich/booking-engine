import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildConsoleApp } from '../../src/console-app.js'
import { loadConfig } from '../../src/config.js'
import { TenantRepository } from '../../src/modules/tenants/tenant.repository.js'
import { TenantService } from '../../src/modules/tenants/tenant.service.js'
import { closeTestDb, getTestDb, resetDb } from './helpers.js'

let app: FastifyInstance

beforeAll(async () => {
  app = await buildConsoleApp({
    config: loadConfig({ DATABASE_URL: inject('databaseUrl'), LOG_LEVEL: 'silent' }),
    db: getTestDb(),
  })
  await app.ready()
})
beforeEach(resetDb)
afterAll(async () => {
  await app.close()
  await closeTestDb()
})

const form = (
  payload: Record<string, string> = {},
): { headers: Record<string, string>; payload: string } => ({
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  payload: new URLSearchParams(payload).toString(),
})

describe('tenants page', () => {
  it('says so when there are none, rather than rendering an empty table', async () => {
    const response = await app.inject({ method: 'GET', url: '/tenants' })
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/html')
    expect(response.body).toContain('No tenants yet')
  })

  it('redirects the root to the tenant list', async () => {
    const response = await app.inject({ method: 'GET', url: '/' })
    expect(response.statusCode).toBe(303)
    expect(response.headers.location).toBe('/tenants')
  })

  it('creates one, then redirects rather than rendering', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/tenants',
      ...form({ name: 'Houses' }),
    })
    expect(response.statusCode).toBe(303)
    expect(response.headers.location).toBe('/tenants')

    const listing = await app.inject({ method: 'GET', url: '/tenants' })
    expect(listing.body).toContain('Houses')
  })

  it('trims the name', async () => {
    await app.inject({ method: 'POST', url: '/tenants', ...form({ name: '  Houses  ' }) })
    const listing = await app.inject({ method: 'GET', url: '/tenants' })
    expect(listing.body).toContain('>Houses<')
  })

  it('renders a hostile name as text', async () => {
    await app.inject({
      method: 'POST',
      url: '/tenants',
      ...form({ name: '<script>alert(1)</script>' }),
    })
    const listing = await app.inject({ method: 'GET', url: '/tenants' })
    expect(listing.body).not.toContain('<script>alert(1)</script>')
    expect(listing.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it.each([['   '], ['']])('refuses a blank name (%j) and creates nothing', async (name) => {
    const response = await app.inject({ method: 'POST', url: '/tenants', ...form({ name }) })
    expect(response.statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/tenants' })).body).toContain('No tenants yet')
  })

  it('refuses a name past the limit', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/tenants',
      ...form({ name: 'x'.repeat(101) }),
    })
    expect(response.statusCode).toBe(400)
    expect(response.body).toContain('at most 100')
  })

  it('keeps two tenants of the same name apart by id', async () => {
    for (let i = 0; i < 2; i += 1) {
      await app.inject({ method: 'POST', url: '/tenants', ...form({ name: 'Houses' }) })
    }
    const rows = (await app.inject({ method: 'GET', url: '/tenants' })).body.match(
      /<tr>[\s\S]*?<\/tr>/g,
    )
    // One header row plus two tenants.
    expect(rows).toHaveLength(3)
  })
})

describe('origin guard', () => {
  it('refuses a write from a foreign origin and creates nothing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/tenants',
      ...form({ name: 'Houses' }),
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://evil.example',
      },
    })
    expect(response.statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: '/tenants' })).body).toContain('No tenants yet')
  })

  // Browsers always send Origin on a form post, so its absence means a non-browser client.
  it('accepts a write with no origin at all', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/tenants',
      ...form({ name: 'Houses' }),
    })
    expect(response.statusCode).toBe(303)
  })

  it.each(['127.0.0.1:3001', 'localhost:4001', 'localhost'])(
    'accepts a write whose origin matches the host it was addressed to (%s)',
    async (host) => {
      const response = await app.inject({
        method: 'POST',
        url: '/tenants',
        ...form({ name: 'Houses' }),
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          host,
          origin: `http://${host}`,
        },
      })
      expect(response.statusCode).toBe(303)
    },
  )

  it('refuses an origin that names a different port on the same host', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/tenants',
      ...form({ name: 'Houses' }),
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        host: '127.0.0.1:3001',
        origin: 'http://127.0.0.1:9999',
      },
    })
    expect(response.statusCode).toBe(403)
  })

  it('leaves reads alone whatever the origin', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/tenants',
      headers: { origin: 'https://evil.example' },
    })
    expect(response.statusCode).toBe(200)
  })
})

describe('errors', () => {
  it('answers an HTML 404 for an unknown path', async () => {
    const response = await app.inject({ method: 'GET', url: '/nope' })
    expect(response.statusCode).toBe(404)
    expect(response.headers['content-type']).toContain('text/html')
    expect(response.body).toContain('No such page')
  })

  it('needs no API key, unlike the data plane', async () => {
    expect((await app.inject({ method: 'GET', url: '/tenants' })).statusCode).toBe(200)
  })
})

async function makeTenant(name = 'Houses'): Promise<string> {
  await app.inject({ method: 'POST', url: '/tenants', ...form({ name }) })
  const tenants = await new TenantService(new TenantRepository(getTestDb())).listTenants()
  return tenants[tenants.length - 1]!.id
}

const keysOf = (tenantId: string) =>
  new TenantService(new TenantRepository(getTestDb())).listKeys(tenantId)

const SECRET = /bk_live_[A-Za-z0-9]{51}/

describe('keys page', () => {
  it('says so when the tenant has none', async () => {
    const id = await makeTenant()
    const response = await app.inject({ method: 'GET', url: `/tenants/${id}/api-keys` })
    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('No keys yet')
  })

  it('answers 400 for a malformed uuid rather than a stack trace', async () => {
    const response = await app.inject({ method: 'GET', url: '/tenants/not-a-uuid/api-keys' })
    expect(response.statusCode).toBe(400)
    expect(response.body).not.toContain('at Object.')
  })

  it('answers 404 for a well-formed unknown tenant', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/tenants/00000000-0000-4000-8000-000000000000/api-keys',
    })
    expect(response.statusCode).toBe(404)
  })

  it('issues a key, redirects, and reveals the secret exactly once', async () => {
    const id = await makeTenant()
    const created = await app.inject({
      method: 'POST',
      url: `/tenants/${id}/api-keys`,
      ...form({ name: 'site', preset: 'site_backend' }),
    })
    expect(created.statusCode).toBe(303)

    const location = created.headers.location as string
    expect(location).toMatch(new RegExp(`^/tenants/${id}/api-keys\\?revealed=[0-9a-f]{32}$`))

    const revealed = await app.inject({ method: 'GET', url: location })
    const secret = SECRET.exec(revealed.body)?.[0]
    expect(secret).toBeDefined()

    // The same URL again: gone, and the list renders normally.
    const again = await app.inject({ method: 'GET', url: location })
    expect(again.body).not.toContain(secret!)
    expect(again.body).toContain('site')
  })

  it('does not issue a second key when the reveal page is reloaded', async () => {
    const id = await makeTenant()
    const created = await app.inject({
      method: 'POST',
      url: `/tenants/${id}/api-keys`,
      ...form({ name: 'site', preset: 'widget' }),
    })
    const location = created.headers.location as string

    await app.inject({ method: 'GET', url: location })
    await app.inject({ method: 'GET', url: location })

    expect(await keysOf(id)).toHaveLength(1)
  })

  it('never puts the secret in the list, only its prefix', async () => {
    const id = await makeTenant()
    const created = await app.inject({
      method: 'POST',
      url: `/tenants/${id}/api-keys`,
      ...form({ name: 'site', preset: 'widget' }),
    })
    const secret = SECRET.exec(
      (await app.inject({ method: 'GET', url: created.headers.location as string })).body,
    )![0]

    const listing = await app.inject({ method: 'GET', url: `/tenants/${id}/api-keys` })
    expect(listing.body).not.toContain(secret)
    expect(listing.body).toContain(secret.slice('bk_live_'.length, 'bk_live_'.length + 8))
  })

  it('stores exactly the preset expansion, and not the preset name', async () => {
    const id = await makeTenant()
    await app.inject({
      method: 'POST',
      url: `/tenants/${id}/api-keys`,
      ...form({ name: 'partner', preset: 'partner_channel' }),
    })

    expect((await keysOf(id))[0]?.scopes.sort()).toEqual(
      ['availability.read', 'bookings.read', 'bookings.write', 'resources.read'].sort(),
    )

    const listing = await app.inject({ method: 'GET', url: `/tenants/${id}/api-keys` })
    expect(listing.body).toContain('bookings.write')
    // The preset name appears only in the form below, never as a property of the issued key.
    expect(listing.body).not.toMatch(/<tbody>[\s\S]*partner_channel[\s\S]*<\/tbody>/)
  })

  it('accepts a custom subset, one checkbox or several', async () => {
    const id = await makeTenant()
    await app.inject({
      method: 'POST',
      url: `/tenants/${id}/api-keys`,
      ...form({ name: 'one', preset: 'custom', scopes: 'schedule.write' }),
    })
    expect((await keysOf(id))[0]?.scopes).toEqual(['schedule.write'])

    const many = new URLSearchParams()
    many.append('name', 'two')
    many.append('preset', 'custom')
    many.append('scopes', 'schedule.write')
    many.append('scopes', 'bookings.list')
    await app.inject({
      method: 'POST',
      url: `/tenants/${id}/api-keys`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: many.toString(),
    })
    expect((await keysOf(id))[0]?.scopes.sort()).toEqual(['bookings.list', 'schedule.write'])
  })

  it.each([
    [{ name: 'x', preset: 'custom' }, 'custom with nothing ticked'],
    [{ name: 'x', preset: 'custom', scopes: 'bookings.destroy' }, 'an unknown scope'],
    [{ name: 'x', preset: 'superuser' }, 'an unknown preset'],
    [{ name: '  ', preset: 'widget' }, 'a blank name'],
  ])('refuses %j — %s', async (payload, _why) => {
    const id = await makeTenant()
    const response = await app.inject({
      method: 'POST',
      url: `/tenants/${id}/api-keys`,
      ...form(payload as Record<string, string>),
    })
    expect(response.statusCode).toBe(400)
    expect(await keysOf(id)).toEqual([])
  })

  it('refuses to issue against an unknown tenant', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/tenants/00000000-0000-4000-8000-000000000000/api-keys',
      ...form({ name: 'x', preset: 'widget' }),
    })
    expect(response.statusCode).toBe(404)
  })
})

describe('revocation', () => {
  it('marks the key revoked, keeps the row, and drops the control', async () => {
    const id = await makeTenant()
    await app.inject({
      method: 'POST',
      url: `/tenants/${id}/api-keys`,
      ...form({ name: 'site', preset: 'widget' }),
    })
    const keyId = (await keysOf(id))[0]!.id

    const response = await app.inject({
      method: 'POST',
      url: `/api-keys/${keyId}/revoke`,
      ...form(),
    })
    expect(response.statusCode).toBe(303)
    expect(response.headers.location).toBe(`/tenants/${id}/api-keys`)

    const keys = await keysOf(id)
    expect(keys).toHaveLength(1)
    expect(keys[0]?.revoked_at).not.toBeNull()

    const listing = await app.inject({ method: 'GET', url: `/tenants/${id}/api-keys` })
    expect(listing.body).toContain('revoked')
    expect(listing.body).not.toContain(`/api-keys/${keyId}/revoke`)
  })

  it('answers 404 revoking an unknown key, and 404 revoking one twice', async () => {
    const id = await makeTenant()
    await app.inject({
      method: 'POST',
      url: `/tenants/${id}/api-keys`,
      ...form({ name: 'site', preset: 'widget' }),
    })
    const keyId = (await keysOf(id))[0]!.id

    await app.inject({ method: 'POST', url: `/api-keys/${keyId}/revoke`, ...form() })
    expect(
      (await app.inject({ method: 'POST', url: `/api-keys/${keyId}/revoke`, ...form() }))
        .statusCode,
    ).toBe(404)
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api-keys/00000000-0000-4000-8000-000000000000/revoke',
          ...form(),
        })
      ).statusCode,
    ).toBe(404)
  })
})
