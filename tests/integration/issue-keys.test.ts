import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { issueKeys } from '../../src/issue-keys.js'
import { TenantRepository } from '../../src/modules/tenants/tenant.repository.js'
import { TenantService } from '../../src/modules/tenants/tenant.service.js'
import { expandPreset } from '../../src/shared/scopes.js'
import { issuedCases, refusedCases } from '../fixtures/datasets/issue-keys.js'
import { closeTestDb, getTestDb, resetDb } from './helpers.js'

beforeEach(resetDb)
afterAll(closeTestDb)

const service = () => new TenantService(new TenantRepository(getTestDb()))

async function run(argv: string[]) {
  const out: string[] = []
  const err: string[] = []
  const code = await issueKeys(argv, {
    service: service(),
    out: (text) => out.push(text),
    err: (text) => err.push(text),
  })
  return { code, out, err: err.join('') }
}

describe('issue-keys', () => {
  it.each(issuedCases)('issues keys for $name', async ({ argv, issued }) => {
    const { code, out, err } = await run(argv)
    expect(err).toBe('')
    expect(code).toBe(0)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatch(/^\{.*\}\n$/)

    const result = JSON.parse(out[0]!) as { tenantId: string; keys: Record<string, string> }
    expect(Object.keys(result.keys).sort()).toEqual([...issued].sort())
    expect(await service().listKeys(result.tenantId)).toHaveLength(issued.length)

    for (const preset of issued) {
      const resolved = await service().authenticate(result.keys[preset]!)
      expect(resolved?.tenantId).toBe(result.tenantId)
      expect([...(resolved?.scopes ?? [])].sort()).toEqual(expandPreset(preset).sort())
    }
  })

  it.each(refusedCases)('refuses $name and creates nothing', async ({ argv, refused }) => {
    const { code, out, err } = await run(argv)
    expect(code).not.toBe(0)
    expect(out).toEqual([])
    expect(err).toMatch(refused)
    expect(await getTestDb().selectFrom('tenants').select('id').execute()).toEqual([])
  })
})
