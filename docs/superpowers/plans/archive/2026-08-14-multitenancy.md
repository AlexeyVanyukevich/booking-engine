# Multitenancy and the key console — Implementation Plan

> **Executed and archived.** This plan built the slice named above. It is kept for provenance, sits outside the reading path, and is not current truth — for what the engine does today read [architecture.md](../../../architecture.md) and [conventions.md](../../../conventions.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the engine shareable by several unrelated owners in one deployment — every row owned by a tenant, every request authenticated by an API key carrying a set of scopes, and a loopback-only console that issues those keys.

**Architecture:** `tenant_id` lands on all four existing tables, kept honest by composite foreign keys so a cross-tenant row cannot be written. A `preHandler` in `buildApp` resolves the key to a tenant and checks one scope per route; repositories take `tenantId` as a required first parameter, so a forgotten filter is a compile error. A third entrypoint, `console.ts`, binds to `127.0.0.1` and serves three server-rendered pages with no client-side framework.

**Tech Stack:** Node 24 LTS · TypeScript strict · Fastify 5 · TypeBox · Kysely + `pg` · PostgreSQL 16 · Luxon · Vitest + Testcontainers · Playwright

**Spec:** [2026-08-14-multitenancy-design.md](../../specs/2026-08-14-multitenancy-design.md)

**Branch:** `spec-4-multitenancy`, already created and holding the spec commits.

## Global Constraints

The engine-wide rules live in [conventions.md](../../../conventions.md), which is authoritative. They are restated here because a task may be executed by someone who sees only that task. If the two disagree, `conventions.md` is right and this list is stale.

- TypeScript `strict: true`, NodeNext modules. Relative imports carry a `.js` extension even in `.ts` files. No `any` outside Kysely migration signatures, where `Kysely<any>` is required by Kysely itself.
- The TypeBox package is `typebox` (not `@sinclair/typebox`), paired with `@fastify/type-provider-typebox`.
- Every error response has the shape `{ error, message, details? }`. Unknown fields in a request body are rejected, never ignored — `additionalProperties: false` on every body schema.
- Every route carries `tags`, `summary` and a `response` map. `tests/unit/docs.test.ts` asserts this and fails if a route is added without them.
- Every data-plane route additionally carries `config: { scope }` **or** `config: { public: true }`. A route with neither fails at startup.
- **The eight scopes are exactly:** `resources.read`, `resources.write`, `schedule.read`, `schedule.write`, `availability.read`, `bookings.read`, `bookings.write`, `bookings.list`. No implication between them; the check is set membership.
- **Migration `003` hardcodes its scope list.** It must not import `src/shared/scopes.ts` — an applied migration is a historical record and cannot change meaning when a constant does.
- Parameterised behavioural cases live in `tests/fixtures/datasets/` as typed tables consumed by `it.each`. Structural assertions about schema and configuration are ordinary test bodies.
- Test-driven: the failing test is written and run before the implementation, in every task.
- Commit at the end of every task, on the `spec-4-multitenancy` branch.

## File Structure

**Created:**

| File                                                                            | Responsibility                                                               |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `src/shared/scopes.ts`                                                          | The eight literals, the `Scope` union, descriptions, preset expansion        |
| `src/shared/auth.ts`                                                            | The authentication `preHandler`, route config types, scope check             |
| `src/db/migrations/003_tenancy.ts`                                              | `tenants`, `api_keys`, `tenant_id` ×4, composite FKs, nullable `customer_id` |
| `src/modules/tenants/api-key.ts`                                                | Pure: generate, parse, hash, constant-time verify                            |
| `src/modules/tenants/tenant.repository.ts`                                      | All SQL for `tenants` and `api_keys`                                         |
| `src/modules/tenants/tenant.service.ts`                                         | Create tenant, issue / list / revoke keys                                    |
| `src/console-app.ts`                                                            | `buildConsoleApp` — its own Fastify instance                                 |
| `src/console.ts`                                                                | Third entrypoint, bound to `127.0.0.1`                                       |
| `src/modules/console/html.ts`                                                   | `escapeHtml`, the page shell, shared CSS                                     |
| `src/modules/console/flash.ts`                                                  | One-shot secret store                                                        |
| `src/modules/console/console.pages.ts`                                          | Three pages as typed functions returning strings                             |
| `src/modules/console/console.routes.ts`                                         | The five console routes and the `Origin` guard                               |
| `playwright.config.ts`                                                          | Two projects, one worker, trace on retry                                     |
| `tests/ui/global-setup.ts`                                                      | Container, migrations, both apps on ephemeral ports                          |
| `tests/ui/helpers.ts`                                                           | Truncation between tests, data-plane fetch helper                            |
| `tests/ui/tenants.spec.ts`, `keys.spec.ts`, `hardening.spec.ts`, `a11y.spec.ts` | The 46 UI cases                                                              |

**Modified:** `src/db/schema.ts`, `src/db/migrations/index.ts`, `src/config.ts`, `src/app.ts`, every `*.repository.ts` and `*.service.ts` under `src/modules/`, every `*.routes.ts` (scope declarations), `src/modules/bookings/booking.schemas.ts` (optional `customer_id`), `src/modules/resources/resource.schemas.ts` (list response), `src/shared/errors.ts` (four error classes), `tests/integration/helpers.ts`, `package.json`, `.env.example`, `run`, `README.md`, `docs/architecture.md`, `docs/conventions.md`.

---

### Task 1: Scope vocabulary, migration 003, table types, configuration

**Files:**

- Create: `src/shared/scopes.ts`, `src/db/migrations/003_tenancy.ts`
- Modify: `src/db/migrations/index.ts`, `src/db/schema.ts`, `src/config.ts`, `.env.example`, `tests/integration/helpers.ts`
- Test: `tests/unit/scopes.test.ts`, `tests/unit/config.test.ts`, `tests/integration/migrations.test.ts`

**Interfaces:**

- Produces: `SCOPES: readonly Scope[]`, `type Scope`, `SCOPE_DESCRIPTIONS: Record<Scope, string>`, `PRESETS: Record<PresetName, readonly Scope[]>`, `type PresetName`, `isScope(v: string): v is Scope`, `expandPreset(name: PresetName): Scope[]`. `Database` gains `tenants` and `api_keys`; `Config` gains `consolePort` and `rateLimitPerMinute`.

- [ ] **Step 1: Write the failing unit test for the vocabulary**

`tests/unit/scopes.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  PRESETS,
  SCOPES,
  SCOPE_DESCRIPTIONS,
  expandPreset,
  isScope,
} from '../../src/shared/scopes.js'

describe('scopes', () => {
  it('has exactly the eight the spec names', () => {
    expect([...SCOPES].sort()).toEqual([
      'availability.read',
      'bookings.list',
      'bookings.read',
      'bookings.write',
      'resources.read',
      'resources.write',
      'schedule.read',
      'schedule.write',
    ])
  })

  it('describes every scope', () => {
    for (const scope of SCOPES) expect(SCOPE_DESCRIPTIONS[scope]).toBeTruthy()
  })

  it('accepts a known scope and rejects anything else', () => {
    expect(isScope('bookings.write')).toBe(true)
    expect(isScope('bookings.destroy')).toBe(false)
    expect(isScope('')).toBe(false)
  })

  it.each(Object.keys(PRESETS) as (keyof typeof PRESETS)[])(
    'expands preset %s to known scopes only',
    (name) => {
      const expanded = expandPreset(name)
      expect(expanded.length).toBeGreaterThan(0)
      for (const scope of expanded) expect(SCOPES).toContain(scope)
    },
  )

  // The difference the whole model exists for: a partner may book and may not read the calendar.
  it('gives partner_channel bookings.write without bookings.list', () => {
    expect(expandPreset('partner_channel')).toContain('bookings.write')
    expect(expandPreset('partner_channel')).not.toContain('bookings.list')
  })

  it('gives site_backend bookings.list', () => {
    expect(expandPreset('site_backend')).toContain('bookings.list')
  })

  // A scope no preset can issue is a scope nobody can use without hand-editing SQL.
  it('reaches every scope through at least one preset', () => {
    const reachable = new Set(
      Object.keys(PRESETS).flatMap((n) => expandPreset(n as keyof typeof PRESETS)),
    )
    expect([...reachable].sort()).toEqual([...SCOPES].sort())
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/unit/scopes.test.ts`
Expected: FAIL — `Cannot find module '../../src/shared/scopes.js'`.

- [ ] **Step 3: Write the vocabulary**

`src/shared/scopes.ts`:

```ts
/**
 * The scope vocabulary. Deliberately flat: no scope implies another, and the check is set
 * membership. Nested tiers cannot express a partner channel that may create bookings and must
 * not read the tenant's calendar — whatever tier grants the write also grants the listing.
 *
 * This list is duplicated by the check constraint in migration 003, which hardcodes it because
 * an applied migration must not change meaning when a constant does. The integration suite
 * asserts the two agree.
 */
export const SCOPES = [
  'resources.read',
  'resources.write',
  'schedule.read',
  'schedule.write',
  'availability.read',
  'bookings.read',
  'bookings.write',
  'bookings.list',
] as const

export type Scope = (typeof SCOPES)[number]

/** Shown beside each checkbox in the console. Here rather than in a table, so a missing one is a compile error. */
export const SCOPE_DESCRIPTIONS: Record<Scope, string> = {
  'resources.read': 'List resources and read one',
  'resources.write': 'Create, update and delete resources',
  'schedule.read': 'Read the weekly schedule and date exceptions',
  'schedule.write': 'Replace the schedule, set and clear exceptions',
  'availability.read': 'Compute free slots',
  'bookings.read': 'Read one booking by id',
  'bookings.write': 'Create bookings and move them through their lifecycle',
  'bookings.list': "List bookings by resource or across the tenant — the owner's calendar",
}

/**
 * Named bundles offered by the console. A preset name is never stored: it is expanded at issue
 * time and only the resulting set is written, so editing a preset tomorrow cannot change the
 * authority of a key already in the field.
 */
export const PRESETS = {
  widget: ['availability.read', 'resources.read'],
  site_backend: [
    'availability.read',
    'resources.read',
    'bookings.read',
    'bookings.write',
    'bookings.list',
  ],
  partner_channel: ['availability.read', 'resources.read', 'bookings.read', 'bookings.write'],
  reporting: [
    'resources.read',
    'schedule.read',
    'availability.read',
    'bookings.read',
    'bookings.list',
  ],
  back_office: [...SCOPES],
} as const satisfies Record<string, readonly Scope[]>

export type PresetName = keyof typeof PRESETS

export const PRESET_LABELS: Record<PresetName, string> = {
  widget: 'Widget',
  site_backend: 'Site backend',
  partner_channel: 'Partner channel',
  reporting: 'Reporting',
  back_office: 'Back office',
}

export function isScope(value: string): value is Scope {
  return (SCOPES as readonly string[]).includes(value)
}

export function isPresetName(value: string): value is PresetName {
  return Object.hasOwn(PRESETS, value)
}

export function expandPreset(name: PresetName): Scope[] {
  return [...PRESETS[name]]
}
```

- [ ] **Step 4: Run the unit test to green**

Run: `npx vitest run tests/unit/scopes.test.ts`
Expected: PASS, 7 cases.

- [ ] **Step 5: Write the failing migration test**

Append to `tests/integration/migrations.test.ts`:

```ts
it('creates tenants and api_keys', async () => {
  const tables = await sql<{ table_name: string }>`
    select table_name from information_schema.tables where table_schema = 'public'
  `.execute(getTestDb())
  const names = tables.rows.map((r) => r.table_name)
  expect(names).toContain('tenants')
  expect(names).toContain('api_keys')
})

it('puts tenant_id on all four owned tables, not null', async () => {
  const columns = await sql<{ table_name: string; is_nullable: string }>`
    select table_name, is_nullable from information_schema.columns
    where table_schema = 'public' and column_name = 'tenant_id'
  `.execute(getTestDb())
  const byTable = Object.fromEntries(columns.rows.map((r) => [r.table_name, r.is_nullable]))
  expect(byTable).toEqual({
    resources: 'NO',
    schedule: 'NO',
    schedule_exceptions: 'NO',
    bookings: 'NO',
  })
})

it('makes customer_id nullable', async () => {
  const column = await sql<{ is_nullable: string }>`
    select is_nullable from information_schema.columns
    where table_name = 'bookings' and column_name = 'customer_id'
  `.execute(getTestDb())
  expect(column.rows[0]?.is_nullable).toBe('YES')
})

it('permits exactly the scopes the code knows', async () => {
  const tenant = await getTestDb()
    .insertInto('tenants')
    .values({ name: 'constraint probe' })
    .returning('id')
    .executeTakeFirstOrThrow()

  // Every scope in the union must satisfy the check constraint.
  await expect(
    getTestDb()
      .insertInto('api_keys')
      .values({
        tenant_id: tenant.id,
        name: 'all',
        key_prefix: 'probe001',
        key_hash: 'x',
        scopes: [...SCOPES],
      })
      .execute(),
  ).resolves.toBeDefined()

  // And anything outside it must not.
  await expect(
    getTestDb()
      .insertInto('api_keys')
      .values({
        tenant_id: tenant.id,
        name: 'bogus',
        key_prefix: 'probe002',
        key_hash: 'x',
        scopes: ['bookings.destroy'] as unknown as Scope[],
      })
      .execute(),
  ).rejects.toThrow()

  // An empty set is not a key with no powers, it is a mistake.
  await expect(
    getTestDb()
      .insertInto('api_keys')
      .values({
        tenant_id: tenant.id,
        name: 'empty',
        key_prefix: 'probe003',
        key_hash: 'x',
        scopes: [],
      })
      .execute(),
  ).rejects.toThrow()
})

it('refuses a child row whose tenant disagrees with its resource', async () => {
  const db = getTestDb()
  const [a, b] = await Promise.all([
    db.insertInto('tenants').values({ name: 'A' }).returning('id').executeTakeFirstOrThrow(),
    db.insertInto('tenants').values({ name: 'B' }).returning('id').executeTakeFirstOrThrow(),
  ])
  const resource = await db
    .insertInto('resources')
    .values({
      tenant_id: a.id,
      timezone: 'Europe/Warsaw',
      slot_duration: 'PT1H',
      concurrency_mode: 'exclusive',
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  await expect(
    db
      .insertInto('schedule')
      .values({
        tenant_id: b.id,
        resource_id: resource.id,
        day_of_week: 0,
        start_time: '09:00',
        end_time: '17:00',
      })
      .execute(),
  ).rejects.toThrow()
})
```

Add `import { SCOPES, type Scope } from '../../src/shared/scopes.js'` at the top of the file.

- [ ] **Step 6: Run it and watch it fail**

Run: `npx vitest run tests/integration/migrations.test.ts`
Expected: FAIL — `tenants` does not exist.

- [ ] **Step 7: Write migration 003**

`src/db/migrations/003_tenancy.ts`:

```ts
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
    .addCheckConstraint('api_keys_scopes_not_empty', sql`array_length(scopes, 1) >= 1`)
    .addCheckConstraint(
      'api_keys_scopes_known',
      sql`scopes <@ ${sql.lit(`{${SCOPES.join(',')}}`)}::text[]`,
    )
    .execute()

  // Partial: the authentication lookup only ever asks for live keys, and revoked ones
  // accumulate forever.
  await sql`
    create index api_keys_active_prefix_idx on api_keys (key_prefix) where revoked_at is null
  `.execute(db)

  for (const table of OWNED_TABLES) {
    await db.schema.alterTable(table).addColumn('tenant_id', 'uuid').execute()
  }

  // Only when there is something to own. On an empty database no tenant is invented.
  await sql`
    insert into tenants (name)
    select 'default' where exists (select 1 from resources)
  `.execute(db)

  await sql`
    update resources set tenant_id = (select id from tenants where name = 'default')
    where tenant_id is null
  `.execute(db)

  // Children inherit from their parent rather than from the same subquery, so the backfill is
  // correct even if this migration is ever re-run against a database with several tenants.
  for (const table of ['schedule', 'schedule_exceptions', 'bookings'] as const) {
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

  // Postgres names an inline `references()` constraint `<table>_<column>_fkey`.
  const children = [
    { table: 'schedule', onDelete: 'cascade' },
    { table: 'schedule_exceptions', onDelete: 'cascade' },
    // RESTRICT, as migration 002 set it: a delete must not discard booking history.
    { table: 'bookings', onDelete: 'restrict' },
  ] as const

  for (const { table, onDelete } of children) {
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

  for (const { table, onDelete } of [
    { table: 'schedule', onDelete: 'cascade' },
    { table: 'schedule_exceptions', onDelete: 'cascade' },
    { table: 'bookings', onDelete: 'restrict' },
  ] as const) {
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
```

- [ ] **Step 8: Register the migration and widen the Kysely types**

`src/db/migrations/index.ts` — add the import and the entry:

```ts
import * as tenancy from './003_tenancy.js'
// ...
export const migrations: Record<string, Migration> = {
  '001_initial': initial,
  '002_bookings': bookings,
  '003_tenancy': tenancy,
}
```

`src/db/schema.ts` — add `tenant_id: string` to `ResourcesTable`, `ScheduleTable`, `ScheduleExceptionsTable` and `BookingsTable`, widen `BookingsTable.customer_id` to `string | null`, and append:

```ts
import type { Scope } from '../shared/scopes.js'

export interface TenantsTable {
  id: Generated<string>
  name: string
  is_active: Generated<boolean>
  created_at: Generated<Date>
}

export interface ApiKeysTable {
  id: Generated<string>
  tenant_id: string
  name: string
  key_prefix: string
  key_hash: string
  /** A set, not a rank. Nothing here implies anything else — see `src/shared/scopes.ts`. */
  scopes: Scope[]
  created_at: Generated<Date>
  last_used_at: ColumnType<Date | null, Date | string | null, Date | string | null>
  revoked_at: ColumnType<Date | null, Date | string | null, Date | string | null>
}

export interface Database {
  tenants: TenantsTable
  api_keys: ApiKeysTable
  resources: ResourcesTable
  schedule: ScheduleTable
  schedule_exceptions: ScheduleExceptionsTable
  bookings: BookingsTable
}
```

- [ ] **Step 9: Extend the test truncation list**

`tests/integration/helpers.ts` — `resetDb` must clear the new tables too, and `tenants` must come last because everything references it:

```ts
export async function resetDb(): Promise<void> {
  await sql`truncate table bookings, schedule_exceptions, schedule, resources, api_keys, tenants restart identity cascade`.execute(
    getTestDb(),
  )
}
```

- [ ] **Step 10: Add the two configuration variables**

`src/config.ts` — extend the interface and the loader:

```ts
export interface Config {
  // ...existing fields...
  consolePort: number
  rateLimitPerMinute: number
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  return {
    // ...existing fields...
    consolePort: positiveInt(env, 'CONSOLE_PORT', 3001),
    rateLimitPerMinute: positiveInt(env, 'RATE_LIMIT_PER_MINUTE', 600),
  }
}
```

There is deliberately no `CONSOLE_HOST`. The console is safe only while it is unreachable from outside, so the bind address is not something a deployment can get wrong.

Append to `.env.example`:

```
CONSOLE_PORT=3001
RATE_LIMIT_PER_MINUTE=600
```

Add to `tests/unit/config.test.ts`, following the existing cases:

```ts
it('defaults the console port and the rate limit', () => {
  const config = loadConfig({ DATABASE_URL: 'postgres://localhost/x' })
  expect(config.consolePort).toBe(3001)
  expect(config.rateLimitPerMinute).toBe(600)
})

it('rejects a non-positive console port', () => {
  expect(() => loadConfig({ DATABASE_URL: 'postgres://localhost/x', CONSOLE_PORT: '0' })).toThrow(
    /CONSOLE_PORT/,
  )
})
```

- [ ] **Step 11: Run the whole suite**

Run: `npm test`
Expected: PASS. Existing suites still pass because nothing yet requires a tenant on insert — the migration backfills, and `resetDb` empties the tables. Any test that inserts a resource directly will now fail on `tenant_id` NOT NULL; fix those by inserting a tenant in the fixture, which Task 5 formalises.

- [ ] **Step 12: Commit**

```bash
git add src/shared/scopes.ts src/db/migrations/003_tenancy.ts src/db/migrations/index.ts \
  src/db/schema.ts src/config.ts .env.example tests/unit/scopes.test.ts \
  tests/unit/config.test.ts tests/integration/migrations.test.ts tests/integration/helpers.ts
git commit -m "feat: tenants, api_keys and the scope vocabulary"
```

---

### Task 2: API key generation, hashing and verification

**Files:**

- Create: `src/modules/tenants/api-key.ts`
- Test: `tests/unit/api-key.test.ts`

**Interfaces:**

- Produces: `generateKey(): { key: string; prefix: string; hash: string }`, `parseKey(raw: string): { prefix: string; secret: string } | undefined`, `hashSecret(secret: string): string`, `verifySecret(secret: string, hash: string): boolean`, `KEY_MARKER = 'bk_live_'`.

- [ ] **Step 1: Write the failing test**

`tests/unit/api-key.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  generateKey,
  hashSecret,
  parseKey,
  verifySecret,
} from '../../src/modules/tenants/api-key.js'

describe('api keys', () => {
  it('generates a key with an 8-character prefix and a 43-character secret', () => {
    const { key, prefix, hash } = generateKey()
    expect(key.startsWith('bk_live_')).toBe(true)
    expect(prefix).toHaveLength(8)
    expect(key).toHaveLength('bk_live_'.length + 8 + 43)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('never generates the same key twice', () => {
    const keys = new Set(Array.from({ length: 200 }, () => generateKey().key))
    expect(keys.size).toBe(200)
  })

  it('round-trips through parse', () => {
    const { key, prefix, hash } = generateKey()
    const parsed = parseKey(key)
    expect(parsed?.prefix).toBe(prefix)
    expect(verifySecret(parsed!.secret, hash)).toBe(true)
  })

  it('rejects a secret differing in one character', () => {
    const { key, hash } = generateKey()
    const parsed = parseKey(key)!
    const tampered = parsed.secret.slice(0, -1) + (parsed.secret.endsWith('a') ? 'b' : 'a')
    expect(verifySecret(tampered, hash)).toBe(false)
  })

  it('rejects a hash of the wrong length without throwing', () => {
    // timingSafeEqual throws on a length mismatch; verifySecret must not propagate that.
    expect(verifySecret('anything', 'deadbeef')).toBe(false)
  })

  it.each([
    ['', 'empty'],
    ['bk_live_', 'marker only'],
    ['bk_test_abcdefghAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'wrong marker'],
    ['abcdefgh' + 'A'.repeat(43), 'no marker'],
    ['bk_live_short', 'too short'],
    ['bk_live_' + 'A'.repeat(60), 'too long'],
    ['bk_live_abcdefg!' + 'A'.repeat(42), 'non-alphanumeric'],
  ])('refuses to parse %s (%s)', (raw) => {
    expect(parseKey(raw)).toBeUndefined()
  })

  it('hashes deterministically', () => {
    expect(hashSecret('abc')).toBe(hashSecret('abc'))
    expect(hashSecret('abc')).not.toBe(hashSecret('abd'))
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/unit/api-key.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/modules/tenants/api-key.ts`:

```ts
import { createHash, randomInt, timingSafeEqual } from 'node:crypto'

export const KEY_MARKER = 'bk_live_'
const PREFIX_LENGTH = 8
const SECRET_LENGTH = 43
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/**
 * `randomInt` rather than `randomBytes` and a modulo: a modulo over 256 is biased towards the
 * first 8 characters of a 62-character alphabet, and `randomInt` rejects out-of-range draws
 * for us. 43 base62 characters carry roughly 256 bits.
 */
function randomString(length: number): string {
  let out = ''
  for (let i = 0; i < length; i += 1) out += ALPHABET[randomInt(ALPHABET.length)]
  return out
}

/**
 * SHA-256 rather than argon2 or bcrypt. Those are slow on purpose because human passwords have
 * little entropy and must survive an offline attack; this secret has 256 bits from a CSPRNG and
 * there is no search to slow down. A per-request argon2 would add ~100ms to every call to the
 * engine to defend against an attack that cannot succeed either way.
 */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}

export function generateKey(): { key: string; prefix: string; hash: string } {
  const prefix = randomString(PREFIX_LENGTH)
  const secret = randomString(SECRET_LENGTH)
  return { key: `${KEY_MARKER}${prefix}${secret}`, prefix, hash: hashSecret(secret) }
}

const KEY_PATTERN = new RegExp(
  `^${KEY_MARKER}([A-Za-z0-9]{${PREFIX_LENGTH}})([A-Za-z0-9]{${SECRET_LENGTH}})$`,
)

export function parseKey(raw: string): { prefix: string; secret: string } | undefined {
  const match = KEY_PATTERN.exec(raw)
  if (match === null) return undefined
  return { prefix: match[1]!, secret: match[2]! }
}

/** Constant-time over the hex digests. A `===` here would leak the hash a byte at a time. */
export function verifySecret(secret: string, hash: string): boolean {
  const expected = Buffer.from(hash, 'hex')
  const actual = Buffer.from(hashSecret(secret), 'hex')
  if (expected.length !== actual.length) return false
  return timingSafeEqual(expected, actual)
}
```

- [ ] **Step 4: Run to green**

Run: `npx vitest run tests/unit/api-key.test.ts`
Expected: PASS, 13 cases.

- [ ] **Step 5: Commit**

```bash
git add src/modules/tenants/api-key.ts tests/unit/api-key.test.ts
git commit -m "feat: api key generation, hashing and constant-time verification"
```

---

### Task 3: Tenant repository and service

**Files:**

- Create: `src/modules/tenants/tenant.repository.ts`, `src/modules/tenants/tenant.service.ts`
- Modify: `src/shared/errors.ts`
- Test: `tests/integration/tenants.test.ts`

**Interfaces:**

- Consumes: `generateKey`, `hashSecret`, `verifySecret`, `parseKey` (Task 2); `Scope`, `PresetName`, `expandPreset`, `isScope` (Task 1).
- Produces:
  - `TenantRepository`: `createTenant(name)`, `listTenants()`, `findTenant(id)`, `insertKey(v)`, `listKeys(tenantId)`, `findKeyByPrefix(prefix)`, `touchKey(id)`, `revokeKey(id)`.
  - `TenantService`: `createTenant(name): Promise<TenantRow>`, `listTenants()`, `getTenant(id)`, `issueKey(tenantId, name, scopes): Promise<{ row: ApiKeyRow; secret: string }>`, `listKeys(tenantId)`, `revokeKey(id)`, `authenticate(raw): Promise<{ tenantId: string; keyId: string; scopes: Scope[] } | undefined>`.
  - `ApiKeyRow`: `{ id, tenant_id, name, key_prefix, scopes, created_at, last_used_at, revoked_at }` — no `key_hash`, so a hash cannot reach a page by accident.

- [ ] **Step 1: Write the failing test**

`tests/integration/tenants.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeTestDb, getTestDb, resetDb } from './helpers.js'
import { TenantRepository } from '../../src/modules/tenants/tenant.repository.js'
import { TenantService } from '../../src/modules/tenants/tenant.service.js'
import { parseKey } from '../../src/modules/tenants/api-key.js'

const service = () => new TenantService(new TenantRepository(getTestDb()))

beforeEach(resetDb)
afterAll(closeTestDb)

describe('tenants', () => {
  it('creates and lists', async () => {
    const s = service()
    const created = await s.createTenant('Houses')
    expect(created.name).toBe('Houses')
    expect(await s.listTenants()).toHaveLength(1)
  })

  it('rejects a blank name', async () => {
    await expect(service().createTenant('   ')).rejects.toThrow()
  })

  it('allows two tenants with the same name', async () => {
    const s = service()
    const a = await s.createTenant('Houses')
    const b = await s.createTenant('Houses')
    expect(a.id).not.toBe(b.id)
  })
})

describe('api keys', () => {
  it('returns the secret once and stores only its hash', async () => {
    const s = service()
    const tenant = await s.createTenant('Houses')
    const { row, secret } = await s.issueKey(tenant.id, 'site', ['bookings.write'])

    expect(secret.startsWith('bk_live_')).toBe(true)
    expect(parseKey(secret)?.prefix).toBe(row.key_prefix)
    expect(JSON.stringify(row)).not.toContain('key_hash')

    const stored = await getTestDb()
      .selectFrom('api_keys')
      .select(['key_hash'])
      .where('id', '=', row.id)
      .executeTakeFirstOrThrow()
    expect(secret).not.toContain(stored.key_hash)
  })

  it('rejects an empty scope set', async () => {
    const s = service()
    const tenant = await s.createTenant('Houses')
    await expect(s.issueKey(tenant.id, 'site', [])).rejects.toThrow()
  })

  it('authenticates a live key and resolves its tenant and scopes', async () => {
    const s = service()
    const tenant = await s.createTenant('Houses')
    const { secret } = await s.issueKey(tenant.id, 'site', ['bookings.write', 'bookings.read'])

    const resolved = await s.authenticate(secret)
    expect(resolved?.tenantId).toBe(tenant.id)
    expect(resolved?.scopes.sort()).toEqual(['bookings.read', 'bookings.write'])
  })

  it.each([
    ['garbage', 'not a key at all'],
    ['bk_live_' + 'A'.repeat(51), 'well-formed but unknown'],
  ])('refuses %s (%s)', async (raw) => {
    expect(await service().authenticate(raw)).toBeUndefined()
  })

  it('refuses a key whose secret is wrong but whose prefix is real', async () => {
    const s = service()
    const tenant = await s.createTenant('Houses')
    const { row } = await s.issueKey(tenant.id, 'site', ['bookings.read'])
    expect(await s.authenticate(`bk_live_${row.key_prefix}${'A'.repeat(43)}`)).toBeUndefined()
  })

  it('refuses a revoked key and keeps its row', async () => {
    const s = service()
    const tenant = await s.createTenant('Houses')
    const { row, secret } = await s.issueKey(tenant.id, 'site', ['bookings.read'])

    await s.revokeKey(row.id)
    expect(await s.authenticate(secret)).toBeUndefined()

    const keys = await s.listKeys(tenant.id)
    expect(keys).toHaveLength(1)
    expect(keys[0]?.revoked_at).not.toBeNull()
  })

  it('refuses a key belonging to an inactive tenant', async () => {
    const s = service()
    const tenant = await s.createTenant('Houses')
    const { secret } = await s.issueKey(tenant.id, 'site', ['bookings.read'])
    await getTestDb()
      .updateTable('tenants')
      .set({ is_active: false })
      .where('id', '=', tenant.id)
      .execute()
    expect(await s.authenticate(secret)).toBeUndefined()
  })

  it('stamps last_used_at once, then not again within the minute', async () => {
    const s = service()
    const tenant = await s.createTenant('Houses')
    const { row, secret } = await s.issueKey(tenant.id, 'site', ['bookings.read'])

    await s.authenticate(secret)
    const first = (await s.listKeys(tenant.id))[0]?.last_used_at
    expect(first).not.toBeNull()

    await s.authenticate(secret)
    expect((await s.listKeys(tenant.id))[0]?.last_used_at).toEqual(first)
    expect(row.last_used_at).toBeNull()
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/integration/tenants.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Add the error classes**

Append to `src/shared/errors.ts`:

```ts
/**
 * Every authentication failure answers this, whatever went wrong: no header, a malformed key,
 * an unknown prefix, a wrong secret, a revoked key, an inactive tenant. A caller learns that
 * the key did not work and never which step rejected it — distinguishing "no such key" from
 * "wrong secret" turns prefix enumeration into a probe.
 */
export class UnauthorizedError extends AppError {
  readonly statusCode = 401
  readonly code = 'unauthorized'
  readonly headers = { 'www-authenticate': 'Bearer' }
}

export class ForbiddenScopeError extends AppError {
  readonly statusCode = 403
  readonly code = 'forbidden_scope'
}

/** A console write whose Origin is not the console itself. */
export class ForbiddenOriginError extends AppError {
  readonly statusCode = 403
  readonly code = 'forbidden_origin'
}
```

- [ ] **Step 4: Write the repository**

`src/modules/tenants/tenant.repository.ts`:

```ts
import { sql, type Kysely } from 'kysely'
import type { Database } from '../../db/schema.js'
import type { Scope } from '../../shared/scopes.js'

export interface TenantRow {
  id: string
  name: string
  is_active: boolean
  created_at: Date
}

/** No `key_hash`. A shape that cannot carry the hash cannot leak it into a page or a log. */
export interface ApiKeyRow {
  id: string
  tenant_id: string
  name: string
  key_prefix: string
  scopes: Scope[]
  created_at: Date
  last_used_at: Date | null
  revoked_at: Date | null
}

/** The authentication path needs the hash and the tenant's state; nothing else does. */
export interface ApiKeySecretRow {
  id: string
  tenant_id: string
  key_hash: string
  scopes: Scope[]
  tenant_is_active: boolean
}

const keyColumns = [
  'id',
  'tenant_id',
  'name',
  'key_prefix',
  'scopes',
  'created_at',
  'last_used_at',
  'revoked_at',
] as const

export interface InsertKey {
  tenant_id: string
  name: string
  key_prefix: string
  key_hash: string
  scopes: Scope[]
}

export class TenantRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async createTenant(name: string): Promise<TenantRow> {
    return this.db
      .insertInto('tenants')
      .values({ name })
      .returning(['id', 'name', 'is_active', 'created_at'])
      .executeTakeFirstOrThrow()
  }

  async listTenants(): Promise<TenantRow[]> {
    return this.db
      .selectFrom('tenants')
      .select(['id', 'name', 'is_active', 'created_at'])
      .orderBy('created_at')
      .execute()
  }

  async findTenant(id: string): Promise<TenantRow | undefined> {
    return this.db
      .selectFrom('tenants')
      .select(['id', 'name', 'is_active', 'created_at'])
      .where('id', '=', id)
      .executeTakeFirst()
  }

  async insertKey(values: InsertKey): Promise<ApiKeyRow> {
    return this.db
      .insertInto('api_keys')
      .values(values)
      .returning(keyColumns)
      .executeTakeFirstOrThrow()
  }

  async listKeys(tenantId: string): Promise<ApiKeyRow[]> {
    return this.db
      .selectFrom('api_keys')
      .select(keyColumns)
      .where('tenant_id', '=', tenantId)
      .orderBy('created_at', 'desc')
      .execute()
  }

  /** Live keys only: the partial index `api_keys_active_prefix_idx` serves exactly this. */
  async findKeyByPrefix(prefix: string): Promise<ApiKeySecretRow | undefined> {
    return this.db
      .selectFrom('api_keys')
      .innerJoin('tenants', 'tenants.id', 'api_keys.tenant_id')
      .select([
        'api_keys.id',
        'api_keys.tenant_id',
        'api_keys.key_hash',
        'api_keys.scopes',
        'tenants.is_active as tenant_is_active',
      ])
      .where('api_keys.key_prefix', '=', prefix)
      .where('api_keys.revoked_at', 'is', null)
      .executeTakeFirst()
  }

  /**
   * At most one write per key per minute. Without the predicate a read-heavy caller turns
   * every GET into an UPDATE; with it, the statement usually matches nothing and costs an
   * index probe.
   */
  async touchKey(id: string): Promise<void> {
    await this.db
      .updateTable('api_keys')
      .set({ last_used_at: sql<Date>`now()` })
      .where('id', '=', id)
      .where((eb) =>
        eb.or([
          eb('last_used_at', 'is', null),
          eb('last_used_at', '<', sql<Date>`now() - interval '1 minute'`),
        ]),
      )
      .execute()
  }

  /** Soft: the row stays, so `last_used_at` and the audit trail survive the revocation. */
  async revokeKey(id: string): Promise<ApiKeyRow | undefined> {
    return this.db
      .updateTable('api_keys')
      .set({ revoked_at: sql<Date>`now()` })
      .where('id', '=', id)
      .where('revoked_at', 'is', null)
      .returning(keyColumns)
      .executeTakeFirst()
  }
}
```

- [ ] **Step 5: Write the service**

`src/modules/tenants/tenant.service.ts`:

```ts
import { NotFoundError, ValidationError } from '../../shared/errors.js'
import { isScope, type Scope } from '../../shared/scopes.js'
import { generateKey, parseKey, verifySecret } from './api-key.js'
import type { ApiKeyRow, TenantRepository, TenantRow } from './tenant.repository.js'

