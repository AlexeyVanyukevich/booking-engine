import type { Kysely } from 'kysely'
import type { ConcurrencyMode, Database } from '../../db/schema.js'

export interface ResourceRow {
  id: string
  /** Carried on the row so a loaded resource knows its own owner and callers need no second argument. */
  tenant_id: string
  timezone: string
  slot_duration: string
  slot_anchor_time: string
  capacity: number
  concurrency_mode: ConcurrencyMode
  is_active: boolean
  pool_id: string | null
}

/**
 * Exported so a write transaction elsewhere can re-read the same shape under `FOR UPDATE`
 * rather than keeping a second list that can drift from this one.
 */
export const resourceColumns = [
  'id',
  'tenant_id',
  'timezone',
  'slot_duration',
  'slot_anchor_time',
  'capacity',
  'concurrency_mode',
  'is_active',
  'pool_id',
] as const

export interface InsertResource {
  tenant_id: string
  timezone: string
  slot_duration: string
  slot_anchor_time: string
  capacity: number
  concurrency_mode: ConcurrencyMode
  pool_id?: string | null
}

export interface ListFilter {
  isActive?: boolean | undefined
}

export interface UpdateResource {
  slot_duration?: string
  slot_anchor_time?: string
  capacity?: number
  is_active?: boolean
  pool_id?: string | null
}

export class ResourceRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async insert(values: InsertResource): Promise<ResourceRow> {
    return this.db
      .insertInto('resources')
      .values(values)
      .returning(resourceColumns)
      .executeTakeFirstOrThrow()
  }

  async findById(tenantId: string, id: string): Promise<ResourceRow | undefined> {
    return this.db
      .selectFrom('resources')
      .select(resourceColumns)
      .where('tenant_id', '=', tenantId)
      .where('id', '=', id)
      .executeTakeFirst()
  }

  async list(tenantId: string, filter: ListFilter): Promise<ResourceRow[]> {
    let query = this.db
      .selectFrom('resources')
      .select(resourceColumns)
      .where('tenant_id', '=', tenantId)
      .orderBy('created_at')
      .orderBy('id')
    if (filter.isActive !== undefined) query = query.where('is_active', '=', filter.isActive)
    return query.execute()
  }

  /**
   * An update that matches nothing because the row belongs to someone else returns exactly
   * what a missing row returns, and the service turns both into `NotFoundError`. That is where
   * 404-never-403 comes from, and it costs no branch.
   */
  async update(
    tenantId: string,
    id: string,
    values: UpdateResource,
  ): Promise<ResourceRow | undefined> {
    return this.db
      .updateTable('resources')
      .set({ ...values, updated_at: new Date() })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', id)
      .returning(resourceColumns)
      .executeTakeFirst()
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('resources')
      .where('tenant_id', '=', tenantId)
      .where('id', '=', id)
      .executeTakeFirst()
    return (result.numDeletedRows ?? 0n) > 0n
  }
}
