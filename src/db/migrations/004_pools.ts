import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('resources').addColumn('pool_id', 'uuid').execute()

  // Composite, on (tenant_id, pool_id): the pattern migration 003 established for the child
  // tables, applied to a self-reference. A member whose tenant disagrees with its pool's has
  // no referent and cannot be written, so scoping a pool to a tenant is structural rather
  // than a filter someone has to remember. The target is `resources_tenant_id_unique`.
  await sql`
    alter table resources
      add constraint resources_pool_fk
      foreign key (tenant_id, pool_id) references resources (tenant_id, id)
      on delete restrict
  `.execute(db)

  // RESTRICT, not SET NULL: silently detaching ten rooms because someone deleted the pool is
  // the quiet data change design principle #8 exists to refuse.

  await db.schema
    .alterTable('resources')
    .addCheckConstraint('resources_pool_not_self', sql`pool_id <> id`)
    .execute()

  // Partial: the overwhelming majority of resources are not members, and the only query this
  // serves is "the members of this pool".
  await sql`
    create index resources_pool_idx on resources (tenant_id, pool_id) where pool_id is not null
  `.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex('resources_pool_idx').execute()
  await db.schema.alterTable('resources').dropConstraint('resources_pool_not_self').execute()
  await sql`alter table resources drop constraint resources_pool_fk`.execute(db)
  await db.schema.alterTable('resources').dropColumn('pool_id').execute()
}