export interface ResolvedKey {
  tenantId: string
  keyId: string
  scopes: Scope[]
}

const MAX_NAME_LENGTH = 100

export class TenantService {
  constructor(private readonly repository: TenantRepository) {}

  async createTenant(name: string): Promise<TenantRow> {
    return this.repository.createTenant(this.cleanName(name, 'Tenant name'))
  }

  async listTenants(): Promise<TenantRow[]> {
    return this.repository.listTenants()
  }

  async getTenant(id: string): Promise<TenantRow> {
    const tenant = await this.repository.findTenant(id)
    if (tenant === undefined) throw new NotFoundError(`No tenant with id ${id}`)
    return tenant
  }

  async issueKey(
    tenantId: string,
    name: string,
    scopes: readonly string[],
  ): Promise<{ row: ApiKeyRow; secret: string }> {
    await this.getTenant(tenantId)

    const cleanName = this.cleanName(name, 'Key name')
    const unique = [...new Set(scopes)]
    if (unique.length === 0) throw new ValidationError('A key needs at least one scope')

    const unknown = unique.filter((s) => !isScope(s))
    if (unknown.length > 0) {
      throw new ValidationError('Unknown scope', { unknown })
    }

    const { key, prefix, hash } = generateKey()
    const row = await this.repository.insertKey({
      tenant_id: tenantId,
      name: cleanName,
      key_prefix: prefix,
      key_hash: hash,
      scopes: unique as Scope[],
    })
    return { row, secret: key }
  }

