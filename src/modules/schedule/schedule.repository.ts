import type { Kysely } from 'kysely'
import type { Database } from '../../db/schema.js'
import type { ScheduleRuleInput } from './schedule.schemas.js'

export interface ScheduleRow {
  id: string
  day_of_week: number
  start_time: string | null
  end_time: string | null
}

const columns = ['id', 'day_of_week', 'start_time', 'end_time'] as const
const columnsWithResource = [...columns, 'resource_id'] as const

export class ScheduleRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async listByResource(tenantId: string, resourceId: string): Promise<ScheduleRow[]> {
    return this.db
      .selectFrom('schedule')
      .select(columns)
      .where('tenant_id', '=', tenantId)
      .where('resource_id', '=', resourceId)
      .orderBy('day_of_week')
      .orderBy('start_time')
      .execute()
  }

  /** Same rows as `listByResource`, batched over several members and carrying `resource_id`. */
  async listByResourceIds(
    tenantId: string,
    resourceIds: string[],
  ): Promise<Array<ScheduleRow & { resource_id: string }>> {
    if (resourceIds.length === 0) return []
    return this.db
      .selectFrom('schedule')
      .select(columnsWithResource)
      .where('tenant_id', '=', tenantId)
      .where('resource_id', 'in', resourceIds)
      .orderBy('day_of_week')
      .orderBy('start_time')
      .execute()
  }

  /**
   * Delete-then-insert in one transaction. Validation runs before this is called, so a
   * rejected submission never reaches the database and the old schedule survives intact.
   */
  async replaceForResource(
    tenantId: string,
    resourceId: string,
    rules: ScheduleRuleInput[],
  ): Promise<ScheduleRow[]> {
    return this.db.transaction().execute(async (trx) => {
      await trx
        .deleteFrom('schedule')
        .where('tenant_id', '=', tenantId)
        .where('resource_id', '=', resourceId)
        .execute()

      if (rules.length === 0) return []

      return trx
        .insertInto('schedule')
        .values(
          rules.map((rule) => ({
            tenant_id: tenantId,
            resource_id: resourceId,
            day_of_week: rule.day_of_week,
            start_time: rule.start_time,
            end_time: rule.end_time,
          })),
        )
        .returning(columns)
        .execute()
    })
  }
}
