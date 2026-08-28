import type { Kysely } from 'kysely'
import type { Database } from '../../db/schema.js'
import { resourceColumns, type ResourceRow } from './resource.repository.js'

export class PoolRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /** Members in the order selection prefers them: stable, and independent of contention. */
  async listMembers(tenantId: string, poolId: string, activeOnly: boolean): Promise<ResourceRow[]> {
    let query = this.db
      .selectFrom('resources')
      .select(resourceColumns)
      .where('tenant_id', '=', tenantId)
      .where('pool_id', '=', poolId)
      .orderBy('created_at')
      .orderBy('id')
    if (activeOnly) query = query.where('is_active', '=', true)
    return query.execute()
  }
}