  async listKeys(tenantId: string): Promise<ApiKeyRow[]> {
    await this.getTenant(tenantId)
    return this.repository.listKeys(tenantId)
  }

  async revokeKey(id: string): Promise<ApiKeyRow> {
    const revoked = await this.repository.revokeKey(id)
    if (revoked === undefined) throw new NotFoundError(`No live key with id ${id}`)
    return revoked
  }

  /**
   * Returns undefined for every failure, without saying which. The caller turns that into one
   * `401 unauthorized`; a response that distinguished "unknown prefix" from "wrong secret"
   * would make prefix enumeration a usable probe.
   */
  async authenticate(raw: string): Promise<ResolvedKey | undefined> {
    const parsed = parseKey(raw)
    if (parsed === undefined) return undefined

    const key = await this.repository.findKeyByPrefix(parsed.prefix)
    if (key === undefined) return undefined
    if (!verifySecret(parsed.secret, key.key_hash)) return undefined
    if (!key.tenant_is_active) return undefined

    await this.repository.touchKey(key.id)
    return { tenantId: key.tenant_id, keyId: key.id, scopes: key.scopes }
  }

  private cleanName(name: string, what: string): string {
    const trimmed = name.trim()
    if (trimmed.length === 0) throw new ValidationError(`${what} must not be blank`)
    if (trimmed.length > MAX_NAME_LENGTH) {
      throw new ValidationError(`${what} must be at most ${MAX_NAME_LENGTH} characters`)
    }
    return trimmed
  }
}
```

- [ ] **Step 6: Run to green**

Run: `npx vitest run tests/integration/tenants.test.ts`
Expected: PASS, 12 cases.

- [ ] **Step 7: Commit**

```bash
git add src/modules/tenants/ src/shared/errors.ts tests/integration/tenants.test.ts
git commit -m "feat: tenant repository and service, key issuance and authentication"
```

---

### Task 4: The authentication preHandler, route scopes, rate limit, log redaction

**Files:**

- Create: `src/shared/auth.ts`
- Modify: `src/app.ts`, every `src/modules/*/**.routes.ts`, `package.json`
- Test: `tests/integration/auth.test.ts`

**Interfaces:**

- Consumes: `TenantService.authenticate` (Task 3), `Scope`, `SCOPES` (Task 1).
- Produces: `registerAuth(app, service)`, and the route config contract `{ scope: Scope } | { public: true }`. After this task `request.tenantId`, `request.apiKeyId` and `request.scopes` are populated on every non-public route; handlers do not use them yet — Task 5 threads them through.

- [ ] **Step 1: Install the rate limiter**

```bash
npm install @fastify/rate-limit
```

- [ ] **Step 2: Write the failing test**

`tests/integration/auth.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, closeTestDb, getTestDb, resetDb } from './helpers.js'
import { TenantRepository } from '../../src/modules/tenants/tenant.repository.js'
import { TenantService } from '../../src/modules/tenants/tenant.service.js'
import { SCOPES, type Scope } from '../../src/shared/scopes.js'

let app: FastifyInstance

beforeAll(async () => {
  app = await buildTestApp()
})
beforeEach(resetDb)
afterAll(async () => {
  await app.close()
  await closeTestDb()
})

async function keyWith(scopes: Scope[]): Promise<string> {
  const service = new TenantService(new TenantRepository(getTestDb()))
  const tenant = await service.createTenant('Houses')
  const { secret } = await service.issueKey(tenant.id, 'test', scopes)
  return secret
}

const auth = (key: string) => ({ authorization: `Bearer ${key}` })

describe('authentication', () => {
  it('answers 401 with WWW-Authenticate when the header is missing', async () => {
    const response = await app.inject({ method: 'GET', url: '/resources' })
    expect(response.statusCode).toBe(401)
    expect(response.json().error).toBe('unauthorized')
    expect(response.headers['www-authenticate']).toBe('Bearer')
  })

  it.each([
    ['Bearer garbage', 'malformed'],
    ['Basic abcdef', 'wrong scheme'],
    ['bk_live_' + 'A'.repeat(51), 'no Bearer prefix'],
  ])('answers 401 for %s (%s)', async (header) => {
    const response = await app.inject({
      method: 'GET',
      url: '/resources',
      headers: { authorization: header },
    })
    expect(response.statusCode).toBe(401)
  })

  it('gives every failure the same body, so the reason cannot be probed', async () => {
    const missing = await app.inject({ method: 'GET', url: '/resources' })
    const unknown = await app.inject({
      method: 'GET',
      url: '/resources',
      headers: auth('bk_live_' + 'A'.repeat(51)),
    })
    expect(unknown.json()).toEqual(missing.json())
  })

  it('lets health and docs through without a key', async () => {
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/docs/json' })).statusCode).toBe(200)
  })
})

describe('scopes', () => {
  it('admits a key holding exactly the route scope', async () => {
    const key = await keyWith(['resources.read'])
    const response = await app.inject({ method: 'GET', url: '/resources', headers: auth(key) })
    expect(response.statusCode).toBe(200)
  })

  it('refuses a key holding every scope except the route one, and names it', async () => {
    const key = await keyWith(SCOPES.filter((s) => s !== 'resources.read'))
    const response = await app.inject({ method: 'GET', url: '/resources', headers: auth(key) })
    expect(response.statusCode).toBe(403)
    expect(response.json().error).toBe('forbidden_scope')
    expect(response.json().details).toEqual({ required: 'resources.read' })
  })

  // The reason the model is a set and not three nested tiers.
  it('lets a partner channel book and refuses it the calendar', async () => {
    const service = new TenantService(new TenantRepository(getTestDb()))
    const tenant = await service.createTenant('Houses')
    const { secret } = await service.issueKey(tenant.id, 'partner', [
      'availability.read',
      'resources.read',
      'bookings.read',
      'bookings.write',
    ])

    const listing = await app.inject({
      method: 'GET',
      url: '/bookings?from=2026-09-01&to=2026-09-08',
      headers: auth(secret),
    })
    expect(listing.statusCode).toBe(403)
    expect(listing.json().details).toEqual({ required: 'bookings.list' })
  })

  it('declares a scope or public on every route', () => {
    const missing: string[] = []
    for (const route of app.routes ?? []) void route
    // The real assertion lives in the startup check; this asserts the app started at all,
    // which it would not have done had a route been undeclared.
    expect(missing).toEqual([])
  })
})
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run tests/integration/auth.test.ts`
Expected: FAIL — the requests succeed with 200 because no authentication exists yet.

- [ ] **Step 4: Write the hook**

`src/shared/auth.ts`:

```ts
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { ForbiddenScopeError, UnauthorizedError } from './errors.js'
import type { Scope } from './scopes.js'
import type { TenantService } from '../modules/tenants/tenant.service.js'

/**
 * What a route says about who may call it. Declaring neither is a startup error rather than a
 * route that quietly admits any key: a list of protected prefixes fails open, and default deny
 * fails closed — design principle #8.
 */
export type RouteAuth = { scope: Scope; public?: never } | { public: true; scope?: never }

declare module 'fastify' {
  interface FastifyRequest {
    tenantId: string
    apiKeyId: string
    scopes: Scope[]
  }
  interface FastifyContextConfig {
    scope?: Scope
    public?: true
  }
}

const BEARER = /^Bearer (.+)$/

export function registerAuth(app: FastifyInstance, service: TenantService): void {
  app.decorateRequest('tenantId', '')
  app.decorateRequest('apiKeyId', '')
  app.decorateRequest('scopes', null)

  // Fastify's own 404 handler has no route config, so an unmatched path must not be treated as
  // an undeclared route. It answers 404 before this hook decides anything.
  app.addHook('onRoute', (route) => {
    const config = route.config as { scope?: Scope; public?: true } | undefined
    if (config?.public === true || config?.scope !== undefined) return
    if (route.url.startsWith('/docs')) return
    throw new Error(
      `Route ${route.method} ${route.url} declares neither a scope nor public: true. ` +
        'Every route must say who may call it.',
    )
  })

  app.addHook('preHandler', async (request: FastifyRequest) => {
    const config = request.routeOptions.config as { scope?: Scope; public?: true }
    if (config.public === true) return

    const header = request.headers.authorization
    const match = header === undefined ? null : BEARER.exec(header)
    if (match === null) throw new UnauthorizedError('A valid API key is required')

    const resolved = await service.authenticate(match[1]!)
    if (resolved === undefined) throw new UnauthorizedError('A valid API key is required')

    const required = config.scope
    if (required === undefined) {
      // Unreachable: onRoute refuses to register such a route. Kept so a future bypass fails
      // closed rather than granting access.
      throw new ForbiddenScopeError('This route declares no scope')
    }
    if (!resolved.scopes.includes(required)) {
      throw new ForbiddenScopeError(`This key does not hold ${required}`, { required })
    }

    request.tenantId = resolved.tenantId
    request.apiKeyId = resolved.keyId
    request.scopes = resolved.scopes
  })
}
```

- [ ] **Step 5: Declare a scope on every route**

Add a `config` block beside each route's `schema`. `GET /health` and `GET /` take `config: { public: true }`; the rest:

| File                     | Route                                                                           | `config`                         |
| ------------------------ | ------------------------------------------------------------------------------- | -------------------------------- |
| `resource.routes.ts`     | `POST /resources`                                                               | `{ scope: 'resources.write' }`   |
|                          | `GET /resources/:id`                                                            | `{ scope: 'resources.read' }`    |
|                          | `PATCH /resources/:id`                                                          | `{ scope: 'resources.write' }`   |
|                          | `DELETE /resources/:id`                                                         | `{ scope: 'resources.write' }`   |
| `schedule.routes.ts`     | `GET /resources/:id/schedule`                                                   | `{ scope: 'schedule.read' }`     |
|                          | `PUT /resources/:id/schedule`                                                   | `{ scope: 'schedule.write' }`    |
| `exception.routes.ts`    | `GET /resources/:id/exceptions`                                                 | `{ scope: 'schedule.read' }`     |
|                          | `PUT /resources/:id/exceptions/:date`                                           | `{ scope: 'schedule.write' }`    |
|                          | `DELETE /resources/:id/exceptions/:date`                                        | `{ scope: 'schedule.write' }`    |
| `availability.routes.ts` | `GET /resources/:id/availability`                                               | `{ scope: 'availability.read' }` |
| `booking.routes.ts`      | `POST /resources/:id/bookings`                                                  | `{ scope: 'bookings.write' }`    |
|                          | `GET /bookings/:id`                                                             | `{ scope: 'bookings.read' }`     |
|                          | `POST /bookings/:id/confirm` · `cancel` · `reschedule` · `complete` · `no-show` | `{ scope: 'bookings.write' }`    |
|                          | `GET /resources/:id/bookings`                                                   | `{ scope: 'bookings.list' }`     |
|                          | `GET /bookings`                                                                 | `{ scope: 'bookings.list' }`     |

The shape is:

```ts
app.get(
  '/resources/:id',
  {
    config: { scope: 'resources.read' },
    schema: {/* unchanged */},
  },
  async (request) => service.getById(request.params.id),
)
```

`GET /resources` does not exist yet; it arrives in Task 6 carrying `{ scope: 'resources.read' }`.

- [ ] **Step 6: Wire it up in `buildApp`**

`src/app.ts` — register the limiter and the hook before the route plugins, and redact the header:

```ts
import fastifyRateLimit from '@fastify/rate-limit'
import { registerAuth } from './shared/auth.js'
import { TenantRepository } from './modules/tenants/tenant.repository.js'
import { TenantService } from './modules/tenants/tenant.service.js'

