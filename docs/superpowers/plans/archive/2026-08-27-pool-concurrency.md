# The `pool` concurrency mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a caller book a group of interchangeable resources as one, so that a member can be individually unavailable — room 101 out of service on the 20th while 102 keeps selling — which a scalar `capacity` cannot express.

**Architecture:** One nullable self-referencing column, `resources.pool_id`, joined by a composite foreign key on `(tenant_id, pool_id)` so a cross-tenant member is unwritable. A pool is a resource with `concurrency_mode = 'pool'`; its members are ordinary `exclusive` resources. Booking a pool validates the interval against the pool's grid, narrows to members that offer the run, then claims one with `FOR UPDATE SKIP LOCKED` — no capacity count and no pool lock, because each member's disjointness is already carried by `bookings_no_overlap`. A pool's availability is the union over its members, computed from three batched queries.

**Tech Stack:** Node 24 LTS · TypeScript strict · Fastify 5 · TypeBox · Kysely + `pg` · PostgreSQL 16 · Luxon · Vitest + Testcontainers

**Spec:** [2026-08-27-pool-concurrency-design.md](../specs/2026-08-27-pool-concurrency-design.md)

**Branch:** `spec-3-pool`, already created and holding the spec commit.

## Global Constraints

The engine-wide rules live in [conventions.md](../../conventions.md), which is authoritative. They are restated here because a task may be executed by someone who sees only that task. If the two disagree, `conventions.md` is right and this list is stale.

- TypeScript `strict: true`, NodeNext modules. Relative imports carry a `.js` extension even in `.ts` files. No `any` outside Kysely migration signatures, where `Kysely<any>` is required by Kysely itself.
- The TypeBox package is `typebox` (not `@sinclair/typebox`), paired with `@fastify/type-provider-typebox`.
- Every error response has the shape `{ error, message, details? }`. Unknown fields in a request body are rejected, never ignored — `additionalProperties: false` on every body schema.
- Every route carries `tags`, `summary` and a `response` map, plus `config: { scope }` or `config: { public: true }`. A route with neither fails at startup.
- **No new routes and no new scope in this slice.** A pool is a resource; `resources.*`, `availability.read` and `bookings.*` already cover it.
- Repositories take `tenantId` as a required first parameter. A forgotten filter must be a compile error.
- Test data lives in `tests/fixtures/datasets/` as typed tables consumed by `it.each`. Shared entities go behind factories in `tests/fixtures/`. Extending coverage means adding a row, not copying a test.
- `src/modules/availability/slot-generator.ts` and `src/modules/bookings/booking-validator.ts` must not import anything from `src/db/`. A `grep` for `db/` in either must come back empty.
- **Where a resource has a parent, the parent is locked before the member.** In this slice that fires on exactly one path — Task 6.
- `./run check` must be clean before every commit. `./run openapi` after any route schema change, and the regenerated `openapi.json` is committed with it.
- Commit messages are a **single line**: Conventional Commits `type(scope): subject`, imperative, lowercase, no body, no trailers.

## File Structure

**Created**

| File                                           | Responsibility                                       |
| ---------------------------------------------- | ---------------------------------------------------- |
| `src/db/migrations/004_pools.ts`               | The column, its constraints and its index            |
| `src/modules/resources/pool.repository.ts`     | Member lookup and claim-a-member; the only pool SQL  |
| `src/modules/resources/pool.service.ts`        | Membership rules, and the pool-shaped resource rules |
| `tests/fixtures/datasets/pool-membership.ts`   | Accepted and rejected `pool_id` writes               |
| `tests/fixtures/datasets/pool-availability.ts` | Member layouts and the union they must produce       |
| `tests/fixtures/suites/pools.ts`               | The smoke suite over those datasets                  |
| `tests/integration/pools.test.ts`              | Membership, availability, selection, idempotency     |

**Modified**

| File                                               | Change                                                        |
| -------------------------------------------------- | ------------------------------------------------------------- |
| `src/db/schema.ts`                                 | `pool_id` on `ResourcesTable`                                 |
| `src/modules/resources/resource.repository.ts`     | `pool_id` in `ResourceRow`, `resourceColumns`, insert/update  |
| `src/modules/resources/resource.schemas.ts`        | `pool_id` on create, patch and response                       |
| `src/modules/resources/resource.service.ts`        | Lift the `pool` refusal; delegate membership to `PoolService` |
| `src/modules/resources/resource.routes.ts`         | Wire `PoolService` in                                         |
| `src/modules/schedule/schedule.service.ts`         | Refuse a schedule write on a pool                             |
| `src/modules/exceptions/exception.service.ts`      | Refuse an exception write on a pool                           |
| `src/modules/schedule/schedule.repository.ts`      | `listByResourceIds`                                           |
| `src/modules/exceptions/exception.repository.ts`   | `listInRangeForResources`                                     |
| `src/modules/bookings/booking.repository.ts`       | `activeInRangeForResources`, `inPoolWriteTransaction`         |
| `src/modules/availability/availability.service.ts` | The pool branch and the batched union                         |
| `src/modules/bookings/booking.service.ts`          | The pool branch in `create`                                   |
| `src/shared/errors.ts`                             | `InvalidPoolMembershipError`, `PoolHasMembersError`           |
| `tests/fixtures/suites/index.ts`                   | One line for the new suite                                    |

---

### Task 1: The migration

**Files:**

- Create: `src/db/migrations/004_pools.ts`
- Modify: `src/db/migrations/index.ts`, `src/db/schema.ts`
- Test: `tests/integration/migrations.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: the column `resources.pool_id`, constraints `resources_pool_fk`, `resources_pool_not_self`, and index `resources_pool_idx`. `ResourcesTable.pool_id: ColumnType<string | null, string | null | undefined, string | null>`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/integration/migrations.test.ts`:

```ts
describe('004_pools', () => {
  it('accepts a member whose pool is in the same tenant', async () => {
    const poolId = await insertResource({ concurrency_mode: 'pool' })
    const memberId = await insertResource({ pool_id: poolId })
    const row = await getTestDb()
      .selectFrom('resources')
      .select('pool_id')
      .where('id', '=', memberId)
      .executeTakeFirstOrThrow()
    expect(row.pool_id).toBe(poolId)
  })

  it('refuses a member whose pool belongs to another tenant', async () => {
    const otherTenant = await seedTenantId('other tenant')
    const poolId = await insertResource({ concurrency_mode: 'pool', tenant_id: otherTenant })
    await expect(insertResource({ pool_id: poolId })).rejects.toThrow(/resources_pool_fk/)
  })

  it('refuses a row that points at itself', async () => {
    const id = await insertResource({})
    await expect(
      getTestDb().updateTable('resources').set({ pool_id: id }).where('id', '=', id).execute(),
    ).rejects.toThrow(/resources_pool_not_self/)
  })

  it('refuses to delete a pool that still has members', async () => {
    const poolId = await insertResource({ concurrency_mode: 'pool' })
    await insertResource({ pool_id: poolId })
    await expect(
      getTestDb().deleteFrom('resources').where('id', '=', poolId).execute(),
    ).rejects.toThrow(/resources_pool_fk/)
  })
})
```

