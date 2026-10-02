# Test json types Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No `any` in hand-written code outside the migration signatures, enforced by a test, with every response read in a test typed against the server's own response types.

**Architecture:** A line-scanning unit test reports `any` in type positions, with the migration allowance as a dataset row. The migrations test's `as any` becomes a map of typed inserts. `json` becomes `json<T = unknown>()`, and each read names a type from `tests/fixtures/bodies.ts`, which derives them from the schemas in `src/`.

**Tech Stack:** TypeScript 7 (native compiler, no JS API), Vitest, Kysely, TypeBox.

**Spec:** `docs/superpowers/specs/2026-10-02-test-json-types-design.md`

## Global Constraints

- No production code changes.
- The one permitted `any`: `Kysely<any>` in a file under `src/db/migrations/`.
- Test data lives in datasets under `tests/fixtures/datasets/`.
- Commits: Conventional Commits, subject line only, no body, no trailer. `./run check` passes before every commit. Check `git branch --show-current` is `refactor/test-json-types` before every commit.

## Review Focus

- The scan must not report itself: its own patterns would otherwise contain the text they look for. Patterns are assembled from parts; Task 2's green run proves it.
- `//` inside a string (a URL) truncates the scanned code on that line; that can only hide a finding later on the same line, never invent one. Accepted in the spec.
- A response typed `json<X>()` with the wrong `X` compiles if the fields read happen to exist on `X`. The rule in Task 2 Step 5 ties the type to the asserted status; the reviewer should spot-check error-path reads use `ErrorResponse`.
- After Task 1, the composite-key test must still fail when the tenants agree — proved by a mutation run in Task 1, not assumed.

---

### Task 1: Typed inserts in the migrations test

**Files:**

- Modify: `tests/integration/migrations.test.ts`, the `refuses a %s row whose tenant disagrees with its resource` case

- [ ] **Step 1: Replace the cast with a map**

Replace the `it.each([...] as const)` block that ends with `(db.insertInto(table) as any)` with:

```ts
// The guarantee the composite foreign keys exist for. One typed insert per table, because
// `insertInto` over a union of table names cannot type the columns each one needs.
const insertFor = {
  schedule: (tenant_id: string, resource_id: string) =>
    getTestDb()
      .insertInto('schedule')
      .values({ tenant_id, resource_id, day_of_week: 0, start_time: '09:00', end_time: '17:00' })
      .execute(),
  schedule_exceptions: (tenant_id: string, resource_id: string) =>
    getTestDb()
      .insertInto('schedule_exceptions')
      .values({ tenant_id, resource_id, date: '2026-09-01', start_time: null, end_time: null })
      .execute(),
  bookings: (tenant_id: string, resource_id: string) =>
    getTestDb()
      .insertInto('bookings')
      .values({
        tenant_id,
        resource_id,
        start_time: '2026-09-01T09:00:00Z',
        end_time: '2026-09-01T10:00:00Z',
        status: 'confirmed',
        customer_id: 'c-1',
        held_until: null,
        concurrency_mode: 'exclusive',
      })
      .execute(),
}

it.each(['schedule', 'schedule_exceptions', 'bookings'] as const)(
  'refuses a %s row whose tenant disagrees with its resource',
  async (table) => {
    const other = await seedTenantId('other')
    const resourceId = await insertResource()
    await expect(insertFor[table](other, resourceId)).rejects.toThrow()
  },
)
```

If `npx tsc --noEmit` reports a column Kysely requires that the old untyped values omitted, add it with a value that is valid apart from the tenant, so the insert still fails for the tenant alone.

- [ ] **Step 2: Prove the cases still bite**

Temporarily pass the resource's own tenant instead of `other` (the `tenantId` the surrounding `describe` seeds) and run `npx vitest run tests/integration/migrations.test.ts -t "whose tenant disagrees"`.
Expected: the three cases FAIL — the inserts succeed. Restore `other` and run again.
Expected: PASS, 3 cases. A case that passes in the mutated run is testing something other than the tenant, and is fixed before going on.

- [ ] **Step 3: Check and commit**

Run: `./run check`. Expected: passes.

```bash
git add tests/integration/migrations.test.ts
git commit -m "test: type the cross-tenant inserts in the migrations test"
```

