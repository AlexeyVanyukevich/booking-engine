import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  // Required to combine `uuid WITH =` and `tstzrange WITH &&` in one GiST index. Spec 1
  // flagged this and deliberately did not create it.
  await sql`create extension if not exists btree_gist`.execute(db)

  await db.schema
    .createTable('bookings')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    // RESTRICT, not CASCADE: a delete must not discard booking history as a side effect.
    .addColumn('resource_id', 'uuid', (col) =>
      col.notNull().references('resources.id').onDelete('restrict'),
    )
    .addColumn('start_time', 'timestamptz', (col) => col.notNull())
    .addColumn('end_time', 'timestamptz', (col) => col.notNull())
    .addColumn('time_range', sql`tstzrange`, (col) =>
      col.generatedAlwaysAs(sql`tstzrange(start_time, end_time)`).stored(),
    )
    .addColumn('status', 'text', (col) => col.notNull())
    .addColumn('customer_id', 'text', (col) => col.notNull())
    .addColumn('concurrency_mode', 'text', (col) => col.notNull())
    .addColumn('held_until', 'timestamptz')
    .addColumn('idempotency_key', 'text')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      'bookings_status_valid',
      sql`status in ('held','confirmed','cancelled','completed','no_show','expired')`,
    )
    .addCheckConstraint(
      'bookings_concurrency_mode_valid',
      sql`concurrency_mode in ('exclusive', 'shared', 'pool')`,
    )
    .addCheckConstraint('bookings_times_ordered', sql`end_time > start_time`)
    // An expiry is only meaningful on a hold that is outstanding or one that ran out.
    // `confirm` and `cancel` clear it in the same statement that changes the status.
    .addCheckConstraint(
      'bookings_held_until_matches_status',
      sql`(status in ('held','expired')) = (held_until is not null)`,
    )
    // NULLs are distinct in a unique index, so keyless bookings never collide.
    .addUniqueConstraint('bookings_idempotency_key_unique', ['resource_id', 'idempotency_key'])
    .execute()

  // The whole concurrency story for `exclusive`: atomic at any isolation level, no
  // application lock. Kysely's schema builder cannot express EXCLUDE, hence raw SQL.
  //
  // Only `exclusive` rows are governed by disjointness. A `shared` resource's invariant is a
  // count, enforced under the row lock in the service — if this predicate covered every row,
  // the second overlapping booking on a shared resource would be refused here and the mode
  // would be unreachable. The predicate cannot read `resources`, which is why the mode is
  // copied onto the booking; it is immutable on the resource, so the copy cannot drift.
  await sql`
    alter table bookings add constraint bookings_no_overlap
      exclude using gist (resource_id with =, time_range with &&)
      where (status in ('held','confirmed') and concurrency_mode = 'exclusive')
  `.execute(db)

  await db.schema
    .createIndex('bookings_resource_start_idx')
    .on('bookings')
    .columns(['resource_id', 'start_time'])
    .execute()

  await db.schema
    .createIndex('bookings_customer_start_idx')
    .on('bookings')
    .columns(['customer_id', 'start_time'])
    .execute()

  // Partial, so it stays tiny no matter how the table grows.
  await sql`
    create index bookings_held_until_idx on bookings (held_until) where status = 'held'
  `.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
  // btree_gist is left installed: dropping an extension another migration may rely on is
  // not this migration's business.
  await db.schema.dropTable('bookings').execute()
}