`insertResource(overrides)` already exists in this file and returns the created **id**, not a row; it spreads `overrides` into the insert, so `pool_id` and `tenant_id` need no change to it. `seedTenantId(name)` comes from `tests/integration/helpers.js`, which the file already imports — there is no `insertTenant`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/integration/migrations.test.ts -t 004_pools`
Expected: FAIL — `column "pool_id" of relation "resources" does not exist`.

- [ ] **Step 3: Write the migration**

Create `src/db/migrations/004_pools.ts`:

```ts
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
```

Register it in `src/db/migrations/index.ts` beside `003_tenancy`, following the existing shape.

- [ ] **Step 4: Add the column to the typed schema**

In `src/db/schema.ts`, inside `ResourcesTable`, after `concurrency_mode`:

```ts
/**
 * The pool this resource belongs to, or null. A pool is itself a resource with
 * `concurrency_mode = 'pool'`; see spec 3.
 */
pool_id: ColumnType<string | null, string | null | undefined, string | null>
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/integration/migrations.test.ts`
Expected: PASS, including the pre-existing cases.

- [ ] **Step 6: Commit**

```bash
git add src/db/migrations/004_pools.ts src/db/migrations/index.ts src/db/schema.ts tests/integration/migrations.test.ts
git commit -m "feat(db): add resources.pool_id with a composite tenant-scoped key"
```

---

### Task 2: `pool_id` through the resource contract

**Files:**

- Modify: `src/modules/resources/resource.repository.ts`, `src/modules/resources/resource.schemas.ts`, `src/modules/resources/resource.service.ts`
- Test: `tests/integration/resources.test.ts`

**Interfaces:**

- Consumes: `ResourcesTable.pool_id` from Task 1.
- Produces: `ResourceRow.pool_id: string | null`; `InsertResource.pool_id?: string | null`; `UpdateResource.pool_id?: string | null`; `ResourceResponse.pool_id: string | null`. `toResponse` returns it.

This task carries the field end to end but sets **no rules** — a `pool_id` pointing at a non-pool is still accepted here, and Task 3 refuses it. The field is nullable and optional, so every existing test keeps passing.

- [ ] **Step 1: Write the failing test**

In `tests/integration/resources.test.ts`:

```ts
it('reports pool_id as null on a resource that has no pool', async () => {
  const response = await api.createResource(aResource())
  expect(response.json()).toHaveProperty('pool_id', null)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/integration/resources.test.ts -t pool_id`
Expected: FAIL — the property is absent, because the response schema strips it.

- [ ] **Step 3: Carry the column through the repository**

In `src/modules/resources/resource.repository.ts`: add `pool_id: string | null` to `ResourceRow`, `'pool_id'` to the end of `resourceColumns`, and `pool_id?: string | null` to both `InsertResource` and `UpdateResource`.

- [ ] **Step 4: Add it to the schemas**

In `src/modules/resources/resource.schemas.ts`:

```ts
const PoolId = Type.String({
  format: 'uuid',
  description:
    'The pool this resource belongs to. The target must be a resource with `concurrency_mode: "pool"`, in the same tenant, and must share this resource\'s timezone, slot_duration and slot_anchor_time.',
})
```

Add `pool_id: Type.Optional(PoolId)` to `CreateResourceBody`; add `pool_id: Type.Optional(Type.Union([PoolId, Type.Null()]))` to `UpdateResourceBody` — the null is how a member leaves its pool; add `pool_id: Type.Union([Uuid, Type.Null()])` to `ResourceResponse`, and `pool_id: null` to its example.

Update the `ConcurrencyMode` description: replace "`pool` — a group of interchangeable resources, **not implemented yet** and rejected with 400." with "`pool` — a group of interchangeable resources; a booking against it lands on a member. Members carry `pool_id` and must be `exclusive`."

- [ ] **Step 5: Return it from the service**

In `src/modules/resources/resource.service.ts`, add `pool_id: row.pool_id` to `toResponse`, pass `pool_id: body.pool_id ?? null` in `create`, and include `...(body.pool_id === undefined ? {} : { pool_id: body.pool_id })` in the `update` call.

- [ ] **Step 6: Run the full suite**

Run: `./run check`
Expected: PASS. `tests/unit/documented-tables.test.ts` still passes — no route was added.

- [ ] **Step 7: Commit**

```bash
git add src/modules/resources tests/integration/resources.test.ts
git commit -m "feat(resources): carry pool_id through the resource contract"
```

---

### Task 3: Membership rules and the pool-shaped resource

**Files:**

- Create: `src/modules/resources/pool.service.ts`, `tests/fixtures/datasets/pool-membership.ts`
- Modify: `src/modules/resources/resource.service.ts`, `src/modules/resources/resource.routes.ts`, `src/shared/errors.ts`, `docs/conventions.md`
- Test: `tests/integration/pools.test.ts` (create)

**Interfaces:**

- Consumes: `ResourceRow`, `ResourceRepository` from Task 2.
- Produces: `class PoolService { assertMembership(tenantId: string, joining: MembershipCandidate, poolId: string): Promise<void>; assertPoolShape(mode: ConcurrencyMode, capacity: number): void }` where `MembershipCandidate = { id?: string; timezone: string; slot_duration: string; slot_anchor_time: string; concurrency_mode: ConcurrencyMode }`. Also `InvalidPoolMembershipError` and `PoolHasMembersError` from `src/shared/errors.ts`.

- [ ] **Step 1: Write the dataset**

Create `tests/fixtures/datasets/pool-membership.ts`:

```ts
/** Which of the four rules of spec 3 §3 a rejected case violates. */
export type MembershipRule = 'tenant' | 'kind' | 'member_mode' | 'grid'

export interface RejectedMembership {
  name: string
  /** Overrides applied to the joining resource, on top of a P1D/14:00/Europe/Warsaw base. */
  member: Record<string, unknown>
  /** Overrides applied to the pool, on the same base. */
  pool: Record<string, unknown>
  rule: MembershipRule
}

export const rejectedMemberships: readonly RejectedMembership[] = [
  {
    name: 'the target is an ordinary resource, not a pool',
    member: {},
    pool: { concurrency_mode: 'exclusive' },
    rule: 'kind',
  },
  {
    name: 'the joining resource is itself a pool',
    member: { concurrency_mode: 'pool' },
    pool: {},
    rule: 'member_mode',
  },
  {
    name: 'the joining resource is shared',
    member: { concurrency_mode: 'shared', capacity: 4 },
    pool: {},
    rule: 'member_mode',
  },
  { name: 'the timezone differs', member: { timezone: 'UTC' }, pool: {}, rule: 'grid' },
  {
    name: 'the slot duration differs',
    member: { slot_duration: 'PT1H', slot_anchor_time: '00:00' },
    pool: {},
    rule: 'grid',
  },
  { name: 'the anchor differs', member: { slot_anchor_time: '15:00' }, pool: {}, rule: 'grid' },
]
```

- [ ] **Step 2: Write the failing tests**

Create `tests/integration/pools.test.ts` with the standard harness from `tests/integration/resources.test.ts` (`buildTestApp`, `resetDbWithTenant`, `Api` over `injectTransport` with `testAuthorization`), then:

```ts
const poolBase = {
  timezone: 'Europe/Warsaw',
  slot_duration: 'P1D',
  slot_anchor_time: '14:00',
  concurrency_mode: 'pool' as const,
}
const memberBase = { ...poolBase, concurrency_mode: 'exclusive' as const }

it('accepts a member that matches its pool', async () => {
  const pool = (await api.createResource(poolBase)).json()
  const member = await api.createResource({ ...memberBase, pool_id: pool.id })
  expect(member.statusCode).toBe(201)
  expect(member.json().pool_id).toBe(pool.id)
})

it.each(rejectedMemberships)('refuses when $name', async ({ member, pool, rule }) => {
  const created = (await api.createResource({ ...poolBase, ...pool })).json()
  const response = await api.createResource({ ...memberBase, ...member, pool_id: created.id })
  expect(response.statusCode).toBe(400)
  expect(response.json().error).toBe('invalid_pool_membership')
  expect(response.json().details).toMatchObject({ rule })
})

it('refuses a pool created with a capacity other than 1', async () => {
  const response = await api.createResource({ ...poolBase, capacity: 3 })
  expect(response.statusCode).toBe(400)
  expect(response.json().error).toBe('validation_error')
})

it('lets a member leave its pool', async () => {
  const pool = (await api.createResource(poolBase)).json()
  const member = (await api.createResource({ ...memberBase, pool_id: pool.id })).json()
  const patched = await api.patchResource(member.id, { pool_id: null })
  expect(patched.statusCode).toBe(200)
  expect(patched.json().pool_id).toBeNull()
})

it('refuses to delete a pool that still has members', async () => {
  const pool = (await api.createResource(poolBase)).json()
  await api.createResource({ ...memberBase, pool_id: pool.id })
  const response = await api.deleteResource(pool.id)
  expect(response.statusCode).toBe(409)
  expect(response.json().error).toBe('pool_has_members')
})
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run tests/integration/pools.test.ts`
Expected: FAIL — creating a pool is still refused with `unsupported_concurrency_mode`.

- [ ] **Step 4: Add the two error classes**

In `src/shared/errors.ts`, beside the other 4xx classes:

```ts
/** A `pool_id` write that breaks one of the four membership rules. `details.rule` names which. */
export class InvalidPoolMembershipError extends AppError {
  readonly statusCode = 400
  readonly code = 'invalid_pool_membership'
}

/** `DELETE /resources/:id` on a pool whose members have not left it. */
export class PoolHasMembersError extends AppError {
  readonly statusCode = 409
  readonly code = 'pool_has_members'
}
```

- [ ] **Step 5: Document them**

Add two rows to the error table in `docs/conventions.md`, in status order:

```
| `invalid_pool_membership`      | 400    | `pool_id` names a non-pool, a pool, or a resource on a different grid |
| `pool_has_members`             | 409    | `DELETE /resources/:id` on a pool whose members have not left        |
```

Change the `unsupported_concurrency_mode` row's meaning from "`pool`, until spec 3" to "A booking reached the write path carrying `pool`; selection should have chosen a member".

`tests/unit/documented-tables.test.ts` fails until this step is done — that is the guard working.

- [ ] **Step 6: Write `PoolService`**

Create `src/modules/resources/pool.service.ts`:

```ts
import type { ConcurrencyMode } from '../../db/schema.js'
import { InvalidPoolMembershipError, ValidationError } from '../../shared/errors.js'
import { formatTime } from '../../shared/time.js'
import type { ResourceRepository, ResourceRow } from './resource.repository.js'

/** The fields a membership decision reads, on a resource that may not exist yet. */
export interface MembershipCandidate {
  timezone: string
  slot_duration: string
  slot_anchor_time: string
  concurrency_mode: ConcurrencyMode
}

const GRID_FIELDS = ['timezone', 'slot_duration', 'slot_anchor_time'] as const

export class PoolService {
  constructor(private readonly resources: ResourceRepository) {}

  /**
   * The four rules of spec 3 §3. The composite foreign key already makes a cross-tenant pool
   * unwritable; checking here first is what turns a constraint violation into an answer that
   * tells the caller nothing about other tenants.
   */
  async assertMembership(
    tenantId: string,
    joining: MembershipCandidate,
    poolId: string,
  ): Promise<void> {
    const pool = await this.resources.findById(tenantId, poolId)
    if (!pool) {
      throw new InvalidPoolMembershipError(`No pool ${poolId} in this tenant`, {
        rule: 'tenant',
        pool_id: poolId,
      })
    }

    if (pool.concurrency_mode !== 'pool') {
      throw new InvalidPoolMembershipError(
        `Resource ${poolId} is not a pool; only a resource with concurrency_mode "pool" can have members`,
        { rule: 'kind', pool_id: poolId },
      )
    }

    // One rule, two exclusions: a `pool` member would be nesting, and a `shared` member would
    // make derived capacity a sum of capacities rather than a count of members.
    if (joining.concurrency_mode !== 'exclusive') {
      throw new InvalidPoolMembershipError(
        `A pool member must be exclusive, not "${joining.concurrency_mode}"`,
        { rule: 'member_mode', concurrency_mode: joining.concurrency_mode },
      )
    }

    const mismatched = GRID_FIELDS.filter(
      (field) => normalise(field, joining) !== normalise(field, pool),
    )
    if (mismatched.length > 0) {
      throw new InvalidPoolMembershipError(
        `A member must share its pool's grid; ${mismatched.join(', ')} differ from pool ${poolId}`,
        { rule: 'grid', fields: mismatched, pool_id: poolId },
      )
    }
  }

  /** A pool's stored capacity is meaningless, so only the value that says so is accepted. */
  assertPoolShape(mode: ConcurrencyMode, capacity: number): void {
    if (mode === 'pool' && capacity !== 1) {
      throw new ValidationError(
        'capacity must be 1 on a pool; effective capacity is derived from the count of active members and is never stored',
        { field: 'capacity' },
      )
    }
  }
}

/** `slot_anchor_time` reads back as `HH:MM:SS` from Postgres but arrives as `HH:MM`. */
function normalise(
  field: (typeof GRID_FIELDS)[number],
  row: MembershipCandidate | ResourceRow,
): string {
  const value = row[field]
  return field === 'slot_anchor_time' ? formatTime(value) : value
}
```

- [ ] **Step 7: Wire it into `ResourceService`**

In `src/modules/resources/resource.service.ts`:

- Take `private readonly pools: PoolService` as a second constructor argument.
- Delete the `if (body.concurrency_mode === 'pool')` refusal at the top of `create`.
- In `create`, after `assertCapacityMatchesMode`, add:

```ts
this.pools.assertPoolShape(body.concurrency_mode, capacity)
if (body.pool_id !== undefined) {
  await this.pools.assertMembership(
    tenantId,
    {
      timezone: body.timezone,
      slot_duration: duration.iso,
      slot_anchor_time: anchor,
      concurrency_mode: body.concurrency_mode,
    },
    body.pool_id,
  )
}
```

- In `update`, after `assertCapacityMatchesMode`, add the same pair, validating the **resulting** state:

```ts
this.pools.assertPoolShape(current.concurrency_mode, capacity)
const poolId = body.pool_id === undefined ? current.pool_id : body.pool_id
if (poolId !== null) {
  await this.pools.assertMembership(
    tenantId,
    {
      timezone: current.timezone,
      slot_duration: duration.iso,
      slot_anchor_time: anchor,
      concurrency_mode: current.concurrency_mode,
    },
    poolId,
  )
}
```

This is what makes a patch that would break the grid — changing a member's `slot_duration` — fail, exactly as the anchor rule already does.

- In `delete`, extend the error translation. Beside `isBookingReference`, add:

```ts
function isMemberReference(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { code?: unknown; constraint?: unknown }
  return candidate.code === '23503' && candidate.constraint === 'resources_pool_fk'
}
```

and in the `catch`, before the booking check:

```ts
if (isMemberReference(error)) {
  throw new PoolHasMembersError(
    `Pool ${id} still has members; move them out with PATCH pool_id: null before deleting it`,
    { pool_id: id },
  )
}
```

- [ ] **Step 8: Construct it in the route plugin**

In `src/modules/resources/resource.routes.ts`, build `new ResourceService(repository, new PoolService(repository))`, following the existing construction. Do the same anywhere else `ResourceService` is constructed — `grep -rn "new ResourceService" src tests` and fix each.

- [ ] **Step 9: Run everything**

Run: `./run check`
Expected: PASS.

- [ ] **Step 10: Regenerate and commit**

```bash
./run openapi
git add src/modules/resources src/shared/errors.ts docs/conventions.md openapi.json tests/fixtures/datasets/pool-membership.ts tests/integration/pools.test.ts
git commit -m "feat(resources): accept pools and enforce the membership rules"
```

---

### Task 4: A pool has no schedule of its own

**Files:**

- Modify: `src/modules/schedule/schedule.service.ts`, `src/modules/exceptions/exception.service.ts`
- Test: `tests/integration/pools.test.ts`

**Interfaces:**

- Consumes: `ResourceRow.concurrency_mode`, already loaded by both services via `ResourceService.loadOrFail`.
- Produces: nothing new.

- [ ] **Step 1: Write the failing tests**

In `tests/integration/pools.test.ts`:

```ts
it.each([
  {
    name: 'a schedule',
    call: (id: string) =>
      api.putSchedule(id, [{ day_of_week: 0, start_time: null, end_time: null }]),
  },
  {
    name: 'an exception',
    call: (id: string) => api.putException(id, '2026-09-01', { start_time: null, end_time: null }),
  },
])('refuses $name on a pool', async ({ call }) => {
  const pool = (await api.createResource(poolBase)).json()
  const response = await call(pool.id)
  expect(response.statusCode).toBe(400)
  expect(response.json().error).toBe('validation_error')
  expect(response.json().message).toMatch(/pool/i)
})

it('still serves a schedule read on a pool, as an empty list', async () => {
  const pool = (await api.createResource(poolBase)).json()
  expect((await api.getSchedule(pool.id)).json()).toEqual([])
})
```

Reads stay legal: a pool genuinely has no schedule rows, and `[]` is the truthful answer.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/integration/pools.test.ts -t pool`
Expected: FAIL — both writes currently succeed with 200.

- [ ] **Step 3: Refuse the writes**

Add to both `src/modules/schedule/schedule.service.ts` and `src/modules/exceptions/exception.service.ts`, called immediately after the resource is loaded in every **write** path (`replace` in the schedule service; `upsert` and `remove` in the exception service):

```ts
/**
 * A pool has no availability of its own — it is the union over its members, which is where
 * the schedules live. Refusing rather than silently ignoring is design principle #8; a pool
 * whose schedule was accepted and never consulted would be a lie the caller could not see.
 */
function assertNotPool(resource: ResourceRow): void {
  if (resource.concurrency_mode === 'pool') {
    throw new ValidationError(
      `Resource ${resource.id} is a pool, and a pool has no schedule of its own; its availability is the union over its members`,
      { resource_id: resource.id },
    )
  }
}
```

- [ ] **Step 4: Run everything**

Run: `./run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/schedule src/modules/exceptions tests/integration/pools.test.ts
git commit -m "feat(schedule): refuse schedule and exception writes on a pool"
```

---

### Task 5: A pool's availability

**Files:**

- Create: `tests/fixtures/datasets/pool-availability.ts`
- Modify: `src/modules/schedule/schedule.repository.ts`, `src/modules/exceptions/exception.repository.ts`, `src/modules/bookings/booking.repository.ts`, `src/modules/resources/pool.repository.ts` (create), `src/modules/availability/availability.service.ts`
- Test: `tests/integration/pools.test.ts`

**Interfaces:**

- Consumes: `PoolService` from Task 3; `resolveWindows`, `generateSlots`, `countOccupying`, all unchanged.
- Produces:
  - `PoolRepository.listMembers(tenantId: string, poolId: string, activeOnly: boolean): Promise<ResourceRow[]>`
  - `ScheduleRepository.listByResourceIds(tenantId: string, resourceIds: string[]): Promise<ScheduleRow[]>` — rows carry `resource_id`
  - `ExceptionRepository.listInRangeForResources(tenantId: string, resourceIds: string[], from: string, to: string): Promise<ExceptionRow[]>`
  - `BookingRepository.activeInRangeForResources(tenantId: string, resourceIds: string[], from: Date, to: Date): Promise<Array<ActiveBooking & { resource_id: string }>>`

- [ ] **Step 1: Write the dataset**

Create `tests/fixtures/datasets/pool-availability.ts`:

```ts
export interface PoolAvailabilityCase {
  name: string
  /** One entry per member: its weekly windows, its day-off dates, and whether it is active. */
  members: Array<{
    windows: Array<[day: number, start: string | null, end: string | null]>
    daysOff?: string[]
    active?: boolean
  }>
  from: string
  to: string
  /** Slot starts that must come back `available: true`, in order. */
  availableStarts: string[]
  /** Slot starts that must come back, but `available: false`. */
  unavailableStarts?: string[]
}

const wholeWeek: Array<[number, null, null]> = [0, 1, 2, 3, 4, 5, 6].map((d) => [d, null, null])

export const poolAvailabilityCases: PoolAvailabilityCase[] = [
  {
    name: 'a slot one member offers is offered by the pool',
    members: [{ windows: [[0, null, null]] }, { windows: [] }],
    from: '2026-07-20',
    to: '2026-07-21',
    availableStarts: ['2026-07-20T14:00:00+02:00'],
  },
  {
    name: 'a day off on one member is covered by the other',
    members: [{ windows: wholeWeek, daysOff: ['2026-07-21'] }, { windows: wholeWeek }],
    from: '2026-07-20',
    to: '2026-07-23',
    availableStarts: [
      '2026-07-20T14:00:00+02:00',
      '2026-07-21T14:00:00+02:00',
      '2026-07-22T14:00:00+02:00',
    ],
  },
  {
    name: 'a day off on every member removes the slot entirely',
    members: [
      { windows: wholeWeek, daysOff: ['2026-07-21'] },
      { windows: wholeWeek, daysOff: ['2026-07-21'] },
    ],
    from: '2026-07-21',
    to: '2026-07-22',
    availableStarts: [],
  },
  {
    name: 'an inactive member does not contribute',
    members: [{ windows: wholeWeek, active: false }, { windows: [] }],
    from: '2026-07-20',
    to: '2026-07-21',
    availableStarts: [],
  },
  {
    name: 'a pool with no members offers nothing',
    members: [],
    from: '2026-07-20',
    to: '2026-07-21',
    availableStarts: [],
  },
]
```

- [ ] **Step 2: Write the failing test**

First the helper the availability and booking cases both use. Add it to `tests/integration/pools.test.ts`:

```ts
/** A pool plus one member per entry, each with its own windows, days off and active flag. */
async function aPoolWith(
  members: PoolAvailabilityCase['members'],
): Promise<{ id: string; memberIds: string[] }> {
  const pool = (await api.createResource(poolBase)).json()
  const memberIds: string[] = []

  for (const spec of members) {
    const member = (await api.createResource({ ...memberBase, pool_id: pool.id })).json()

    await api.putSchedule(
      member.id,
      spec.windows.map(([day_of_week, start_time, end_time]) => ({
        day_of_week,
        start_time,
        end_time,
      })),
    )

    for (const date of spec.daysOff ?? []) {
      await api.putException(member.id, date, { start_time: null, end_time: null })
    }

    // Last, so the schedule writes above are not refused on an inactive resource.
    if (spec.active === false) await api.patchResource(member.id, { is_active: false })

    memberIds.push(member.id)
  }

  return { id: pool.id, memberIds }
}

const night = {
  start_time: '2026-07-20T14:00:00+02:00',
  end_time: '2026-07-21T14:00:00+02:00',
}
```

`aPoolWith` returns `memberIds` in creation order, which is the order `claimMember` prefers — so a selection test can assert `memberIds[0]` won without listing resources. Then:

```ts
it.each(poolAvailabilityCases)('$name', async (scenario) => {
  const pool = await aPoolWith(scenario.members)
  const slots = (await api.getAvailability(pool.id, scenario.from, scenario.to)).json().slots
  expect(slots.filter((s: Slot) => s.available).map((s: Slot) => s.start)).toEqual(
    scenario.availableStarts,
  )
})

it('marks a slot unavailable once every member is booked', async () => {
  const pool = await aPoolWith([{ windows: wholeWeek }, { windows: wholeWeek }])
  const night = { start_time: '2026-07-20T14:00:00+02:00', end_time: '2026-07-21T14:00:00+02:00' }
  expect((await api.createBooking(pool.id, night)).statusCode).toBe(201)
  expect(
    (await api.getAvailability(pool.id, '2026-07-20', '2026-07-21')).json().slots[0].available,
  ).toBe(true)
  expect((await api.createBooking(pool.id, night)).statusCode).toBe(201)
  expect(
    (await api.getAvailability(pool.id, '2026-07-20', '2026-07-21')).json().slots[0].available,
  ).toBe(false)
})
```

The second case depends on Task 6 and will stay red until then; mark it `it.skip` here and un-skip it in Task 6 Step 6.

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tests/integration/pools.test.ts`
Expected: FAIL — a pool currently returns `{ slots: [] }`, since it has no schedule rows of its own.

- [ ] **Step 4: Add the batched repository methods**

Each mirrors its single-resource sibling with `where(... 'in', resourceIds)` and `resource_id` added to the selected columns. Guard each with `if (resourceIds.length === 0) return []` — Kysely renders an empty `in ()` as invalid SQL.

Create `src/modules/resources/pool.repository.ts`:

```ts
import type { Kysely } from 'kysely'
import type { Database } from '../../db/schema.js'
import { resourceColumns, type ResourceRow } from './resource.repository.js'

export class PoolRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /** Members in the order selection prefers them: stable, and independent of contention. */
  async listMembers(tenantId: string, poolId: string, activeOnly: boolean): Promise<ResourceRow[]> {
    let query = this.db
      .selectFrom('resources')
      .select(resourceColumns)
      .where('tenant_id', '=', tenantId)
      .where('pool_id', '=', poolId)
      .orderBy('created_at')
      .orderBy('id')
    if (activeOnly) query = query.where('is_active', '=', true)
    return query.execute()
  }
}
```

- [ ] **Step 5: Branch availability on the mode**

In `src/modules/availability/availability.service.ts`, take `private readonly pools: PoolRepository` and add to `computeForResource`, immediately after the `is_active` check:

```ts
if (resource.concurrency_mode === 'pool') return this.computeForPool(resource, from, to)
```

Then:

```ts
  /**
   * The union over the pool's active members: a slot is available when at least one of them
   * offers it and has no conflicting booking. Three queries whatever the member count —
   * members carry different schedules, so per-member windows genuinely have to be resolved,
   * but that does not need three round trips each.
   */
  private async computeForPool(
    pool: ResourceRow,
    from: string,
    to: string,
  ): Promise<AvailabilityResponse> {
    const members = await this.pools.listMembers(pool.tenant_id, pool.id, true)
    if (members.length === 0) return { slots: [] }

    const ids = members.map((member) => member.id)
    const dates = enumerateDates(from, to, pool.timezone)

    const [scheduleRows, exceptionRows] = await Promise.all([
      this.schedule.listByResourceIds(pool.tenant_id, ids),
      this.exceptions.listInRangeForResources(pool.tenant_id, ids, from, to),
    ])

    // Every member shares the pool's grid, so the slot list is the same for all of them and
    // only the windows differ. Offered-by-member is therefore a set of slot starts.
    const perMember = members.map((member) => ({
      member,
      slots: generateSlots({
        dates,
        windowsByDate: resolveWindows({
          dates,
          timezone: pool.timezone,
          scheduleRows: scheduleRows.filter((row) => row.resource_id === member.id),
          exceptionRows: exceptionRows.filter((row) => row.resource_id === member.id),
        }),
        timezone: pool.timezone,
        slotDuration: parseSlotDuration(pool.slot_duration),
        anchorTime: formatTime(pool.slot_anchor_time),
      }),
    }))

    const everySlot = new Map<string, Slot>()
    for (const { slots } of perMember) for (const slot of slots) everySlot.set(slot.start, slot)
    if (everySlot.size === 0) return { slots: [] }

    const ordered = [...everySlot.values()].sort((a, b) => a.start.localeCompare(b.start))
    const first = new Date(Math.min(...ordered.map((slot) => Date.parse(slot.start))))
    const last = new Date(Math.max(...ordered.map((slot) => Date.parse(slot.end))))
    const active = await this.bookings.activeInRangeForResources(pool.tenant_id, ids, first, last)

    return {
      slots: ordered.map((slot) => ({
        ...slot,
        available: perMember.some(
          ({ member, slots }) =>
            slots.some((candidate) => candidate.start === slot.start) &&
            countOccupying(
              active.filter((booking) => booking.resource_id === member.id),
              slot,
            ) < member.capacity,
        ),
      })),
    }
  }
```

Construct `PoolRepository` wherever `AvailabilityService` is built — `grep -rn "new AvailabilityService" src tests`.

- [ ] **Step 6: Run everything**

Run: `./run check`
Expected: PASS, with the one `it.skip` still skipped.

- [ ] **Step 7: Commit**

```bash
git add src/modules tests/fixtures/datasets/pool-availability.ts tests/integration/pools.test.ts
git commit -m "feat(availability): compute a pool as the union over its members"
```

---

### Task 6: Booking a pool

**Files:**

- Modify: `src/modules/bookings/booking.service.ts`, `src/modules/bookings/booking.repository.ts`, `src/modules/resources/pool.repository.ts`
- Test: `tests/integration/pools.test.ts`

**Interfaces:**

- Consumes: `PoolRepository.listMembers`, the batched repository methods from Task 5.
- Produces:
  - `PoolRepository.claimMember(trx: Trx, tenantId: string, candidateIds: string[], start: Date, end: Date): Promise<string | undefined>`
  - `BookingRepository.inPoolWriteTransaction<T>(tenantId, poolId, lockPool, work: (trx, pool) => Promise<T>): Promise<T>`

- [ ] **Step 1: Write the failing tests**

In `tests/integration/pools.test.ts`:

```ts
it('books a member and reports the member as resource_id', async () => {
  const pool = await aPoolWith([{ windows: wholeWeek }])
  const response = await api.createBooking(pool.id, night)
  expect(response.statusCode).toBe(201)
  expect(response.json().resource_id).toBe(pool.memberIds[0])
})

it('answers outside_schedule when no member offers the run', async () => {
  const pool = await aPoolWith([{ windows: [] }])
  const response = await api.createBooking(pool.id, night)
  expect(response.statusCode).toBe(400)
  expect(response.json().error).toBe('outside_schedule')
})

it('answers slot_unavailable when every member that offers it is taken', async () => {
  const pool = await aPoolWith([{ windows: wholeWeek }])
  expect((await api.createBooking(pool.id, night)).statusCode).toBe(201)
  const second = await api.createBooking(pool.id, night)
  expect(second.statusCode).toBe(409)
  expect(second.json().error).toBe('slot_unavailable')
})

it('gives two concurrent bookings different members', async () => {
  const pool = await aPoolWith([{ windows: wholeWeek }, { windows: wholeWeek }])
  const [a, b] = await Promise.all([
    api.createBooking(pool.id, night),
    api.createBooking(pool.id, night),
  ])
  expect([a.statusCode, b.statusCode].sort()).toEqual([201, 201])
  expect(a.json().resource_id).not.toBe(b.json().resource_id)
})

it('gives the last free member to exactly one of two racing requests', async () => {
  const pool = await aPoolWith([{ windows: wholeWeek }])
  const [a, b] = await Promise.all([
    api.createBooking(pool.id, night),
    api.createBooking(pool.id, night),
  ])
  expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409])
})

