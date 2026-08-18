import type { Kysely } from 'kysely'
import type { Database } from '../../db/schema.js'

export interface ExceptionRow {
  id: string
  date: string
  start_time: string | null
  end_time: string | null
}

const columns = ['id', 'date', 'start_time', 'end_time'] as const

export class ExceptionRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /** Half-open on `to`, matching every other range in the API. */
  async listInRange(
    tenantId: string,
    resourceId: string,
    from: string,
    to: string,
  ): Promise<ExceptionRow[]> {
    return this.db
      .selectFrom('schedule_exceptions')
      .select(columns)
      .where('tenant_id', '=', tenantId)
      .where('resource_id', '=', resourceId)
      .where('date', '>=', from)
      .where('date', '<', to)
      .orderBy('date')
      .execute()
  }

  async upsert(
    tenantId: string,
    resourceId: string,
    date: string,
    startTime: string | null,
    endTime: string | null,
  ): Promise<ExceptionRow> {
    return this.db
      .insertInto('schedule_exceptions')
      .values({
        tenant_id: tenantId,
        resource_id: resourceId,
        date,
        start_time: startTime,
        end_time: endTime,
      })
      .onConflict((oc) =>
        oc
          .columns(['resource_id', 'date'])
          .doUpdateSet({ start_time: startTime, end_time: endTime }),
      )
      .returning(columns)
      .executeTakeFirstOrThrow()
  }

  async delete(tenantId: string, resourceId: string, date: string): Promise<void> {
    await this.db
      .deleteFrom('schedule_exceptions')
      .where('tenant_id', '=', tenantId)
      .where('resource_id', '=', resourceId)
      .where('date', '=', date)
      .execute()
  }
}