---

### Task 2: The scan, and `json<T>()`

**Files:**

- Create: `tests/fixtures/datasets/any-allowances.ts`
- Create: `tests/unit/no-any.test.ts`
- Create: `tests/fixtures/bodies.ts`
- Modify: `tests/fixtures/transport.ts`, `tests/fixtures/suites/types.ts`
- Modify: every file `tsc` reports after the flip — measured at 15
- Modify: `docs/backlog.md` — delete the entry

- [ ] **Step 1: Write the allowance dataset**

`tests/fixtures/datasets/any-allowances.ts`:

```ts
export interface AnyAllowance {
  name: string
  /** Matched against the path from the repository root. */
  file: RegExp
  /** Matched against the line. */
  line: RegExp
}

// `any` is assembled rather than written, so the scan does not report its own dataset.
const ANY = 'any'

export const anyAllowances: AnyAllowance[] = [
  {
    name: "a migration's Kysely signature, which Kysely's migration API requires",
    file: /^src\/db\/migrations\/[^/]+\.ts$/,
    line: new RegExp(String.raw`\bKysely<${ANY}>`),
  },
]
```

- [ ] **Step 2: Write the scan**

`tests/unit/no-any.test.ts`:

```ts
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { anyAllowances } from '../fixtures/datasets/any-allowances.js'

/**
 * The shared TypeScript rule allows `any` in one place: a migration's `Kysely<any>`. Nothing
 * else enforced it, so this does. It is a line scan, not a parse — TypeScript 7 ships no
 * JavaScript API to walk a tree with — and the spec for it says what that can and cannot see.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SCANNED = ['src', 'tests', 'scripts', 'testing/src']

// Assembled from parts, so this file does not report itself.
const ANY = 'any'
const TYPE_POSITION = new RegExp(
  String.raw`(:\s*${ANY}\b|\bas ${ANY}\b|=>\s*${ANY}\b|<${ANY}>|\b${ANY}\[\])`,
)
const SUPPRESSION = ['no', 'explicit', ANY].join('-')

interface Finding {
  file: string
  line: number
  text: string
}

function sourceFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => relative(ROOT, join(entry.parentPath, entry.name)))
}

/** The code on a line, without its comment, so prose such as "any number of" is not a finding. */
function code(line: string): string {
  const trimmed = line.trimStart()
  if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) return ''
  const comment = line.indexOf('//')
  return comment === -1 ? line : line.slice(0, comment)
}

function findings(): Finding[] {
  return SCANNED.flatMap(sourceFiles).flatMap((file) =>
    readFileSync(join(ROOT, file), 'utf8')
      .split('\n')
      .map((text, index) => ({ file, line: index + 1, text }))
      // A suppression is itself a comment, so it is looked for on the raw line.
      .filter(({ text }) => TYPE_POSITION.test(code(text)) || text.includes(SUPPRESSION)),
  )
}

const allowed = (finding: Finding) =>
  anyAllowances.some(({ file, line }) => file.test(finding.file) && line.test(finding.text))

it('writes any nowhere the shared rule does not allow it', () => {
  const unallowed = findings()
    .filter((finding) => !allowed(finding))
    .map(({ file, line, text }) => `${file}:${line}: ${text.trim()}`)
  expect(unallowed).toEqual([])
})

/** An allowance nothing uses any more is a stale row, and the list must stay exact. */
it.each(anyAllowances)('still needs the allowance for $name', ({ file, line }) => {
  expect(findings().some((finding) => file.test(finding.file) && line.test(finding.text))).toBe(
    true,
  )
})
```

- [ ] **Step 3: Run it and see it fail**

Run: `npx vitest run tests/unit/no-any.test.ts`
Expected: the first test FAILS listing exactly `tests/fixtures/suites/types.ts:83` and `tests/fixtures/transport.ts:20` (Task 1 removed the third); the allowance test PASSES.

- [ ] **Step 4: Add the body types and flip the declarations**

`tests/fixtures/bodies.ts`:

```ts
/**
 * The response bodies a test may read, derived from the schemas the server serialises with.
 * A test names one in `response.json<T>()`, so a field it reads that the contract does not
 * have fails to compile. `src/` exports a type beside some schemas and not others; this file
 * gives every one a type under the schema's own name.
 */
import type { Static } from 'typebox'
import type { AvailabilityResponse } from '../../src/modules/availability/availability.schemas.js'
import type {
  BookingListResponse as BookingListSchema,
  BookingResponse,
} from '../../src/modules/bookings/booking.schemas.js'
import type {
  ExceptionListResponse as ExceptionListSchema,
  ExceptionResponse,
} from '../../src/modules/exceptions/exception.schemas.js'
import type {
  ErrorResponse as ErrorSchema,
  ResourceListResponse as ResourceListSchema,
  ResourceResponse,
} from '../../src/modules/resources/resource.schemas.js'
import type {
  ScheduleResponse as ScheduleSchema,
  ScheduleRuleResponse,
} from '../../src/modules/schedule/schedule.schemas.js'

export type {
  AvailabilityResponse,
  BookingResponse,
  ExceptionResponse,
  ResourceResponse,
  ScheduleRuleResponse,
}
export type BookingListResponse = Static<typeof BookingListSchema>
export type ExceptionListResponse = Static<typeof ExceptionListSchema>
export type ErrorResponse = Static<typeof ErrorSchema>
export type ResourceListResponse = Static<typeof ResourceListSchema>
export type ScheduleResponse = Static<typeof ScheduleSchema>
```

If a name collides because `src/` already exports both a schema and a type of it, import the type directly instead of deriving it.

In `tests/fixtures/transport.ts` and `tests/fixtures/suites/types.ts`, change `json: () => any` to:

```ts
/** The parsed body, as the type the caller names; `unknown` until it names one. */
json: <T = unknown>() => T
```

- [ ] **Step 5: Type every read `tsc` reports**

Run `npx tsc --noEmit 2>&1 | grep 'error TS' | cut -d'(' -f1 | sort | uniq -c` and work file by file. For each read, name the type by what the test asserted about the response just before it:

| The test asserted, or the read is about                     | `json<…>()`                                   |
| ----------------------------------------------------------- | --------------------------------------------- |
| A 2xx from a resource route, one resource                   | `ResourceResponse`                            |
| A 2xx from `GET /resources`                                 | `ResourceListResponse`                        |
| A 2xx from the schedule routes                              | `ScheduleResponse`                            |
| A 2xx from an exception route, one / a list                 | `ExceptionResponse` / `ExceptionListResponse` |
| A 2xx from availability                                     | `AvailabilityResponse`                        |
| A 2xx from a booking route, one / a listing                 | `BookingResponse` / `BookingListResponse`     |
| A 4xx or 5xx, or reading `.error`, `.message` or `.details` | `ErrorResponse`                               |
| Deliberately probing for a field outside the contract       | `Record<string, unknown>`                     |

A response read twice is read once into a typed constant. Where a fixture helper returns a body to its callers (the suites' `newResource`, for instance), type the helper's return rather than each caller. Repeat until `tsc` reports nothing.

- [ ] **Step 6: Run the scan and the suite**

Run: `npx vitest run tests/unit/no-any.test.ts`. Expected: PASS, 2 tests.
Delete _Three `any`s remain in hand-written test code_ from `docs/backlog.md`.
Run: `./run check`. Expected: passes, 1202 tests (1200 before, plus the two scan tests).

- [ ] **Step 7: Commit**

```bash
git add tests docs/backlog.md
git commit -m "test: type response bodies and forbid any outside migrations"
```

---

### Task 3: Documents, and close the slice

- [ ] **Step 1:** In `docs/conventions.md`, after the technology-stack table, add: "The shared TypeScript rule allows `any` only in a migration's `Kysely<any>`; `tests/unit/no-any.test.ts` fails on any other, and a test reads a response body as a named type from `tests/fixtures/bodies.ts`."
- [ ] **Step 2:** Set the spec's status line to `**Status:** implemented · **Date:** 2026-10-02`, with an _As built_ note for any ruling that changed what it says. `git mv` this plan to `docs/superpowers/plans/archive/`.
- [ ] **Step 3:** `./run check`, then:

```bash
git add -A docs
git commit -m "docs: record that a test enforces the any rule, and archive the plan"
```