it('frees a member whose hold has expired, without waiting for the sweeper', async () => {
  const pool = await aPoolWith([{ windows: wholeWeek }])
  const held = (await api.createBooking(pool.id, { ...night, hold: true, hold_minutes: 10 })).json()
  await expireHold(held.id) // sets held_until into the past, as bookings.test.ts does
  expect((await api.createBooking(pool.id, night)).statusCode).toBe(201)
})
```

Un-skip the availability case parked in Task 5 Step 2.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/integration/pools.test.ts`
Expected: FAIL — booking a pool currently raises `unsupported_concurrency_mode` from `capacityIsCounted`.

- [ ] **Step 3: Add the pool write transaction**

In `src/modules/bookings/booking.repository.ts`, beside `inWriteTransaction`:

```ts
  /**
   * The pool equivalent. Two differences, both load-bearing.
   *
   * The in-transaction sweep runs across the pool's **members**, not the pool row: an expired
   * hold on a member still blocks it until something moves it out of `held`, and selection
   * would otherwise skip a member that is in fact free — the exact failure spec 2's inline
   * sweep exists to prevent, one level down.
   *
   * The pool row is locked only when the caller asks, which is only when an idempotency key
   * is present. Capacity is derived rather than counted, so nothing else needs it.
   */
  async inPoolWriteTransaction<T>(
    tenantId: string,
    poolId: string,
    lockPool: boolean,
    work: (trx: Trx, pool: ResourceRow | undefined) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      const query = trx
        .selectFrom('resources')
        .select(resourceColumns)
        .where('tenant_id', '=', tenantId)
        .where('id', '=', poolId)
      const pool = await (lockPool ? query.forUpdate() : query).executeTakeFirst()

      await trx
        .updateTable('bookings')
        .set({ status: 'expired', updated_at: now() })
        .where('id', 'in', (eb) =>
          eb
            .selectFrom('bookings')
            .select('bookings.id')
            .innerJoin('resources', 'resources.id', 'bookings.resource_id')
            .where('resources.pool_id', '=', poolId)
            .where('bookings.status', '=', 'held')
            .where('bookings.held_until', '<=', sql<Date>`now()`)
            .orderBy('bookings.id')
            .forUpdate()
            .of('bookings'),
        )
        .execute()

      return work(trx, pool)
    })
  }
```