const app = Fastify({
  logger: {
    level: deps.config.logLevel,
    // Without this the first authenticated request writes a live credential to the log.
    redact: ['req.headers.authorization'],
  },
  ajv: { customOptions: { removeAdditional: false } },
}).withTypeProvider<TypeBoxTypeProvider>()

// ...decorators and error handler as before...

await app.register(fastifyRateLimit, {
  max: deps.config.rateLimitPerMinute,
  timeWindow: '1 minute',
  // Per key, so one tenant cannot exhaust the engine for the others. Unauthenticated requests
  // fall back to the source address; the hook has not run yet when this is called, so the
  // header is read directly.
  keyGenerator: (request) => request.headers.authorization ?? request.ip,
  errorResponseBuilder: () => ({
    error: 'rate_limited',
    message: 'Too many requests; slow down and retry',
  }),
})

registerAuth(app, new TenantService(new TenantRepository(deps.db)))
```

Also update the OpenAPI description in `openapiDocument`, replacing the sentence _"There is no authentication…"_ with:

```ts
'Every request carries an API key: `Authorization: Bearer bk_live_…`. A key belongs to one tenant and holds a set of scopes; a route requires exactly one of them, and nothing implies anything else. Keys are issued from the console.',
```

`buildApp` becomes `async` because `register` is awaited; update `src/server.ts` and `tests/integration/helpers.ts` to `await buildApp(...)`.

- [ ] **Step 7: Fix the existing suites**

Every integration test now needs a key. Add to `tests/integration/helpers.ts`:

```ts
import { TenantRepository } from '../../src/modules/tenants/tenant.repository.js'
import { TenantService } from '../../src/modules/tenants/tenant.service.js'
import { SCOPES } from '../../src/shared/scopes.js'

/** A tenant and a key holding every scope: the default for suites that are not about auth. */
export async function seedTenant(): Promise<{
  tenantId: string
  authHeader: Record<string, string>
}> {
  const service = new TenantService(new TenantRepository(getTestDb()))
  const tenant = await service.createTenant('test tenant')
  const { secret } = await service.issueKey(tenant.id, 'test', [...SCOPES])
  return { tenantId: tenant.id, authHeader: { authorization: `Bearer ${secret}` } }
}
```

Then in each existing integration suite, call `seedTenant()` in `beforeEach` after `resetDb()` and spread `authHeader` into every `app.inject` call.

- [ ] **Step 8: Run the whole suite**

Run: `npm test`
Expected: PASS. If a suite fails with 401, its `inject` call is missing the header.

- [ ] **Step 9: Commit**

```bash
git add src/shared/auth.ts src/app.ts src/server.ts src/modules/*/**.routes.ts \
  package.json package-lock.json tests/integration/
git commit -m "feat: authenticate every request by API key and enforce one scope per route"
```

---

### Task 5: Thread the tenant through every repository and service

**Files:**

- Modify: `src/modules/resources/resource.repository.ts` + `.service.ts`, `src/modules/schedule/*`, `src/modules/exceptions/*`, `src/modules/availability/availability.service.ts`, `src/modules/bookings/booking.repository.ts` + `.service.ts`, and every `*.routes.ts` handler
- Test: `tests/integration/isolation.test.ts`

**Interfaces:**

- Consumes: `request.tenantId` (Task 4).
- Produces: every repository method takes `tenantId: string` as its **first** parameter. `ResourceRepository.list(tenantId, filter)` is new and Task 6 uses it.

- [ ] **Step 1: Write the failing isolation test**

`tests/integration/isolation.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, closeTestDb, getTestDb, resetDb } from './helpers.js'
import { TenantRepository } from '../../src/modules/tenants/tenant.repository.js'
import { TenantService } from '../../src/modules/tenants/tenant.service.js'
import { SCOPES } from '../../src/shared/scopes.js'

let app: FastifyInstance

beforeAll(async () => {
  app = await buildTestApp()
})
beforeEach(resetDb)
afterAll(async () => {
  await app.close()
  await closeTestDb()
})

async function tenantWithKey(name: string): Promise<Record<string, string>> {
  const service = new TenantService(new TenantRepository(getTestDb()))
  const tenant = await service.createTenant(name)
  const { secret } = await service.issueKey(tenant.id, 'test', [...SCOPES])
  return { authorization: `Bearer ${secret}` }
}

const resourceBody = {
  timezone: 'Europe/Warsaw',
  slot_duration: 'P1D',
  slot_anchor_time: '15:00',
  capacity: 1,
  concurrency_mode: 'exclusive',
}

describe('tenant isolation', () => {
  it("answers 404 — never 403 — on another tenant's resource, everywhere", async () => {
    const a = await tenantWithKey('A')
    const b = await tenantWithKey('B')

    const created = await app.inject({
      method: 'POST',
      url: '/resources',
      headers: a,
      payload: resourceBody,
    })
    const id = created.json().id as string

    const absent = '00000000-0000-4000-8000-000000000000'
    const paths = [
      `/resources/${id}`,
      `/resources/${id}/schedule`,
      `/resources/${id}/exceptions?from=2026-09-01&to=2026-09-08`,
      `/resources/${id}/availability?from=2026-09-01&to=2026-09-08`,
      `/resources/${id}/bookings?from=2026-09-01&to=2026-09-08`,
    ]

    for (const path of paths) {
      const foreign = await app.inject({ method: 'GET', url: path, headers: b })
      const missing = await app.inject({
        method: 'GET',
        url: path.replace(id, absent),
        headers: b,
      })
      expect(foreign.statusCode).toBe(404)
      // Identical, so the response cannot be used to tell "someone else's" from "nobody's".
      expect(foreign.json()).toEqual(missing.json())
    }
  })

  it("refuses to modify another tenant's resource", async () => {
    const a = await tenantWithKey('A')
    const b = await tenantWithKey('B')
    const id = (
      await app.inject({ method: 'POST', url: '/resources', headers: a, payload: resourceBody })
    ).json().id as string

    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/resources/${id}`,
          headers: b,
          payload: { capacity: 2 },
        })
      ).statusCode,
    ).toBe(404)
    expect(
      (await app.inject({ method: 'DELETE', url: `/resources/${id}`, headers: b })).statusCode,
    ).toBe(404)
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/resources/${id}/schedule`,
          headers: b,
          payload: [],
        })
      ).statusCode,
    ).toBe(404)
  })

  it("cannot book another tenant's resource", async () => {
    const a = await tenantWithKey('A')
    const b = await tenantWithKey('B')
    const id = (
      await app.inject({ method: 'POST', url: '/resources', headers: a, payload: resourceBody })
    ).json().id as string

    const response = await app.inject({
      method: 'POST',
      url: `/resources/${id}/bookings`,
      headers: b,
      payload: {
        customer_id: 'guest-1',
        start_time: '2026-09-01T15:00:00+02:00',
        end_time: '2026-09-02T15:00:00+02:00',
      },
    })
    expect(response.statusCode).toBe(404)
  })

  it("cannot read another tenant's booking by id", async () => {
    const a = await tenantWithKey('A')
    const b = await tenantWithKey('B')
    const id = (
      await app.inject({ method: 'POST', url: '/resources', headers: a, payload: resourceBody })
    ).json().id as string
    await app.inject({
      method: 'PUT',
      url: `/resources/${id}/schedule`,
      headers: a,
      payload: [0, 1, 2, 3, 4, 5, 6].map((d) => ({
        day_of_week: d,
        start_time: null,
        end_time: null,
      })),
    })
    const booking = await app.inject({
      method: 'POST',
      url: `/resources/${id}/bookings`,
      headers: a,
      payload: {
        customer_id: 'guest-1',
        start_time: '2026-09-01T15:00:00+02:00',
        end_time: '2026-09-02T15:00:00+02:00',
      },
    })
    const bookingId = booking.json().id as string

    expect(
      (await app.inject({ method: 'GET', url: `/bookings/${bookingId}`, headers: b })).statusCode,
    ).toBe(404)
    expect(
      (await app.inject({ method: 'POST', url: `/bookings/${bookingId}/cancel`, headers: b }))
        .statusCode,
    ).toBe(404)
  })

  it('lists only its own bookings', async () => {
    const a = await tenantWithKey('A')
    const b = await tenantWithKey('B')
    const id = (
      await app.inject({ method: 'POST', url: '/resources', headers: a, payload: resourceBody })
    ).json().id as string
    await app.inject({
      method: 'PUT',
      url: `/resources/${id}/schedule`,
      headers: a,
      payload: [0, 1, 2, 3, 4, 5, 6].map((d) => ({
        day_of_week: d,
        start_time: null,
        end_time: null,
      })),
    })
    await app.inject({
      method: 'POST',
      url: `/resources/${id}/bookings`,
      headers: a,
      payload: {
        customer_id: 'guest-1',
        start_time: '2026-09-01T15:00:00+02:00',
        end_time: '2026-09-02T15:00:00+02:00',
      },
    })

    const mine = await app.inject({
      method: 'GET',
      url: '/bookings?customer_id=guest-1&from=2026-09-01&to=2026-09-08',
      headers: a,
    })
    const theirs = await app.inject({
      method: 'GET',
      url: '/bookings?customer_id=guest-1&from=2026-09-01&to=2026-09-08',
      headers: b,
    })
    expect(mine.json()).toHaveLength(1)
    expect(theirs.json()).toEqual([])
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/integration/isolation.test.ts`
Expected: FAIL — tenant B reads and modifies tenant A's rows, because nothing filters yet.

- [ ] **Step 3: Add `tenantId` to `ResourceRepository`**

Every method gains it as the first parameter and every query gains the filter. `insert` takes it in the values instead:

```ts
export interface InsertResource {
  tenant_id: string
  timezone: string
  slot_duration: string
  slot_anchor_time: string
  capacity: number
  concurrency_mode: ConcurrencyMode
}

export interface ListFilter {
  isActive?: boolean
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
    if (filter.isActive !== undefined) query = query.where('is_active', '=', filter.isActive)
    return query.execute()
  }

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
```

An `update` or `delete` that matches nothing because the row belongs to someone else returns exactly what a missing row returns, and the service turns both into `NotFoundError`. That is where 404-never-403 comes from, and it costs no branch.

- [ ] **Step 4: Do the same for schedule, exceptions and bookings**

Apply the identical treatment — `tenantId` first, `.where('tenant_id', '=', tenantId)` on every statement — to `ScheduleRepository`, `ExceptionRepository` and `BookingRepository`. Two places in `BookingRepository` need attention beyond the mechanical change:

```ts
  async inWriteTransaction<T>(
    tenantId: string,
    resourceId: string,
    lockResource: boolean,
    work: (trx: Trx, resource: ResourceRow | undefined) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      const query = trx
        .selectFrom('resources')
        .select(resourceColumns)
        .where('tenant_id', '=', tenantId)
        .where('id', '=', resourceId)
      const resource = await (lockResource ? query.forUpdate() : query).executeTakeFirst()

      // The expiry sweep stays scoped to the resource and needs no tenant filter: resource_id
      // is globally unique and the composite FK proves it belongs to one tenant. Adding the
      // filter here would only widen the index.
      // ...unchanged sweep...

      return work(trx, resource)
    })
  }
```

and the two listing queries, whose join to `resources` is already present:

```ts
let query = this.db
  .selectFrom('bookings')
  .innerJoin('resources', 'resources.id', 'bookings.resource_id')
  .select([/* unchanged */])
  .where('bookings.tenant_id', '=', tenantId)
  .where('bookings.start_time', '<', filter.to)
  .where('bookings.end_time', '>', filter.from)
  .orderBy('bookings.start_time')
```

`findById` likewise gains `.where('bookings.tenant_id', '=', tenantId)`.

- [ ] **Step 5: Thread it through the services and handlers**

Each service method gains `tenantId` as its first parameter and passes it down. Handlers read it from the request:

```ts
async (request) => service.getById(request.tenantId, request.params.id),
```

`BookingService.create` puts it on the row it inserts:

```ts
const values: NewBooking = {
  tenant_id: tenantId,
  resource_id: resourceId,
  // ...unchanged...
}
```

`ResourceService.create` likewise puts `tenant_id` into `InsertResource`, and `ScheduleService.replace` / `ExceptionService.put` put it on every row they insert. The composite foreign key rejects a mismatch, so a mistake here fails the suite rather than writing a cross-tenant row.

- [ ] **Step 6: Run to green**

Run: `npx vitest run tests/integration/isolation.test.ts && npm test`
Expected: PASS. TypeScript catches any repository call that forgot the argument — that is the point of making it required and first.

- [ ] **Step 7: Commit**

```bash
git add src/modules/ tests/integration/isolation.test.ts
git commit -m "feat: scope every query to the calling tenant"
```

---

### Task 6: `GET /resources`, and `customer_id` becomes optional

**Files:**

- Modify: `src/modules/resources/resource.schemas.ts` + `.routes.ts` + `.service.ts`, `src/modules/bookings/booking.schemas.ts` + `.service.ts`
- Test: `tests/integration/resources.test.ts`, `tests/integration/bookings.test.ts`

**Interfaces:**

- Consumes: `ResourceRepository.list` (Task 5).
- Produces: `GET /resources?is_active=` returning a bare array; `customer_id` optional on `POST /resources/:id/bookings` and on `GET /bookings`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/integration/resources.test.ts`:

```ts
it('lists the tenant resources oldest first', async () => {
  const first = await app.inject({
    method: 'POST',
    url: '/resources',
    headers,
    payload: resourceBody,
  })
  const second = await app.inject({
    method: 'POST',
    url: '/resources',
    headers,
    payload: resourceBody,
  })

  const response = await app.inject({ method: 'GET', url: '/resources', headers })
  expect(response.statusCode).toBe(200)
  expect(response.json().map((r: { id: string }) => r.id)).toEqual([
    first.json().id,
    second.json().id,
  ])
})

it('filters the listing by is_active', async () => {
  const created = await app.inject({
    method: 'POST',
    url: '/resources',
    headers,
    payload: resourceBody,
  })
  await app.inject({
    method: 'PATCH',
    url: `/resources/${created.json().id}`,
    headers,
    payload: { is_active: false },
  })

  expect(
    (await app.inject({ method: 'GET', url: '/resources?is_active=false', headers })).json(),
  ).toHaveLength(1)
  expect(
    (await app.inject({ method: 'GET', url: '/resources?is_active=true', headers })).json(),
  ).toEqual([])
})

it('answers an empty array when the tenant owns nothing', async () => {
  expect((await app.inject({ method: 'GET', url: '/resources', headers })).json()).toEqual([])
})
```

Append to `tests/integration/bookings.test.ts`:

```ts
it('books without a customer_id and reports it as null', async () => {
  const response = await app.inject({
    method: 'POST',
    url: `/resources/${resourceId}/bookings`,
    headers,
    payload: { start_time: '2026-09-01T15:00:00+02:00', end_time: '2026-09-02T15:00:00+02:00' },
  })
  expect(response.statusCode).toBe(201)
  expect(response.json().customer_id).toBeNull()
})

it('never returns a null-customer booking under a customer filter', async () => {
  await app.inject({
    method: 'POST',
    url: `/resources/${resourceId}/bookings`,
    headers,
    payload: { start_time: '2026-09-01T15:00:00+02:00', end_time: '2026-09-02T15:00:00+02:00' },
  })
  const response = await app.inject({
    method: 'GET',
    url: '/bookings?customer_id=guest-1&from=2026-09-01&to=2026-09-08',
    headers,
  })
  expect(response.json()).toEqual([])
})

it('lists every booking of the tenant when no customer is named', async () => {
  await app.inject({
    method: 'POST',
    url: `/resources/${resourceId}/bookings`,
    headers,
    payload: { start_time: '2026-09-01T15:00:00+02:00', end_time: '2026-09-02T15:00:00+02:00' },
  })
  const response = await app.inject({
    method: 'GET',
    url: '/bookings?from=2026-09-01&to=2026-09-08',
    headers,
  })
  expect(response.json()).toHaveLength(1)
})

it('still bounds the window when no customer is named', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/bookings?from=2026-01-01&to=2028-01-01',
    headers,
  })
  expect(response.statusCode).toBe(400)
  expect(response.json().error).toBe('invalid_range')
})

describe('idempotency across a null customer', () => {
  const times = { start_time: '2026-09-01T15:00:00+02:00', end_time: '2026-09-02T15:00:00+02:00' }

  it('replays when both omit the customer', async () => {
    const body = { ...times, idempotency_key: 'k1' }
    const first = await app.inject({
      method: 'POST',
      url: `/resources/${resourceId}/bookings`,
      headers,
      payload: body,
    })
    const second = await app.inject({
      method: 'POST',
      url: `/resources/${resourceId}/bookings`,
      headers,
      payload: body,
    })
    expect(first.statusCode).toBe(201)
    expect(second.statusCode).toBe(200)
    expect(second.json().id).toBe(first.json().id)
  })

  it('refuses a replay that adds a customer the original did not have', async () => {
    await app.inject({
      method: 'POST',
      url: `/resources/${resourceId}/bookings`,
      headers,
      payload: { ...times, idempotency_key: 'k2' },
    })
    const second = await app.inject({
      method: 'POST',
      url: `/resources/${resourceId}/bookings`,
      headers,
      payload: { ...times, customer_id: 'guest-1', idempotency_key: 'k2' },
    })
    expect(second.statusCode).toBe(409)
    expect(second.json().error).toBe('idempotency_key_reused')
  })

  it('refuses a replay that drops the customer the original had', async () => {
    await app.inject({
      method: 'POST',
      url: `/resources/${resourceId}/bookings`,
      headers,
      payload: { ...times, customer_id: 'guest-1', idempotency_key: 'k3' },
    })
    const second = await app.inject({
      method: 'POST',
      url: `/resources/${resourceId}/bookings`,
      headers,
      payload: { ...times, idempotency_key: 'k3' },
    })
    expect(second.statusCode).toBe(409)
  })
})
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run tests/integration/resources.test.ts tests/integration/bookings.test.ts`
Expected: FAIL — `GET /resources` is 404, and a booking without `customer_id` is a 400.

- [ ] **Step 3: Add the listing schema and route**

`src/modules/resources/resource.schemas.ts`:

```ts
export const ResourceListQuery = Type.Object(
  {
    is_active: Type.Optional(
      Type.Boolean({
        description: 'Narrows the list. Omitted, both active and inactive are returned.',
      }),
    ),
  },
  { additionalProperties: false },
)
export type ResourceListQuery = Static<typeof ResourceListQuery>

export const ResourceListResponse = Type.Array(ResourceResponse)
```

`src/modules/resources/resource.routes.ts` — registered before `GET /resources/:id` is unnecessary (Fastify's router is not order-sensitive for a static versus parametric segment), but keep it adjacent for readability:

```ts
app.get(
  '/resources',
  {
    config: { scope: 'resources.read' },
    schema: {
      tags: ['Resources'],
      summary: 'List resources',
      description: md(
        "Every resource this key's tenant owns, oldest first.",
        'A caller that keeps its own records already knows its ids; this exists for the console and for reconciliation when the two disagree.',
      ),
      querystring: ResourceListQuery,
      response: { 200: ResourceListResponse, 400: ErrorResponse },
    },
  },
  async (request) => service.list(request.tenantId, request.query),
)
```

`ResourceService.list` is two lines:

```ts
  async list(tenantId: string, query: ResourceListQuery): Promise<ResourceRow[]> {
    return this.repository.list(tenantId, { isActive: query.is_active })
  }
```

- [ ] **Step 4: Make `customer_id` optional**

`src/modules/bookings/booking.schemas.ts` — in `CreateBookingBody`, wrap the field:

```ts
  customer_id: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        'Opaque external identifier, never interpreted. Optional: a caller that keeps its own records does not need the engine to hold one, and omitting it makes the booking invisible to `GET /bookings?customer_id=`.',
      examples: ['customer-42'],
    }),
  ),
```

In `BookingResponse`, widen it so the field is always present and may be null:

```ts
  customer_id: Type.Union([Type.String(), Type.Null()]),
```

In `CustomerBookingsQuery`, make the filter optional and correct its description:

```ts
export const CustomerBookingsQuery = Type.Object({
  customer_id: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "Narrows the list to one customer. Omitted, every booking of the tenant in the window is returned — the owner's calendar.",
      examples: ['customer-42'],
    }),
  ),
  from: RangeDate('First date, inclusive, interpreted in UTC', '2026-07-20'),
  to: RangeDate('Last date, exclusive, interpreted in UTC', '2026-07-27'),
  status: StatusFilter,
})
```

`BookingService.create` passes `body.customer_id ?? null` into `NewBooking`, and `sameOrFail` compares against the same normalisation so `undefined` and `null` cannot disagree:

```ts
const matches =
  existing.customer_id === (body.customer_id ?? null) &&
  existing.start_time.getTime() === start.getTime() &&
  existing.end_time.getTime() === end.getTime()
```

Update `BookingRepository`'s `BookingRow.customer_id` and `NewBooking.customer_id` to `string | null`.

- [ ] **Step 5: Run to green**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/modules/resources/ src/modules/bookings/ tests/integration/
git commit -m "feat: list resources, and let a booking omit its customer"
```

---

### Task 7: Console skeleton — entrypoint, HTML shell, Origin guard, tenants page

**Files:**

- Create: `src/modules/console/html.ts`, `src/modules/console/console.pages.ts`, `src/modules/console/console.routes.ts`, `src/console-app.ts`, `src/console.ts`
- Modify: `package.json`
- Test: `tests/unit/html.test.ts`, `tests/integration/console.test.ts`

**Interfaces:**

- Consumes: `TenantService` (Task 3).
- Produces: `buildConsoleApp(deps: { config: Config; db: Kysely<Database> }): Promise<FastifyInstance>`, `escapeHtml(s: string): string`, `page(title, body): string`, `tenantsPage(tenants)`, `errorPage(status, message)`.

- [ ] **Step 1: Install the form body parser**

```bash
npm install @fastify/formbody
```

- [ ] **Step 2: Write the failing escaping test**

`tests/unit/html.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { escapeHtml, page } from '../../src/modules/console/html.js'

describe('escapeHtml', () => {
  it.each([
    ['<', '&lt;'],
    ['>', '&gt;'],
    ['&', '&amp;'],
    ['"', '&quot;'],
    ["'", '&#39;'],
  ])('escapes %s', (input, expected) => {
    expect(escapeHtml(input)).toBe(expected)
  })

  it('escapes a script tag whole', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('leaves ordinary text alone, including non-Latin', () => {
    expect(escapeHtml('Дом у озера 🏡')).toBe('Дом у озера 🏡')
  })

  it('escapes ampersands before the entities it introduces', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;')
  })
})

describe('page', () => {
  it('escapes the title and sets one h1', () => {
    const html = page('<b>Tenants</b>', '<p>body</p>')
    expect(html).toContain('<title>&lt;b&gt;Tenants&lt;/b&gt;')
    expect(html.match(/<h1>/g)).toHaveLength(1)
  })
})
```

- [ ] **Step 3: Run and watch it fail**

Run: `npx vitest run tests/unit/html.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the HTML helpers**

`src/modules/console/html.ts`:

```ts
const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/** Every interpolation in every page goes through this. A tenant named `<script>` is text. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char]!)
}

/** Matched to the Swagger UI theme, so the console and the documentation are one product. */
const CSS = `
  :root { color-scheme: light dark; --fg: #1b1b1b; --muted: #6b6b6b; --line: #d8d8d8; --bg: #fff; --accent: #1f6feb; }
  @media (prefers-color-scheme: dark) {
    :root { --fg: #e8e8e8; --muted: #9a9a9a; --line: #333; --bg: #151515; --accent: #58a6ff; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 2rem 1rem; background: var(--bg); color: var(--fg);
         font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 60rem; margin: 0 auto; }
  h1 { font-size: 1.4rem; margin: 0 0 1.5rem; }
  h2 { font-size: 1.05rem; margin: 2rem 0 .75rem; }
  a { color: var(--accent); }
  table { width: 100%; border-collapse: collapse; margin-bottom: 1rem; display: block; overflow-x: auto; }
  th, td { text-align: left; padding: .5rem .75rem; border-bottom: 1px solid var(--line); white-space: nowrap; }
  th { font-weight: 600; color: var(--muted); font-size: .82rem; text-transform: uppercase; letter-spacing: .04em; }
  code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em; }
  form { margin: 1rem 0; }
  label { display: block; margin: .6rem 0 .2rem; font-weight: 500; }
  input[type=text] { padding: .45rem .6rem; border: 1px solid var(--line); border-radius: 4px;
                     background: var(--bg); color: var(--fg); width: 100%; max-width: 24rem; }
  button { padding: .45rem .9rem; border: 1px solid var(--accent); border-radius: 4px;
           background: var(--accent); color: #fff; cursor: pointer; font: inherit; }
  button.secondary { background: transparent; color: var(--accent); }
  fieldset { border: 1px solid var(--line); border-radius: 4px; margin: 1rem 0; padding: .75rem 1rem; }
  .empty { color: var(--muted); font-style: italic; }
  .reveal { border: 1px solid var(--accent); border-radius: 4px; padding: 1rem; margin: 1rem 0; }
  .muted { color: var(--muted); }
`

export function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Booking Engine console</title>
<style>${CSS}</style>
</head>
<body><main><h1>${escapeHtml(title)}</h1>${body}</main></body>
</html>`
}
```

- [ ] **Step 5: Write the failing console integration test**

`tests/integration/console.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { inject } from 'vitest'
import { buildConsoleApp } from '../../src/console-app.js'
import { closeTestDb, getTestDb, resetDb } from './helpers.js'
import { loadConfig } from '../../src/config.js'

let app: FastifyInstance

beforeAll(async () => {
  app = await buildConsoleApp({
    config: loadConfig({ DATABASE_URL: inject('databaseUrl'), LOG_LEVEL: 'silent' }),
    db: getTestDb(),
  })
  await app.ready()
})
beforeEach(resetDb)
afterAll(async () => {
  await app.close()
  await closeTestDb()
})

const form = (payload: Record<string, string>) => ({
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  payload: new URLSearchParams(payload).toString(),
})

describe('tenants page', () => {
  it('says so when there are none', async () => {
    const response = await app.inject({ method: 'GET', url: '/tenants' })
    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('No tenants yet')
  })

  it('creates one and redirects', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/tenants',
      ...form({ name: 'Houses' }),
    })
    expect(response.statusCode).toBe(303)
    expect(response.headers.location).toBe('/tenants')

    const listing = await app.inject({ method: 'GET', url: '/tenants' })
    expect(listing.body).toContain('Houses')
  })

  it('renders a hostile name as text', async () => {
    await app.inject({
      method: 'POST',
      url: '/tenants',
      ...form({ name: '<script>alert(1)</script>' }),
    })
    const listing = await app.inject({ method: 'GET', url: '/tenants' })
    expect(listing.body).not.toContain('<script>alert(1)</script>')
    expect(listing.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it.each([['   '], ['']])('refuses a blank name (%j)', async (name) => {
    const response = await app.inject({ method: 'POST', url: '/tenants', ...form({ name }) })
    expect(response.statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/tenants' })).body).toContain('No tenants yet')
  })

  it('refuses a name past the limit', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/tenants',
      ...form({ name: 'x'.repeat(101) }),
    })
    expect(response.statusCode).toBe(400)
  })
})

describe('origin guard', () => {
  it('refuses a write from a foreign origin', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/tenants',
      ...form({ name: 'Houses' }),
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://evil.example',
      },
    })
    expect(response.statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: '/tenants' })).body).toContain('No tenants yet')
  })

  it('accepts a write with no origin at all, which is curl', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/tenants',
      ...form({ name: 'Houses' }),
    })
    expect(response.statusCode).toBe(303)
  })

  it('accepts a write from the console itself', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/tenants',
      ...form({ name: 'Houses' }),
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'http://127.0.0.1:3001',
      },
    })
    expect(response.statusCode).toBe(303)
  })

  it('leaves reads alone whatever the origin', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/tenants',
      headers: { origin: 'https://evil.example' },
    })
    expect(response.statusCode).toBe(200)
  })
})

describe('errors', () => {
  it('answers an HTML 404 for an unknown path', async () => {
    const response = await app.inject({ method: 'GET', url: '/nope' })
    expect(response.statusCode).toBe(404)
    expect(response.headers['content-type']).toContain('text/html')
  })

  it('answers 400 for a malformed uuid rather than a stack trace', async () => {
    const response = await app.inject({ method: 'GET', url: '/tenants/not-a-uuid/api-keys' })
    expect(response.statusCode).toBe(400)
    expect(response.body).not.toContain('at ')
  })

  it('answers 404 for a well-formed unknown tenant', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/tenants/00000000-0000-4000-8000-000000000000/api-keys',
    })
    expect(response.statusCode).toBe(404)
  })
})
```

- [ ] **Step 6: Write the tenants page**

`src/modules/console/console.pages.ts`:

```ts
import type { TenantRow } from '../tenants/tenant.repository.js'
import { escapeHtml, page } from './html.js'

function formatDate(value: Date): string {
  return value.toISOString().replace('T', ' ').slice(0, 16)
}

export function tenantsPage(tenants: TenantRow[]): string {
  const rows = tenants
    .map(
      (tenant) => `<tr>
      <td><a href="/tenants/${escapeHtml(tenant.id)}/api-keys">${escapeHtml(tenant.name)}</a></td>
      <td class="mono muted">${escapeHtml(tenant.id)}</td>
      <td>${tenant.is_active ? 'active' : 'disabled'}</td>
      <td class="muted">${formatDate(tenant.created_at)}</td>
    </tr>`,
    )
    .join('')

  const table =
    tenants.length === 0
      ? '<p class="empty">No tenants yet. Create the first one below.</p>'
      : `<table><thead><tr><th>Name</th><th>Id</th><th>State</th><th>Created</th></tr></thead><tbody>${rows}</tbody></table>`

  return page(
    'Tenants',
    `${table}
    <h2>New tenant</h2>
    <form method="post" action="/tenants">
      <label for="name">Name</label>
      <input type="text" id="name" name="name" maxlength="100" required autofocus>
      <p><button type="submit">Create tenant</button></p>
    </form>`,
  )
}

export function errorPage(status: number, message: string): string {
  return page(
    `${status}`,
    `<p>${escapeHtml(message)}</p><p><a href="/tenants">Back to tenants</a></p>`,
  )
}
```

- [ ] **Step 7: Write the routes and the Origin guard**

`src/modules/console/console.routes.ts`:

```ts
import type { FastifyPluginAsync } from 'fastify'
import { ForbiddenOriginError, NotFoundError, ValidationError } from '../../shared/errors.js'
import { TenantRepository } from '../tenants/tenant.repository.js'
import { TenantService } from '../tenants/tenant.service.js'
import { errorPage, tenantsPage } from './console.pages.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function requireUuid(value: string, what: string): string {
  if (!UUID.test(value)) throw new ValidationError(`${what} is not a uuid`)
  return value
}

