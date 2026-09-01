# Resources, Schedule & Availability — Implementation Plan

> **Executed and archived.** This plan built the slice named above. It is kept for provenance, sits outside the reading path, and is not current truth — for what the engine does today read [architecture.md](../../../architecture.md) and [conventions.md](../../../conventions.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the foundation of the booking engine and its entire read side — resources, weekly schedules, per-date exceptions, and a timezone-correct availability calculation exposed over HTTP.

**Architecture:** A Fastify service over PostgreSQL, accessed through Kysely. Modules are organised by entity (`resources`, `schedule`, `exceptions`, `availability`), each split into routes (HTTP + schemas), service (rules) and repository (SQL). All DST-sensitive arithmetic is isolated in one pure function, `slot-generator.ts`, which never touches the database.

**Tech Stack:** Node 24 LTS · TypeScript strict · Fastify 5 · TypeBox · Kysely + `pg` · PostgreSQL 16 · Luxon · Vitest + Testcontainers

**Spec:** [2026-07-27-resources-schedule-availability-design.md](../../specs/2026-07-27-resources-schedule-availability-design.md)

## Global Constraints

The engine-wide rules live in [conventions.md](../../../conventions.md), which is authoritative. They are restated in full below on purpose: a task in this plan may be executed by someone who sees only that task, so every constraint has to be readable without following a link. If the two ever disagree, `conventions.md` is right and this list is stale.

- Node.js 24, the current active LTS. Declared in `.nvmrc` and in `engines` in `package.json`; the container image pins the minor (`node:24.18-alpine`) rather than floating on `node:24-alpine`, so a rebuild months later produces the same runtime.
- TypeScript `strict: true`, ES2022 target, NodeNext module resolution. No `any` outside Kysely migration signatures (`Kysely<any>` is required there by Kysely itself).
- The TypeBox package is `typebox` (not `@sinclair/typebox`), paired with `@fastify/type-provider-typebox`.
- `src/modules/availability/slot-generator.ts` must not import anything from `src/db/`. This is the core isolation rule of the design.
- Day-of-week is **Monday = 0 … Sunday = 6**. Postgres `EXTRACT(DOW)` (Sunday = 0), JS `getDay()` (Sunday = 0) and Luxon `weekday` (Monday = 1) all disagree with it. Only `src/shared/time.ts` is allowed to convert between conventions.
- Durations in the API use the restricted ISO-8601 grammar: `P<n>D` **or** `PT[<n>H][<n>M]` totalling less than 24 hours. `P1D` and `PT24H` are not interchangeable; the written form is what makes a resource day-based.
- Date ranges are half-open: `from` inclusive, `to` exclusive. Maximum span `MAX_RANGE_DAYS`, default 366.
- Response timestamps are ISO-8601 **with offset**: `2026-07-20T09:00:00+02:00`. Times of day are `HH:MM`. Dates are `YYYY-MM-DD`.
- Every error response has the shape `{ error, message, details? }`.
- Test-driven: the failing test is written and run before the implementation, in every task.
- Commit at the end of every task. The repository is initialised by the project owner; if `git status` fails, stop and ask rather than running `git init`.

---

### Task 1: Project skeleton, config, health endpoint

**Files:**

- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.prettierrc`, `.gitignore`, `.env.example`
- Create: `src/config.ts`, `src/app.ts`, `src/server.ts`
- Test: `tests/unit/config.test.ts`, `tests/integration/health.test.ts`
- Delete: the empty `booking_engine/` directory

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `loadConfig(env: NodeJS.ProcessEnv): Config` where `Config = { databaseUrl: string; port: number; logLevel: string; maxRangeDays: number }`
  - `buildApp(deps: { config: Config; db: Kysely<Database> }): FastifyInstance` — added in Task 2; in this task the signature is `buildApp(deps: { config: Config }): FastifyInstance`

- [ ] **Step 1: Initialise the package and install dependencies**

```bash
npm init -y
npm pkg set name="booking-engine" version="0.1.0" private=true type="module"
npm pkg set engines.node=">=24.0.0"
echo 24 > .nvmrc
npm i fastify @fastify/type-provider-typebox typebox kysely pg luxon
npm i -D typescript tsx vitest @types/node @types/pg @types/luxon prettier @testcontainers/postgresql
rmdir booking_engine
```

`type: "module"` matters: the whole project is ESM, so relative imports carry a `.js` extension even in `.ts` files.

- [ ] **Step 2: Write the configuration files**

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": ".",
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globalSetup: ['./tests/integration/global-setup.ts'],
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    pool: 'forks',
    fileParallelism: false,
  },
})
```

`fileParallelism: false` keeps integration tests from truncating each other's tables — they share one database. `hookTimeout` is generous because the first run pulls the Postgres image.

The `global-setup.ts` file is created in Task 2. Until then Vitest will fail to start, so create a placeholder now:

```bash
mkdir -p tests/integration tests/unit src
cat > tests/integration/global-setup.ts <<'EOF'
export async function setup(): Promise<void> {}
export async function teardown(): Promise<void> {}
EOF
```

`.prettierrc`:

```json
{ "semi": false, "singleQuote": true, "printWidth": 100 }
```

`.gitignore`:

```
node_modules/
dist/
.env
```

`.env.example`:

```
DATABASE_URL=postgres://postgres:postgres@localhost:5432/booking_engine
PORT=3000
LOG_LEVEL=info
MAX_RANGE_DAYS=366
```

Add scripts:

```bash
npm pkg set scripts.dev="tsx watch src/server.ts"
npm pkg set scripts.build="tsc"
npm pkg set scripts.start="node dist/src/server.js"
npm pkg set scripts.test="vitest run"
npm pkg set scripts.migrate="tsx src/db/migrate.ts"
npm pkg set scripts.format="prettier --write ."
```

- [ ] **Step 3: Write the failing config test**

`tests/unit/config.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config.js'

const valid = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
  PORT: '4000',
  LOG_LEVEL: 'debug',
  MAX_RANGE_DAYS: '90',
}

describe('loadConfig', () => {
  it('parses a fully specified environment', () => {
    expect(loadConfig(valid)).toEqual({
      databaseUrl: 'postgres://user:pass@localhost:5432/db',
      port: 4000,
      logLevel: 'debug',
      maxRangeDays: 90,
    })
  })

  it('applies defaults for optional variables', () => {
    const config = loadConfig({ DATABASE_URL: valid.DATABASE_URL })
    expect(config).toEqual({
      databaseUrl: valid.DATABASE_URL,
      port: 3000,
      logLevel: 'info',
      maxRangeDays: 366,
    })
  })

  it('throws when DATABASE_URL is missing', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/)
  })

  it('throws when PORT is not a number', () => {
    expect(() => loadConfig({ ...valid, PORT: 'http' })).toThrow(/PORT/)
  })

  it('throws when MAX_RANGE_DAYS is zero or negative', () => {
    expect(() => loadConfig({ ...valid, MAX_RANGE_DAYS: '0' })).toThrow(/MAX_RANGE_DAYS/)
  })
})
```

- [ ] **Step 4: Run it and confirm it fails**

Run: `npx vitest run tests/unit/config.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/config.js"`.

- [ ] **Step 5: Implement the config loader**

`src/config.ts`:

```ts
export interface Config {
  databaseUrl: string
  port: number
  logLevel: string
  maxRangeDays: number
}

function requireString(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]
  if (value === undefined || value.trim() === '') {
    throw new Error(`Invalid configuration: ${key} is required`)
  }
  return value
}

function positiveInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid configuration: ${key} must be a positive integer, got "${raw}"`)
  }
  return value
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  return {
    databaseUrl: requireString(env, 'DATABASE_URL'),
    port: positiveInt(env, 'PORT', 3000),
    logLevel: env.LOG_LEVEL?.trim() || 'info',
    maxRangeDays: positiveInt(env, 'MAX_RANGE_DAYS', 366),
  }
}
```

- [ ] **Step 6: Run the config test and confirm it passes**

Run: `npx vitest run tests/unit/config.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 7: Write the failing health test**

`tests/integration/health.test.ts`:

```ts
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../src/app.js'

let app: FastifyInstance

beforeAll(async () => {
  app = buildApp({
    config: { databaseUrl: 'unused', port: 0, logLevel: 'silent', maxRangeDays: 366 },
  })
  await app.ready()
})

afterAll(async () => {
  await app.close()
})

it('reports health', async () => {
  const response = await app.inject({ method: 'GET', url: '/health' })
  expect(response.statusCode).toBe(200)
  expect(response.json()).toEqual({ status: 'ok' })
})
```

- [ ] **Step 8: Run it and confirm it fails**

Run: `npx vitest run tests/integration/health.test.ts`
Expected: FAIL — cannot resolve `../../src/app.js`.

- [ ] **Step 9: Implement `app.ts` and `server.ts`**

`src/app.ts`:

```ts
import Fastify, { type FastifyInstance } from 'fastify'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import type { Config } from './config.js'

export interface AppDeps {
  config: Config
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: { level: deps.config.logLevel },
  }).withTypeProvider<TypeBoxTypeProvider>()

  app.get('/health', async () => ({ status: 'ok' }))

  return app
}
```

`src/server.ts`:

```ts
import { buildApp } from './app.js'
import { loadConfig } from './config.js'

const config = loadConfig(process.env)
const app = buildApp({ config })

try {
  await app.listen({ port: config.port, host: '0.0.0.0' })
} catch (error) {
  app.log.error(error)
  process.exit(1)
}
```

- [ ] **Step 10: Run the whole suite**

Run: `npm test`
Expected: PASS, 6 tests across 2 files.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat: project skeleton, configuration and health endpoint"
```

---

### Task 2: Database client, initial migration, test harness

**Files:**

- Create: `src/db/schema.ts`, `src/db/client.ts`, `src/db/migrate.ts`, `src/db/migrations/001_initial.ts`, `src/db/migrations/index.ts`
- Create: `tests/integration/global-setup.ts` (replacing the placeholder), `tests/integration/helpers.ts`
- Modify: `src/app.ts`, `src/server.ts`
- Test: `tests/integration/migrations.test.ts`

**Interfaces:**

- Consumes: `loadConfig`, `buildApp` from Task 1.
- Produces:
  - `Database` — the Kysely schema interface with tables `resources`, `schedule`, `schedule_exceptions`
  - `createDb(databaseUrl: string): Kysely<Database>` — the instance owns its pool, so `db.destroy()` closes it; calling `pool.end()` as well throws "Called end on pool more than once"
  - `runMigrations(db: Kysely<Database>): Promise<void>`
  - `buildApp(deps: { config: Config; db: Kysely<Database> }): FastifyInstance` — `db` is now required and reachable in handlers via `app.db`
  - Test helpers: `getTestDb(): Kysely<Database>`, `resetDb(): Promise<void>`, `buildTestApp(): Promise<FastifyInstance>`

- [ ] **Step 1: Write the schema types and the client**

Two `pg` type parsers must be overridden here, and both are load-bearing.

`pg` decodes `interval` (OID 1186) into an object and `date` (OID 1082) into a `Date` at _local_ midnight — which silently shifts the date when the server's timezone differs from the resource's. Reading both as raw strings avoids the whole class of bug. Combined with `SET intervalstyle = 'iso_8601'`, Postgres then hands back durations already in the exact format the API uses: `PT1H`, `P1D`.

`src/db/schema.ts`:

```ts
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
```

`src/db/client.ts`:

```ts
import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import type { Database } from './schema.js'

const PG_INTERVAL_OID = 1186
const PG_DATE_OID = 1082

// Read intervals and dates as raw strings. See the note in the plan: pg's default
// parsers turn them into an object and a local-midnight Date respectively, both of
// which lose or distort information this engine depends on.
pg.types.setTypeParser(PG_INTERVAL_OID, (value: string) => value)
pg.types.setTypeParser(PG_DATE_OID, (value: string) => value)

/**
 * The returned instance owns its connection pool: `db.destroy()` closes it, and calling
 * `pool.end()` separately would throw. That is why no pool is handed back.
 */
export function createDb(databaseUrl: string): Kysely<Database> {
  const pool = new pg.Pool({ connectionString: databaseUrl })

  // Makes Postgres emit intervals as 'PT1H' / 'P1D' — the same grammar the API uses.
  pool.on('connect', (client) => {
    void client.query("SET intervalstyle = 'iso_8601'")
  })

  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
}
```

- [ ] **Step 2: Write the initial migration**

`src/db/migrations/001_initial.ts`:

```ts
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
```

`gen_random_uuid()` is built into Postgres 13+; no extension is needed. Spec 2 will additionally require `btree_gist` for the bookings exclusion constraint.

- [ ] **Step 3: Write the migration runner**

Do **not** use `FileMigrationProvider`. It discovers migrations by importing files from disk at runtime, which fails wherever the runtime cannot load TypeScript directly — notably inside Vitest's global setup, where the import bypasses Vite's transform and Node reports `ERR_UNKNOWN_FILE_EXTENSION` for `.ts`. A static map works in every runtime and makes the order of application reviewable.

`src/db/migrations/index.ts`:

```ts
import type { Migration } from 'kysely/migration'
import * as initial from './001_initial.js'

/**
 * Keys are the migration names Kysely records in `kysely_migration`; they are applied in
 * lexicographic order, so keep the numeric prefix.
 */
export const migrations: Record<string, Migration> = {
  '001_initial': initial,
}
```

The `Migration` type must come from `kysely/migration`. The root `kysely` export deliberately resolves it to a `KyselyTypeError` telling you to import from the submodule, which surfaces as a confusing "Property `__kyselyTypeError__` is missing" error.

`src/db/migrate.ts`:

```ts
import { fileURLToPath } from 'node:url'
import type { Kysely } from 'kysely'
import { Migrator } from 'kysely/migration'
import { loadConfig } from '../config.js'
import { createDb } from './client.js'
import { migrations } from './migrations/index.js'
import type { Database } from './schema.js'