`.of('bookings')` keeps `FOR UPDATE` off the joined `resources` rows; without it Postgres would lock both sides and a concurrent `PATCH` on a member would contend needlessly.

- [ ] **Step 4: Add `claimMember`**

In `src/modules/resources/pool.repository.ts`:

```ts
  /**
   * Claims one member that has no active booking overlapping the interval, in a stable order.
   *
   * `SKIP LOCKED` is the whole concurrency story for the mode: two requests arriving together
   * take different rows and neither waits, and a request arriving when one member is left
   * finds it locked, skips it, and returns nothing rather than blocking. There is no retry
   * loop — `bookings_no_overlap` remains the backstop, as spec 2 left it.
   */
  async claimMember(
    trx: Trx,
    tenantId: string,
    candidateIds: string[],
    start: Date,
    end: Date,
  ): Promise<string | undefined> {
    if (candidateIds.length === 0) return undefined

    const row = await trx
      .selectFrom('resources')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('id', 'in', candidateIds)
      .where('is_active', '=', true)
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('bookings')
              .select('bookings.id')
              .whereRef('bookings.resource_id', '=', 'resources.id')
              .where('bookings.status', 'in', ['held', 'confirmed'])
              .where('bookings.start_time', '<', end)
              .where('bookings.end_time', '>', start),
          ),
        ),
      )
      .orderBy('created_at')
      .orderBy('id')
      .forUpdate()
      .skipLocked()
      .limit(1)
      .executeTakeFirst()

    return row?.id
  }
```

