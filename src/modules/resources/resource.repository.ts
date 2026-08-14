import type { Kysely } from 'kysely'
import type { ConcurrencyMode, Database } from '../../db/schema.js'

export interface ResourceRow {
  id: string
  timezone: string
  slot_duration: string
  slot_anchor_time: string
  capacity: number
  concurrency_mode: ConcurrencyMode
  is_active: boolean
}

/**
 * Exported so a write transaction elsewhere can re-read the same shape under `FOR UPDATE`
 * rather than keeping a second list that can drift from this one.
 */
export const resourceColumns = [
  'id',
  'timezone',
  'slot_duration',
  'slot_anchor_time',
  'capacity',
  'concurrency_mode',
  'is_active',
] as const

export interface InsertResource {
  timezone: string
  slot_duration: string
  slot_anchor_time: string
  capacity: number
  concurrency_mode: ConcurrencyMode
}

export interface UpdateResource {
  slot_duration?: string
  slot_anchor_time?: string
  capacity?: number
  is_active?: boolean
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

  async findById(id: string): Promise<ResourceRow | undefined> {
    return this.db
      .selectFrom('resources')
      .select(resourceColumns)
      .where('id', '=', id)
      .executeTakeFirst()
  }

  async update(id: string, values: UpdateResource): Promise<ResourceRow | undefined> {
    return this.db
      .updateTable('resources')
      .set({ ...values, updated_at: new Date() })
      .where('id', '=', id)
      .returning(resourceColumns)
      .executeTakeFirst()
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.deleteFrom('resources').where('id', '=', id).executeTakeFirst()
    return (result.numDeletedRows ?? 0n) > 0n
  }
}
