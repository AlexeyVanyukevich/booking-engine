import type { ColumnType, Generated } from 'kysely'

export interface ResourcesTable {
  id: Generated<string>
  timezone: string
  is_active: Generated<boolean>
  /** Postgres interval, read and written as an ISO-8601 string (intervalstyle = iso_8601) */
  slot_duration: string
  /** Postgres time, read as 'HH:MM:SS' */
  slot_anchor_time: Generated<string>
  capacity: Generated<number>
  concurrency_mode: string
  created_at: Generated<Date>
  updated_at: ColumnType<Date, Date | undefined, Date>
}

export interface ScheduleTable {
  id: Generated<string>
  resource_id: string
  day_of_week: number
  start_time: string | null
  end_time: string | null
}

export interface ScheduleExceptionsTable {
  id: Generated<string>
  resource_id: string
  /** Postgres date, read as 'YYYY-MM-DD' */
  date: string
  start_time: string | null
  end_time: string | null
}

export interface Database {
  resources: ResourcesTable
  schedule: ScheduleTable
  schedule_exceptions: ScheduleExceptionsTable
}