- [ ] **Step 5: Branch `BookingService.create`**

At the top of `create`, after `loadOrFail`:

```ts
if (resource.concurrency_mode === 'pool') return this.createInPool(tenantId, resource, body)
```

Then add the method. The check order is spec 3 §5.1, and it is what keeps `outside_schedule` and `slot_unavailable` meaning different things:

```ts
  private async createInPool(
    tenantId: string,
    pool: ResourceRow,
    body: CreateBookingBody,
  ): Promise<CreateResult> {
    if (!pool.is_active) {
      throw new ResourceInactiveError(`Resource ${pool.id} is not active and cannot be booked`, {
        resource_id: pool.id,
      })
    }

    // Step 1: interval and boundary, against the pool's own grid. Every member shares it, so
    // this answer is member-independent and is reached before any member is considered.
    const { start, end } = this.parseInterval(body.start_time, body.end_time, pool.timezone)

    // Step 2: the members that offer the whole run. None means the slots were never on offer.
    const members = await this.pools.listMembers(tenantId, pool.id, true)
    const offering: ResourceRow[] = []
    for (const member of members) {
      const slots = await this.offeredSlots(member, body.start_time, body.end_time)
      const check = checkAgainstGrid(slots, body.start_time, body.end_time)
      if (check.ok) offering.push(member)
      else if (check.error !== 'outside_schedule') gridError(check.error, body.start_time, body.end_time)
    }
    if (offering.length === 0) {
      throw new OutsideScheduleError(
        `No member of pool ${pool.id} offers every slot between ${body.start_time} and ${body.end_time}`,
        { pool_id: pool.id },
      )
    }

    const holdMinutes = this.resolveHoldMinutes(body)
    const key = body.idempotency_key ?? null

    const outcome = await this.inPoolWrite(tenantId, pool.id, key !== null, async (trx) => {
      if (key !== null) {
        const existing = await this.bookings.findByPoolIdempotencyKey(trx, tenantId, pool.id, key)
        if (existing) return { row: this.sameOrFail(existing, body, start, end), created: false }
      }

      // Step 3: claim one. `undefined` means every member that offers the run is taken.
      const memberId = await this.pools.claimMember(
        trx,
        tenantId,
        offering.map((member) => member.id),
        start,
        end,
      )
      if (memberId === undefined) {
        throw new SlotUnavailableError(
          'Those slots are offered, but every member of the pool is already booked for them',
          { pool_id: pool.id },
        )
      }

      return {
        row: await this.bookings.insert(trx, {
          tenant_id: tenantId,
          resource_id: memberId,
          start_time: start,
          end_time: end,
          status: (holdMinutes === null ? 'confirmed' : 'held') as 'confirmed' | 'held',
          customer_id: body.customer_id ?? null,
          // The member's mode, never the pool's: a booking row carrying `pool` would be
          // governed by neither the exclusion constraint nor the capacity count.
          concurrency_mode: 'exclusive',
          held_until: holdMinutes === null ? null : holdExpiry(holdMinutes),
          idempotency_key: key,
        }),
        created: true,
      }
    })

    return outcome
  }

  private async inPoolWrite<T>(
    tenantId: string,
    poolId: string,
    lockPool: boolean,
    work: (trx: Trx) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.bookings.inPoolWriteTransaction(tenantId, poolId, lockPool, (trx) => work(trx))
    } catch (error) {
      if (isOverlapViolation(error)) {
        throw new SlotUnavailableError(
          'Those slots are offered, but a member was taken between selection and the insert',
          { pool_id: poolId },
        )
      }
      rethrowContention(error, 'The booking')
    }
  }
```