export async function runMigrations(db: Kysely<Database>): Promise<void> {
  const migrator = new Migrator({
    db,
    provider: { getMigrations: async () => migrations },
  })

  const { error, results } = await migrator.migrateToLatest()

  for (const result of results ?? []) {
    if (result.status === 'Error') {
      throw new Error(`Migration "${result.migrationName}" failed`)
    }
  }

  if (error) throw error
}

// Executed only when run directly: `npm run migrate`
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadConfig(process.env)
  const db = createDb(config.databaseUrl)
  try {
    await runMigrations(db)
    console.log('migrations applied')
  } finally {
    await db.destroy()
  }
}
```

- [ ] **Step 4: Write the test harness**

`tests/integration/global-setup.ts` (replaces the placeholder):

```ts
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { createDb } from '../../src/db/client.js'
import { runMigrations } from '../../src/db/migrate.js'

let container: StartedPostgreSqlContainer

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string
  }
}

/**
 * Typed structurally rather than against a Vitest export: the name of the global-setup
 * context type has moved between major versions (`vitest/node` exports no
 * `GlobalSetupContext` in v4), and `provide` is all this file needs.
 */
interface GlobalSetupContext {
  provide: <K extends 'databaseUrl'>(key: K, value: string) => void
}

export async function setup({ provide }: GlobalSetupContext): Promise<void> {
  container = await new PostgreSqlContainer('postgres:16-alpine').start()
  const databaseUrl = container.getConnectionUri()

  const db = createDb(databaseUrl)
  try {
    await runMigrations(db)
  } finally {
    await db.destroy()
  }

  provide('databaseUrl', databaseUrl)
}

export async function teardown(): Promise<void> {
  await container?.stop()
}
```

`tests/integration/helpers.ts`:

```ts
import { inject } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { buildApp } from '../../src/app.js'
import { createDb } from '../../src/db/client.js'
import type { Database } from '../../src/db/schema.js'

let cached: Kysely<Database> | undefined

export function getTestDb(): Kysely<Database> {
  cached ??= createDb(inject('databaseUrl'))
  return cached
}

export async function closeTestDb(): Promise<void> {
  await cached?.destroy()
  cached = undefined
}

export async function resetDb(): Promise<void> {
  await sql`truncate table schedule_exceptions, schedule, resources restart identity cascade`.execute(
    getTestDb(),
  )
}

export async function buildTestApp(): Promise<FastifyInstance> {
  const app = buildApp({
    config: { databaseUrl: inject('databaseUrl'), port: 0, logLevel: 'silent', maxRangeDays: 366 },
    db: getTestDb(),
  })
  await app.ready()
  return app
}
```

- [ ] **Step 5: Write the failing migration test**

`tests/integration/migrations.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { closeTestDb, getTestDb, resetDb } from './helpers.js'

beforeEach(resetDb)
afterAll(closeTestDb)

describe('initial migration', () => {
  it('creates the three engine tables', async () => {
    const result = await sql<{ table_name: string }>`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_name in ('resources', 'schedule', 'schedule_exceptions')
      order by table_name
    `.execute(getTestDb())

    expect(result.rows.map((row) => row.table_name)).toEqual([
      'resources',
      'schedule',
      'schedule_exceptions',
    ])
  })

  it('returns intervals as ISO-8601 strings', async () => {
    const db = getTestDb()
    await db
      .insertInto('resources')
      .values({ timezone: 'Europe/Warsaw', slot_duration: 'PT1H', concurrency_mode: 'exclusive' })
      .execute()

    const row = await db.selectFrom('resources').select('slot_duration').executeTakeFirstOrThrow()
    expect(row.slot_duration).toBe('PT1H')
  })

  it('stores P1D distinctly from PT24H', async () => {
    const db = getTestDb()
    await db
      .insertInto('resources')
      .values({ timezone: 'Europe/Warsaw', slot_duration: 'P1D', concurrency_mode: 'exclusive' })
      .execute()

    const row = await db.selectFrom('resources').select('slot_duration').executeTakeFirstOrThrow()
    expect(row.slot_duration).toBe('P1D')
  })

  it('rejects a capacity below one', async () => {
    await expect(
      getTestDb()
        .insertInto('resources')
        .values({
          timezone: 'Europe/Warsaw',
          slot_duration: 'PT1H',
          concurrency_mode: 'exclusive',
          capacity: 0,
        })
        .execute(),
    ).rejects.toThrow(/resources_capacity_positive/)
  })

  it('rejects a schedule rule with only one time set', async () => {
    const db = getTestDb()
    const resource = await db
      .insertInto('resources')
      .values({ timezone: 'Europe/Warsaw', slot_duration: 'PT1H', concurrency_mode: 'exclusive' })
      .returning('id')
      .executeTakeFirstOrThrow()

    await expect(
      db
        .insertInto('schedule')
        .values({ resource_id: resource.id, day_of_week: 0, start_time: '09:00', end_time: null })
        .execute(),
    ).rejects.toThrow(/schedule_times_both_or_neither/)
  })

  it('cascades deletion of a resource to its schedule and exceptions', async () => {
    const db = getTestDb()
    const resource = await db
      .insertInto('resources')
      .values({ timezone: 'Europe/Warsaw', slot_duration: 'PT1H', concurrency_mode: 'exclusive' })
      .returning('id')
      .executeTakeFirstOrThrow()

    await db
      .insertInto('schedule')
      .values({ resource_id: resource.id, day_of_week: 0, start_time: '09:00', end_time: '17:00' })
      .execute()
    await db
      .insertInto('schedule_exceptions')
      .values({ resource_id: resource.id, date: '2026-07-20', start_time: null, end_time: null })
      .execute()

    await db.deleteFrom('resources').where('id', '=', resource.id).execute()

    const schedule = await db.selectFrom('schedule').selectAll().execute()
    const exceptions = await db.selectFrom('schedule_exceptions').selectAll().execute()
    expect(schedule).toHaveLength(0)
    expect(exceptions).toHaveLength(0)
  })

  it('returns dates as plain strings', async () => {
    const db = getTestDb()
    const resource = await db
      .insertInto('resources')
      .values({ timezone: 'Pacific/Auckland', slot_duration: 'P1D', concurrency_mode: 'exclusive' })
      .returning('id')
      .executeTakeFirstOrThrow()

    await db
      .insertInto('schedule_exceptions')
      .values({ resource_id: resource.id, date: '2026-07-20', start_time: null, end_time: null })
      .execute()

    const row = await db.selectFrom('schedule_exceptions').select('date').executeTakeFirstOrThrow()
    expect(row.date).toBe('2026-07-20')
  })
})
```

- [ ] **Step 6: Run it and confirm it fails**

Run: `npx vitest run tests/integration/migrations.test.ts`
Expected: FAIL — the container starts, but `buildApp` does not yet accept `db`, or module resolution fails. Docker must be running.

- [ ] **Step 7: Wire the database into the app**

Modify `src/app.ts` — add the `db` dependency and decorate the instance:

```ts
import Fastify, { type FastifyInstance } from 'fastify'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import type { Kysely } from 'kysely'
import type { Config } from './config.js'
import type { Database } from './db/schema.js'

export interface AppDeps {
  config: Config
  db: Kysely<Database>
}

declare module 'fastify' {
  interface FastifyInstance {
    db: Kysely<Database>
    config: Config
  }
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: { level: deps.config.logLevel },
  }).withTypeProvider<TypeBoxTypeProvider>()

  app.decorate('db', deps.db)
  app.decorate('config', deps.config)

  app.get('/health', async () => ({ status: 'ok' }))

  return app
}
```

Modify `src/server.ts` to build the client and close it on shutdown:

```ts
import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { createDb } from './db/client.js'

const config = loadConfig(process.env)
const { db, pool } = createDb(config.databaseUrl)
const app = buildApp({ config, db })

app.addHook('onClose', async () => {
  await db.destroy()
  await pool.end()
})

try {
  await app.listen({ port: config.port, host: '0.0.0.0' })
} catch (error) {
  app.log.error(error)
  process.exit(1)
}
```

Update `tests/integration/health.test.ts` to use the shared helper:

```ts
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, closeTestDb } from './helpers.js'

let app: FastifyInstance

beforeAll(async () => {
  app = await buildTestApp()
})

afterAll(async () => {
  await app.close()
  await closeTestDb()
})

it('reports health', async () => {
  const response = await app.inject({ method: 'GET', url: '/health' })
  expect(response.statusCode).toBe(200)
  expect(response.json()).toEqual({ status: 'ok' })
})
```

- [ ] **Step 8: Run the suite and confirm it passes**

Run: `npm test`
Expected: PASS. The first run pulls `postgres:16-alpine`, so allow a minute.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: database client, initial migration and Testcontainers harness"
```

---

### Task 3: Time helpers — duration grammar and day-of-week conversion

**Files:**

- Create: `src/shared/time.ts`
- Test: `tests/unit/time.test.ts`

**Interfaces:**

- Consumes: Luxon.
- Produces:
  - `parseSlotDuration(value: string): SlotDuration` — throws `InvalidDurationError` on a value outside the grammar
  - `SlotDuration = { iso: string; kind: 'day' | 'intraday'; luxon: Duration }`
  - `dayOfWeekOf(dt: DateTime): number` — Monday = 0 … Sunday = 6
  - `formatTime(pgTime: string): string` — `'09:00:00'` → `'09:00'`
  - `enumerateDates(from: string, to: string, timezone: string): string[]` — half-open, `YYYY-MM-DD`
  - `InvalidDurationError extends Error`

- [ ] **Step 1: Write the failing test**

`tests/unit/time.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { DateTime } from 'luxon'
import {
  dayOfWeekOf,
  enumerateDates,
  formatTime,
  parseSlotDuration,
} from '../../src/shared/time.js'

describe('parseSlotDuration', () => {
  it.each([
    ['PT30M', 'intraday', 30],
    ['PT1H', 'intraday', 60],
    ['PT1H30M', 'intraday', 90],
    ['PT23H59M', 'intraday', 1439],
  ])('accepts the intraday duration %s', (iso, kind, minutes) => {
    const parsed = parseSlotDuration(iso)
    expect(parsed.kind).toBe(kind)
    expect(parsed.luxon.as('minutes')).toBe(minutes)
    expect(parsed.iso).toBe(iso)
  })

  it.each([
    ['P1D', 1],
    ['P7D', 7],
    ['P30D', 30],
  ])('accepts the day-based duration %s', (iso, days) => {
    const parsed = parseSlotDuration(iso)
    expect(parsed.kind).toBe('day')
    expect(parsed.luxon.as('days')).toBe(days)
  })

  it.each([
    'P1M',
    'P1Y',
    'P1DT2H',
    'PT0M',
    'PT0H0M',
    'PT24H',
    'PT25H',
    'P0D',
    'P367D',
    '',
    'sixty minutes',
    'PT1S',
  ])('rejects %s', (iso) => {
    expect(() => parseSlotDuration(iso)).toThrow(/duration/i)
  })

  it('keeps P1D and PT24H distinguishable', () => {
    expect(parseSlotDuration('P1D').kind).toBe('day')
    expect(() => parseSlotDuration('PT24H')).toThrow()
  })
})

describe('dayOfWeekOf', () => {
  // 2026-07-20 is a Monday.
  it.each([
    ['2026-07-20', 0],
    ['2026-07-21', 1],
    ['2026-07-22', 2],
    ['2026-07-23', 3],
    ['2026-07-24', 4],
    ['2026-07-25', 5],
    ['2026-07-26', 6],
  ])('maps %s to %i', (date, expected) => {
    const dt = DateTime.fromISO(date, { zone: 'Europe/Warsaw' })
    expect(dayOfWeekOf(dt)).toBe(expected)
  })
})

describe('formatTime', () => {
  it('trims seconds', () => {
    expect(formatTime('09:00:00')).toBe('09:00')
    expect(formatTime('23:45:00')).toBe('23:45')
  })
})

describe('enumerateDates', () => {
  it('is half-open on the upper bound', () => {
    expect(enumerateDates('2026-07-20', '2026-07-23', 'Europe/Warsaw')).toEqual([
      '2026-07-20',
      '2026-07-21',
      '2026-07-22',
    ])
  })

  it('returns an empty list when the bounds coincide', () => {
    expect(enumerateDates('2026-07-20', '2026-07-20', 'Europe/Warsaw')).toEqual([])
  })

  it('does not skip or repeat a date across a DST transition', () => {
    // Europe/Warsaw springs forward on 2026-03-29.
    expect(enumerateDates('2026-03-28', '2026-03-31', 'Europe/Warsaw')).toEqual([
      '2026-03-28',
      '2026-03-29',
      '2026-03-30',
    ])
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/unit/time.test.ts`
Expected: FAIL — cannot resolve `../../src/shared/time.js`.

- [ ] **Step 3: Implement the helpers**

`src/shared/time.ts`:

```ts
import { DateTime, Duration } from 'luxon'

export class InvalidDurationError extends Error {
  constructor(value: string) {
    super(`Invalid slot duration "${value}": expected P<n>D or PT[<n>H][<n>M] under 24 hours`)
    this.name = 'InvalidDurationError'
  }
}

export interface SlotDuration {
  iso: string
  kind: 'day' | 'intraday'
  luxon: Duration
}

const DAY_PATTERN = /^P(\d+)D$/
const TIME_PATTERN = /^PT(?:(\d+)H)?(?:(\d+)M)?$/

const MAX_DAYS = 366

/**
 * The written form decides the kind: P1D means "anchor to anchor" (23, 24 or 25 real
 * hours depending on DST) while PT24H would mean exactly 24 elapsed hours. Treating
 * them as interchangeable breaks day-based resources twice a year, so PT durations
 * are capped below 24 hours and never produce a day-based resource.
 */
export function parseSlotDuration(value: string): SlotDuration {
  const dayMatch = DAY_PATTERN.exec(value)
  if (dayMatch) {
    const days = Number(dayMatch[1])
    if (days < 1 || days > MAX_DAYS) throw new InvalidDurationError(value)
    return { iso: value, kind: 'day', luxon: Duration.fromObject({ days }) }
  }

  const timeMatch = TIME_PATTERN.exec(value)
  if (timeMatch && (timeMatch[1] !== undefined || timeMatch[2] !== undefined)) {
    const hours = Number(timeMatch[1] ?? 0)
    const minutes = Number(timeMatch[2] ?? 0)
    const total = hours * 60 + minutes
    if (total < 1 || total >= 24 * 60) throw new InvalidDurationError(value)
    return { iso: value, kind: 'intraday', luxon: Duration.fromObject({ hours, minutes }) }
  }

  throw new InvalidDurationError(value)
}

/**
 * The engine's convention is Monday = 0 … Sunday = 6. Luxon uses Monday = 1 … Sunday = 7,
 * Postgres EXTRACT(DOW) and JS getDay() both use Sunday = 0. This is the only place in
 * the codebase permitted to convert between them.
 */
export function dayOfWeekOf(dt: DateTime): number {
  return (dt.weekday + 6) % 7
}

export function formatTime(pgTime: string): string {
  return pgTime.slice(0, 5)
}

export function enumerateDates(from: string, to: string, timezone: string): string[] {
  const dates: string[] = []
  let cursor = DateTime.fromISO(from, { zone: timezone }).startOf('day')
  const end = DateTime.fromISO(to, { zone: timezone }).startOf('day')

  while (cursor < end) {
    const iso = cursor.toISODate()
    if (iso) dates.push(iso)
    cursor = cursor.plus({ days: 1 })
  }

  return dates
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run tests/unit/time.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: duration grammar, day-of-week conversion and date enumeration"
```

---

### Task 4: Error hierarchy and the global error handler

**Files:**

- Create: `src/shared/errors.ts`
- Modify: `src/app.ts`
- Test: `tests/unit/errors.test.ts`, `tests/integration/error-handler.test.ts`

**Interfaces:**

- Consumes: `buildApp` from Task 2.
- Produces:
  - `AppError` — abstract base carrying `statusCode`, `code`, `details?`
  - `ValidationError`, `InvalidRangeError`, `ScheduleOverlapError`, `ScheduleShapeMismatchError`, `UnsupportedConcurrencyModeError`, `NotFoundError`
  - `registerErrorHandler(app: FastifyInstance): void`

- [ ] **Step 1: Write the failing unit test**

`tests/unit/errors.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  AppError,
  InvalidRangeError,
  NotFoundError,
  ScheduleOverlapError,
  ValidationError,
} from '../../src/shared/errors.js'

describe('AppError hierarchy', () => {
  it('carries a status code and a stable machine-readable code', () => {
    const error = new ValidationError('bad input', { field: 'timezone' })
    expect(error).toBeInstanceOf(AppError)
    expect(error.statusCode).toBe(400)
    expect(error.code).toBe('validation_error')
    expect(error.details).toEqual({ field: 'timezone' })
  })

  it.each([
    [new NotFoundError('resource'), 404, 'not_found'],
    [new InvalidRangeError('too wide'), 400, 'invalid_range'],
    [new ScheduleOverlapError('overlap', { day_of_week: 0 }), 400, 'schedule_overlap'],
  ])('maps %s', (error, statusCode, code) => {
    expect(error.statusCode).toBe(statusCode)
    expect(error.code).toBe(code)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/unit/errors.test.ts`
Expected: FAIL — cannot resolve `../../src/shared/errors.js`.

- [ ] **Step 3: Implement the error hierarchy**

`src/shared/errors.ts`:

```ts
import type { FastifyInstance } from 'fastify'

export abstract class AppError extends Error {
  abstract readonly statusCode: number
  abstract readonly code: string
  readonly details?: Record<string, unknown>

  constructor(message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = new.target.name
    this.details = details
  }
}

export class ValidationError extends AppError {
  readonly statusCode = 400
  readonly code = 'validation_error'
}

export class InvalidRangeError extends AppError {
  readonly statusCode = 400
  readonly code = 'invalid_range'
}

export class ScheduleOverlapError extends AppError {
  readonly statusCode = 400
  readonly code = 'schedule_overlap'
}

export class ScheduleShapeMismatchError extends AppError {
  readonly statusCode = 400
  readonly code = 'schedule_shape_mismatch'
}

export class UnsupportedConcurrencyModeError extends AppError {
  readonly statusCode = 400
  readonly code = 'unsupported_concurrency_mode'
}

export class NotFoundError extends AppError {
  readonly statusCode = 404
  readonly code = 'not_found'
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      void reply.status(error.statusCode).send({
        error: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      })
      return
    }

    // Fastify's own schema validation failures, translated into our shape.
    if (error.validation) {
      void reply.status(400).send({
        error: 'validation_error',
        message: error.message,
        details: { issues: error.validation },
      })
      return
    }

    // Anything unexpected: log with the stack, reveal nothing. Database structure
    // must never reach the client through error text.
    request.log.error({ err: error }, 'unhandled error')
    void reply.status(500).send({ error: 'internal_error', message: 'Internal server error' })
  })

  app.setNotFoundHandler((_request, reply) => {
    void reply.status(404).send({ error: 'not_found', message: 'Route not found' })
  })
}
```

- [ ] **Step 4: Run the unit test and confirm it passes**

Run: `npx vitest run tests/unit/errors.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing integration test**

`tests/integration/error-handler.test.ts`:

```ts
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, closeTestDb } from './helpers.js'

let app: FastifyInstance

beforeAll(async () => {
  app = await buildTestApp()
})

afterAll(async () => {
  await app.close()
  await closeTestDb()
})

it('returns the uniform error shape for an unknown route', async () => {
  const response = await app.inject({ method: 'GET', url: '/nope' })
  expect(response.statusCode).toBe(404)
  expect(response.json()).toEqual({ error: 'not_found', message: 'Route not found' })
})
```

- [ ] **Step 6: Run it and confirm it fails**

Run: `npx vitest run tests/integration/error-handler.test.ts`
Expected: FAIL — Fastify's default 404 body is `{"message":"Route GET:/nope not found","error":"Not Found","statusCode":404}`.

- [ ] **Step 7: Register the handler in `app.ts`**

Add to `src/app.ts`, immediately after the two `app.decorate` calls:

```ts
registerErrorHandler(app)
```

with the import:

```ts
import { registerErrorHandler } from './shared/errors.js'
```

- [ ] **Step 8: Run the suite and confirm it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: error hierarchy and uniform error responses"
```

---

### Task 5: Resources module

**Files:**

- Create: `src/modules/resources/resource.schemas.ts`, `resource.repository.ts`, `resource.service.ts`, `resource.routes.ts`
- Modify: `src/app.ts`
- Test: `tests/integration/resources.test.ts`

**Interfaces:**

- Consumes: `Database`, `AppError` subclasses, `parseSlotDuration`, `formatTime`.
- Produces:
  - `ResourceResponse = { id, timezone, slot_duration, slot_anchor_time, capacity, concurrency_mode, is_active }`
  - `ResourceService` with `create`, `getById`, `update`, `delete`
  - `ResourceRepository` with `insert`, `findById`, `update`, `delete`
  - `resourceRoutes: FastifyPluginAsync`
  - `assertResourceExists(db, id): Promise<ResourceRow>` — reused by later modules

- [ ] **Step 1: Write the failing tests**

`tests/integration/resources.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, closeTestDb, resetDb } from './helpers.js'

let app: FastifyInstance

beforeAll(async () => {
  app = await buildTestApp()
})

beforeEach(resetDb)

afterAll(async () => {
  await app.close()
  await closeTestDb()
})

const validBody = {
  timezone: 'Europe/Warsaw',
  slot_duration: 'PT1H',
  concurrency_mode: 'exclusive',
}

async function createResource(overrides: Record<string, unknown> = {}) {
  const response = await app.inject({
    method: 'POST',
    url: '/resources',
    payload: { ...validBody, ...overrides },
  })
  return response
}

describe('POST /resources', () => {
  it('creates a resource with defaults applied', async () => {
    const response = await createResource()
    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({
      timezone: 'Europe/Warsaw',
      slot_duration: 'PT1H',
      slot_anchor_time: '00:00',
      capacity: 1,
      concurrency_mode: 'exclusive',
      is_active: true,
    })
    expect(response.json().id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('creates a day-based resource with an anchor', async () => {
    const response = await createResource({ slot_duration: 'P1D', slot_anchor_time: '14:00' })
    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({ slot_duration: 'P1D', slot_anchor_time: '14:00' })
  })

  it('rejects an unknown timezone', async () => {
    const response = await createResource({ timezone: 'Mars/Olympus' })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('validation_error')
  })

  it('rejects a malformed duration', async () => {
    const response = await createResource({ slot_duration: 'PT24H' })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('validation_error')
  })

  it('rejects exclusive mode with capacity above one', async () => {
    const response = await createResource({ concurrency_mode: 'exclusive', capacity: 3 })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('validation_error')
  })

  it('accepts shared mode with capacity above one', async () => {
    const response = await createResource({ concurrency_mode: 'shared', capacity: 12 })
    expect(response.statusCode).toBe(201)
    expect(response.json().capacity).toBe(12)
  })

  it('rejects pool mode until spec 3', async () => {
    const response = await createResource({ concurrency_mode: 'pool' })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('unsupported_concurrency_mode')
  })

  it('rejects a non-default anchor on an intraday resource', async () => {
    const response = await createResource({ slot_duration: 'PT30M', slot_anchor_time: '14:00' })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('validation_error')
  })
})

describe('GET /resources/:id', () => {
  it('returns a resource', async () => {
    const { id } = (await createResource()).json()
    const response = await app.inject({ method: 'GET', url: `/resources/${id}` })
    expect(response.statusCode).toBe(200)
    expect(response.json().id).toBe(id)
  })

  it('returns 404 for an unknown id', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/resources/00000000-0000-0000-0000-000000000000',
    })
    expect(response.statusCode).toBe(404)
    expect(response.json().error).toBe('not_found')
  })

  it('returns 400 for a malformed id', async () => {
    const response = await app.inject({ method: 'GET', url: '/resources/not-a-uuid' })
    expect(response.statusCode).toBe(400)
  })
})

describe('PATCH /resources/:id', () => {
  it('updates the mutable fields', async () => {
    const { id } = (await createResource()).json()
    const response = await app.inject({
      method: 'PATCH',
      url: `/resources/${id}`,
      payload: { slot_duration: 'PT30M', is_active: false },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ slot_duration: 'PT30M', is_active: false })
  })

  it('rejects an attempt to change the timezone', async () => {
    const { id } = (await createResource()).json()
    const response = await app.inject({
      method: 'PATCH',
      url: `/resources/${id}`,
      payload: { timezone: 'Europe/Berlin' },
    })
    expect(response.statusCode).toBe(400)
  })

  it('rejects an attempt to change the concurrency mode', async () => {
    const { id } = (await createResource()).json()
    const response = await app.inject({
      method: 'PATCH',
      url: `/resources/${id}`,
      payload: { concurrency_mode: 'shared' },
    })
    expect(response.statusCode).toBe(400)
  })

  it('rejects an anchor that becomes invalid for the new duration', async () => {
    const { id } = (
      await createResource({ slot_duration: 'P1D', slot_anchor_time: '14:00' })
    ).json()
    const response = await app.inject({
      method: 'PATCH',
      url: `/resources/${id}`,
      payload: { slot_duration: 'PT1H' },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('validation_error')
  })

  it('returns 404 for an unknown id', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/resources/00000000-0000-0000-0000-000000000000',
      payload: { is_active: false },
    })
    expect(response.statusCode).toBe(404)
  })
})

describe('DELETE /resources/:id', () => {
  it('deletes a resource', async () => {
    const { id } = (await createResource()).json()
    const response = await app.inject({ method: 'DELETE', url: `/resources/${id}` })
    expect(response.statusCode).toBe(204)

    const after = await app.inject({ method: 'GET', url: `/resources/${id}` })
    expect(after.statusCode).toBe(404)
  })

  it('returns 404 for an unknown id', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: '/resources/00000000-0000-0000-0000-000000000000',
    })
    expect(response.statusCode).toBe(404)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/integration/resources.test.ts`
Expected: FAIL — every request returns the 404 body from `setNotFoundHandler`.

- [ ] **Step 3: Write the schemas**

`src/modules/resources/resource.schemas.ts`:

```ts
import { Type, type Static } from 'typebox'

export const TimeOfDay = Type.String({ pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' })
export const Uuid = Type.String({ format: 'uuid' })

export const ResourceParams = Type.Object({ id: Uuid })
export type ResourceParams = Static<typeof ResourceParams>

export const CreateResourceBody = Type.Object(
  {
    timezone: Type.String({ minLength: 1 }),
    slot_duration: Type.String({ minLength: 2 }),
    slot_anchor_time: Type.Optional(TimeOfDay),
    capacity: Type.Optional(Type.Integer({ minimum: 1 })),
    concurrency_mode: Type.Union([
      Type.Literal('exclusive'),
      Type.Literal('shared'),
      Type.Literal('pool'),
    ]),
  },
  { additionalProperties: false },
)
export type CreateResourceBody = Static<typeof CreateResourceBody>

export const UpdateResourceBody = Type.Object(
  {
    slot_duration: Type.Optional(Type.String({ minLength: 2 })),
    slot_anchor_time: Type.Optional(TimeOfDay),
    capacity: Type.Optional(Type.Integer({ minimum: 1 })),
    is_active: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
)
export type UpdateResourceBody = Static<typeof UpdateResourceBody>

export const ResourceResponse = Type.Object({
  id: Uuid,
  timezone: Type.String(),
  slot_duration: Type.String(),
  slot_anchor_time: TimeOfDay,
  capacity: Type.Integer(),
  concurrency_mode: Type.String(),
  is_active: Type.Boolean(),
})
export type ResourceResponse = Static<typeof ResourceResponse>

export const ErrorResponse = Type.Object({
  error: Type.String(),
  message: Type.String(),
  details: Type.Optional(Type.Unknown()),
})
```

