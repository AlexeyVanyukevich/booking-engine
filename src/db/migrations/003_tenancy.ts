import { Kysely, sql } from 'kysely'

/**
 * Hardcoded, not imported from `src/shared/scopes.ts`. A migration is a record of what already
 * ran; importing a live constant would make an applied migration describe something different
 * tomorrow. `tests/integration/migrations.test.ts` asserts this list and the union agree.
 */
const SCOPES = [
  'resources.read',
  'resources.write',
  'schedule.read',
  'schedule.write',
  'availability.read',
  'bookings.read',
  'bookings.write',
  'bookings.list',
]

const OWNED_TABLES = ['resources', 'schedule', 'schedule_exceptions', 'bookings'] as const

/** Postgres names an inline `references()` constraint `<table>_<column>_fkey`. */
const CHILDREN = [
  { table: 'schedule', onDelete: 'cascade' },
  { table: 'schedule_exceptions', onDelete: 'cascade' },
  // RESTRICT, as migration 002 set it: a delete must not discard booking history.
  { table: 'bookings', onDelete: 'restrict' },
] as const

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('tenants')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('is_active', 'boolean', (col) => col.notNull().defaultTo(true))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint('tenants_name_not_blank', sql`length(btrim(name)) > 0`)
    .execute()

  await db.schema
    .createTable('api_keys')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade'),
    )
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('key_prefix', 'text', (col) => col.notNull().unique())
    .addColumn('key_hash', 'text', (col) => col.notNull())
    .addColumn('scopes', sql`text[]`, (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('last_used_at', 'timestamptz')
    .addColumn('revoked_at', 'timestamptz')
    .addCheckConstraint('api_keys_name_not_blank', sql`length(btrim(name)) > 0`)
    // `cardinality`, not `array_length`: the latter returns NULL for an empty array, and a
    // CHECK constraint passes on NULL, so `array_length(scopes, 1) >= 1` admits `{}` — the
    // one input it exists to refuse. `cardinality('{}')` is 0.
    .addCheckConstraint('api_keys_scopes_not_empty', sql`cardinality(scopes) >= 1`)
    // The second copy of the vocabulary in `src/shared/scopes.ts`. Deliberate: see the note
    // above the constant.
    .addCheckConstraint(
      'api_keys_scopes_known',
      sql`scopes <@ ${sql.lit(`{${SCOPES.join(',')}}`)}::text[]`,
    )
    .execute()

  // Partial: authentication only ever asks for live keys, and revoked ones accumulate forever.
  await sql`
    create index api_keys_active_prefix_idx on api_keys (key_prefix) where revoked_at is null
  `.execute(db)

  for (const table of OWNED_TABLES) {
    await db.schema.alterTable(table).addColumn('tenant_id', 'uuid').execute()
  }

  // Only when there is something to own. On an empty database no tenant is invented.
  await sql`
    insert into tenants (name) select 'default' where exists (select 1 from resources)
  `.execute(db)

  await sql`
    update resources set tenant_id = (select id from tenants where name = 'default')
    where tenant_id is null
  `.execute(db)

  // Children inherit from their parent rather than from the same subquery, so the backfill
  // stays correct against a database that somehow already holds several tenants.
  for (const { table } of CHILDREN) {
    await sql`
      update ${sql.table(table)} as c set tenant_id = r.tenant_id
      from resources r where r.id = c.resource_id and c.tenant_id is null
    `.execute(db)
  }

  for (const table of OWNED_TABLES) {
    await db.schema
      .alterTable(table)
      .alterColumn('tenant_id', (col) => col.setNotNull())
      .execute()
    await sql`
      alter table ${sql.table(table)}
        add constraint ${sql.raw(`${table}_tenant_fk`)}
        foreign key (tenant_id) references tenants (id) on delete restrict
    `.execute(db)
  }

  // The target of the composite keys below.
  await db.schema
    .alterTable('resources')
    .addUniqueConstraint('resources_tenant_id_unique', ['tenant_id', 'id'])
    .execute()

  // A child row whose tenant disagrees with its resource's now has no referent, so drift
  // between the denormalised column and the truth is unrepresentable rather than unlikely.
  for (const { table, onDelete } of CHILDREN) {
    await sql`
      alter table ${sql.table(table)} drop constraint ${sql.raw(`${table}_resource_id_fkey`)}
    `.execute(db)
    await sql`
      alter table ${sql.table(table)}
        add constraint ${sql.raw(`${table}_resource_fk`)}
        foreign key (tenant_id, resource_id) references resources (tenant_id, id)
        on delete ${sql.raw(onDelete)}
    `.execute(db)
  }

  // Every listing filters on the tenant first, so an index that does not lead with it is
  // usable only after a filter step.
  await db.schema.dropIndex('bookings_resource_start_idx').execute()
  await db.schema
    .createIndex('bookings_resource_start_idx')
    .on('bookings')
    .columns(['tenant_id', 'resource_id', 'start_time'])
    .execute()

  await db.schema.dropIndex('bookings_customer_start_idx').execute()
  // Partial, because the column is about to become optional: a tenant that keeps its own
  // guest records should not carry an index entry per booking for a column it never fills.
  await sql`
    create index bookings_customer_start_idx on bookings (tenant_id, customer_id, start_time)
      where customer_id is not null
  `.execute(db)

  await db.schema
    .alterTable('bookings')
    .alterColumn('customer_id', (col) => col.dropNotNull())
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  // Restoring NOT NULL is impossible once a booking has been written without a customer, and
  // inventing a placeholder would be indistinguishable from a real id forever after. Refuse
  // loudly instead — design principle #8 applies to migrations too.
  const orphans = await sql<{ count: string }>`
    select count(*)::text as count from bookings where customer_id is null
  `.execute(db)
  const count = Number(orphans.rows[0]?.count ?? '0')
  if (count > 0) {
    throw new Error(
      `Cannot reverse 003_tenancy: ${count} booking(s) have a null customer_id, and restoring ` +
        'NOT NULL would require inventing customer ids. Delete or backfill those rows first.',
    )
  }

  await db.schema
    .alterTable('bookings')
    .alterColumn('customer_id', (col) => col.setNotNull())
    .execute()

  await db.schema.dropIndex('bookings_customer_start_idx').execute()
  await db.schema
    .createIndex('bookings_customer_start_idx')
    .on('bookings')
    .columns(['customer_id', 'start_time'])
    .execute()

  await db.schema.dropIndex('bookings_resource_start_idx').execute()
  await db.schema
    .createIndex('bookings_resource_start_idx')
    .on('bookings')
    .columns(['resource_id', 'start_time'])
    .execute()

  for (const { table, onDelete } of CHILDREN) {
    await sql`
      alter table ${sql.table(table)} drop constraint ${sql.raw(`${table}_resource_fk`)}
    `.execute(db)
    await sql`
      alter table ${sql.table(table)}
        add constraint ${sql.raw(`${table}_resource_id_fkey`)}
        foreign key (resource_id) references resources (id) on delete ${sql.raw(onDelete)}
    `.execute(db)
  }

  await db.schema.alterTable('resources').dropConstraint('resources_tenant_id_unique').execute()

  for (const table of OWNED_TABLES) {
    await sql`
      alter table ${sql.table(table)} drop constraint ${sql.raw(`${table}_tenant_fk`)}
    `.execute(db)
    await db.schema.alterTable(table).dropColumn('tenant_id').execute()
  }

  await db.schema.dropTable('api_keys').execute()
  await db.schema.dropTable('tenants').execute()
}