Take `private readonly pools: PoolRepository` in the constructor and update every construction site.

`findByPoolIdempotencyKey` arrives in Task 7; until then, stub it as a method that returns `undefined` and add the real query there. **Do not leave the stub uncommitted into Task 7** — Task 7 Step 3 replaces it.

- [ ] **Step 6: Pin the invariant that makes all of this safe**

Spec 3 §7: `capacityIsCounted` must keep throwing on `pool` **permanently**. It is not a stub this slice removes — a booking row carrying `concurrency_mode = 'pool'` is governed by neither the exclusion constraint nor the capacity count, so it is a bug in member selection, and that `throw` is what catches it. Nothing in this task removes it, and a test says so out loud.

Create `tests/unit/pool-invariants.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { capacityIsCounted } from '../../src/modules/bookings/booking.service.js'
import { UnsupportedConcurrencyModeError } from '../../src/shared/errors.js'

describe('the mode branch before a booking row is written', () => {
  it.each([
    ['exclusive', false],
    ['shared', true],
  ] as const)('decides %s without throwing', (mode, counted) => {
    expect(capacityIsCounted(mode)).toBe(counted)
  })

  /**
   * Deliberately permanent. A booking always points at a member, whose own mode is
   * `exclusive`, so no row should ever reach here carrying `pool`. If one does, member
   * selection is broken and the row would be governed by nothing at all.
   */
  it('refuses to write a booking row carrying pool', () => {
    expect(() => capacityIsCounted('pool')).toThrow(UnsupportedConcurrencyModeError)
  })
})
```

