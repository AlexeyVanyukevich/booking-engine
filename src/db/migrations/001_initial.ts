import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('resources')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('timezone', 'text', (col) => col.notNull())
    .addColumn('is_active', 'boolean', (col) => col.notNull().defaultTo(true))
    .addColumn('slot_duration', sql`interval`, (col) => col.notNull())
    .addColumn('slot_anchor_time', sql`time`, (col) => col.notNull().defaultTo(sql`'00:00'`))
    .addColumn('capacity', 'integer', (col) => col.notNull().defaultTo(1))
    .addColumn('concurrency_mode', 'text', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint('resources_capacity_positive', sql`capacity >= 1`)
    .addCheckConstraint(
      'resources_concurrency_mode_valid',
      sql`concurrency_mode in ('exclusive', 'shared', 'pool')`,
    )
    .execute()

  await db.schema
    .createTable('schedule')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('resource_id', 'uuid', (col) =>
      col.notNull().references('resources.id').onDelete('cascade'),
    )
    .addColumn('day_of_week', 'int2', (col) => col.notNull())
    .addColumn('start_time', sql`time`)
    .addColumn('end_time', sql`time`)
    .addCheckConstraint('schedule_day_of_week_range', sql`day_of_week between 0 and 6`)
    .addCheckConstraint(
      'schedule_times_both_or_neither',
      sql`(start_time is null) = (end_time is null)`,
    )
    .addCheckConstraint('schedule_times_ordered', sql`start_time is null or start_time < end_time`)
    .execute()

  await db.schema
    .createIndex('schedule_resource_day_idx')
    .on('schedule')
    .columns(['resource_id', 'day_of_week'])
    .execute()

  await db.schema
    .createTable('schedule_exceptions')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('resource_id', 'uuid', (col) =>
      col.notNull().references('resources.id').onDelete('cascade'),
    )
    .addColumn('date', 'date', (col) => col.notNull())
    .addColumn('start_time', sql`time`)
    .addColumn('end_time', sql`time`)
    .addUniqueConstraint('schedule_exceptions_resource_date_unique', ['resource_id', 'date'])
    .addCheckConstraint(
      'schedule_exceptions_times_both_or_neither',
      sql`(start_time is null) = (end_time is null)`,
    )
    .addCheckConstraint(
      'schedule_exceptions_times_ordered',
      sql`start_time is null or start_time < end_time`,
    )
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('schedule_exceptions').execute()
  await db.schema.dropIndex('schedule_resource_day_idx').execute()
  await db.schema.dropTable('schedule').execute()
  await db.schema.dropTable('resources').execute()
}
