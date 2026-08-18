import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeTestDb, getTestDb, resetDb } from './helpers.js'
import { TenantRepository } from '../../src/modules/tenants/tenant.repository.js'
import { TenantService } from '../../src/modules/tenants/tenant.service.js'
import { parseKey } from '../../src/modules/tenants/api-key.js'

const service = (): TenantService => new TenantService(new TenantRepository(getTestDb()))

beforeEach(resetDb)
afterAll(closeTestDb)

describe('tenants', () => {
  it('creates and lists', async () => {
    const s = service()
    const created = await s.createTenant('Houses')
    expect(created.name).toBe('Houses')
    expect(await s.listTenants()).toHaveLength(1)
  })

  it('trims the name', async () => {
    expect((await service().createTenant('  Houses  ')).name).toBe('Houses')
  })

  it.each([['   '], ['']])('rejects a blank name (%j)', async (name) => {
    await expect(service().createTenant(name)).rejects.toThrow(/blank/)
  })

  it('rejects a name past the limit', async () => {
    await expect(service().createTenant('x'.repeat(101))).rejects.toThrow(/at most/)
  })

  it('allows two tenants with the same name', async () => {
    const s = service()
    const a = await s.createTenant('Houses')
    const b = await s.createTenant('Houses')
    expect(a.id).not.toBe(b.id)
  })

  it('answers not found for an absent tenant', async () => {
    await expect(service().getTenant('00000000-0000-4000-8000-000000000000')).rejects.toThrow(
      /No tenant/,
    )
  })
})

describe('api keys', () => {
  it('returns the secret once and stores only its hash', async () => {
    const s = service()
    const tenant = await s.createTenant('Houses')
    const { row, secret } = await s.issueKey(tenant.id, 'site', ['bookings.write'])

    expect(secret.startsWith('bk_live_')).toBe(true)
    expect(parseKey(secret)?.prefix).toBe(row.key_prefix)
    // The row shape cannot carry the hash, so it cannot leak into a page or a log.
    expect(Object.keys(row)).not.toContain('key_hash')

    const stored = await getTestDb()
      .selectFrom('api_keys')
      .select(['key_hash'])
      .where('id', '=', row.id)
      .executeTakeFirstOrThrow()
    expect(secret).not.toContain(stored.key_hash)
  })

  it('rejects an empty scope set', async () => {
    const s = service()
    const tenant = await s.createTenant('Houses')
    await expect(s.issueKey(tenant.id, 'site', [])).rejects.toThrow(/at least one scope/)
  })

  it('rejects an unknown scope and names it', async () => {
    const s = service()
    const tenant = await s.createTenant('Houses')
    await expect(s.issueKey(tenant.id, 'site', ['bookings.destroy'])).rejects.toThrow(
      /Unknown scope/,
    )
  })

  it('rejects a blank key name', async () => {
    const s = service()
    const tenant = await s.createTenant('Houses')
    await expect(s.issueKey(tenant.id, '  ', ['bookings.read'])).rejects.toThrow(/blank/)
  })

  it('refuses to issue against an absent tenant', async () => {
    await expect(
      service().issueKey('00000000-0000-4000-8000-000000000000', 'site', ['bookings.read']),
    ).rejects.toThrow(/No tenant/)
  })

  it('deduplicates a repeated scope', async () => {
    const s = service()
    const tenant = await s.createTenant('Houses')
    const { row } = await s.issueKey(tenant.id, 'site', ['bookings.read', 'bookings.read'])
    expect(row.scopes).toEqual(['bookings.read'])
  })

  it('authenticates a live key and resolves its tenant and scopes', async () => {
    const s = service()
    const tenant = await s.createTenant('Houses')
    const { secret } = await s.issueKey(tenant.id, 'site', ['bookings.write', 'bookings.read'])

    const resolved = await s.authenticate(secret)
    expect(resolved?.tenantId).toBe(tenant.id)
    expect(resolved?.scopes.sort()).toEqual(['bookings.read', 'bookings.write'])
  })

  it.each([
    ['garbage', 'not a key at all'],
    [`bk_live_${'A'.repeat(51)}`, 'well-formed but unknown'],
  ])('refuses %s (%s)', async (raw) => {
    expect(await service().authenticate(raw)).toBeUndefined()
  })

  it('refuses a key whose secret is wrong but whose prefix is real', async () => {
    const s = service()
    const tenant = await s.createTenant('Houses')
    const { row } = await s.issueKey(tenant.id, 'site', ['bookings.read'])
    expect(await s.authenticate(`bk_live_${row.key_prefix}${'A'.repeat(43)}`)).toBeUndefined()
  })

  it('refuses a revoked key and keeps its row', async () => {
    const s = service()
    const tenant = await s.createTenant('Houses')
    const { row, secret } = await s.issueKey(tenant.id, 'site', ['bookings.read'])

    await s.revokeKey(row.id)
    expect(await s.authenticate(secret)).toBeUndefined()

    const keys = await s.listKeys(tenant.id)
    expect(keys).toHaveLength(1)
    expect(keys[0]?.revoked_at).not.toBeNull()
  })

  it('refuses to revoke twice, or to revoke something absent', async () => {
    const s = service()
    const tenant = await s.createTenant('Houses')
    const { row } = await s.issueKey(tenant.id, 'site', ['bookings.read'])

    await s.revokeKey(row.id)
    await expect(s.revokeKey(row.id)).rejects.toThrow(/No live key/)
    await expect(s.revokeKey('00000000-0000-4000-8000-000000000000')).rejects.toThrow(/No live key/)
  })

  it('refuses a key belonging to an inactive tenant', async () => {
    const s = service()
    const tenant = await s.createTenant('Houses')
    const { secret } = await s.issueKey(tenant.id, 'site', ['bookings.read'])

    await getTestDb()
      .updateTable('tenants')
      .set({ is_active: false })
      .where('id', '=', tenant.id)
      .execute()

    expect(await s.authenticate(secret)).toBeUndefined()
  })

  it('lists only the keys of the tenant asked about', async () => {
    const s = service()
    const [a, b] = [await s.createTenant('A'), await s.createTenant('B')]
    await s.issueKey(a.id, 'a-key', ['bookings.read'])
    await s.issueKey(b.id, 'b-key', ['bookings.read'])

    expect((await s.listKeys(a.id)).map((k) => k.name)).toEqual(['a-key'])
  })

  it('stamps last_used_at once, then not again within the minute', async () => {
    const s = service()
    const tenant = await s.createTenant('Houses')
    const { row, secret } = await s.issueKey(tenant.id, 'site', ['bookings.read'])
    expect(row.last_used_at).toBeNull()

    await s.authenticate(secret)
    const first = (await s.listKeys(tenant.id))[0]?.last_used_at
    expect(first).not.toBeNull()

    await s.authenticate(secret)
    expect((await s.listKeys(tenant.id))[0]?.last_used_at).toEqual(first)
  })
})