Export `capacityIsCounted` from `src/modules/bookings/booking.service.ts` — it is currently a module-private function; add `export` to its declaration and nothing else.

- [ ] **Step 7: Run everything**

Run: `./run check`
Expected: PASS, including the un-skipped availability case.

- [ ] **Step 8: Commit**

```bash
git add src/modules tests/integration/pools.test.ts tests/unit/pool-invariants.test.ts
git commit -m "feat(bookings): book a pool by claiming a free member"
```

---

### Task 7: Idempotency across a pool

**Files:**

- Modify: `src/modules/bookings/booking.repository.ts`, `src/modules/bookings/booking.service.ts`
- Test: `tests/integration/pools.test.ts`

**Interfaces:**

- Consumes: `inPoolWriteTransaction` with `lockPool = true` from Task 6.
- Produces: `BookingRepository.findByPoolIdempotencyKey(trx: Trx, tenantId: string, poolId: string, key: string): Promise<BookingRow | undefined>`.

- [ ] **Step 1: Write the failing tests**

```ts
it('replays an idempotency key against a pool to the same booking', async () => {
  const pool = await aPoolWith([{ windows: wholeWeek }, { windows: wholeWeek }])
  const first = await api.createBooking(pool.id, { ...night, idempotency_key: 'k-1' })
  const second = await api.createBooking(pool.id, { ...night, idempotency_key: 'k-1' })
  expect(first.statusCode).toBe(201)
  expect(second.statusCode).toBe(200)
  expect(second.json().id).toBe(first.json().id)
})

it('does not create a second booking on another member when a key is replayed concurrently', async () => {
  const pool = await aPoolWith([{ windows: wholeWeek }, { windows: wholeWeek }])
  const [a, b] = await Promise.all([
    api.createBooking(pool.id, { ...night, idempotency_key: 'k-2' }),
    api.createBooking(pool.id, { ...night, idempotency_key: 'k-2' }),
  ])
  expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201])
  expect(a.json().id).toBe(b.json().id)
})

it('refuses a replayed key describing a different booking', async () => {
  const pool = await aPoolWith([{ windows: wholeWeek }])
  await api.createBooking(pool.id, { ...night, idempotency_key: 'k-3' })
  const other = await api.createBooking(pool.id, {
    ...night,
    customer_id: 'someone-else',
    idempotency_key: 'k-3',
  })
  expect(other.statusCode).toBe(409)
  expect(other.json().error).toBe('idempotency_key_reused')
})
```

The second is the case this task exists for: without the pool lock both requests miss the lookup, pick different members, and both insert — `bookings_idempotency_key_unique` is on `(resource_id, idempotency_key)` and would not fire.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/integration/pools.test.ts -t idempotency`
Expected: FAIL — the stub returns `undefined`, so a replay creates a second booking.

- [ ] **Step 3: Implement the lookup**

Replace the Task 6 stub in `src/modules/bookings/booking.repository.ts`:

```ts
  /**
   * The replay lookup for a pool. It joins through `resources` because the caller sent the
   * pool id and the booking carries a member id — the key spans the pool, while the unique
   * index spans only `(resource_id, idempotency_key)`.
   *
   * Correct only under the pool row lock its caller takes: without it, two concurrent replays
   * both miss here, claim different members, and both insert. That lock is the one place in
   * the engine where a parent is held before a member, which is the ordering conventions.md
   * records so that pools do not discover it as an intermittent deadlock.
   */
  async findByPoolIdempotencyKey(
    trx: Trx,
    tenantId: string,
    poolId: string,
    key: string,
  ): Promise<BookingRow | undefined> {
    return trx
      .selectFrom('bookings')
      .innerJoin('resources', (join) =>
        join
          .onRef('resources.id', '=', 'bookings.resource_id')
          .onRef('resources.tenant_id', '=', 'bookings.tenant_id'),
      )
      .select(columns.map((column) => `bookings.${column}` as const))
      .where('bookings.tenant_id', '=', tenantId)
      .where('resources.pool_id', '=', poolId)
      .where('bookings.idempotency_key', '=', key)
      .executeTakeFirst()
  }
