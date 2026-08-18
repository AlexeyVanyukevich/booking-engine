import { NotFoundError, ValidationError } from '../../shared/errors.js'
import { isScope, type Scope } from '../../shared/scopes.js'
import { generateKey, parseKey, verifySecret } from './api-key.js'
import type { ApiKeyRow, TenantRepository, TenantRow } from './tenant.repository.js'

export interface ResolvedKey {
  tenantId: string
  keyId: string
  scopes: Scope[]
}

const MAX_NAME_LENGTH = 100

export class TenantService {
  constructor(private readonly repository: TenantRepository) {}

  async createTenant(name: string): Promise<TenantRow> {
    return this.repository.createTenant(cleanName(name, 'Tenant name'))
  }

  async listTenants(): Promise<TenantRow[]> {
    return this.repository.listTenants()
  }

  async getTenant(id: string): Promise<TenantRow> {
    const tenant = await this.repository.findTenant(id)
    if (tenant === undefined) throw new NotFoundError(`No tenant with id ${id}`)
    return tenant
  }

  async issueKey(
    tenantId: string,
    name: string,
    scopes: readonly string[],
  ): Promise<{ row: ApiKeyRow; secret: string }> {
    await this.getTenant(tenantId)
    const keyName = cleanName(name, 'Key name')

    const unique = [...new Set(scopes)]
    if (unique.length === 0) throw new ValidationError('A key needs at least one scope')

    const unknown = unique.filter((scope) => !isScope(scope))
    if (unknown.length > 0) throw new ValidationError('Unknown scope', { unknown })

    const { key, prefix, hash } = generateKey()
    const row = await this.repository.insertKey({
      tenant_id: tenantId,
      name: keyName,
      key_prefix: prefix,
      key_hash: hash,
      scopes: unique as Scope[],
    })
    // The only moment the secret exists outside the caller's browser.
    return { row, secret: key }
  }

  async listKeys(tenantId: string): Promise<ApiKeyRow[]> {
    await this.getTenant(tenantId)
    return this.repository.listKeys(tenantId)
  }

  async revokeKey(id: string): Promise<ApiKeyRow> {
    const revoked = await this.repository.revokeKey(id)
    if (revoked === undefined) throw new NotFoundError(`No live key with id ${id}`)
    return revoked
  }

  /**
   * Returns undefined for every failure, without saying which. The caller turns that into one
   * `401 unauthorized`; a response that distinguished "unknown prefix" from "wrong secret"
   * would make prefix enumeration a usable probe.
   */
  async authenticate(raw: string): Promise<ResolvedKey | undefined> {
    const parsed = parseKey(raw)
    if (parsed === undefined) return undefined

    const key = await this.repository.findKeyByPrefix(parsed.prefix)
    if (key === undefined) return undefined
    if (!verifySecret(parsed.secret, key.key_hash)) return undefined
    if (!key.tenant_is_active) return undefined

    await this.repository.touchKey(key.id)
    return { tenantId: key.tenant_id, keyId: key.id, scopes: key.scopes }
  }
}

function cleanName(name: string, what: string): string {
  const trimmed = name.trim()
  if (trimmed.length === 0) throw new ValidationError(`${what} must not be blank`)
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw new ValidationError(`${what} must be at most ${MAX_NAME_LENGTH} characters`)
  }
  return trimmed
}
