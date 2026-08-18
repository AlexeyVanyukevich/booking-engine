import { sql, type Kysely } from 'kysely'
import type { Database } from '../../db/schema.js'
import type { Scope } from '../../shared/scopes.js'

export interface TenantRow {
  id: string
  name: string
  is_active: boolean
  created_at: Date
}

/** No `key_hash`. A shape that cannot carry the hash cannot leak it into a page or a log. */
export interface ApiKeyRow {
  id: string
  tenant_id: string
  name: string
  key_prefix: string
  scopes: Scope[]
  created_at: Date
  last_used_at: Date | null
  revoked_at: Date | null
}

/** The authentication path needs the hash and the tenant's state; nothing else does. */
export interface ApiKeySecretRow {
  id: string
  tenant_id: string
  key_hash: string
  scopes: Scope[]
  tenant_is_active: boolean
}

const tenantColumns = ['id', 'name', 'is_active', 'created_at'] as const

const keyColumns = [
  'id',
  'tenant_id',
  'name',
  'key_prefix',
  'scopes',
  'created_at',
  'last_used_at',
  'revoked_at',
] as const

export interface InsertKey {
  tenant_id: string
  name: string
  key_prefix: string
  key_hash: string
  scopes: Scope[]
}

export class TenantRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async createTenant(name: string): Promise<TenantRow> {
    return this.db
      .insertInto('tenants')
      .values({ name })
      .returning(tenantColumns)
      .executeTakeFirstOrThrow()
  }

  async listTenants(): Promise<TenantRow[]> {
    return this.db.selectFrom('tenants').select(tenantColumns).orderBy('created_at').execute()
  }

  async findTenant(id: string): Promise<TenantRow | undefined> {
    return this.db
      .selectFrom('tenants')
      .select(tenantColumns)
      .where('id', '=', id)
      .executeTakeFirst()
  }

  async insertKey(values: InsertKey): Promise<ApiKeyRow> {
    return this.db
      .insertInto('api_keys')
      .values(values)
      .returning(keyColumns)
      .executeTakeFirstOrThrow()
  }

  async listKeys(tenantId: string): Promise<ApiKeyRow[]> {
    return this.db
      .selectFrom('api_keys')
      .select(keyColumns)
      .where('tenant_id', '=', tenantId)
      .orderBy('created_at', 'desc')
      .execute()
  }

  /** Live keys only: the partial index `api_keys_active_prefix_idx` serves exactly this. */
  async findKeyByPrefix(prefix: string): Promise<ApiKeySecretRow | undefined> {
    return this.db
      .selectFrom('api_keys')
      .innerJoin('tenants', 'tenants.id', 'api_keys.tenant_id')
      .select([
        'api_keys.id',
        'api_keys.tenant_id',
        'api_keys.key_hash',
        'api_keys.scopes',
        'tenants.is_active as tenant_is_active',
      ])
      .where('api_keys.key_prefix', '=', prefix)
      .where('api_keys.revoked_at', 'is', null)
      .executeTakeFirst()
  }

  /**
   * At most one write per key per minute. Without the predicate a read-heavy caller turns every
   * GET into an UPDATE; with it, the statement usually matches nothing and costs an index probe.
   */
  async touchKey(id: string): Promise<void> {
    await this.db
      .updateTable('api_keys')
      .set({ last_used_at: sql<Date>`now()` })
      .where('id', '=', id)
      .where((eb) =>
        eb.or([
          eb('last_used_at', 'is', null),
          eb('last_used_at', '<', sql<Date>`now() - interval '1 minute'`),
        ]),
      )
      .execute()
  }

  /**
   * Soft: the row stays, so `last_used_at` and the audit trail survive the revocation. The
   * `revoked_at is null` guard makes a second revoke a no-op the service reports as absent,
   * rather than silently moving the timestamp.
   */
  async revokeKey(id: string): Promise<ApiKeyRow | undefined> {
    return this.db
      .updateTable('api_keys')
      .set({ revoked_at: sql<Date>`now()` })
      .where('id', '=', id)
      .where('revoked_at', 'is', null)
      .returning(keyColumns)
      .executeTakeFirst()
  }
}