`additionalProperties: false` is what turns "change the timezone via PATCH" into a 400 rather than a silently ignored field.

- [ ] **Step 4: Write the repository**

`src/modules/resources/resource.repository.ts`:

```ts
import type { Kysely } from 'kysely'
import type { Database } from '../../db/schema.js'

export interface ResourceRow {
  id: string
  timezone: string
  slot_duration: string
  slot_anchor_time: string
  capacity: number
  concurrency_mode: string
  is_active: boolean
}

const columns = [
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
  concurrency_mode: string
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
      .returning(columns)
      .executeTakeFirstOrThrow()
  }

  async findById(id: string): Promise<ResourceRow | undefined> {
    return this.db.selectFrom('resources').select(columns).where('id', '=', id).executeTakeFirst()
  }

  async update(id: string, values: UpdateResource): Promise<ResourceRow | undefined> {
    return this.db
      .updateTable('resources')
      .set({ ...values, updated_at: new Date() })
      .where('id', '=', id)
      .returning(columns)
      .executeTakeFirst()
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.deleteFrom('resources').where('id', '=', id).executeTakeFirst()
    return (result.numDeletedRows ?? 0n) > 0n
  }
}
```

- [ ] **Step 5: Write the service**

`src/modules/resources/resource.service.ts`:

```ts
import { IANAZone } from 'luxon'
import {
  InvalidDurationError,
  formatTime,
  parseSlotDuration,
  type SlotDuration,
} from '../../shared/time.js'
import {
  NotFoundError,
  UnsupportedConcurrencyModeError,
  ValidationError,
} from '../../shared/errors.js'
import type { ResourceRepository, ResourceRow } from './resource.repository.js'
import type {
  CreateResourceBody,
  ResourceResponse,
  UpdateResourceBody,
} from './resource.schemas.js'

const DEFAULT_ANCHOR = '00:00'

function parseDurationOrFail(value: string): SlotDuration {
  try {
    return parseSlotDuration(value)
  } catch (error) {
    if (error instanceof InvalidDurationError) {
      throw new ValidationError(error.message, { field: 'slot_duration' })
    }
    throw error
  }
}

/**
 * The anchor is only consulted for day-based resources. Silently ignoring a value the
 * caller explicitly set is a worse failure mode than rejecting it, so an intraday
 * resource must leave the anchor at its default.
 */
function assertAnchorMatchesDuration(duration: SlotDuration, anchor: string): void {
  if (duration.kind === 'intraday' && anchor !== DEFAULT_ANCHOR) {
    throw new ValidationError(
      `slot_anchor_time must be ${DEFAULT_ANCHOR} for an intraday resource; it only applies to P<n>D durations`,
      { field: 'slot_anchor_time' },
    )
  }
}

function assertCapacityMatchesMode(mode: string, capacity: number): void {
  if (mode === 'exclusive' && capacity !== 1) {
    throw new ValidationError('capacity must be 1 when concurrency_mode is "exclusive"', {
      field: 'capacity',
    })
  }
}

export function toResponse(row: ResourceRow): ResourceResponse {
  return {
    id: row.id,
    timezone: row.timezone,
    slot_duration: row.slot_duration,
    slot_anchor_time: formatTime(row.slot_anchor_time),
    capacity: row.capacity,
    concurrency_mode: row.concurrency_mode,
    is_active: row.is_active,
  }
}

export class ResourceService {
  constructor(private readonly repository: ResourceRepository) {}

  async create(body: CreateResourceBody): Promise<ResourceResponse> {
    if (body.concurrency_mode === 'pool') {
      throw new UnsupportedConcurrencyModeError(
        'concurrency_mode "pool" is not implemented yet; storing a resource the engine cannot serve availability for would be worse than refusing it',
      )
    }

    if (!IANAZone.isValidZone(body.timezone)) {
      throw new ValidationError(`Unknown IANA timezone "${body.timezone}"`, { field: 'timezone' })
    }

    const duration = parseDurationOrFail(body.slot_duration)
    const anchor = body.slot_anchor_time ?? DEFAULT_ANCHOR
    const capacity = body.capacity ?? 1

    assertAnchorMatchesDuration(duration, anchor)
    assertCapacityMatchesMode(body.concurrency_mode, capacity)

    const row = await this.repository.insert({
      timezone: body.timezone,
      slot_duration: duration.iso,
      slot_anchor_time: anchor,
      capacity,
      concurrency_mode: body.concurrency_mode,
    })

    return toResponse(row)
  }

  async getById(id: string): Promise<ResourceResponse> {
    return toResponse(await this.loadOrFail(id))
  }

  async update(id: string, body: UpdateResourceBody): Promise<ResourceResponse> {
    const current = await this.loadOrFail(id)

    // Validate the resulting state, not the patch: changing only the duration can
    // invalidate an anchor that was legal before.
    const duration = parseDurationOrFail(body.slot_duration ?? current.slot_duration)
    const anchor = body.slot_anchor_time ?? formatTime(current.slot_anchor_time)
    const capacity = body.capacity ?? current.capacity

    assertAnchorMatchesDuration(duration, anchor)
    assertCapacityMatchesMode(current.concurrency_mode, capacity)

    const row = await this.repository.update(id, {
      slot_duration: duration.iso,
      slot_anchor_time: anchor,
      capacity,
      ...(body.is_active === undefined ? {} : { is_active: body.is_active }),
    })

    if (!row) throw new NotFoundError(`Resource ${id} not found`)
    return toResponse(row)
  }

  async delete(id: string): Promise<void> {
    const deleted = await this.repository.delete(id)
    if (!deleted) throw new NotFoundError(`Resource ${id} not found`)
  }

  async loadOrFail(id: string): Promise<ResourceRow> {
    const row = await this.repository.findById(id)
    if (!row) throw new NotFoundError(`Resource ${id} not found`)
    return row
  }
}
```

- [ ] **Step 6: Write the routes**

`src/modules/resources/resource.routes.ts`:

```ts
import { Type } from 'typebox'
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { ResourceRepository } from './resource.repository.js'
import { ResourceService } from './resource.service.js'
import {
  CreateResourceBody,
  ErrorResponse,
  ResourceParams,
  ResourceResponse,
  UpdateResourceBody,
} from './resource.schemas.js'

export const resourceRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const service = new ResourceService(new ResourceRepository(app.db))

  app.post(
    '/resources',
    {
      schema: {
        body: CreateResourceBody,
        response: { 201: ResourceResponse, 400: ErrorResponse },
      },
    },
    async (request, reply) => reply.status(201).send(await service.create(request.body)),
  )

  app.get(
    '/resources/:id',
    {
      schema: {
        params: ResourceParams,
        response: { 200: ResourceResponse, 404: ErrorResponse },
      },
    },
    async (request) => service.getById(request.params.id),
  )

  app.patch(
    '/resources/:id',
    {
      schema: {
        params: ResourceParams,
        body: UpdateResourceBody,
        response: { 200: ResourceResponse, 400: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (request) => service.update(request.params.id, request.body),
  )

  app.delete(
    '/resources/:id',
    {
      schema: {
        params: ResourceParams,
        response: { 204: Type.Null(), 404: ErrorResponse },
      },
    },
    async (request, reply) => {
      await service.delete(request.params.id)
      return reply.status(204).send()
    },
  )
}
```

- [ ] **Step 7: Register the routes**

In `src/app.ts`, after `registerErrorHandler(app)`:

```ts
void app.register(resourceRoutes)
```

with the import:

```ts
import { resourceRoutes } from './modules/resources/resource.routes.js'
```

- [ ] **Step 8: Run the tests and confirm they pass**

Run: `npx vitest run tests/integration/resources.test.ts`
Expected: PASS, 17 tests.

If `format: 'uuid'` is not enforced, install and register `ajv-formats` — Fastify 5 ships AJV without the format vocabulary. The symptom is the "malformed id" test returning 500 instead of 400. Fix by adding to `buildApp`:

```ts
import addFormats from 'ajv-formats'
// ...
const app = Fastify({
  logger: { level: deps.config.logLevel },
  ajv: { plugins: [addFormats] },
}).withTypeProvider<TypeBoxTypeProvider>()
```

after `npm i ajv-formats`.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: resource CRUD with validation"
```

---

### Task 6: Schedule module

**Files:**

- Create: `src/modules/schedule/schedule.schemas.ts`, `schedule.repository.ts`, `schedule.service.ts`, `schedule.routes.ts`
- Modify: `src/app.ts`
- Test: `tests/unit/schedule-validation.test.ts`, `tests/integration/schedule.test.ts`

**Interfaces:**

- Consumes: `ResourceService.loadOrFail`, `parseSlotDuration`, `formatTime`, error classes.
- Produces:
  - `validateScheduleSet(rules: ScheduleRuleInput[], duration: SlotDuration): void` — pure, throws `ScheduleShapeMismatchError` / `ScheduleOverlapError`
  - `ScheduleRepository` with `listByResource`, `replaceForResource`
  - `ScheduleService` with `list`, `replace`
  - `scheduleRoutes: FastifyPluginAsyncTypebox`

- [ ] **Step 1: Write the failing unit test for set validation**

`tests/unit/schedule-validation.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { parseSlotDuration } from '../../src/shared/time.js'
import { validateScheduleSet } from '../../src/modules/schedule/schedule.service.js'

const intraday = parseSlotDuration('PT1H')
const dayBased = parseSlotDuration('P1D')