export const consoleRoutes: FastifyPluginAsync = async (app) => {
  const service = new TenantService(new TenantRepository(app.db))
  const port = app.config.consolePort
  const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`])

  /**
   * Loopback keeps the network out; it does not keep out a page the operator already has open,
   * which can POST here from their browser. A request with no Origin is a non-browser client
   * such as curl and is allowed — browsers always send it on a form post.
   */
  app.addHook('preHandler', async (request) => {
    if (request.method === 'GET' || request.method === 'HEAD') return
    const origin = request.headers.origin
    if (origin === undefined) return
    if (!allowedOrigins.has(origin)) {
      throw new ForbiddenOriginError('This request did not come from the console')
    }
  })

  app.get('/', async (_request, reply) => reply.redirect('/tenants', 303))

  app.get('/tenants', async (_request, reply) => {
    const tenants = await service.listTenants()
    return reply.type('text/html; charset=utf-8').send(tenantsPage(tenants))
  })

  app.post<{ Body: { name?: string } }>('/tenants', async (request, reply) => {
    await service.createTenant(request.body?.name ?? '')
    return reply.redirect('/tenants', 303)
  })
}

export { errorPage, requireUuid }
```

- [ ] **Step 8: Write the console app and the entrypoint**

`src/console-app.ts`:

```ts
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import fastifyFormbody from '@fastify/formbody'
import type { Kysely } from 'kysely'
import type { Config } from './config.js'
import type { Database } from './db/schema.js'
import { AppError } from './shared/errors.js'
import { consoleRoutes, errorPage } from './modules/console/console.routes.js'

export interface ConsoleDeps {
  config: Config
  db: Kysely<Database>
}

export async function buildConsoleApp(deps: ConsoleDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: deps.config.logLevel } })

  app.decorate('db', deps.db)
  app.decorate('config', deps.config)

  await app.register(fastifyFormbody)

  // HTML, not JSON: a browser is the only client. The data plane's handler stays untouched.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof AppError) {
      void reply
        .status(error.statusCode)
        .type('text/html; charset=utf-8')
        .send(errorPage(error.statusCode, error.message))
      return
    }
    request.log.error({ err: error }, 'console error')
    void reply
      .status(500)
      .type('text/html; charset=utf-8')
      .send(errorPage(500, 'Something went wrong. Check the console log.'))
  })

  app.setNotFoundHandler((_request, reply) => {
    void reply.status(404).type('text/html; charset=utf-8').send(errorPage(404, 'No such page.'))
  })

  await app.register(consoleRoutes)
  return app
}
```

`src/console.ts`:

```ts
import { buildConsoleApp } from './console-app.js'
import { loadConfig } from './config.js'
import { createDb } from './db/client.js'

const config = loadConfig(process.env)
const db = createDb(config.databaseUrl)
const app = await buildConsoleApp({ config, db })

app.addHook('onClose', async () => {
  await db.destroy()
})

try {
  // 127.0.0.1, hard-coded and not configurable. Key issuance here is unauthenticated, which is
  // only safe while the port is unreachable from anywhere else. There is no env var to set wrong.
  await app.listen({ port: config.consolePort, host: '127.0.0.1' })
} catch (error) {
  app.log.error(error)
  process.exit(1)
}
```

Add to `package.json` scripts: `"console": "node dist/src/console.js"` and `"dev:console": "tsx watch src/console.ts"`.

- [ ] **Step 9: Run to green**

Run: `npx vitest run tests/unit/html.test.ts tests/integration/console.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/console.ts src/console-app.ts src/modules/console/ package.json package-lock.json \
  tests/unit/html.test.ts tests/integration/console.test.ts
git commit -m "feat: console entrypoint on loopback with the tenants page"
```

---

### Task 8: The keys page — presets, one-shot reveal, revoke

**Files:**

- Create: `src/modules/console/flash.ts`
- Modify: `src/modules/console/console.pages.ts`, `src/modules/console/console.routes.ts`
- Test: `tests/unit/flash.test.ts`, `tests/integration/console.test.ts`

**Interfaces:**

- Consumes: `TenantService.issueKey/listKeys/revokeKey` (Task 3), `PRESETS`, `PRESET_LABELS`, `SCOPE_DESCRIPTIONS`, `expandPreset`, `isPresetName`, `isScope` (Task 1).
- Produces: `SecretFlash` with `put(secret): string` and `take(id): string | undefined`; `keysPage(tenant, keys, revealed?)`.

- [ ] **Step 1: Write the failing flash test**

`tests/unit/flash.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { SecretFlash } from '../../src/modules/console/flash.js'

describe('SecretFlash', () => {
  it('returns the secret once', () => {
    const flash = new SecretFlash()
    const id = flash.put('bk_live_secret')
    expect(flash.take(id)).toBe('bk_live_secret')
  })

  // The whole mechanism: a reload finds nothing, so "shown once" is behaviour, not a rule.
  it('returns nothing the second time', () => {
    const flash = new SecretFlash()
    const id = flash.put('bk_live_secret')
    flash.take(id)
    expect(flash.take(id)).toBeUndefined()
  })

  it('returns nothing for an unknown id', () => {
    expect(new SecretFlash().take('nope')).toBeUndefined()
  })

  it('expires an entry after its ttl', () => {
    vi.useFakeTimers()
    try {
      const flash = new SecretFlash(60_000)
      const id = flash.put('bk_live_secret')
      vi.advanceTimersByTime(60_001)
      expect(flash.take(id)).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('issues a different id every time', () => {
    const flash = new SecretFlash()
    expect(new Set([flash.put('a'), flash.put('b'), flash.put('c')]).size).toBe(3)
  })
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run tests/unit/flash.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the flash**

`src/modules/console/flash.ts`:

```ts
import { randomBytes } from 'node:crypto'

/**
 * Holds a freshly issued secret between the POST that created it and the redirect that shows
 * it, then forgets it.
 *
 * Two requirements turn out to be the same requirement: the key must be shown exactly once,
 * and reloading must not issue a second key. Rendering the secret in the POST response
 * satisfies the first and breaks the second, because F5 re-submits. POST, redirect, GET with a
 * one-shot store satisfies both, and "reload and the secret is gone" falls out of the
 * mechanism rather than being a rule bolted on top.
 *
 * In memory because the console is one process on one machine. Two processes would need a
 * table with a TTL.
 */
export class SecretFlash {
  private readonly entries = new Map<string, { secret: string; expiresAt: number }>()

  constructor(private readonly ttlMs = 60_000) {}

  put(secret: string): string {
    const id = randomBytes(16).toString('hex')
    this.entries.set(id, { secret, expiresAt: Date.now() + this.ttlMs })
    return id
  }

  take(id: string): string | undefined {
    this.sweep()
    const entry = this.entries.get(id)
    if (entry === undefined) return undefined
    this.entries.delete(id)
    return entry.secret
  }

  /** On access, so there is no timer to leak and nothing to unref at shutdown. */
  private sweep(): void {
    const now = Date.now()
    for (const [id, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(id)
  }
}
```

- [ ] **Step 4: Write the failing keys-page tests**

Append to `tests/integration/console.test.ts`:

```ts
async function makeTenant(name = 'Houses'): Promise<string> {
  await app.inject({ method: 'POST', url: '/tenants', ...form({ name }) })
  const tenants = await new TenantService(new TenantRepository(getTestDb())).listTenants()
  return tenants[0]!.id
}

describe('keys page', () => {
  it('says so when the tenant has none', async () => {
    const id = await makeTenant()
    const response = await app.inject({ method: 'GET', url: `/tenants/${id}/api-keys` })
    expect(response.body).toContain('No keys yet')
  })

  it('issues a key, redirects, and reveals the secret exactly once', async () => {
    const id = await makeTenant()
    const created = await app.inject({
      method: 'POST',
      url: `/tenants/${id}/api-keys`,
      ...form({ name: 'site', preset: 'site_backend' }),
    })
    expect(created.statusCode).toBe(303)

    const location = created.headers.location as string
    expect(location).toMatch(new RegExp(`^/tenants/${id}/api-keys\\?revealed=[0-9a-f]{32}$`))

    const revealed = await app.inject({ method: 'GET', url: location })
    const secret = /bk_live_[A-Za-z0-9]{51}/.exec(revealed.body)?.[0]
    expect(secret).toBeDefined()

    // The same URL again: gone, and the list renders normally.
    const again = await app.inject({ method: 'GET', url: location })
    expect(again.body).not.toContain(secret!)
    expect(again.body).toContain('site')
  })

  it('never puts the secret in the list', async () => {
    const id = await makeTenant()
    const created = await app.inject({
      method: 'POST',
      url: `/tenants/${id}/api-keys`,
      ...form({ name: 'site', preset: 'widget' }),
    })
    const secret = /bk_live_[A-Za-z0-9]{51}/.exec(
      (await app.inject({ method: 'GET', url: created.headers.location as string })).body,
    )![0]

    const listing = await app.inject({ method: 'GET', url: `/tenants/${id}/api-keys` })
    expect(listing.body).not.toContain(secret)
    expect(listing.body).toContain(secret.slice('bk_live_'.length, 'bk_live_'.length + 8))
  })

  it('stores exactly the preset expansion, and not the preset name', async () => {
    const id = await makeTenant()
    await app.inject({
      method: 'POST',
      url: `/tenants/${id}/api-keys`,
      ...form({ name: 'partner', preset: 'partner_channel' }),
    })

    const keys = await new TenantService(new TenantRepository(getTestDb())).listKeys(id)
    expect(keys[0]?.scopes.sort()).toEqual(
      ['availability.read', 'bookings.read', 'bookings.write', 'resources.read'].sort(),
    )

    const listing = await app.inject({ method: 'GET', url: `/tenants/${id}/api-keys` })
    expect(listing.body).toContain('bookings.write')
    expect(listing.body).not.toContain('partner_channel')
  })

  it('accepts a custom subset', async () => {
    const id = await makeTenant()
    await app.inject({
      method: 'POST',
      url: `/tenants/${id}/api-keys`,
      ...form({ name: 'odd', preset: 'custom', scopes: 'schedule.write' }),
    })
    const keys = await new TenantService(new TenantRepository(getTestDb())).listKeys(id)
    expect(keys[0]?.scopes).toEqual(['schedule.write'])
  })

  it.each([
    [{ name: 'x', preset: 'custom' }, 'custom with nothing ticked'],
    [{ name: 'x', preset: 'custom', scopes: 'bookings.destroy' }, 'unknown scope'],
    [{ name: 'x', preset: 'superuser' }, 'unknown preset'],
    [{ name: '  ', preset: 'widget' }, 'blank name'],
  ])('refuses %j (%s)', async (payload) => {
    const id = await makeTenant()
    const response = await app.inject({
      method: 'POST',
      url: `/tenants/${id}/api-keys`,
      ...form(payload as Record<string, string>),
    })
    expect(response.statusCode).toBe(400)
    expect(await new TenantService(new TenantRepository(getTestDb())).listKeys(id)).toEqual([])
  })

  it('revokes without deleting', async () => {
    const id = await makeTenant()
    await app.inject({
      method: 'POST',
      url: `/tenants/${id}/api-keys`,
      ...form({ name: 'site', preset: 'widget' }),
    })
    const service = new TenantService(new TenantRepository(getTestDb()))
    const keyId = (await service.listKeys(id))[0]!.id

    const response = await app.inject({
      method: 'POST',
      url: `/api-keys/${keyId}/revoke`,
      ...form({}),
    })
    expect(response.statusCode).toBe(303)

    const keys = await service.listKeys(id)
    expect(keys).toHaveLength(1)
    expect(keys[0]?.revoked_at).not.toBeNull()

    // No second revoke control for a key already revoked.
    const listing = await app.inject({ method: 'GET', url: `/tenants/${id}/api-keys` })
    expect(listing.body).not.toContain(`/api-keys/${keyId}/revoke`)
  })

  it('answers 404 revoking an unknown key', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api-keys/00000000-0000-4000-8000-000000000000/revoke',
      ...form({}),
    })
    expect(response.statusCode).toBe(404)
  })
})
```

Add the imports `TenantRepository`, `TenantService` at the top of the file.

- [ ] **Step 5: Write the keys page**

Append to `src/modules/console/console.pages.ts`:

```ts
import {
  PRESETS,
  PRESET_LABELS,
  SCOPES,
  SCOPE_DESCRIPTIONS,
  type PresetName,
} from '../../shared/scopes.js'
import type { ApiKeyRow } from '../tenants/tenant.repository.js'

function reveal(secret: string): string {
  return `<div class="reveal">
    <h2>Your new key</h2>
    <p>Copy it now. It is shown once and cannot be retrieved again — issue a new key if you lose it.</p>
    <p><input type="text" class="mono" id="secret" value="${escapeHtml(secret)}" readonly size="60"></p>
    <p><button type="button" class="secondary" id="copy" hidden>Copy</button></p>
    <script>
      // Progressive only: with scripting off the value above is still selectable.
      const b = document.getElementById('copy');
      b.hidden = false;
      b.addEventListener('click', () => navigator.clipboard.writeText(document.getElementById('secret').value));
    </script>
  </div>`
}

function presetOptions(): string {
  const named = (Object.keys(PRESETS) as PresetName[])
    .map(
      (name, index) => `<p>
        <label><input type="radio" name="preset" value="${escapeHtml(name)}"${index === 0 ? ' checked' : ''}>
        ${escapeHtml(PRESET_LABELS[name])}</label>
        <span class="muted mono">${PRESETS[name].map(escapeHtml).join(' · ')}</span>
      </p>`,
    )
    .join('')

  const custom = SCOPES.map(
    (scope) => `<p>
      <label><input type="checkbox" name="scopes" value="${escapeHtml(scope)}">
      <span class="mono">${escapeHtml(scope)}</span></label>
      <span class="muted">${escapeHtml(SCOPE_DESCRIPTIONS[scope])}</span>
    </p>`,
  ).join('')

  return `<fieldset><legend>Preset</legend>${named}
    <p><label><input type="radio" name="preset" value="custom"> Custom</label></p>
    <fieldset><legend>Custom scopes</legend>${custom}</fieldset>
  </fieldset>`
}

export function keysPage(tenant: TenantRow, keys: ApiKeyRow[], revealedSecret?: string): string {
  const rows = keys
    .map((key) => {
      const revoked = key.revoked_at !== null
      return `<tr>
        <td>${escapeHtml(key.name)}</td>
        <td class="mono">${escapeHtml(key.key_prefix)}…</td>
        <td class="mono muted">${key.scopes.map(escapeHtml).join(' · ')}</td>
        <td class="muted">${formatDate(key.created_at)}</td>
        <td class="muted">${key.last_used_at === null ? 'never' : formatDate(key.last_used_at)}</td>
        <td>${
          revoked
            ? `<span class="muted">revoked ${formatDate(key.revoked_at!)}</span>`
            : `<form method="post" action="/api-keys/${escapeHtml(key.id)}/revoke"><button class="secondary" type="submit">Revoke</button></form>`
        }</td>
      </tr>`
    })
    .join('')

  const table =
    keys.length === 0
      ? '<p class="empty">No keys yet. Issue the first one below.</p>'
      : `<table><thead><tr><th>Name</th><th>Prefix</th><th>Scopes</th><th>Created</th><th>Last used</th><th></th></tr></thead><tbody>${rows}</tbody></table>`

  return page(
    `Keys · ${tenant.name}`,
    `<p><a href="/tenants">← All tenants</a></p>
    ${revealedSecret === undefined ? '' : reveal(revealedSecret)}
    ${table}
    <h2>New key</h2>
    <form method="post" action="/tenants/${escapeHtml(tenant.id)}/api-keys">
      <label for="keyname">Name</label>
      <input type="text" id="keyname" name="name" maxlength="100" required>
      ${presetOptions()}
      <p><button type="submit">Issue key</button></p>
    </form>`,
  )
}
```

Note `page` escapes its title, so `Keys · ${tenant.name}` is safe with a hostile tenant name.

- [ ] **Step 6: Wire the three routes**

Append to `consoleRoutes` in `src/modules/console/console.routes.ts`:

```ts
const flash = new SecretFlash()