```

- [ ] **Step 4: Run everything**

Run: `./run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/bookings tests/integration/pools.test.ts
git commit -m "feat(bookings): make an idempotency key span a whole pool"
```

---

### Task 8: The smoke suite

**Files:**

- Create: `tests/fixtures/suites/pools.ts`
- Modify: `tests/fixtures/suites/index.ts`, `tests/fixtures/api.ts`
- Test: `./run smoke pool`

**Interfaces:**

- Consumes: `rejectedMemberships` from Task 3; `Suite<TCase>` and `SuiteContext` from `tests/fixtures/suites/types.ts`.
- Produces: `poolMembershipSuite: Suite<RejectedMembership>`, `poolBookingSuite: Suite<{ name: string }>`.

- [ ] **Step 1: Write the suite**

Create `tests/fixtures/suites/pools.ts`. `expectStatus` comes from `./types.js`, and `newResource` returns the created **id**, not a row — it records the id for cleanup at the end of the run.

First widen the payload type: in `tests/fixtures/resources.ts`, add `pool_id?: string` to `ResourcePayload`, otherwise `newResource(poolBase)` does not type-check.

```ts
import { rejectedMemberships, type RejectedMembership } from '../datasets/pool-membership.js'
import { expectStatus, type Suite } from './types.js'

const poolBase = {
  timezone: 'Europe/Warsaw',
  slot_duration: 'P1D',
  slot_anchor_time: '14:00',
  concurrency_mode: 'pool' as const,
}
const memberBase = { ...poolBase, concurrency_mode: 'exclusive' as const }

export const poolMembershipSuite: Suite<RejectedMembership> = {
  name: 'Pools — membership validation',
  cases: rejectedMemberships,
  describe: (testCase) => `refuses when ${testCase.name}`,
  run: async ({ api, newResource }, testCase) => {
    // newResource records what it creates, so the run cleans up after itself.
    const poolId = await newResource({ ...poolBase, ...testCase.pool })
    const response = await api.createResource({
      ...memberBase,
      ...testCase.member,
      pool_id: poolId,
    })

    const status = expectStatus(response, 400)
    if (status) return status

    const body = response.json()
    if (body?.error !== 'invalid_pool_membership') {
      return `expected error "invalid_pool_membership", got "${body?.error}"`
    }
    if (body?.details?.rule !== testCase.rule) {
      return `expected details.rule "${testCase.rule}", got "${body?.details?.rule}"`
    }
    return null
  },
}

interface PoolBookingCase {
  name: string
  members: number
  /** How many bookings for the same night must be accepted before one is refused. */
  accepted: number
}

const poolBookingCases: readonly PoolBookingCase[] = [
  { name: 'one member takes one booking, then refuses', members: 1, accepted: 1 },
  { name: 'two members take two bookings, then refuse', members: 2, accepted: 2 },
]

export const poolBookingSuite: Suite<PoolBookingCase> = {
  name: 'Pools — booking claims a member',
  cases: poolBookingCases,
  describe: (testCase) => testCase.name,
  run: async ({ api, newResource }, testCase) => {
    const poolId = await newResource(poolBase)
    const memberIds: string[] = []

    for (let i = 0; i < testCase.members; i += 1) {
      const memberId = await newResource({ ...memberBase, pool_id: poolId })
      await api.putSchedule(
        memberId,
        [0, 1, 2, 3, 4, 5, 6].map((day_of_week) => ({
          day_of_week,
          start_time: null,
          end_time: null,
        })),
      )
      memberIds.push(memberId)
    }

    const night = {
      start_time: '2026-07-20T14:00:00+02:00',
      end_time: '2026-07-21T14:00:00+02:00',
    }

    const landedOn = new Set<string>()
    for (let i = 0; i < testCase.accepted; i += 1) {
      const response = await api.createBooking(poolId, night)
      const status = expectStatus(response, 201)
      if (status) return `booking ${i + 1}: ${status}`

      const resourceId = response.json()?.resource_id
      if (resourceId === poolId) return 'the booking points at the pool rather than a member'
      if (!memberIds.includes(resourceId)) return `resource_id ${resourceId} is not a member`
      if (landedOn.has(resourceId)) return `two bookings landed on the same member ${resourceId}`
      landedOn.add(resourceId)
    }

    const refused = await api.createBooking(poolId, night)
    const status = expectStatus(refused, 409)
    if (status) return `after ${testCase.accepted} bookings: ${status}`
    return refused.json()?.error === 'slot_unavailable'
      ? null
      : `expected error "slot_unavailable", got "${refused.json()?.error}"`
  },
}
```

The booking suite asserts the invariant the whole slice rests on: a booking never points at the pool, no two bookings land on the same member, and the run refuses once every member is taken.

- [ ] **Step 2: Register it**

One line each in the import block and the `suites` array in `tests/fixtures/suites/index.ts`. The runner does not change.

- [ ] **Step 3: Run it**

```bash
./run up
./run smoke pool
```

Expected: both suites pass, and the filter reports "Filtered to 2 of 18 suites".

- [ ] **Step 4: Commit**

```bash
git add tests/fixtures
git commit -m "test: replay the pool datasets against a running engine"
```

---

### Task 9: The documents

**Files:**

- Modify: `docs/architecture.md`, `docs/conventions.md`, `README.md`, `docs/test-cases.md`, `openapi.json`

**Interfaces:**

- Consumes: everything above.
- Produces: nothing code depends on.

- [ ] **Step 1: architecture.md**

Set slice 3 to **Implemented** in the status table. Replace the `pool` bullet under Concurrency modes — it currently says "**Not implemented:** the engine currently refuses `pool`..." — with what the mode now does, keeping the settled data model sentences. Add `pool_id` to the Resource column table.

- [ ] **Step 2: conventions.md**

Remove the `pool` mode rejected row from the deliberate-limitations table. Add the four limitations of spec 3 §9. The two error rows and the narrowed `unsupported_concurrency_mode` meaning landed in Task 3.

- [ ] **Step 3: README.md**

Delete "The `pool` concurrency mode arrives in spec 3." from the intro and say what the mode does instead. Remove "`pool` mode rejected until spec 3" from the known-limitations sentence.

- [ ] **Step 4: test-cases.md**

Add a section for pools — membership, availability union, selection, idempotency — with the same **Covered by** discipline as the rest of the document. Update **TC-RES-C16**, which asserts a resource response has exactly seven keys and now has eight.

- [ ] **Step 5: Regenerate and verify**

```bash
./run openapi
./run check
```

Expected: PASS. `tests/unit/documented-tables.test.ts` covers the error and config tables; the endpoint table is unchanged because no route was added.

- [ ] **Step 6: Commit**

```bash
git add docs README.md openapi.json
git commit -m "docs: record the pool concurrency mode as implemented"
```

---

## Definition of done

Copied from spec 3 §12, and each line is checkable:

- [ ] Every rule of §3 and §5 implemented and covered by the tests of §10
- [ ] `./run check` is clean from a clean checkout with Docker running
- [ ] `./run smoke` passes against a running engine
- [ ] `npm run migrate` brings a spec 4 database to the schema of §2, and `004_pools.ts` has a `down` that reverses it
- [ ] `capacityIsCounted` still throws on `pool`, and a test asserts it
- [ ] The documents of §11 are updated in the same branch