describe('validateScheduleSet', () => {
  it('accepts disjoint windows on the same weekday', () => {
    expect(() =>
      validateScheduleSet(
        [
          { day_of_week: 0, start_time: '09:00', end_time: '12:00' },
          { day_of_week: 0, start_time: '13:00', end_time: '17:00' },
        ],
        intraday,
      ),
    ).not.toThrow()
  })

  it('accepts windows that merely touch', () => {
    expect(() =>
      validateScheduleSet(
        [
          { day_of_week: 0, start_time: '09:00', end_time: '12:00' },
          { day_of_week: 0, start_time: '12:00', end_time: '17:00' },
        ],
        intraday,
      ),
    ).not.toThrow()
  })

  it('rejects overlapping windows on the same weekday', () => {
    expect(() =>
      validateScheduleSet(
        [
          { day_of_week: 0, start_time: '09:00', end_time: '13:00' },
          { day_of_week: 0, start_time: '12:00', end_time: '17:00' },
        ],
        intraday,
      ),
    ).toThrow(/overlap/i)
  })

  it('allows identical windows on different weekdays', () => {
    expect(() =>
      validateScheduleSet(
        [
          { day_of_week: 0, start_time: '09:00', end_time: '17:00' },
          { day_of_week: 1, start_time: '09:00', end_time: '17:00' },
        ],
        intraday,
      ),
    ).not.toThrow()
  })

  it('rejects null times on an intraday resource', () => {
    expect(() =>
      validateScheduleSet([{ day_of_week: 0, start_time: null, end_time: null }], intraday),
    ).toThrow(/shape/i)
  })

  it('rejects set times on a day-based resource', () => {
    expect(() =>
      validateScheduleSet([{ day_of_week: 0, start_time: '09:00', end_time: '17:00' }], dayBased),
    ).toThrow(/shape/i)
  })

  it('rejects two rules on one weekday for a day-based resource', () => {
    expect(() =>
      validateScheduleSet(
        [
          { day_of_week: 0, start_time: null, end_time: null },
          { day_of_week: 0, start_time: null, end_time: null },
        ],
        dayBased,
      ),
    ).toThrow(/shape/i)
  })

  it('rejects a window that ends before it starts', () => {
    expect(() =>
      validateScheduleSet([{ day_of_week: 0, start_time: '17:00', end_time: '09:00' }], intraday),
    ).toThrow(/start_time/)
  })

  it('accepts an empty set', () => {
    expect(() => validateScheduleSet([], intraday)).not.toThrow()
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/unit/schedule-validation.test.ts`
Expected: FAIL — cannot resolve the schedule service module.

- [ ] **Step 3: Write the schemas**

`src/modules/schedule/schedule.schemas.ts`:

```ts
import { Type, type Static } from 'typebox'
import { TimeOfDay, Uuid } from '../resources/resource.schemas.js'

export const ScheduleRuleInput = Type.Object(
  {
    day_of_week: Type.Integer({ minimum: 0, maximum: 6 }),
    start_time: Type.Union([TimeOfDay, Type.Null()]),
    end_time: Type.Union([TimeOfDay, Type.Null()]),
  },
  { additionalProperties: false },
)
export type ScheduleRuleInput = Static<typeof ScheduleRuleInput>

export const ReplaceScheduleBody = Type.Array(ScheduleRuleInput)
export type ReplaceScheduleBody = Static<typeof ReplaceScheduleBody>

export const ScheduleRuleResponse = Type.Object({
  id: Uuid,
  day_of_week: Type.Integer(),
  start_time: Type.Union([TimeOfDay, Type.Null()]),
  end_time: Type.Union([TimeOfDay, Type.Null()]),
})

export const ScheduleResponse = Type.Array(ScheduleRuleResponse)
export type ScheduleRuleResponse = Static<typeof ScheduleRuleResponse>
```

- [ ] **Step 4: Write the service with the pure validator**

`src/modules/schedule/schedule.service.ts`:

```ts
import {
  ScheduleOverlapError,
  ScheduleShapeMismatchError,
  ValidationError,
} from '../../shared/errors.js'
import { formatTime, parseSlotDuration, type SlotDuration } from '../../shared/time.js'
import type { ResourceService } from '../resources/resource.service.js'
import type { ScheduleRepository, ScheduleRow } from './schedule.repository.js'
import type { ScheduleRuleInput, ScheduleRuleResponse } from './schedule.schemas.js'

function toMinutes(time: string): number {
  const [hours, minutes] = time.split(':')
  return Number(hours) * 60 + Number(minutes)
}

/**
 * Validates the submitted set as a whole. Per-row invariants are also enforced by CHECK
 * constraints in the database; the rules that span rows — overlap and shape consistency —
 * can only live here.
 */
export function validateScheduleSet(rules: ScheduleRuleInput[], duration: SlotDuration): void {
  for (const rule of rules) {
    const bothNull = rule.start_time === null && rule.end_time === null
    const bothSet = rule.start_time !== null && rule.end_time !== null

    if (!bothNull && !bothSet) {
      throw new ValidationError('start_time and end_time must both be set or both be null', {
        day_of_week: rule.day_of_week,
      })
    }

    if (duration.kind === 'day' && !bothNull) {
      throw new ScheduleShapeMismatchError(
        'A day-based resource (P<n>D) requires schedule rules with null times',
        { day_of_week: rule.day_of_week },
      )
    }

    if (duration.kind === 'intraday' && !bothSet) {
      throw new ScheduleShapeMismatchError(
        'An intraday resource (PT…) requires schedule rules with both times set',
        { day_of_week: rule.day_of_week },
      )
    }

    if (bothSet && toMinutes(rule.start_time!) >= toMinutes(rule.end_time!)) {
      throw new ValidationError(
        'start_time must be earlier than end_time; windows crossing midnight are not supported',
        { day_of_week: rule.day_of_week },
      )
    }
  }

  const byDay = new Map<number, ScheduleRuleInput[]>()
  for (const rule of rules) {
    const bucket = byDay.get(rule.day_of_week) ?? []
    bucket.push(rule)
    byDay.set(rule.day_of_week, bucket)
  }

  for (const [day, bucket] of byDay) {
    if (duration.kind === 'day' && bucket.length > 1) {
      throw new ScheduleShapeMismatchError(
        'A day-based resource allows at most one schedule rule per weekday',
        { day_of_week: day },
      )
    }

    const sorted = bucket
      .filter((rule) => rule.start_time !== null)
      .map((rule) => ({ start: toMinutes(rule.start_time!), end: toMinutes(rule.end_time!) }))
      .sort((a, b) => a.start - b.start)

    for (let i = 1; i < sorted.length; i += 1) {
      // Touching endpoints are fine: 09:00–12:00 and 12:00–17:00 do not overlap.
      if (sorted[i]!.start < sorted[i - 1]!.end) {
        throw new ScheduleOverlapError('Schedule rules on the same weekday must not overlap', {
          day_of_week: day,
        })
      }
    }
  }
}

export function toScheduleResponse(row: ScheduleRow): ScheduleRuleResponse {
  return {
    id: row.id,
    day_of_week: row.day_of_week,
    start_time: row.start_time === null ? null : formatTime(row.start_time),
    end_time: row.end_time === null ? null : formatTime(row.end_time),
  }
}

export class ScheduleService {
  constructor(
    private readonly repository: ScheduleRepository,
    private readonly resources: ResourceService,
  ) {}

  async list(resourceId: string): Promise<ScheduleRuleResponse[]> {
    await this.resources.loadOrFail(resourceId)
    const rows = await this.repository.listByResource(resourceId)
    return rows.map(toScheduleResponse)
  }

  async replace(resourceId: string, rules: ScheduleRuleInput[]): Promise<ScheduleRuleResponse[]> {
    const resource = await this.resources.loadOrFail(resourceId)
    validateScheduleSet(rules, parseSlotDuration(resource.slot_duration))
    const rows = await this.repository.replaceForResource(resourceId, rules)
    return rows.map(toScheduleResponse)
  }
}
```

- [ ] **Step 5: Run the unit test and confirm it passes**

Run: `npx vitest run tests/unit/schedule-validation.test.ts`
Expected: PASS, 9 tests. The repository import is type-only, so the missing file does not break the run — but create it in the next step before running anything else.

- [ ] **Step 6: Write the repository**

`src/modules/schedule/schedule.repository.ts`:

```ts
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

export class ScheduleRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async listByResource(resourceId: string): Promise<ScheduleRow[]> {
    return this.db
      .selectFrom('schedule')
      .select(columns)
      .where('resource_id', '=', resourceId)
      .orderBy('day_of_week')
      .orderBy('start_time')
      .execute()
  }

  /** Delete-then-insert in one transaction: a rejected submission must leave the old schedule intact. */
  async replaceForResource(resourceId: string, rules: ScheduleRuleInput[]): Promise<ScheduleRow[]> {
    return this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('schedule').where('resource_id', '=', resourceId).execute()

      if (rules.length === 0) return []

      return trx
        .insertInto('schedule')
        .values(
          rules.map((rule) => ({
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
```

- [ ] **Step 7: Write the routes and register them**

`src/modules/schedule/schedule.routes.ts`:

```ts
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { ResourceRepository } from '../resources/resource.repository.js'
import { ResourceService } from '../resources/resource.service.js'
import { ErrorResponse, ResourceParams } from '../resources/resource.schemas.js'
import { ScheduleRepository } from './schedule.repository.js'
import { ScheduleService } from './schedule.service.js'
import { ReplaceScheduleBody, ScheduleResponse } from './schedule.schemas.js'

export const scheduleRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const service = new ScheduleService(
    new ScheduleRepository(app.db),
    new ResourceService(new ResourceRepository(app.db)),
  )

  app.get(
    '/resources/:id/schedule',
    {
      schema: {
        params: ResourceParams,
        response: { 200: ScheduleResponse, 404: ErrorResponse },
      },
    },
    async (request) => service.list(request.params.id),
  )

  app.put(
    '/resources/:id/schedule',
    {
      schema: {
        params: ResourceParams,
        body: ReplaceScheduleBody,
        response: { 200: ScheduleResponse, 400: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (request) => service.replace(request.params.id, request.body),
  )
}
```

In `src/app.ts`, alongside the resource routes:

```ts
import { scheduleRoutes } from './modules/schedule/schedule.routes.js'
// ...
void app.register(scheduleRoutes)
```

- [ ] **Step 8: Write the failing integration test**

`tests/integration/schedule.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, closeTestDb, resetDb } from './helpers.js'

let app: FastifyInstance

beforeAll(async () => {
  app = await buildTestApp()
})

beforeEach(resetDb)

afterAll(async () => {
  await app.close()
  await closeTestDb()
})

async function createResource(overrides: Record<string, unknown> = {}): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/resources',
    payload: {
      timezone: 'Europe/Warsaw',
      slot_duration: 'PT1H',
      concurrency_mode: 'exclusive',
      ...overrides,
    },
  })
  return response.json().id
}

describe('PUT /resources/:id/schedule', () => {
  it('stores and returns the submitted rules', async () => {
    const id = await createResource()
    const response = await app.inject({
      method: 'PUT',
      url: `/resources/${id}/schedule`,
      payload: [
        { day_of_week: 0, start_time: '09:00', end_time: '17:00' },
        { day_of_week: 1, start_time: '09:00', end_time: '17:00' },
      ],
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toHaveLength(2)
    expect(response.json()[0]).toMatchObject({
      day_of_week: 0,
      start_time: '09:00',
      end_time: '17:00',
    })
  })

  it('replaces the previous schedule entirely', async () => {
    const id = await createResource()
    await app.inject({
      method: 'PUT',
      url: `/resources/${id}/schedule`,
      payload: [{ day_of_week: 0, start_time: '09:00', end_time: '17:00' }],
    })
    await app.inject({
      method: 'PUT',
      url: `/resources/${id}/schedule`,
      payload: [{ day_of_week: 3, start_time: '10:00', end_time: '14:00' }],
    })

    const listed = await app.inject({ method: 'GET', url: `/resources/${id}/schedule` })
    expect(listed.json()).toHaveLength(1)
    expect(listed.json()[0]).toMatchObject({ day_of_week: 3 })
  })

  it('accepts an empty schedule', async () => {
    const id = await createResource()
    const response = await app.inject({
      method: 'PUT',
      url: `/resources/${id}/schedule`,
      payload: [],
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual([])
  })

  it('leaves the old schedule intact when the submission is rejected', async () => {
    const id = await createResource()
    await app.inject({
      method: 'PUT',
      url: `/resources/${id}/schedule`,
      payload: [{ day_of_week: 0, start_time: '09:00', end_time: '17:00' }],
    })

    const rejected = await app.inject({
      method: 'PUT',
      url: `/resources/${id}/schedule`,
      payload: [
        { day_of_week: 1, start_time: '09:00', end_time: '13:00' },
        { day_of_week: 1, start_time: '12:00', end_time: '17:00' },
      ],
    })
    expect(rejected.statusCode).toBe(400)
    expect(rejected.json().error).toBe('schedule_overlap')

    const listed = await app.inject({ method: 'GET', url: `/resources/${id}/schedule` })
    expect(listed.json()).toHaveLength(1)
    expect(listed.json()[0]).toMatchObject({ day_of_week: 0 })
  })

  it('rejects a shape mismatched to an intraday duration', async () => {
    const id = await createResource()
    const response = await app.inject({
      method: 'PUT',
      url: `/resources/${id}/schedule`,
      payload: [{ day_of_week: 0, start_time: null, end_time: null }],
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('schedule_shape_mismatch')
  })

  it('rejects a shape mismatched to a day-based duration', async () => {
    const id = await createResource({ slot_duration: 'P1D', slot_anchor_time: '14:00' })
    const response = await app.inject({
      method: 'PUT',
      url: `/resources/${id}/schedule`,
      payload: [{ day_of_week: 0, start_time: '09:00', end_time: '17:00' }],
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('schedule_shape_mismatch')
  })

  it('returns 404 for an unknown resource', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/resources/00000000-0000-0000-0000-000000000000/schedule',
      payload: [],
    })
    expect(response.statusCode).toBe(404)
  })
})

describe('GET /resources/:id/schedule', () => {
  it('returns an empty list for a resource without a schedule', async () => {
    const id = await createResource()
    const response = await app.inject({ method: 'GET', url: `/resources/${id}/schedule` })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual([])
  })
})
```

- [ ] **Step 9: Run the suite and confirm it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: weekly schedule with whole-set validation"
```

---

### Task 7: Schedule exceptions module

**Files:**

- Create: `src/modules/exceptions/exception.schemas.ts`, `exception.repository.ts`, `exception.service.ts`, `exception.routes.ts`
- Create: `src/shared/range.ts`
- Modify: `src/app.ts`
- Test: `tests/unit/range.test.ts`, `tests/integration/exceptions.test.ts`

**Interfaces:**

- Consumes: `ResourceService.loadOrFail`, `validateScheduleSet`-style shape rules, error classes.
- Produces:
  - `assertValidRange(from: string, to: string, maxRangeDays: number): void` in `src/shared/range.ts`
  - `ExceptionRepository` with `listInRange`, `upsert`, `delete`
  - `ExceptionService` with `list`, `put`, `delete`
  - `exceptionRoutes: FastifyPluginAsyncTypebox`

- [ ] **Step 1: Write the failing range test**

`tests/unit/range.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { assertValidRange } from '../../src/shared/range.js'

describe('assertValidRange', () => {
  it('accepts a normal range', () => {
    expect(() => assertValidRange('2026-07-20', '2026-07-27', 366)).not.toThrow()
  })

  it('rejects an inverted range', () => {
    expect(() => assertValidRange('2026-07-27', '2026-07-20', 366)).toThrow(/after/i)
  })

  it('rejects an empty range', () => {
    expect(() => assertValidRange('2026-07-20', '2026-07-20', 366)).toThrow(/after/i)
  })

  it('accepts a range exactly at the limit', () => {
    expect(() => assertValidRange('2026-01-01', '2026-01-08', 7)).not.toThrow()
  })

  it('rejects a range wider than the limit', () => {
    expect(() => assertValidRange('2026-01-01', '2026-01-09', 7)).toThrow(/7 days/)
  })

  it('rejects an unparseable date', () => {
    expect(() => assertValidRange('20-07-2026', '2026-07-27', 366)).toThrow(/date/i)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/unit/range.test.ts`
Expected: FAIL — cannot resolve `../../src/shared/range.js`.

- [ ] **Step 3: Implement the range guard**

`src/shared/range.ts`:

```ts
import { DateTime } from 'luxon'
import { InvalidRangeError } from './errors.js'

/** Ranges are half-open: `from` inclusive, `to` exclusive. */
export function assertValidRange(from: string, to: string, maxRangeDays: number): void {
  const start = DateTime.fromISO(from, { zone: 'utc' })
  const end = DateTime.fromISO(to, { zone: 'utc' })

  if (!start.isValid || !end.isValid) {
    throw new InvalidRangeError('from and to must be valid YYYY-MM-DD dates', { from, to })
  }

  if (end <= start) {
    throw new InvalidRangeError('to must be after from', { from, to })
  }

  const days = end.diff(start, 'days').days
  if (days > maxRangeDays) {
    throw new InvalidRangeError(`Range must not exceed ${maxRangeDays} days`, { from, to, days })
  }
}
```

- [ ] **Step 4: Run the range test and confirm it passes**

Run: `npx vitest run tests/unit/range.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Write the schemas, repository and service**

`src/modules/exceptions/exception.schemas.ts`:

```ts
import { Type, type Static } from 'typebox'
import { TimeOfDay, Uuid } from '../resources/resource.schemas.js'

export const IsoDate = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' })

export const ExceptionParams = Type.Object({ id: Uuid, date: IsoDate })
export type ExceptionParams = Static<typeof ExceptionParams>

export const ExceptionRangeQuery = Type.Object({ from: IsoDate, to: IsoDate })
export type ExceptionRangeQuery = Static<typeof ExceptionRangeQuery>

export const PutExceptionBody = Type.Object(
  {
    start_time: Type.Union([TimeOfDay, Type.Null()]),
    end_time: Type.Union([TimeOfDay, Type.Null()]),
  },
  { additionalProperties: false },
)
export type PutExceptionBody = Static<typeof PutExceptionBody>

export const ExceptionResponse = Type.Object({
  id: Uuid,
  date: IsoDate,
  start_time: Type.Union([TimeOfDay, Type.Null()]),
  end_time: Type.Union([TimeOfDay, Type.Null()]),
})
export type ExceptionResponse = Static<typeof ExceptionResponse>

export const ExceptionListResponse = Type.Array(ExceptionResponse)
```

`src/modules/exceptions/exception.repository.ts`:

```ts
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
  async listInRange(resourceId: string, from: string, to: string): Promise<ExceptionRow[]> {
    return this.db
      .selectFrom('schedule_exceptions')
      .select(columns)
      .where('resource_id', '=', resourceId)
      .where('date', '>=', from)
      .where('date', '<', to)
      .orderBy('date')
      .execute()
  }

  async upsert(
    resourceId: string,
    date: string,
    startTime: string | null,
    endTime: string | null,
  ): Promise<ExceptionRow> {
    return this.db
      .insertInto('schedule_exceptions')
      .values({ resource_id: resourceId, date, start_time: startTime, end_time: endTime })
      .onConflict((oc) =>
        oc
          .columns(['resource_id', 'date'])
          .doUpdateSet({ start_time: startTime, end_time: endTime }),
      )
      .returning(columns)
      .executeTakeFirstOrThrow()
  }

  async delete(resourceId: string, date: string): Promise<void> {
    await this.db
      .deleteFrom('schedule_exceptions')
      .where('resource_id', '=', resourceId)
      .where('date', '=', date)
      .execute()
  }
}
```

`src/modules/exceptions/exception.service.ts`:

```ts
import { ScheduleShapeMismatchError, ValidationError } from '../../shared/errors.js'
import { assertValidRange } from '../../shared/range.js'
import { formatTime, parseSlotDuration } from '../../shared/time.js'
import type { ResourceService } from '../resources/resource.service.js'
import type { ExceptionRepository, ExceptionRow } from './exception.repository.js'
import type { ExceptionResponse, PutExceptionBody } from './exception.schemas.js'

function toMinutes(time: string): number {
  const [hours, minutes] = time.split(':')
  return Number(hours) * 60 + Number(minutes)
}

function toResponse(row: ExceptionRow): ExceptionResponse {
  return {
    id: row.id,
    date: row.date,
    start_time: row.start_time === null ? null : formatTime(row.start_time),
    end_time: row.end_time === null ? null : formatTime(row.end_time),
  }
}

export class ExceptionService {
  constructor(
    private readonly repository: ExceptionRepository,
    private readonly resources: ResourceService,
    private readonly maxRangeDays: number,
  ) {}

  async list(resourceId: string, from: string, to: string): Promise<ExceptionResponse[]> {
    await this.resources.loadOrFail(resourceId)
    assertValidRange(from, to, this.maxRangeDays)
    const rows = await this.repository.listInRange(resourceId, from, to)
    return rows.map(toResponse)
  }

  async put(resourceId: string, date: string, body: PutExceptionBody): Promise<ExceptionResponse> {
    const resource = await this.resources.loadOrFail(resourceId)
    const duration = parseSlotDuration(resource.slot_duration)

    const bothNull = body.start_time === null && body.end_time === null
    const bothSet = body.start_time !== null && body.end_time !== null

    if (!bothNull && !bothSet) {
      throw new ValidationError(
        'start_time and end_time must both be set (altered hours) or both be null (day off)',
      )
    }

    // A day off is expressible for any resource; altered hours must match the resource's shape.
    if (bothSet && duration.kind === 'day') {
      throw new ScheduleShapeMismatchError(
        'A day-based resource (P<n>D) only accepts exceptions with null times, meaning a day off',
      )
    }

    if (bothSet && toMinutes(body.start_time!) >= toMinutes(body.end_time!)) {
      throw new ValidationError(
        'start_time must be earlier than end_time; windows crossing midnight are not supported',
      )
    }

    const row = await this.repository.upsert(resourceId, date, body.start_time, body.end_time)
    return toResponse(row)
  }

  /** Idempotent: deleting an exception that does not exist is not an error. */
  async delete(resourceId: string, date: string): Promise<void> {
    await this.resources.loadOrFail(resourceId)
    await this.repository.delete(resourceId, date)
  }
}
```

`src/modules/exceptions/exception.routes.ts`:

```ts
import { Type } from 'typebox'
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { ResourceRepository } from '../resources/resource.repository.js'
import { ResourceService } from '../resources/resource.service.js'
import { ErrorResponse, ResourceParams } from '../resources/resource.schemas.js'
import { ExceptionRepository } from './exception.repository.js'
import { ExceptionService } from './exception.service.js'
import {
  ExceptionListResponse,
  ExceptionParams,
  ExceptionRangeQuery,
  ExceptionResponse,
  PutExceptionBody,
} from './exception.schemas.js'

export const exceptionRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const service = new ExceptionService(
    new ExceptionRepository(app.db),
    new ResourceService(new ResourceRepository(app.db)),
    app.config.maxRangeDays,
  )

  app.get(
    '/resources/:id/exceptions',
    {
      schema: {
        params: ResourceParams,
        querystring: ExceptionRangeQuery,
        response: { 200: ExceptionListResponse, 400: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (request) => service.list(request.params.id, request.query.from, request.query.to),
  )

  app.put(
    '/resources/:id/exceptions/:date',
    {
      schema: {
        params: ExceptionParams,
        body: PutExceptionBody,
        response: { 200: ExceptionResponse, 400: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (request) => service.put(request.params.id, request.params.date, request.body),
  )

  app.delete(
    '/resources/:id/exceptions/:date',
    {
      schema: {
        params: ExceptionParams,
        response: { 204: Type.Null(), 404: ErrorResponse },
      },
    },
    async (request, reply) => {
      await service.delete(request.params.id, request.params.date)
      return reply.status(204).send()
    },
  )
}
```

Register in `src/app.ts`:

```ts
import { exceptionRoutes } from './modules/exceptions/exception.routes.js'
// ...
void app.register(exceptionRoutes)
```

- [ ] **Step 6: Write the failing integration test**

`tests/integration/exceptions.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, closeTestDb, resetDb } from './helpers.js'

let app: FastifyInstance

beforeAll(async () => {
  app = await buildTestApp()
})

beforeEach(resetDb)

afterAll(async () => {
  await app.close()
  await closeTestDb()
})

async function createResource(overrides: Record<string, unknown> = {}): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/resources',
    payload: {
      timezone: 'Europe/Warsaw',
      slot_duration: 'PT1H',
      concurrency_mode: 'exclusive',
      ...overrides,
    },
  })
  return response.json().id
}

describe('PUT /resources/:id/exceptions/:date', () => {
  it('stores altered hours', async () => {
    const id = await createResource()
    const response = await app.inject({
      method: 'PUT',
      url: `/resources/${id}/exceptions/2026-07-20`,
      payload: { start_time: '10:00', end_time: '14:00' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      date: '2026-07-20',
      start_time: '10:00',
      end_time: '14:00',
    })
  })

  it('stores a day off', async () => {
    const id = await createResource()
    const response = await app.inject({
      method: 'PUT',
      url: `/resources/${id}/exceptions/2026-07-20`,
      payload: { start_time: null, end_time: null },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().start_time).toBeNull()
  })

  it('overwrites on repeat, staying idempotent', async () => {
    const id = await createResource()
    const url = `/resources/${id}/exceptions/2026-07-20`

    await app.inject({ method: 'PUT', url, payload: { start_time: '10:00', end_time: '14:00' } })
    const second = await app.inject({
      method: 'PUT',
      url,
      payload: { start_time: '11:00', end_time: '15:00' },
    })

    expect(second.statusCode).toBe(200)
    expect(second.json()).toMatchObject({ start_time: '11:00', end_time: '15:00' })

    const listed = await app.inject({
      method: 'GET',
      url: `/resources/${id}/exceptions?from=2026-07-01&to=2026-08-01`,
    })
    expect(listed.json()).toHaveLength(1)
  })

  it('rejects only one time being set', async () => {
    const id = await createResource()
    const response = await app.inject({
      method: 'PUT',
      url: `/resources/${id}/exceptions/2026-07-20`,
      payload: { start_time: '10:00', end_time: null },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('validation_error')
  })

  it('rejects altered hours on a day-based resource', async () => {
    const id = await createResource({ slot_duration: 'P1D', slot_anchor_time: '14:00' })
    const response = await app.inject({
      method: 'PUT',
      url: `/resources/${id}/exceptions/2026-07-20`,
      payload: { start_time: '10:00', end_time: '14:00' },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('schedule_shape_mismatch')
  })

  it('accepts a day off on a day-based resource', async () => {
    const id = await createResource({ slot_duration: 'P1D', slot_anchor_time: '14:00' })
    const response = await app.inject({
      method: 'PUT',
      url: `/resources/${id}/exceptions/2026-07-20`,
      payload: { start_time: null, end_time: null },
    })
    expect(response.statusCode).toBe(200)
  })
})

describe('GET /resources/:id/exceptions', () => {
  it('is half-open on the upper bound', async () => {
    const id = await createResource()
    for (const date of ['2026-07-19', '2026-07-20', '2026-07-21']) {
      await app.inject({
        method: 'PUT',
        url: `/resources/${id}/exceptions/${date}`,
        payload: { start_time: null, end_time: null },
      })
    }

    const response = await app.inject({
      method: 'GET',
      url: `/resources/${id}/exceptions?from=2026-07-19&to=2026-07-21`,
    })
    expect(response.json().map((row: { date: string }) => row.date)).toEqual([
      '2026-07-19',
      '2026-07-20',
    ])
  })

  it('rejects an over-wide range', async () => {
    const id = await createResource()
    const response = await app.inject({
      method: 'GET',
      url: `/resources/${id}/exceptions?from=2026-01-01&to=2028-01-01`,
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('invalid_range')
  })

  it('rejects a missing range', async () => {
    const id = await createResource()
    const response = await app.inject({ method: 'GET', url: `/resources/${id}/exceptions` })
    expect(response.statusCode).toBe(400)
  })
})

describe('DELETE /resources/:id/exceptions/:date', () => {
  it('deletes an existing exception', async () => {
    const id = await createResource()
    await app.inject({
      method: 'PUT',
      url: `/resources/${id}/exceptions/2026-07-20`,
      payload: { start_time: null, end_time: null },
    })

    const response = await app.inject({
      method: 'DELETE',
      url: `/resources/${id}/exceptions/2026-07-20`,
    })
    expect(response.statusCode).toBe(204)
  })

  it('returns 204 for a date with no exception', async () => {
    const id = await createResource()
    const response = await app.inject({
      method: 'DELETE',
      url: `/resources/${id}/exceptions/2026-07-20`,
    })
    expect(response.statusCode).toBe(204)
  })
})
```

- [ ] **Step 7: Run the suite and confirm it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: per-date schedule exceptions"
```

---

### Task 8: Slot generator — the pure core

**Files:**

- Create: `src/modules/availability/slot-generator.ts`
- Test: `tests/unit/slot-generator.test.ts`

**Interfaces:**

- Consumes: Luxon, `SlotDuration` from `src/shared/time.ts`. **Must not import from `src/db/`.**
- Produces:
  - `AvailabilityWindow = { start: string | null; end: string | null }` (`HH:MM`)
  - `GenerateSlotsInput = { dates: string[]; windowsByDate: Map<string, AvailabilityWindow[]>; timezone: string; slotDuration: SlotDuration; anchorTime: string }`
  - `Slot = { start: string; end: string }` — ISO-8601 with offset
  - `generateSlots(input: GenerateSlotsInput): Slot[]`

- [ ] **Step 1: Write the failing test**

`tests/unit/slot-generator.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { DateTime } from 'luxon'
import { parseSlotDuration } from '../../src/shared/time.js'
import {
  generateSlots,
  type AvailabilityWindow,
  type GenerateSlotsInput,
} from '../../src/modules/availability/slot-generator.js'

function input(overrides: Partial<GenerateSlotsInput> = {}): GenerateSlotsInput {
  return {
    dates: ['2026-07-20'],
    windowsByDate: new Map([['2026-07-20', [{ start: '09:00', end: '12:00' }]]]),
    timezone: 'Europe/Warsaw',
    slotDuration: parseSlotDuration('PT1H'),
    anchorTime: '00:00',
    ...overrides,
  }
}

function hoursBetween(slot: { start: string; end: string }): number {
  return DateTime.fromISO(slot.end).diff(DateTime.fromISO(slot.start), 'hours').hours
}

describe('generateSlots — intraday', () => {
  it('slices a window into whole slots', () => {
    const slots = generateSlots(input())
    expect(slots).toEqual([
      { start: '2026-07-20T09:00:00+02:00', end: '2026-07-20T10:00:00+02:00' },
      { start: '2026-07-20T10:00:00+02:00', end: '2026-07-20T11:00:00+02:00' },
      { start: '2026-07-20T11:00:00+02:00', end: '2026-07-20T12:00:00+02:00' },
    ])
  })

  it('drops a trailing remainder shorter than one slot', () => {
    const slots = generateSlots(
      input({
        windowsByDate: new Map([['2026-07-20', [{ start: '09:00', end: '17:30' }]]]),
      }),
    )
    expect(slots).toHaveLength(8)
    expect(slots.at(-1)).toEqual({
      start: '2026-07-20T16:00:00+02:00',
      end: '2026-07-20T17:00:00+02:00',
    })
  })

  it('gives each window on a day its own grid', () => {
    const slots = generateSlots(
      input({
        slotDuration: parseSlotDuration('PT1H'),
        windowsByDate: new Map([
          [
            '2026-07-20',
            [
              { start: '09:00', end: '11:00' },
              { start: '12:30', end: '14:30' },
            ],
          ],
        ]),
      }),
    )
    expect(slots.map((slot) => slot.start)).toEqual([
      '2026-07-20T09:00:00+02:00',
      '2026-07-20T10:00:00+02:00',
      '2026-07-20T12:30:00+02:00',
      '2026-07-20T13:30:00+02:00',
    ])
  })

  it('returns nothing for a date with no windows', () => {
    expect(generateSlots(input({ windowsByDate: new Map() }))).toEqual([])
  })

  it('returns nothing for a window shorter than one slot', () => {
    const slots = generateSlots(
      input({ windowsByDate: new Map([['2026-07-20', [{ start: '09:00', end: '09:30' }]]]) }),
    )
    expect(slots).toEqual([])
  })

  it('emits slots in ascending order across dates', () => {
    const windows: AvailabilityWindow[] = [{ start: '09:00', end: '10:00' }]
    const slots = generateSlots(
      input({
        dates: ['2026-07-21', '2026-07-20'],
        windowsByDate: new Map([
          ['2026-07-20', windows],
          ['2026-07-21', windows],
        ]),
      }),
    )
    expect(slots.map((slot) => slot.start)).toEqual([
      '2026-07-20T09:00:00+02:00',
      '2026-07-21T09:00:00+02:00',
    ])
  })
})

describe('generateSlots — day-based', () => {
  it('emits one slot per day running anchor to anchor', () => {
    const slots = generateSlots(
      input({
        dates: ['2026-07-20', '2026-07-21'],
        windowsByDate: new Map([
          ['2026-07-20', [{ start: null, end: null }]],
          ['2026-07-21', [{ start: null, end: null }]],
        ]),
        slotDuration: parseSlotDuration('P1D'),
        anchorTime: '14:00',
      }),
    )

    expect(slots).toEqual([
      { start: '2026-07-20T14:00:00+02:00', end: '2026-07-21T14:00:00+02:00' },
      { start: '2026-07-21T14:00:00+02:00', end: '2026-07-22T14:00:00+02:00' },
    ])
  })

  it('produces calendar days with the default anchor', () => {
    const slots = generateSlots(
      input({
        windowsByDate: new Map([['2026-07-20', [{ start: null, end: null }]]]),
        slotDuration: parseSlotDuration('P1D'),
        anchorTime: '00:00',
      }),
    )
    expect(slots).toEqual([
      { start: '2026-07-20T00:00:00+02:00', end: '2026-07-21T00:00:00+02:00' },
    ])
  })

  it('emits a multi-day slot for P7D', () => {
    const slots = generateSlots(
      input({
        windowsByDate: new Map([['2026-07-20', [{ start: null, end: null }]]]),
        slotDuration: parseSlotDuration('P7D'),
        anchorTime: '16:00',
      }),
    )
    expect(slots).toEqual([
      { start: '2026-07-20T16:00:00+02:00', end: '2026-07-27T16:00:00+02:00' },
    ])
  })
})

describe('generateSlots — DST in Europe/Warsaw', () => {
  // Warsaw springs forward on 2026-03-29 (02:00 -> 03:00) and falls back on 2026-10-25.
  it('spans 23 real hours on the spring-forward day', () => {
    const slots = generateSlots(
      input({
        dates: ['2026-03-29'],
        windowsByDate: new Map([['2026-03-29', [{ start: null, end: null }]]]),
        slotDuration: parseSlotDuration('P1D'),
        anchorTime: '00:00',
      }),
    )
    expect(slots).toHaveLength(1)
    expect(hoursBetween(slots[0]!)).toBe(23)
    expect(slots[0]!.start).toBe('2026-03-29T00:00:00+01:00')
    expect(slots[0]!.end).toBe('2026-03-30T00:00:00+02:00')
  })

  it('spans 25 real hours on the fall-back day', () => {
    const slots = generateSlots(
      input({
        dates: ['2026-10-25'],
        windowsByDate: new Map([['2026-10-25', [{ start: null, end: null }]]]),
        slotDuration: parseSlotDuration('P1D'),
        anchorTime: '00:00',
      }),
    )
    expect(slots).toHaveLength(1)
    expect(hoursBetween(slots[0]!)).toBe(25)
  })

  it('keeps a 14:00 anchor at 14:00 local across the spring transition', () => {
    const slots = generateSlots(
      input({
        dates: ['2026-03-28', '2026-03-29'],
        windowsByDate: new Map([
          ['2026-03-28', [{ start: null, end: null }]],
          ['2026-03-29', [{ start: null, end: null }]],
        ]),
        slotDuration: parseSlotDuration('P1D'),
        anchorTime: '14:00',
      }),
    )
    expect(slots.map((slot) => slot.start)).toEqual([
      '2026-03-28T14:00:00+01:00',
      '2026-03-29T14:00:00+02:00',
    ])
    // Consecutive slots stay contiguous even though one of them is 23 hours long.
    expect(slots[0]!.end).toBe(slots[1]!.start)
  })

  it('does not drift an intraday grid on a transition day', () => {
    const slots = generateSlots(
      input({
        dates: ['2026-03-29'],
        windowsByDate: new Map([['2026-03-29', [{ start: '09:00', end: '12:00' }]]]),
      }),
    )
    expect(slots.map((slot) => slot.start)).toEqual([
      '2026-03-29T09:00:00+02:00',
      '2026-03-29T10:00:00+02:00',
      '2026-03-29T11:00:00+02:00',
    ])
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/unit/slot-generator.test.ts`
Expected: FAIL — cannot resolve the slot-generator module.

- [ ] **Step 3: Implement the generator**

`src/modules/availability/slot-generator.ts`:

```ts
import { DateTime } from 'luxon'
import type { SlotDuration } from '../../shared/time.js'

export interface AvailabilityWindow {
  /** 'HH:MM', or null for a day-based resource where the anchor supplies the start */
  start: string | null
  /** 'HH:MM', or null for a day-based resource where the slot itself supplies the end */
  end: string | null
}

export interface GenerateSlotsInput {
  /** 'YYYY-MM-DD' dates, in the resource's timezone */
  dates: string[]
  windowsByDate: Map<string, AvailabilityWindow[]>
  timezone: string
  slotDuration: SlotDuration
  /** 'HH:MM' */
  anchorTime: string
}

export interface Slot {
  /** ISO-8601 with offset */
  start: string
  end: string
}

function at(date: string, time: string, timezone: string): DateTime {
  return DateTime.fromISO(`${date}T${time}`, { zone: timezone })
}

function toIso(dt: DateTime): string {
  const iso = dt.toISO({ suppressMilliseconds: true, suppressSeconds: false })
  if (!iso) throw new Error(`Could not format ${dt.toString()} as ISO-8601`)
  return iso
}

/**
 * Pure: no database access, no clock reads. All local-time arithmetic goes through Luxon
 * with the resource's zone, so a day-based slot naturally spans 23, 24 or 25 real hours
 * across a DST transition while still running from local anchor to local anchor.
 */
export function generateSlots(input: GenerateSlotsInput): Slot[] {
  const slots: Slot[] = []

  for (const date of input.dates) {
    const windows = input.windowsByDate.get(date) ?? []

    for (const window of windows) {
      let cursor = at(date, window.start ?? input.anchorTime, input.timezone)

      // A window with no end time is day-based: it is exactly one slot long.
      const windowEnd =
        window.end === null
          ? cursor.plus(input.slotDuration.luxon)
          : at(date, window.end, input.timezone)

      while (cursor.plus(input.slotDuration.luxon) <= windowEnd) {
        const end = cursor.plus(input.slotDuration.luxon)
        slots.push({ start: toIso(cursor), end: toIso(end) })
        cursor = end
      }
    }
  }

  return slots.sort((a, b) => a.start.localeCompare(b.start))
}
```

Note on the final sort: ISO-8601 strings with differing offsets do not sort lexicographically by instant in general. Within one resource the offset changes at most twice a year and never reorders adjacent days, so string comparison is safe here — but if a future change makes ordering load-bearing across zones, sort on `DateTime` instead.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run tests/unit/slot-generator.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Verify the isolation rule holds**

Run: `grep -rn "db/" src/modules/availability/slot-generator.ts`
Expected: no output. Any match is a design violation and must be removed.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: DST-correct slot generator"
```

---

### Task 9: Availability endpoint

**Files:**

- Create: `src/modules/availability/availability.schemas.ts`, `availability.service.ts`, `availability.routes.ts`
- Modify: `src/app.ts`
- Test: `tests/integration/availability.test.ts`

**Interfaces:**

- Consumes: `generateSlots`, `enumerateDates`, `dayOfWeekOf`, `assertValidRange`, `ScheduleRepository`, `ExceptionRepository`, `ResourceService`.
- Produces:
  - `AvailabilityService.getAvailability(resourceId, from, to): Promise<{ slots: AvailabilitySlot[] }>`
  - `AvailabilitySlot = { start: string; end: string; available: boolean }`
  - `availabilityRoutes: FastifyPluginAsyncTypebox`

- [ ] **Step 1: Write the failing test**

`tests/integration/availability.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, closeTestDb, resetDb } from './helpers.js'

let app: FastifyInstance

beforeAll(async () => {
  app = await buildTestApp()
})

beforeEach(resetDb)

afterAll(async () => {
  await app.close()
  await closeTestDb()
})

async function createResource(overrides: Record<string, unknown> = {}): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/resources',
    payload: {
      timezone: 'Europe/Warsaw',
      slot_duration: 'PT1H',
      concurrency_mode: 'exclusive',
      ...overrides,
    },
  })
  return response.json().id
}

async function setSchedule(id: string, rules: unknown[]): Promise<void> {
  await app.inject({ method: 'PUT', url: `/resources/${id}/schedule`, payload: rules })
}

async function availability(id: string, from: string, to: string) {
  return app.inject({ method: 'GET', url: `/resources/${id}/availability?from=${from}&to=${to}` })
}

describe('GET /resources/:id/availability', () => {
  it('returns slots for an intraday resource', async () => {
    const id = await createResource()
    // 2026-07-20 is a Monday, so day_of_week 0.
    await setSchedule(id, [{ day_of_week: 0, start_time: '09:00', end_time: '12:00' }])

    const response = await availability(id, '2026-07-20', '2026-07-21')
    expect(response.statusCode).toBe(200)
    expect(response.json().slots).toEqual([
      { start: '2026-07-20T09:00:00+02:00', end: '2026-07-20T10:00:00+02:00', available: true },
      { start: '2026-07-20T10:00:00+02:00', end: '2026-07-20T11:00:00+02:00', available: true },
      { start: '2026-07-20T11:00:00+02:00', end: '2026-07-20T12:00:00+02:00', available: true },
    ])
  })

  it('maps weekdays with Monday as zero', async () => {
    const id = await createResource()
    // day_of_week 6 is Sunday: 2026-07-26.
    await setSchedule(id, [{ day_of_week: 6, start_time: '09:00', end_time: '10:00' }])

    const response = await availability(id, '2026-07-20', '2026-07-27')
    expect(response.json().slots).toHaveLength(1)
    expect(response.json().slots[0].start).toBe('2026-07-26T09:00:00+02:00')
  })

  it('returns anchor-to-anchor slots for a day-based resource', async () => {
    const id = await createResource({ slot_duration: 'P1D', slot_anchor_time: '14:00' })
    await setSchedule(
      id,
      [0, 1, 2].map((day) => ({ day_of_week: day, start_time: null, end_time: null })),
    )

    const response = await availability(id, '2026-07-20', '2026-07-23')
    expect(response.json().slots).toEqual([
      { start: '2026-07-20T14:00:00+02:00', end: '2026-07-21T14:00:00+02:00', available: true },
      { start: '2026-07-21T14:00:00+02:00', end: '2026-07-22T14:00:00+02:00', available: true },
      { start: '2026-07-22T14:00:00+02:00', end: '2026-07-23T14:00:00+02:00', available: true },
    ])
  })

  it('is half-open: no slot falls on the `to` date', async () => {
    const id = await createResource()
    await setSchedule(
      id,
      [0, 1].map((day) => ({ day_of_week: day, start_time: '09:00', end_time: '10:00' })),
    )

    const response = await availability(id, '2026-07-20', '2026-07-21')
    expect(response.json().slots).toHaveLength(1)
    expect(response.json().slots[0].start).toContain('2026-07-20')
  })

  it('lets an exception replace the weekly schedule for that date', async () => {
    const id = await createResource()
    await setSchedule(id, [{ day_of_week: 0, start_time: '09:00', end_time: '12:00' }])
    await app.inject({
      method: 'PUT',
      url: `/resources/${id}/exceptions/2026-07-20`,
      payload: { start_time: '15:00', end_time: '17:00' },
    })

    const response = await availability(id, '2026-07-20', '2026-07-21')
    expect(response.json().slots.map((slot: { start: string }) => slot.start)).toEqual([
      '2026-07-20T15:00:00+02:00',
      '2026-07-20T16:00:00+02:00',
    ])
  })

  it('produces no slots on a day off', async () => {
    const id = await createResource()
    await setSchedule(id, [{ day_of_week: 0, start_time: '09:00', end_time: '12:00' }])
    await app.inject({
      method: 'PUT',
      url: `/resources/${id}/exceptions/2026-07-20`,
      payload: { start_time: null, end_time: null },
    })

    const response = await availability(id, '2026-07-20', '2026-07-21')
    expect(response.json().slots).toEqual([])
  })

  it('returns an empty list for an inactive resource', async () => {
    const id = await createResource()
    await setSchedule(id, [{ day_of_week: 0, start_time: '09:00', end_time: '12:00' }])
    await app.inject({ method: 'PATCH', url: `/resources/${id}`, payload: { is_active: false } })

    const response = await availability(id, '2026-07-20', '2026-07-21')
    expect(response.statusCode).toBe(200)
    expect(response.json().slots).toEqual([])
  })

  it('returns an empty list when no schedule exists', async () => {
    const id = await createResource()
    const response = await availability(id, '2026-07-20', '2026-07-21')
    expect(response.json().slots).toEqual([])
  })

  it('rejects an inverted range', async () => {
    const id = await createResource()
    const response = await availability(id, '2026-07-21', '2026-07-20')
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('invalid_range')
  })

  it('rejects an over-wide range', async () => {
    const id = await createResource()
    const response = await availability(id, '2026-01-01', '2028-01-01')
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('invalid_range')
  })

  it('returns 404 for an unknown resource', async () => {
    const response = await availability(
      '00000000-0000-0000-0000-000000000000',
      '2026-07-20',
      '2026-07-21',
    )
    expect(response.statusCode).toBe(404)
  })

  it('crosses a DST transition correctly', async () => {
    const id = await createResource({ slot_duration: 'P1D', slot_anchor_time: '14:00' })
    await setSchedule(
      id,
      [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day_of_week: day, start_time: null, end_time: null })),
    )

    // Warsaw springs forward on 2026-03-29.
    const response = await availability(id, '2026-03-28', '2026-03-31')
    const slots = response.json().slots
    expect(slots.map((slot: { start: string }) => slot.start)).toEqual([
      '2026-03-28T14:00:00+01:00',
      '2026-03-29T14:00:00+02:00',
      '2026-03-30T14:00:00+02:00',
    ])
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/integration/availability.test.ts`
Expected: FAIL — the route does not exist, so every request returns 404 `not_found`.

- [ ] **Step 3: Write the schemas**

`src/modules/availability/availability.schemas.ts`:

```ts
import { Type, type Static } from 'typebox'
import { IsoDate } from '../exceptions/exception.schemas.js'

export const AvailabilityQuery = Type.Object({ from: IsoDate, to: IsoDate })
export type AvailabilityQuery = Static<typeof AvailabilityQuery>

export const AvailabilitySlot = Type.Object({
  start: Type.String(),
  end: Type.String(),
  available: Type.Boolean(),
})
export type AvailabilitySlot = Static<typeof AvailabilitySlot>

export const AvailabilityResponse = Type.Object({ slots: Type.Array(AvailabilitySlot) })
export type AvailabilityResponse = Static<typeof AvailabilityResponse>
```

- [ ] **Step 4: Write the service**

`src/modules/availability/availability.service.ts`:

```ts
import { DateTime } from 'luxon'
import { assertValidRange } from '../../shared/range.js'
import { dayOfWeekOf, enumerateDates, formatTime, parseSlotDuration } from '../../shared/time.js'
import type { ExceptionRepository } from '../exceptions/exception.repository.js'
import type { ResourceService } from '../resources/resource.service.js'
import type { ScheduleRepository } from '../schedule/schedule.repository.js'
import { generateSlots, type AvailabilityWindow } from './slot-generator.js'
import type { AvailabilityResponse } from './availability.schemas.js'

export class AvailabilityService {
  constructor(
    private readonly resources: ResourceService,
    private readonly schedule: ScheduleRepository,
    private readonly exceptions: ExceptionRepository,
    private readonly maxRangeDays: number,
  ) {}

  async getAvailability(
    resourceId: string,
    from: string,
    to: string,
  ): Promise<AvailabilityResponse> {
    const resource = await this.resources.loadOrFail(resourceId)
    assertValidRange(from, to, this.maxRangeDays)

    // An inactive resource exists but is not bookable: 404 would be wrong, and returning
    // slots would be misleading.
    if (!resource.is_active) return { slots: [] }

    const [scheduleRows, exceptionRows] = await Promise.all([
      this.schedule.listByResource(resourceId),
      this.exceptions.listInRange(resourceId, from, to),
    ])

    const windowsByWeekday = new Map<number, AvailabilityWindow[]>()
    for (const row of scheduleRows) {
      const bucket = windowsByWeekday.get(row.day_of_week) ?? []
      bucket.push({
        start: row.start_time === null ? null : formatTime(row.start_time),
        end: row.end_time === null ? null : formatTime(row.end_time),
      })
      windowsByWeekday.set(row.day_of_week, bucket)
    }

    const exceptionsByDate = new Map(exceptionRows.map((row) => [row.date, row]))

    const dates = enumerateDates(from, to, resource.timezone)
    const windowsByDate = new Map<string, AvailabilityWindow[]>()

    for (const date of dates) {
      const exception = exceptionsByDate.get(date)

      if (exception) {
        // A day off (both times null) contributes no windows; altered hours replace the
        // weekly schedule for this date entirely, they never merge with it.
        if (exception.start_time !== null && exception.end_time !== null) {
          windowsByDate.set(date, [
            { start: formatTime(exception.start_time), end: formatTime(exception.end_time) },
          ])
        }
        continue
      }

      const weekday = dayOfWeekOf(DateTime.fromISO(date, { zone: resource.timezone }))
      const windows = windowsByWeekday.get(weekday)
      if (windows) windowsByDate.set(date, windows)
    }

    const slots = generateSlots({
      dates,
      windowsByDate,
      timezone: resource.timezone,
      slotDuration: parseSlotDuration(resource.slot_duration),
      anchorTime: formatTime(resource.slot_anchor_time),
    })

    // Every slot is free: bookings arrive in spec 2. The field exists from the start so
    // that the contract does not change when they do.
    return { slots: slots.map((slot) => ({ ...slot, available: true })) }
  }
}
```

A day-off exception for a day-based resource is handled by the same branch: it contributes no window, so the date yields no slot.

- [ ] **Step 5: Write the routes and register them**

`src/modules/availability/availability.routes.ts`:

```ts
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { ExceptionRepository } from '../exceptions/exception.repository.js'
import { ResourceRepository } from '../resources/resource.repository.js'
import { ResourceService } from '../resources/resource.service.js'
import { ErrorResponse, ResourceParams } from '../resources/resource.schemas.js'
import { ScheduleRepository } from '../schedule/schedule.repository.js'
import { AvailabilityService } from './availability.service.js'
import { AvailabilityQuery, AvailabilityResponse } from './availability.schemas.js'

export const availabilityRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const service = new AvailabilityService(
    new ResourceService(new ResourceRepository(app.db)),
    new ScheduleRepository(app.db),
    new ExceptionRepository(app.db),
    app.config.maxRangeDays,
  )

  app.get(
    '/resources/:id/availability',
    {
      schema: {
        params: ResourceParams,
        querystring: AvailabilityQuery,
        response: { 200: AvailabilityResponse, 400: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (request) =>
      service.getAvailability(request.params.id, request.query.from, request.query.to),
  )
}
```

In `src/app.ts`:

```ts
import { availabilityRoutes } from './modules/availability/availability.routes.js'
// ...
void app.register(availabilityRoutes)
```

- [ ] **Step 6: Run the suite and confirm it passes**

Run: `npm test`
Expected: PASS, all files.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: availability endpoint"
```

---

### Task 10: README and final verification

**Files:**

- Create: `README.md`
- Test: the whole suite, plus a manual smoke run

**Interfaces:**

- Consumes: everything.
- Produces: nothing new.

- [ ] **Step 1: Write the README**

`README.md`:

````markdown
# Booking Engine

A domain-agnostic booking engine. It operates on three abstractions — resource, schedule,
booking — and knows nothing about what is being booked. Domain-specific data lives in a
separate layer above, in its own tables referencing `resource_id`.

Spec 1 (this stage) implements resources, schedules, per-date exceptions and availability.
Bookings arrive in spec 2.

- Architecture: [docs/architecture.md](docs/architecture.md)
- Current spec: [docs/superpowers/specs/2026-07-27-resources-schedule-availability-design.md](docs/superpowers/specs/2026-07-27-resources-schedule-availability-design.md)
- Contributing and commit conventions: [CONTRIBUTING.md](CONTRIBUTING.md)

## Requirements

- Node.js 24 (current active LTS)
- PostgreSQL 16+
- Docker (for the test suite, which runs against a real Postgres via Testcontainers)

## Getting started

```bash
npm install
cp .env.example .env      # then edit DATABASE_URL
npm run migrate
npm run dev
```

## Scripts

| Command           | Purpose                        |
| ----------------- | ------------------------------ |
| `npm run dev`     | Start with reload              |
| `npm run build`   | Compile to `dist/`             |
| `npm start`       | Run the compiled build         |
| `npm run migrate` | Apply migrations               |
| `npm test`        | Run unit and integration tests |
| `npm run format`  | Format with Prettier           |

## API

| Method | Path                                    | Purpose                                                             |
| ------ | --------------------------------------- | ------------------------------------------------------------------- |
| GET    | `/health`                               | Liveness                                                            |
| POST   | `/resources`                            | Create a resource                                                   |
| GET    | `/resources/:id`                        | Read a resource                                                     |
| PATCH  | `/resources/:id`                        | Update `slot_duration`, `slot_anchor_time`, `capacity`, `is_active` |
| DELETE | `/resources/:id`                        | Delete a resource and its schedule                                  |
| GET    | `/resources/:id/schedule`               | Read the weekly schedule                                            |
| PUT    | `/resources/:id/schedule`               | Replace the weekly schedule                                         |
| GET    | `/resources/:id/exceptions?from=&to=`   | List exceptions in a range                                          |
| PUT    | `/resources/:id/exceptions/:date`       | Create or overwrite an exception                                    |
| DELETE | `/resources/:id/exceptions/:date`       | Remove an exception                                                 |
| GET    | `/resources/:id/availability?from=&to=` | Compute available slots                                             |

### Conventions

- Date ranges are half-open: `from` inclusive, `to` exclusive, at most `MAX_RANGE_DAYS`.
- Durations use a restricted ISO-8601 grammar: `P<n>D`, or `PT[<n>H][<n>M]` under 24 hours.
  `P1D` and `PT24H` are **not** interchangeable — `P1D` runs from local anchor to local
  anchor and therefore spans 23, 24 or 25 real hours across a DST transition.
- A resource is day-based if and only if its duration uses the `P<n>D` form. Day-based
  resources take schedule rules with null times; intraday resources require both times.
- `slot_anchor_time` sets where a day-based resource's day begins (a hotel with 14:00
  check-in sets `14:00`). It must stay at `00:00` for intraday resources.
- Timestamps in responses carry an offset: `2026-07-20T09:00:00+02:00`.
- Errors have the shape `{ error, message, details? }`.

## Example

```bash
# A hotel room: nightly, day starts at 14:00
curl -X POST localhost:3000/resources -H 'content-type: application/json' -d '{
  "timezone": "Europe/Warsaw",
  "slot_duration": "P1D",
  "slot_anchor_time": "14:00",
  "concurrency_mode": "exclusive"
}'

# Bookable every day of the week
curl -X PUT localhost:3000/resources/$ID/schedule -H 'content-type: application/json' -d '[
  {"day_of_week":0,"start_time":null,"end_time":null},
  {"day_of_week":1,"start_time":null,"end_time":null},
  {"day_of_week":2,"start_time":null,"end_time":null},
  {"day_of_week":3,"start_time":null,"end_time":null},
  {"day_of_week":4,"start_time":null,"end_time":null},
  {"day_of_week":5,"start_time":null,"end_time":null},
  {"day_of_week":6,"start_time":null,"end_time":null}
]'

curl "localhost:3000/resources/$ID/availability?from=2026-07-20&to=2026-07-23"
```

## Known limitations

Deliberate, documented in §9 of the spec: no windows crossing midnight, `pool` concurrency
mode rejected until spec 3, no schedule history, and a slot grid anchored per window rather
than globally.

## Authentication

None. The engine is an internal service; authorization belongs to the domain layer above.
All routes register through a single plugin, so a `preHandler` hook can be added in one
place when needed.
````

- [ ] **Step 2: Verify the type check passes**

Run: `npx tsc --noEmit`
Expected: no output, exit code 0.

- [ ] **Step 3: Verify the whole suite passes**

Run: `npm test`
Expected: all test files pass. Record the actual counts; do not claim success without reading the output.

- [ ] **Step 4: Verify the service starts against a real database**

```bash
docker run --rm -d --name be-pg -e POSTGRES_PASSWORD=postgres -p 5433:5432 postgres:16-alpine
DATABASE_URL=postgres://postgres:postgres@localhost:5433/postgres npm run migrate
DATABASE_URL=postgres://postgres:postgres@localhost:5433/postgres npm run dev
```

In another shell:

```bash
curl -s localhost:3000/health
```

Expected: `{"status":"ok"}`. Then run the hotel example from the README end to end and confirm three slots come back with `+02:00` offsets. Stop the container with `docker rm -f be-pg`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: README and usage examples"
```

---

## Self-review notes

Spec coverage was checked section by section:

| Spec section              | Covered by                                                 |
| ------------------------- | ---------------------------------------------------------- |
| §2 stack                  | Task 1                                                     |
| §3 layout                 | Tasks 1, 2                                                 |
| §4 data model             | Task 2                                                     |
| §5.1 resource validation  | Task 5                                                     |
| §5.2 schedule validation  | Task 6                                                     |
| §5.3 exception validation | Task 7                                                     |
| §6.1 conventions          | Tasks 3, 5, 7                                              |
| §6.2 resources API        | Task 5                                                     |
| §6.3 schedule API         | Task 6                                                     |
| §6.4 exceptions API       | Task 7                                                     |
| §6.5 availability API     | Task 9                                                     |
| §7.1–7.4 algorithm        | Tasks 8, 9                                                 |
| §7.5 error handling       | Task 4                                                     |
| §7.6 auth extension point | Task 4 (single plugin registration), documented in Task 10 |
| §8 configuration          | Task 1                                                     |
| §9 limitations            | Documented in Task 10                                      |
| §10 testing               | Every task                                                 |
| §11 definition of done    | Task 10                                                    |

Two spec requirements deserve explicit note because they are easy to lose:

1. **`available` is always `true`** but the field ships now, so spec 2 changes behaviour without changing the contract. Asserted in the Task 9 tests.
2. **The isolation rule** — `slot-generator.ts` must not import from `db/` — is verified mechanically in Task 8, Step 5, not merely stated.