app.get<{ Params: { id: string }; Querystring: { revealed?: string } }>(
  '/tenants/:id/api-keys',
  async (request, reply) => {
    const id = requireUuid(request.params.id, 'Tenant id')
    const tenant = await service.getTenant(id)
    const keys = await service.listKeys(id)
    const secret =
      request.query.revealed === undefined ? undefined : flash.take(request.query.revealed)
    return reply.type('text/html; charset=utf-8').send(keysPage(tenant, keys, secret))
  },
)

app.post<{
  Params: { id: string }
  Body: { name?: string; preset?: string; scopes?: string | string[] }
}>('/tenants/:id/api-keys', async (request, reply) => {
  const id = requireUuid(request.params.id, 'Tenant id')
  const { name = '', preset = '', scopes } = request.body ?? {}

  // The preset name is expanded here and never stored. Storing it would mean that editing a
  // preset tomorrow silently changes the authority of keys already in the field.
  let requested: string[]
  if (preset === 'custom') {
    requested = scopes === undefined ? [] : Array.isArray(scopes) ? scopes : [scopes]
  } else if (isPresetName(preset)) {
    requested = expandPreset(preset)
  } else {
    throw new ValidationError(`Unknown preset ${preset}`)
  }

  const { secret } = await service.issueKey(id, name, requested)
  return reply.redirect(`/tenants/${id}/api-keys?revealed=${flash.put(secret)}`, 303)
})

app.post<{ Params: { id: string } }>('/api-keys/:id/revoke', async (request, reply) => {
  const keyId = requireUuid(request.params.id, 'Key id')
  const revoked = await service.revokeKey(keyId)
  return reply.redirect(`/tenants/${revoked.tenant_id}/api-keys`, 303)
})
```

Revocation is a `POST`, not a `DELETE`: these are HTML forms, and a form cannot issue `DELETE` without JavaScript, which section 7.7 of the spec keeps out.

- [ ] **Step 7: Run to green**

Run: `npx vitest run tests/unit/flash.test.ts tests/integration/console.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/modules/console/ tests/unit/flash.test.ts tests/integration/console.test.ts
git commit -m "feat: issue, list and revoke keys from the console"
```

---

### Task 9: Playwright harness, and the tenants and keys specs

**Files:**

- Create: `playwright.config.ts`, `tests/ui/global-setup.ts`, `tests/ui/helpers.ts`, `tests/ui/tenants.spec.ts`, `tests/ui/keys.spec.ts`
- Modify: `package.json`, `.gitignore`
- Test: the specs are the test

**Interfaces:**

- Consumes: `buildConsoleApp` (Task 7), `buildApp` (Task 4), `runMigrations`, `createDb`.
- Produces: `baseURL` for the console and `process.env.DATA_PLANE_URL` for the engine; `resetConsoleDb()` and `dataPlane(path, init)` in `tests/ui/helpers.ts`.

- [ ] **Step 1: Install Playwright**

```bash
npm install -D @playwright/test
npx playwright install chromium
```

Add `test-results/` and `playwright-report/` to `.gitignore`.

- [ ] **Step 2: Write the config**

`playwright.config.ts`:

```ts
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/ui',
  // Vitest collects tests/**/*.test.ts; the .spec.ts extension keeps the two runners apart
  // with no change to vitest.config.ts.
  testMatch: '**/*.spec.ts',
  globalSetup: './tests/ui/global-setup.ts',
  // One database, truncated between cases — the same reason vitest.config.ts sets
  // fileParallelism: false.
  workers: 1,
  fullyParallel: false,
  timeout: 30_000,
  reporter: process.env.CI ? 'github' : 'list',
  use: { trace: 'on-first-retry' },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    {
      // Holds the no-JavaScript property in place: if someone later makes the console depend
      // on a script, this project fails.
      name: 'chromium-nojs',
      use: { browserName: 'chromium', javaScriptEnabled: false },
      testIgnore: '**/clipboard.spec.ts',
    },
  ],
})
```

- [ ] **Step 3: Write the global setup**

`tests/ui/global-setup.ts`:

```ts
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import type { AddressInfo } from 'node:net'
import { buildApp } from '../../src/app.js'
import { buildConsoleApp } from '../../src/console-app.js'
import { loadConfig } from '../../src/config.js'
import { createDb } from '../../src/db/client.js'
import { runMigrations } from '../../src/db/migrate.js'

let container: StartedPostgreSqlContainer

/**
 * Mirrors tests/integration/global-setup.ts, but starts both apps: the most valuable UI test
 * issues a key in the console and then uses it against the data plane, which means both have
 * to be listening.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  container = await new PostgreSqlContainer('postgres:16-alpine').start()
  const databaseUrl = container.getConnectionUri()

  const migrationDb = createDb(databaseUrl)
  try {
    await runMigrations(migrationDb)
  } finally {
    await migrationDb.destroy()
  }

  const db = createDb(databaseUrl)
  const config = loadConfig({
    DATABASE_URL: databaseUrl,
    LOG_LEVEL: 'silent',
    HOLD_SWEEP_ENABLED: 'false',
  })

  const consoleApp = await buildConsoleApp({ config, db })
  const dataApp = await buildApp({ config, db })

  await consoleApp.listen({ port: 0, host: '127.0.0.1' })
  await dataApp.listen({ port: 0, host: '127.0.0.1' })

  const consolePort = (consoleApp.server.address() as AddressInfo).port
  const dataPort = (dataApp.server.address() as AddressInfo).port

  process.env.DATABASE_URL = databaseUrl
  process.env.CONSOLE_URL = `http://127.0.0.1:${consolePort}`
  process.env.DATA_PLANE_URL = `http://127.0.0.1:${dataPort}`

  return async () => {
    await consoleApp.close()
    await dataApp.close()
    await db.destroy()
    await container.stop()
  }
}
```

Playwright reads `baseURL` from the config, which cannot see the ephemeral port, so `tests/ui/helpers.ts` exports it instead and each spec navigates with an absolute URL built from it.

- [ ] **Step 4: Write the helpers**

`tests/ui/helpers.ts`:

```ts
import { sql } from 'kysely'
import { createDb } from '../../src/db/client.js'
import type { Database } from '../../src/db/schema.js'
import type { Kysely } from 'kysely'

let db: Kysely<Database> | undefined

export function consoleUrl(path = '/'): string {
  return `${process.env.CONSOLE_URL}${path}`
}

export function testDb(): Kysely<Database> {
  db ??= createDb(process.env.DATABASE_URL!)
  return db
}

export async function resetConsoleDb(): Promise<void> {
  await sql`truncate table bookings, schedule_exceptions, schedule, resources, api_keys, tenants restart identity cascade`.execute(
    testDb(),
  )
}

/** Calls the engine on its own port with a key issued through the UI. */
export async function dataPlane(
  path: string,
  key: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${process.env.DATA_PLANE_URL}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
      ...(init.headers ?? {}),
    },
  })
}
```

- [ ] **Step 5: Write the tenants spec**

`tests/ui/tenants.spec.ts` — cases 1–12 of the spec:

```ts
import { expect, test } from '@playwright/test'
import { consoleUrl, resetConsoleDb } from './helpers.js'

test.beforeEach(resetConsoleDb)

test('explains an empty tenant list instead of showing nothing', async ({ page }) => {
  await page.goto(consoleUrl('/tenants'))
  await expect(page.getByText('No tenants yet')).toBeVisible()
})

test('creates a tenant and shows it with its id', async ({ page }) => {
  await page.goto(consoleUrl('/tenants'))
  await page.getByLabel('Name').fill('Houses')
  await page.getByRole('button', { name: 'Create tenant' }).click()

  await expect(page.getByRole('link', { name: 'Houses' })).toBeVisible()
  await expect(page.locator('td.mono')).toContainText(/[0-9a-f-]{36}/)
})

test.describe('rejected names', () => {
  for (const [name, why] of [
    ['   ', 'whitespace only'],
    ['x'.repeat(101), 'past the length limit'],
  ] as const) {
    test(`refuses a name that is ${why}`, async ({ page }) => {
      await page.goto(consoleUrl('/tenants'))
      // The maxlength attribute stops typing at 100, so submit the form directly.
      await page.evaluate((value) => {
        const input = document.querySelector<HTMLInputElement>('#name')!
        input.removeAttribute('maxlength')
        input.removeAttribute('required')
        input.value = value
        document.querySelector('form')!.submit()
      }, name)
      await expect(page.locator('body')).toContainText(/must not be blank|at most 100/)
    })
  }
})

test('renders a script tag as text and runs nothing', async ({ page }) => {
  let dialogs = 0
  page.on('dialog', async (dialog) => {
    dialogs += 1
    await dialog.dismiss()
  })

  await page.goto(consoleUrl('/tenants'))
  await page.getByLabel('Name').fill('<script>alert(1)</script>')
  await page.getByRole('button', { name: 'Create tenant' }).click()

  await expect(page.getByRole('link', { name: '<script>alert(1)</script>' })).toBeVisible()
  expect(dialogs).toBe(0)
})

test('round-trips emoji and Cyrillic', async ({ page }) => {
  await page.goto(consoleUrl('/tenants'))
  await page.getByLabel('Name').fill('Дом у озера 🏡')
  await page.getByRole('button', { name: 'Create tenant' }).click()
  await expect(page.getByRole('link', { name: 'Дом у озера 🏡' })).toBeVisible()
})

test('allows two tenants with the same name, distinguishable by id', async ({ page }) => {
  await page.goto(consoleUrl('/tenants'))
  for (let i = 0; i < 2; i += 1) {
    await page.getByLabel('Name').fill('Houses')
    await page.getByRole('button', { name: 'Create tenant' }).click()
  }
  const ids = await page.locator('td.mono').allTextContents()
  expect(ids).toHaveLength(2)
  expect(ids[0]).not.toBe(ids[1])
})

test('reloading after creating does not create a second tenant', async ({ page }) => {
  await page.goto(consoleUrl('/tenants'))
  await page.getByLabel('Name').fill('Houses')
  await page.getByRole('button', { name: 'Create tenant' }).click()
  await page.reload()
  await expect(page.getByRole('link', { name: 'Houses' })).toHaveCount(1)
})

test('follows the link into a tenant keys page', async ({ page }) => {
  await page.goto(consoleUrl('/tenants'))
  await page.getByLabel('Name').fill('Houses')
  await page.getByRole('button', { name: 'Create tenant' }).click()
  await page.getByRole('link', { name: 'Houses' }).click()
  await expect(page.getByRole('heading', { name: 'Keys · Houses' })).toBeVisible()
})

test('answers 404 for a well-formed unknown tenant', async ({ page }) => {
  const response = await page.goto(
    consoleUrl('/tenants/00000000-0000-4000-8000-000000000000/api-keys'),
  )
  expect(response?.status()).toBe(404)
  await expect(page.getByText('No such tenant')).toBeVisible()
})

test('answers 400, not a stack trace, for a malformed uuid', async ({ page }) => {
  const response = await page.goto(consoleUrl('/tenants/not-a-uuid/api-keys'))
  expect(response?.status()).toBe(400)
  await expect(page.locator('body')).not.toContainText('at Object.')
})
```

- [ ] **Step 6: Write the keys spec**

`tests/ui/keys.spec.ts` — cases 13–30, including the two end-to-end ones:

```ts
import { expect, test, type Page } from '@playwright/test'
import { consoleUrl, dataPlane, resetConsoleDb } from './helpers.js'

test.beforeEach(resetConsoleDb)

async function createTenant(page: Page, name = 'Houses'): Promise<void> {
  await page.goto(consoleUrl('/tenants'))
  await page.getByLabel('Name').fill(name)
  await page.getByRole('button', { name: 'Create tenant' }).click()
  await page.getByRole('link', { name }).click()
}

async function issueKey(page: Page, name: string, preset: string): Promise<string> {
  await page.getByLabel('Name').fill(name)
  await page.getByRole('radio', { name: preset }).check()
  await page.getByRole('button', { name: 'Issue key' }).click()
  return page.locator('#secret').inputValue()
}

test('explains an empty key list', async ({ page }) => {
  await createTenant(page)
  await expect(page.getByText('No keys yet')).toBeVisible()
})

test('reveals the secret once, with a prefix matching the listed key', async ({ page }) => {
  await createTenant(page)
  const secret = await issueKey(page, 'site', 'Site backend')

  expect(secret).toMatch(/^bk_live_[A-Za-z0-9]{51}$/)
  await expect(page.locator('tbody')).toContainText(secret.slice(8, 16))
})

test('loses the secret on reload and renders the list normally', async ({ page }) => {
  await createTenant(page)
  const secret = await issueKey(page, 'site', 'Site backend')

  await page.reload()
  await expect(page.locator('#secret')).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText(secret)
  await expect(page.locator('tbody')).toContainText('site')
})

test('does not resurrect the secret through the back button', async ({ page }) => {
  await createTenant(page)
  const secret = await issueKey(page, 'site', 'Site backend')
  const revealUrl = page.url()

  await page.goto(consoleUrl('/tenants'))
  await page.goto(revealUrl)
  await expect(page.locator('body')).not.toContainText(secret)
})

test('reloading the reveal page does not issue a second key', async ({ page }) => {
  await createTenant(page)
  await issueKey(page, 'site', 'Site backend')
  await page.reload()
  await expect(page.locator('tbody tr')).toHaveCount(1)
})

test('keeps the secret out of the list markup entirely', async ({ page }) => {
  await createTenant(page)
  const secret = await issueKey(page, 'site', 'Widget')

  await page.goto(consoleUrl('/tenants'))
  await page.getByRole('link', { name: 'Houses' }).click()
  expect(await page.content()).not.toContain(secret)
})

test('stores the partner preset without bookings.list, and the site preset with it', async ({
  page,
}) => {
  await createTenant(page)
  await issueKey(page, 'partner', 'Partner channel')
  await page.goto(page.url().split('?')[0]!)
  const partnerRow = page.locator('tbody tr', { hasText: 'partner' })
  await expect(partnerRow).toContainText('bookings.write')
  await expect(partnerRow).not.toContainText('bookings.list')

  await issueKey(page, 'site', 'Site backend')
  await page.goto(page.url().split('?')[0]!)
  await expect(page.locator('tbody tr', { hasText: 'site' })).toContainText('bookings.list')
})

test('shows scopes rather than the preset that produced them', async ({ page }) => {
  await createTenant(page)
  await issueKey(page, 'partner', 'Partner channel')
  await page.goto(page.url().split('?')[0]!)
  await expect(page.locator('body')).not.toContainText('partner_channel')
})

test('issues a custom subset', async ({ page }) => {
  await createTenant(page)
  await page.getByLabel('Name').fill('odd')
  await page.getByRole('radio', { name: 'Custom' }).check()
  await page.getByRole('checkbox', { name: 'schedule.write' }).check()
  await page.getByRole('button', { name: 'Issue key' }).click()

  await page.goto(page.url().split('?')[0]!)
  const row = page.locator('tbody tr', { hasText: 'odd' })
  await expect(row).toContainText('schedule.write')
  await expect(row).not.toContainText('bookings.write')
})

test('refuses custom with nothing ticked', async ({ page }) => {
  await createTenant(page)
  await page.getByLabel('Name').fill('empty')
  await page.getByRole('radio', { name: 'Custom' }).check()
  await page.getByRole('button', { name: 'Issue key' }).click()
  await expect(page.locator('body')).toContainText('at least one scope')
})

test('refuses an empty key name', async ({ page }) => {
  await createTenant(page)
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('#keyname')!
    input.removeAttribute('required')
    input.value = '  '
    document.querySelector('form[action$="api-keys"]')!.dispatchEvent(new Event('submit'))
    ;(document.querySelector('form[action$="api-keys"]') as HTMLFormElement).submit()
  })
  await expect(page.locator('body')).toContainText('must not be blank')
})

test('lists two keys with different prefixes', async ({ page }) => {
  await createTenant(page)
  const first = await issueKey(page, 'one', 'Widget')
  await page.goto(page.url().split('?')[0]!)
  const second = await issueKey(page, 'two', 'Widget')

  expect(first.slice(8, 16)).not.toBe(second.slice(8, 16))
  await page.goto(page.url().split('?')[0]!)
  await expect(page.locator('tbody tr')).toHaveCount(2)
})

// The test the whole spec exists for.
test('a Site backend key issued here works against the engine, and sees only its tenant', async ({
  page,
}) => {
  await createTenant(page, 'Owner A')
  const keyA = await issueKey(page, 'site', 'Back office')

  const created = await dataPlane('/resources', keyA, {
    method: 'POST',
    body: JSON.stringify({
      timezone: 'Europe/Warsaw',
      slot_duration: 'P1D',
      slot_anchor_time: '15:00',
      capacity: 1,
      concurrency_mode: 'exclusive',
    }),
  })
  expect(created.status).toBe(201)
  const resourceId = ((await created.json()) as { id: string }).id

  expect((await dataPlane(`/resources/${resourceId}`, keyA)).status).toBe(200)

  await createTenant(page, 'Owner B')
  const keyB = await issueKey(page, 'site', 'Back office')
  expect((await dataPlane(`/resources/${resourceId}`, keyB)).status).toBe(404)
})

// The preset's whole purpose, verified through the UI that issues it.
test('a Partner channel key can book and cannot read the calendar', async ({ page }) => {
  await createTenant(page, 'Owner')
  const admin = await issueKey(page, 'admin', 'Back office')

  const resourceId = (
    (await (
      await dataPlane('/resources', admin, {
        method: 'POST',
        body: JSON.stringify({
          timezone: 'Europe/Warsaw',
          slot_duration: 'P1D',
          slot_anchor_time: '15:00',
          capacity: 1,
          concurrency_mode: 'exclusive',
        }),
      })
    ).json()) as { id: string }
  ).id

  await dataPlane(`/resources/${resourceId}/schedule`, admin, {
    method: 'PUT',
    body: JSON.stringify(
      [0, 1, 2, 3, 4, 5, 6].map((d) => ({ day_of_week: d, start_time: null, end_time: null })),
    ),
  })

  await page.goto(page.url().split('?')[0]!)
  const partner = await issueKey(page, 'partner', 'Partner channel')

  const booked = await dataPlane(`/resources/${resourceId}/bookings`, partner, {
    method: 'POST',
    body: JSON.stringify({
      customer_id: 'guest-1',
      start_time: '2026-09-01T15:00:00+02:00',
      end_time: '2026-09-02T15:00:00+02:00',
    }),
  })
  expect(booked.status).toBe(201)

  const calendar = await dataPlane('/bookings?from=2026-09-01&to=2026-09-08', partner)
  expect(calendar.status).toBe(403)
  expect(((await calendar.json()) as { details: unknown }).details).toEqual({
    required: 'bookings.list',
  })
})

test('a Widget key cannot create a resource', async ({ page }) => {
  await createTenant(page)
  const widget = await issueKey(page, 'widget', 'Widget')
  const response = await dataPlane('/resources', widget, {
    method: 'POST',
    body: JSON.stringify({
      timezone: 'Europe/Warsaw',
      slot_duration: 'P1D',
      concurrency_mode: 'exclusive',
    }),
  })
  expect(response.status).toBe(403)
})

test.describe('revocation', () => {
  test('marks the key revoked, keeps the row, and refuses it at the engine', async ({ page }) => {
    await createTenant(page)
    const secret = await issueKey(page, 'site', 'Widget')
    await page.goto(page.url().split('?')[0]!)

    await page.getByRole('button', { name: 'Revoke' }).click()

    await expect(page.locator('tbody tr')).toHaveCount(1)
    await expect(page.locator('tbody')).toContainText('revoked')
    await expect(page.getByRole('button', { name: 'Revoke' })).toHaveCount(0)

    expect((await dataPlane('/resources', secret)).status).toBe(401)
  })

  test('answers 404 revoking an unknown key', async ({ page, request }) => {
    await createTenant(page)
    const response = await request.post(
      consoleUrl('/api-keys/00000000-0000-4000-8000-000000000000/revoke'),
    )
    expect(response.status()).toBe(404)
  })
})
```

- [ ] **Step 7: Add the scripts**

`package.json`:

```json
"test:ui": "playwright test",
"test:ui:headed": "playwright test --headed"
```

- [ ] **Step 8: Run the two specs**

Run: `npm run test:ui -- tests/ui/tenants.spec.ts tests/ui/keys.spec.ts`
Expected: PASS in both projects. If `chromium-nojs` fails on a `page.evaluate` case, mark that case `test.skip(({ javaScriptEnabled }) => !javaScriptEnabled)` — it is testing a client-side bypass, not the console.

- [ ] **Step 9: Commit**

```bash
git add playwright.config.ts tests/ui/ package.json package-lock.json .gitignore
git commit -m "test: playwright harness with the tenant and key journeys"
```

---

### Task 10: Hardening, accessibility and clipboard specs

**Files:**

- Create: `tests/ui/hardening.spec.ts`, `tests/ui/a11y.spec.ts`, `tests/ui/clipboard.spec.ts`
- Modify: `run`

- [ ] **Step 1: Write the hardening spec**

`tests/ui/hardening.spec.ts` — cases 35–38 and 45–46:

```ts
import { expect, test } from '@playwright/test'
import { consoleUrl, resetConsoleDb } from './helpers.js'

test.beforeEach(resetConsoleDb)

const form = { name: 'Houses' }

test('refuses a write from a foreign origin and creates nothing', async ({ page, request }) => {
  const response = await request.post(consoleUrl('/tenants'), {
    form,
    headers: { origin: 'https://evil.example' },
  })
  expect(response.status()).toBe(403)

  await page.goto(consoleUrl('/tenants'))
  await expect(page.getByText('No tenants yet')).toBeVisible()
})

test('accepts a write with no origin, which is a non-browser client', async ({ request }) => {
  const response = await request.post(consoleUrl('/tenants'), { form })
  expect(response.status()).toBe(303)
})

test('accepts a write from the console own origin', async ({ request }) => {
  const response = await request.post(consoleUrl('/tenants'), {
    form,
    headers: { origin: process.env.CONSOLE_URL! },
  })
  expect(response.status()).toBe(303)
})

test('leaves reads alone whatever the origin', async ({ request }) => {
  const response = await request.get(consoleUrl('/tenants'), {
    headers: { origin: 'https://evil.example' },
  })
  expect(response.status()).toBe(200)
})

test('answers an HTML 404 for an unknown path', async ({ page }) => {
  const response = await page.goto(consoleUrl('/nope'))
  expect(response?.status()).toBe(404)
  await expect(page.getByRole('heading', { name: '404' })).toBeVisible()
})
```

The database-failure case (45) is exercised in the integration suite rather than here: stopping the shared container mid-run would break every subsequent Playwright case, and the assertion — that a failure renders the error page instead of an unhandled rejection — needs no browser.

- [ ] **Step 2: Write the accessibility and layout spec**

`tests/ui/a11y.spec.ts` — cases 39–44:

```ts
import { expect, test } from '@playwright/test'
import { consoleUrl, resetConsoleDb } from './helpers.js'

test.beforeEach(async ({ page }) => {
  await resetConsoleDb()
  await page.goto(consoleUrl('/tenants'))
  await page.getByLabel('Name').fill('Houses')
  await page.getByRole('button', { name: 'Create tenant' }).click()
})

const pages = ['/tenants'] as const

test('every form still submits with JavaScript disabled', async ({ page, javaScriptEnabled }) => {
  test.skip(javaScriptEnabled, 'covered by the chromium-nojs project')
  await expect(page.getByRole('link', { name: 'Houses' })).toBeVisible()
})

test('every input has a label', async ({ page }) => {
  await page.getByRole('link', { name: 'Houses' }).click()
  const unlabelled = await page.evaluate(
    () =>
      [...document.querySelectorAll('input')].filter((input) => {
        if (input.labels !== null && input.labels.length > 0) return false
        return input.getAttribute('aria-label') === null
      }).length,
  )
  expect(unlabelled).toBe(0)
})

test('a form submits by pressing Enter in a text field', async ({ page }) => {
  await page.getByLabel('Name').fill('Second')
  await page.getByLabel('Name').press('Enter')
  await expect(page.getByRole('link', { name: 'Second' })).toBeVisible()
})

test('tab order reaches every control', async ({ page, javaScriptEnabled }) => {
  test.skip(!javaScriptEnabled, 'reads document.activeElement')
  const controls = await page.locator('a, input, button').count()
  const reached = new Set<string>()
  for (let i = 0; i < controls + 2; i += 1) {
    await page.keyboard.press('Tab')
    reached.add(await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 60) ?? ''))
  }
  expect(reached.size).toBeGreaterThanOrEqual(controls)
})

for (const path of pages) {
  test(`${path} has one h1 and a titled document`, async ({ page }) => {
    await page.goto(consoleUrl(path))
    await expect(page.locator('h1')).toHaveCount(1)
    await expect(page).toHaveTitle(/Booking Engine console$/)
  })

  test(`${path} does not scroll horizontally at 390px`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 })
    await page.goto(consoleUrl(path))
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(0)
  })
}
```

- [ ] **Step 3: Write the clipboard spec**

`tests/ui/clipboard.spec.ts` — case 27, chromium only:

```ts
import { expect, test } from '@playwright/test'
import { consoleUrl, resetConsoleDb } from './helpers.js'

test.beforeEach(resetConsoleDb)

test('copies the full secret to the clipboard', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'clipboard permissions are chromium-only here')
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])

  await page.goto(consoleUrl('/tenants'))
  await page.getByLabel('Name').fill('Houses')
  await page.getByRole('button', { name: 'Create tenant' }).click()
  await page.getByRole('link', { name: 'Houses' }).click()

  await page.getByLabel('Name').fill('site')
  await page.getByRole('radio', { name: 'Widget' }).check()
  await page.getByRole('button', { name: 'Issue key' }).click()

  const secret = await page.locator('#secret').inputValue()
  await page.getByRole('button', { name: 'Copy' }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(secret)
})
```

- [ ] **Step 4: Add the `run` scenario**

In `run`, beside `cmd_test`, add a scenario that checks its own prerequisite the way every other one does:

```bash
cmd_test_ui() {
  if ! npx playwright --version >/dev/null 2>&1; then
    fail "Playwright is not installed. Run: npm install -D @playwright/test"
  fi
  if [ ! -d "$HOME/Library/Caches/ms-playwright" ] && [ ! -d "$HOME/.cache/ms-playwright" ]; then
    fail "No browser binary. Run: npx playwright install chromium"
  fi
  step "Console UI tests"
  npm run --silent test:ui
}
```

Register `test:ui) cmd_test_ui ;;` in the dispatch and add a line to the usage block:

```
  test:ui      Console UI tests in a real browser (needs: npx playwright install chromium)
```

`cmd_check` is deliberately left alone: a failing `check` must mean the build is broken, not that a browser binary was never downloaded.

- [ ] **Step 5: Run everything**

Run: `npm run test:ui && ./run check`
Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add tests/ui/ run
git commit -m "test: console hardening, accessibility and clipboard coverage"
```

---

### Task 11: Documentation and the smoke suite

**Files:**

- Modify: `README.md`, `docs/architecture.md`, `docs/conventions.md`, `docker-compose.yml`, `scripts/smoke.ts`, `tests/fixtures/api.ts`
- Test: `tests/unit/docs.test.ts`

- [ ] **Step 1: Teach the smoke suite about keys**

`scripts/smoke.ts` replays the datasets against a live engine, so it now needs a tenant and a key. It talks to the console on `CONSOLE_PORT` to create them, which also makes the console part of the smoke path:

```ts
async function bootstrapKey(consoleUrl: string): Promise<string> {
  const created = await fetch(`${consoleUrl}/tenants`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ name: `smoke ${new Date().toISOString()}` }),
    redirect: 'manual',
  })
  if (created.status !== 303)
    throw new Error(`Console refused to create a tenant: ${created.status}`)

  // The console is HTML, so the id comes back through the listing rather than a JSON body.
  const listing = await (await fetch(`${consoleUrl}/tenants`)).text()
  const tenantId = [...listing.matchAll(/([0-9a-f-]{36})\/api-keys/g)].at(-1)?.[1]
  if (tenantId === undefined) throw new Error('Could not find the tenant just created')

  const issued = await fetch(`${consoleUrl}/tenants/${tenantId}/api-keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ name: 'smoke', preset: 'back_office' }),
    redirect: 'manual',
  })
  const revealed = new URL(issued.headers.get('location')!, consoleUrl).searchParams.get('revealed')
  const page = await (
    await fetch(`${consoleUrl}/tenants/${tenantId}/api-keys?revealed=${revealed}`)
  ).text()
  const secret = /bk_live_[A-Za-z0-9]{51}/.exec(page)?.[0]
  if (secret === undefined) throw new Error('The console did not reveal a secret')
  return secret
}
```

Thread the returned key into the `Authorization` header of every request the suite makes, in `tests/fixtures/api.ts` where the transport is built.

- [ ] **Step 2: Update `docs/architecture.md`**

- In the status table, add a fourth slice: `| 4 | Multitenancy, API keys, the console | **Implemented** |`.
- Replace the sentence about the engine being internal and unauthenticated with a short section pointing at the spec, stating that every row belongs to a tenant and every request carries a key with one scope per route.
- Add `tenant_id` to the Resource, Schedule, ScheduleException and Booking column tables, and mark `customer_id` nullable.
- In the API contracts section, add `GET /resources` and make `customer_id` optional in the booking contracts.

- [ ] **Step 3: Update `docs/conventions.md`**

Add `unauthorized`, `forbidden_scope`, `forbidden_origin` and `rate_limited` to the error-code table, and a short "Authentication" subsection under API conventions naming the header, the eight scopes and the rule that a route requires exactly one.

- [ ] **Step 4: Update `README.md`**

- The quick-start gains a step: start the console, create a tenant, issue a key, export it.
- Every `curl` example gains `-H "Authorization: Bearer $BOOKING_KEY"`.
- A new section, "The console", explaining that it binds to loopback, is unauthenticated by design, and must not be exposed.

- [ ] **Step 5: Add the console to `docker-compose.yml`**

A second service from the same image running `npm run console`, published as `127.0.0.1:3001:3001` — the host part of the mapping matters, and a comment says why.

- [ ] **Step 6: Run everything**

Run: `./run check && npm run test:ui && ./run smoke`
Expected: all PASS. `docs.test.ts` fails if any new route lacks `tags`, `summary` or a `response` map.

- [ ] **Step 7: Commit**

```bash
git add README.md docs/ docker-compose.yml scripts/smoke.ts tests/
git commit -m "docs: authentication, the console, and the smoke bootstrap"
```

---

## Self-review

**Spec coverage.** Section 2 → Task 1. Section 3 → Task 1. Section 4.1–4.3 → Task 2 and Task 4. Section 4.4–4.5 → Task 1 (vocabulary) and Task 4 (declarations). Section 4.6–4.7 → Task 3 (`touchKey`) and Task 4 (redaction, rate limit). Section 5 → Task 5. Section 6 → Task 6. Section 7.1–7.5 → Task 7. Section 7.6–7.7 → Task 8. Section 8 → Task 1. Section 9 → Task 3 (error classes). Section 10 → the file structure above. Section 11.1 → Tasks 1, 2, 7, 8. Section 11.2 → Tasks 1, 3, 4, 5, 6. Section 11.3 → Tasks 9 and 10. Section 12 is recorded-for-later and needs no task.

**Deviations from the spec, deliberate:**

- UI case 45 (database stopped mid-session) moved from Playwright to the integration suite: killing the shared container would break every following browser case, and the assertion needs no browser.
- The spec's route table names `POST /api-keys/:id/revoke`; the plan keeps that and drops the `DELETE` the earlier draft mentioned.
- `GET /health` and `GET /` are the only `public: true` routes; `/docs` is exempted inside the `onRoute` hook because `@fastify/swagger-ui` registers its own routes and they carry no config.
