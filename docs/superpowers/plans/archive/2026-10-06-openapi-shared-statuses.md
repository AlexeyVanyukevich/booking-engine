# OpenAPI shared statuses Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `openapi.json` declares every status each route can answer, each error status lists exactly its codes with meanings, examples and headers, and two tests keep it true.

**Architecture:** Every error class carries its `meaning` and an `example`. A pure module, `src/shared/responses.ts`, builds error response schemas from those and holds the rule table for statuses many routes share; an `onRoute` hook merges the rules into each route's real `response` schema before `@fastify/swagger` reads it. The integration suite records every reply against its route's schema, and a dataset triggers each shared status on every route.

**Tech Stack:** TypeScript (NodeNext, `.js` import extensions), Fastify 5.10, `typebox`, `@fastify/swagger` 9.8, `@fastify/rate-limit` 11.2, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-06-openapi-shared-statuses-design.md`

## Global Constraints

- `git branch --show-current` is `fix/openapi-shared-statuses` before every commit; the user switches branches between turns.
- Commits: Conventional Commits, subject only — no body, no footers, no `Co-Authored-By`. `./run check` passes before each.
- `error` is narrowed with `enum`, never with a union of literals or `anyOf` of `const`s — the serializer throws on those (spec §2.3).
- `src/shared/responses.ts` imports nothing from `src/db/`.
- Test data lives in datasets under `tests/fixtures/datasets/`, consumed by `it.each`; no literal cases in test bodies.
- No `any`. TypeBox is imported from `typebox`.
- `openapi.json` is written only by `./run openapi`, never by hand.
- The error table's Meaning column in `docs/conventions.md` is not reworded by this slice: the class `meaning` strings below are copied from it verbatim.

## Review Focus

- **`HEAD` requests.** Fastify registers a `HEAD` for every `GET`, `onRoute` fires for it, and a `HEAD` reply has no body. The hook's merge must be idempotent and give `HEAD` no `413`/`415`; the recorder must not report "no code" on a `HEAD` error. Pinned in Task 2 (a `HEAD` row in the rule dataset, and a merge-twice row) and Task 4 (a `HEAD` row in the recorder dataset).
- **A shared status already declared the old way.** A route that declares `400: SomeSchema` without `errorResponses` would have its codes silently overwritten. The hook throws at startup instead. Pinned in Task 2.
- **`text/plain` is not an unsupported type.** Fastify parses `application/json` and `text/plain` by default, so a `text/plain` body answers `400`, not `415`. The `415` trigger sends `application/xml`. Pinned by the Task 5 dataset.
- **A malformed JSON body on a route with no schema parts.** It answers `400 validation_error` through the framework translation whatever the route validates, so the `400` rule also applies to every method Fastify parses a body for — a deviation from the spec's wording, listed under "Deviations from the spec" at the end. Pinned by the Task 2 row "a scoped POST with no schema parts".
- **Requests sent in `beforeAll` or `afterAll`.** The recorder's `afterEach` would attribute a `beforeAll` mismatch to the first test and never see an `afterAll` one. The setup file checks in `afterAll` too. Pinned in Task 4.

---

## File structure

| File                                           | Responsibility                                                                                          |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `src/shared/errors.ts` (modify)                | `meaning` and `example` on every code; `CLIENT_ERRORS` replaces the bare map                            |
| `src/shared/responses.ts` (create)             | Pure: catalogue of codes, rule table, `errorResponse`, `errorResponses`, merge; plus the `onRoute` hook |
| `src/shared/auth.ts` (modify)                  | Export `isDocsRoute`                                                                                    |
| `src/app.ts` (modify)                          | Register the hook between auth and swagger                                                              |
| `src/modules/*/*.routes.ts` (modify)           | Declare route-specific errors with `errorResponses(...)`                                                |
| `src/modules/resources/resource.schemas.ts`    | `ErrorResponse` removed                                                                                 |
| `tests/fixtures/bodies.ts` (modify)            | `ErrorResponse` type from `ErrorBody`                                                                   |
| `tests/integration/contract.ts` (create)       | The recorder and its mismatch list                                                                      |
| `tests/integration/contract.setup.ts` (create) | `afterEach`/`afterAll` asserting no mismatches                                                          |
| `tests/integration/shared-responses.test.ts`   | The trigger runner                                                                                      |
| `tests/fixtures/datasets/response-rules.ts`    | Unit dataset: route shapes → statuses; `errorResponses` cases                                           |
| `tests/fixtures/datasets/contract-recorder.ts` | Unit dataset: replies → expected mismatches                                                             |
| `tests/fixtures/datasets/shared-responses.ts`  | Trigger dataset, one row per shared status, plus the named skip                                         |

---

### Task 1: Every error code carries its meaning and an example

**Files:**

- Modify: `src/shared/errors.ts`
- Test: `tests/unit/documented-tables.test.ts`

**Interfaces:**

- Produces: `interface ErrorExample { message: string; details?: Record<string, unknown> }`; `interface ErrorDescription { code: string; meaning: string; example: ErrorExample }`; `AppError` gains `abstract readonly meaning: string` and `abstract readonly example: ErrorExample`; `describeError(ErrorType: new (message: string) => AppError): ErrorDescription`; `CLIENT_ERRORS: Record<number, ErrorDescription>` (replaces `CLIENT_ERROR_CODES`); `INTERNAL_ERROR: ErrorDescription` (replaces `INTERNAL_ERROR_CODE`). `FALLBACK_CLIENT_ERROR_CODE` is unchanged.

- [ ] **Step 1: Write the failing test.** In `tests/unit/documented-tables.test.ts`, inside `describe('the error table in conventions.md')`, replace `emitted()` so it collects descriptions, and add a case for the Meaning column:

```ts
/**
 * Every code the engine can put in an `error` field: one per `AppError` subclass, plus the
 * framework 4xx translations, plus the one the handler builds directly.
 * `FALLBACK_CLIENT_ERROR_CODE` is absent on purpose — it has no fixed status, so it is
 * documented in prose instead, which the last case here asserts.
 */
function emitted(): Map<string, { status: number; meaning: string }> {
  const codes = new Map<string, { status: number; meaning: string }>()

  for (const exported of Object.values(errors)) {
    if (typeof exported !== 'function') continue
    if (!(exported.prototype instanceof errors.AppError)) continue
    const instance = new (exported as new (message: string) => errors.AppError)('probe')
    codes.set(instance.code, { status: instance.statusCode, meaning: instance.meaning })
  }

  for (const [status, description] of Object.entries(errors.CLIENT_ERRORS)) {
    codes.set(description.code, { status: Number(status), meaning: description.meaning })
  }

  codes.set(errors.INTERNAL_ERROR.code, { status: 500, meaning: errors.INTERNAL_ERROR.meaning })
  return codes
}

const pairs = (codes: Map<string, { status: number }>) =>
  [...codes].map(([code, { status }]) => `${code} ${status}`)

it('documents every code the engine can emit, at the status it emits it', () => {
  expect([...documented].sort()).toEqual(pairs(emitted()).sort())
})

/**
 * The meaning is stated once, on the class, and read from there by the OpenAPI document; this
 * column is the copy, so it is held equal rather than proof-read.
 */
it('gives every code the meaning the code states', () => {
  const meanings = new Map(table.rows.map((row) => [unwrap(row[0]!), row[2]!]))
  for (const [code, { meaning }] of emitted()) {
    expect(meanings.get(code), code).toBe(meaning)
  }
})
```

In the departures case, replace `const emittedCodes = new Set([...emitted()].map((pair) => pair.split(' ')[0]!))` with `const emittedCodes = new Set(emitted().keys())`.

- [ ] **Step 2: Run it; expect FAIL.** `npx vitest run tests/unit/documented-tables.test.ts` — `errors.CLIENT_ERRORS` is undefined.

- [ ] **Step 3: Implement in `src/shared/errors.ts`.**

Add above `AppError`:

```ts
/** What the OpenAPI document shows for a code. Illustration: never compared with real throws. */
export interface ErrorExample {
  message: string
  details?: Record<string, unknown>
}

/** A code as the documentation describes it — the error table and the OpenAPI document both read this. */
export interface ErrorDescription {
  code: string
  meaning: string
  example: ErrorExample
}
```

In `AppError`, after `abstract readonly code: string`:

```ts
  /** One line, Markdown allowed. The error table in `docs/conventions.md` is asserted equal to it. */
  abstract readonly meaning: string
  abstract readonly example: ErrorExample
```

Give every subclass both fields, after `code`. The meanings are the table's Meaning cells, verbatim; the messages are the ones the code throws:

| Class                             | `meaning`                                                                                   | `example`                                                                                                                                                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ValidationError`                 | `Body, query or path failed validation`                                                     | `{ message: 'Unknown IANA timezone "Mars/Olympus"', details: { field: 'timezone' } }`                                                                                                                                      |
| `InvalidRangeError`               | ``to <= from`, or wider than `MAX_RANGE_DAYS` `` (backticks as in the table)                | `{ message: 'to must be after from', details: { from: '2026-07-20', to: '2026-07-13' } }`                                                                                                                                  |
| `ScheduleOverlapError`            | `Two rules on one weekday overlap`                                                          | `{ message: 'Schedule rules on the same weekday must not overlap', details: { day_of_week: 0 } }`                                                                                                                          |
| `ScheduleShapeMismatchError`      | `Rule shape does not match the slot duration`                                               | `{ message: 'A day-based resource (P<n>D) requires schedule rules with null times', details: { day_of_week: 0 } }`                                                                                                         |
| `UnsupportedConcurrencyModeError` | ``A booking reached the write path carrying `pool`; selection should have chosen a member`` | `{ message: 'A booking row reached the write path carrying concurrency_mode "pool"', details: { concurrency_mode: 'pool' } }`                                                                                              |
| `NotFoundError`                   | `No such resource or booking, or no such route`                                             | `{ message: 'Resource 6f1c2b9e-4a63-4e0b-9a51-2d3c4b5a6e7f not found' }`                                                                                                                                                   |
| `UnauthorizedError`               | `Missing, malformed, unknown or revoked key; inactive tenant`                               | `{ message: 'A valid API key is required' }`                                                                                                                                                                               |
| `ForbiddenScopeError`             | `Valid key, but it does not hold the scope the route requires`                              | `{ message: 'This key does not hold bookings.read', details: { required: 'bookings.read' } }`                                                                                                                              |
| `ForbiddenOriginError`            | ``A console write whose `Origin` is not the console itself``                                | `{ message: 'This request did not come from the console' }`                                                                                                                                                                |
| `InvalidIntervalError`            | `` `end_time <= start_time` ``                                                              | `{ message: 'end_time must be after start_time', details: { start_time: '2026-07-20T10:00:00+02:00', end_time: '2026-07-20T09:00:00+02:00' } }`                                                                            |
| `InvalidSlotBoundaryError`        | `Start or end does not fall on a slot boundary`                                             | `{ message: 'start_time and end_time must fall on slot boundaries offered by this resource', details: { start_time: '2026-07-20T09:15:00+02:00', end_time: '2026-07-20T10:00:00+02:00' } }`                                |
| `OutsideScheduleError`            | `A slot in the requested run is not offered`                                                | `{ message: 'The requested interval is not a contiguous run of slots this resource offers', details: { start_time: '2026-07-20T16:00:00+02:00', end_time: '2026-07-20T18:00:00+02:00' } }`                                 |
| `SlotUnavailableError`            | `The slots exist and are offered, but capacity is taken`                                    | `{ message: 'Those slots are offered, but they are already taken', details: { start_time: '2026-07-20T09:00:00+02:00', end_time: '2026-07-20T10:00:00+02:00' } }`                                                          |
| `ResourceInactiveError`           | ``The resource exists but `is_active` is false``                                            | `{ message: 'Resource 6f1c2b9e-4a63-4e0b-9a51-2d3c4b5a6e7f is not active and cannot be booked', details: { resource_id: '6f1c2b9e-4a63-4e0b-9a51-2d3c4b5a6e7f' } }`                                                        |
| `InvalidStateTransitionError`     | `The requested transition is not legal from the current status`                             | `{ message: 'A booking in status "cancelled" cannot become "confirmed"', details: { status: 'cancelled', requested: 'confirmed' } }`                                                                                       |
| `ResourceHasBookingsError`        | `` `DELETE /resources/:id` with bookings on record ``                                       | `{ message: 'Resource 6f1c2b9e-4a63-4e0b-9a51-2d3c4b5a6e7f has bookings on record and cannot be deleted; set is_active to false to retire it instead', details: { resource_id: '6f1c2b9e-4a63-4e0b-9a51-2d3c4b5a6e7f' } }` |
| `InvalidPoolMembershipError`      | `` `pool_id` names a non-pool, a pool, or a resource on a different grid ``                 | `{ message: 'No pool 6f1c2b9e-4a63-4e0b-9a51-2d3c4b5a6e7f in this tenant', details: { rule: 'tenant', pool_id: '6f1c2b9e-4a63-4e0b-9a51-2d3c4b5a6e7f' } }`                                                                 |
| `PoolHasMembersError`             | `` `DELETE /resources/:id` on a pool whose members have not left ``                         | `{ message: 'Pool 6f1c2b9e-4a63-4e0b-9a51-2d3c4b5a6e7f still has members; move them out with PATCH pool_id: null before deleting it', details: { pool_id: '6f1c2b9e-4a63-4e0b-9a51-2d3c4b5a6e7f' } }`                      |
| `IdempotencyKeyReusedError`       | `Same key, different request body`                                                          | `{ message: 'That idempotency key was used for a different booking; this is a caller error, not a retry' }`                                                                                                                |
| `HoldExpiredError`                | `` `confirm` on a hold whose `held_until` has passed ``                                     | `{ message: 'That hold expired before it was confirmed', details: { status: 'expired' } }`                                                                                                                                 |
| `RateLimitedError`                | ``The per-key limit for this minute is used up; carries `Retry-After` ``                    | `{ message: 'Too many requests; slow down and retry' }`                                                                                                                                                                    |
| `ConcurrentUpdateError`           | `Contention rolled the transaction back; retry the request`                                 | `{ message: 'The booking could not complete because of concurrent activity on the same rows; retry the request' }`                                                                                                         |

Copy each meaning from `docs/conventions.md` rather than from this table if the two differ by a character — the test compares against the document. Type each field as `readonly example: ErrorExample = { … }` so `details` is checked.

Replace `CLIENT_ERROR_CODES` and `INTERNAL_ERROR_CODE`:

```ts
/** Reads a class's description without throwing it; the probe message is never shown. */
export function describeError(ErrorType: new (message: string) => AppError): ErrorDescription {
  const probe = new ErrorType('probe')
  return { code: probe.code, meaning: probe.meaning, example: probe.example }
}

/**
 * What the framework's own 4xx are translated into, so a caller's mistake never surfaces as
 * `internal_error`. Exported because it is half of what the engine can emit: the error table in
 * `docs/conventions.md` and the OpenAPI document both read this and the `AppError` subclasses
 * together. A framework 400 and 404 reuse the engine's own codes, so they reuse their classes.
 */
export const CLIENT_ERRORS: Record<number, ErrorDescription> = {
  400: describeError(ValidationError),
  404: describeError(NotFoundError),
  405: {
    code: 'method_not_allowed',
    meaning: 'The framework matched the path but not the method',
    example: { message: 'Method Not Allowed' },
  },
  406: {
    code: 'not_acceptable',
    meaning: 'The framework could not satisfy the `Accept` header',
    example: { message: 'Not Acceptable' },
  },
  413: {
    code: 'payload_too_large',
    meaning: "Body beyond Fastify's body limit",
    example: { message: 'Request body is too large' },
  },
  415: {
    code: 'unsupported_media_type',
    meaning: 'Body sent with a content type the route cannot parse',
    example: { message: 'Unsupported Media Type: application/xml' },
  },
}

export const INTERNAL_ERROR: ErrorDescription = {
  code: 'internal_error',
  meaning: 'Anything unexpected',
  example: { message: 'Internal server error' },
}
```

`CLIENT_ERRORS` must sit below the `ValidationError` and `NotFoundError` declarations (class declarations are not hoisted). In `clientErrorCode`, return `CLIENT_ERRORS[statusCode]?.code ?? FALLBACK_CLIENT_ERROR_CODE`. In the 500 branch, send `{ error: INTERNAL_ERROR.code, message: INTERNAL_ERROR.example.message }`.

- [ ] **Step 4: Run it; expect PASS.** `npx vitest run tests/unit/documented-tables.test.ts tests/unit/errors.test.ts` and `npx tsc --noEmit`. If a Meaning case fails, the class string differs from the table: correct the class, not the table.

- [ ] **Step 5: Commit.** `./run check`, then `git add src/shared/errors.ts tests/unit/documented-tables.test.ts && git commit -m "refactor(errors): give every error code its meaning and an example"`

---

### Task 2: Error response schemas and the shared rules, as a pure module

**Files:**

- Create: `src/shared/responses.ts`, `tests/fixtures/datasets/response-rules.ts`, `tests/unit/responses.test.ts`

**Interfaces:**

- Consumes: Task 1's `AppError`, `ErrorExample`, `describeError`, `CLIENT_ERRORS`, `INTERNAL_ERROR`; `md` from `./docs.js`.
- Produces:
  - `ErrorBody` — the generic TypeBox error schema (no `enum`), for test body types
  - `interface ErrorEntry { status: number; code: string; meaning: string; example: ErrorExample; headers: readonly string[] }`
  - `catalogue(): ReadonlyMap<string, ErrorEntry>`
  - `errorResponse(entries: readonly ErrorEntry[]): TSchema`
  - `errorResponses(...classes: ErrorClass[]): Record<number, TSchema>` where `type ErrorClass = new (message: string) => AppError`
  - `interface RouteShape { methods: readonly string[]; isPublic: boolean; validates: boolean }`
  - `interface SharedRule { status: number; code: string; appliesTo: (route: RouteShape) => boolean }`, `SHARED_RULES: readonly SharedRule[]`
  - `declaredCodes(schema: unknown, where: string): string[]`
  - `withSharedResponses(response: Record<string, unknown> | undefined, route: RouteShape, where: string): Record<string, unknown>`

- [ ] **Step 1: Write the dataset `tests/fixtures/datasets/response-rules.ts`.**

```ts
import type { RouteShape } from '../../../src/shared/responses.js'

export interface RuleCase {
  name: string
  route: RouteShape
  /** The shared statuses the rules must add, sorted. */
  statuses: number[]
}

export const ruleCases: RuleCase[] = [
  {
    name: 'a public GET with no schema parts',
    route: { methods: ['GET'], isPublic: true, validates: false },
    statuses: [429, 500],
  },
  {
    name: 'a public GET with a query',
    route: { methods: ['GET'], isPublic: true, validates: true },
    statuses: [400, 429, 500],
  },
  {
    name: 'a scoped GET with params',
    route: { methods: ['GET'], isPublic: false, validates: true },
    statuses: [400, 401, 403, 429, 500],
  },
  {
    name: 'a scoped HEAD with params',
    route: { methods: ['HEAD'], isPublic: false, validates: true },
    statuses: [400, 401, 403, 429, 500],
  },
  {
    name: 'a scoped GET with no schema parts',
    route: { methods: ['GET'], isPublic: false, validates: false },
    statuses: [401, 403, 429, 500],
  },
  {
    name: 'a scoped POST with no schema parts',
    route: { methods: ['POST'], isPublic: false, validates: false },
    statuses: [400, 401, 403, 413, 415, 429, 500],
  },
  {
    name: 'a scoped POST with params and a body',
    route: { methods: ['POST'], isPublic: false, validates: true },
    statuses: [400, 401, 403, 413, 415, 429, 500],
  },
  {
    name: 'a scoped PUT',
    route: { methods: ['PUT'], isPublic: false, validates: true },
    statuses: [400, 401, 403, 413, 415, 429, 500],
  },
  {
    name: 'a scoped PATCH',
    route: { methods: ['PATCH'], isPublic: false, validates: true },
    statuses: [400, 401, 403, 413, 415, 429, 500],
  },
  {
    name: 'a scoped DELETE, whose body Fastify parses',
    route: { methods: ['DELETE'], isPublic: false, validates: true },
    statuses: [400, 401, 403, 413, 415, 429, 500],
  },
]

export interface GroupingCase {
  name: string
  /** Export names from `src/shared/errors.ts`, resolved by the test. */
  classes: string[]
  /** status → codes in the `enum`, in order. */
  expected: Record<number, string[]>
  /** status → header names the response declares. */
  headers: Record<number, string[]>
}

export const groupingCases: GroupingCase[] = [
  {
    name: 'one class, one status',
    classes: ['NotFoundError'],
    expected: { 404: ['not_found'] },
    headers: {},
  },
  {
    name: 'two classes sharing a status become one response',
    classes: ['NotFoundError', 'SlotUnavailableError', 'IdempotencyKeyReusedError'],
    expected: { 404: ['not_found'], 409: ['slot_unavailable', 'idempotency_key_reused'] },
    headers: {},
  },
  {
    name: "a class's own headers are declared",
    classes: ['ConcurrentUpdateError'],
    expected: { 503: ['concurrent_update'] },
    headers: { 503: ['retry-after'] },
  },
]

export interface MergeCase {
  name: string
  route: RouteShape
  /** Export names declared by the route itself. */
  declared: string[]
  expected: Record<number, string[]>
  headers: Record<number, string[]>
}

export const mergeCases: MergeCase[] = [
  {
    name: "a route's own 400 codes come first, the shared one last",
    route: { methods: ['GET'], isPublic: false, validates: true },
    declared: ['InvalidRangeError', 'NotFoundError'],
    expected: {
      400: ['invalid_range', 'validation_error'],
      401: ['unauthorized'],
      403: ['forbidden_scope'],
      404: ['not_found'],
      429: ['rate_limited'],
      500: ['internal_error'],
    },
    headers: {
      401: ['www-authenticate'],
      429: ['retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset'],
    },
  },
  {
    name: 'a public route gets no 401 or 403',
    route: { methods: ['GET'], isPublic: true, validates: false },
    declared: [],
    expected: { 429: ['rate_limited'], 500: ['internal_error'] },
    headers: {
      429: ['retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset'],
    },
  },
]
```

- [ ] **Step 2: Write `tests/unit/responses.test.ts`.**

```ts
import { describe, expect, it } from 'vitest'
import { Type, type TSchema } from 'typebox'
import * as errors from '../../src/shared/errors.js'
import {
  catalogue,
  declaredCodes,
  errorResponses,
  SHARED_RULES,
  withSharedResponses,
} from '../../src/shared/responses.js'
import { groupingCases, mergeCases, ruleCases } from '../fixtures/datasets/response-rules.js'

type ErrorClass = new (message: string) => errors.AppError

function classNamed(name: string): ErrorClass {
  const exported = (errors as Record<string, unknown>)[name]
  if (typeof exported !== 'function') throw new Error(`errors.ts exports no ${name}`)
  return exported as ErrorClass
}

interface Built {
  description?: string
  headers?: Record<string, unknown>
  'x-examples'?: Record<string, { value: { error: string } }>
  properties: { error: { enum: string[] } }
}

const built = (schema: unknown) => schema as Built

function shapeOf(response: Record<string, unknown>) {
  const codes: Record<number, string[]> = {}
  const headers: Record<number, string[]> = {}
  for (const [status, schema] of Object.entries(response)) {
    codes[Number(status)] = built(schema).properties.error.enum
    const names = Object.keys(built(schema).headers ?? {})
    if (names.length > 0) headers[Number(status)] = names
  }
  return { codes, headers }
}

describe('the shared rules', () => {
  it.each(ruleCases)('$name', ({ route, statuses }) => {
    const applied = SHARED_RULES.filter((rule) => rule.appliesTo(route)).map((rule) => rule.status)
    expect(applied.sort((a, b) => a - b)).toEqual(statuses)
  })

  it.each(SHARED_RULES)('names a code the engine emits at $status', ({ status, code }) => {
    expect(catalogue().get(code)?.status).toBe(status)
  })
})

describe('errorResponses', () => {
  it.each(groupingCases)('$name', ({ classes, expected, headers }) => {
    const shape = shapeOf(errorResponses(...classes.map(classNamed)))
    expect(shape.codes).toEqual(expected)
    expect(shape.headers).toEqual(headers)
  })

  it.each(groupingCases)('keys one example per code, carrying that code: $name', ({ classes }) => {
    for (const schema of Object.values(errorResponses(...classes.map(classNamed)))) {
      const { properties, 'x-examples': examples } = built(schema)
      expect(Object.keys(examples ?? {})).toEqual(properties.error.enum)
      for (const [code, example] of Object.entries(examples ?? {})) {
        expect(example.value.error).toBe(code)
      }
    }
  })

  it.each(groupingCases)('describes every code with its meaning: $name', ({ classes }) => {
    for (const schema of Object.values(errorResponses(...classes.map(classNamed)))) {
      for (const code of built(schema).properties.error.enum) {
        expect(built(schema).description).toContain(
          `\`${code}\` — ${catalogue().get(code)!.meaning}`,
        )
      }
    }
  })
})

describe('withSharedResponses', () => {
  it.each(mergeCases)('$name', ({ route, declared, expected, headers }) => {
    const merged = withSharedResponses(errorResponses(...declared.map(classNamed)), route, 'probe')
    expect(shapeOf(merged)).toEqual({ codes: expected, headers })
  })

  it.each(mergeCases)('gives the same answer applied twice: $name', ({ route, declared }) => {
    const once = withSharedResponses(errorResponses(...declared.map(classNamed)), route, 'probe')
    expect(withSharedResponses(once, route, 'probe')).toEqual(once)
  })

  it('leaves success responses as they are', () => {
    const ok: TSchema = Type.Object({ status: Type.String() })
    const merged = withSharedResponses({ 200: ok }, ruleCases[0]!.route, 'probe')
    expect(merged['200']).toBe(ok)
  })

  it('refuses a shared status declared without errorResponses', () => {
    const plain = Type.Object({ error: Type.String(), message: Type.String() })
    expect(() =>
      withSharedResponses(
        { 400: plain },
        { methods: ['GET'], isPublic: false, validates: true },
        'GET /x',
      ),
    ).toThrow(/GET \/x 400 .*errorResponses/)
  })

  it('reads no codes from a schema without an enum', () => {
    expect(() => declaredCodes(Type.Object({}), 'GET /x 400')).toThrow(/errorResponses/)
  })
})
```

- [ ] **Step 3: Run it; expect FAIL.** `npx vitest run tests/unit/responses.test.ts` — `responses.js` cannot be resolved.

- [ ] **Step 4: Write `src/shared/responses.ts`.**

```ts
import { Type, type TSchema } from 'typebox'
import { md } from './docs.js'
import * as errors from './errors.js'
import type { AppError, ErrorExample } from './errors.js'

/**
 * Every error response in the OpenAPI document is built here, from the codes themselves: the
 * class states its status, meaning, example and headers once, and this turns them into the
 * schema the route serializes with and the document shows. Pure — nothing here reaches a
 * database — so the rules are tested without one.
 */

type ErrorClass = new (message: string) => AppError

export interface ErrorEntry {
  status: number
  code: string
  meaning: string
  example: ErrorExample
  headers: readonly string[]
}

const ERROR_FIELD = {
  description: 'Stable machine-readable code — branch on this, not on the message.',
}
const MESSAGE_FIELD = { description: 'Human-readable explanation. May change.' }
const DETAILS_FIELD = { description: 'Context, when there is any.' }

/** The shape every error shares, without the narrowing a declared response adds. */
export const ErrorBody = Type.Object({
  error: Type.String(ERROR_FIELD),
  message: Type.String(MESSAGE_FIELD),
  details: Type.Optional(Type.Unknown(DETAILS_FIELD)),
})

/**
 * Headers a code carries that its class does not set: the rate-limit plugin writes these on the
 * reply before it throws, and Fastify's error path keeps them.
 */
const PLUGIN_HEADERS: Record<string, readonly string[]> = {
  rate_limited: ['retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset'],
}

const HEADER_DOCS: Record<string, { type: 'integer' | 'string'; description: string }> = {
  'www-authenticate': {
    type: 'string',
    description: 'Always `Bearer`, the scheme the key is sent in',
  },
  'retry-after': {
    type: 'integer',
    description: 'Seconds to wait before sending the same request again',
  },
  'x-ratelimit-limit': { type: 'integer', description: 'Requests this key may send per minute' },
  'x-ratelimit-remaining': { type: 'integer', description: 'Requests left in the current minute' },
  'x-ratelimit-reset': {
    type: 'integer',
    description: "Seconds until the current minute's count resets",
  },
}

function entryOfClass(ErrorType: ErrorClass): ErrorEntry {
  const probe = new ErrorType('probe')
  return {
    status: probe.statusCode,
    code: probe.code,
    meaning: probe.meaning,
    example: probe.example,
    headers: [...Object.keys(probe.headers ?? {}), ...(PLUGIN_HEADERS[probe.code] ?? [])],
  }
}

function isErrorClass(value: unknown): value is ErrorClass {
  return typeof value === 'function' && value.prototype instanceof errors.AppError
}

let built: ReadonlyMap<string, ErrorEntry> | undefined

/** Every code the engine can emit, by code. Built on first use, once. */
export function catalogue(): ReadonlyMap<string, ErrorEntry> {
  if (built) return built
  const entries: ErrorEntry[] = Object.values(errors).filter(isErrorClass).map(entryOfClass)
  for (const [status, description] of Object.entries(errors.CLIENT_ERRORS)) {
    entries.push({ status: Number(status), headers: [], ...description })
  }
  entries.push({ status: 500, headers: [], ...errors.INTERNAL_ERROR })
  built = new Map(entries.map((entry) => [entry.code, entry]))
  return built
}

function lookup(code: string): ErrorEntry {
  const entry = catalogue().get(code)
  if (!entry) throw new Error(`No error code ${code} in src/shared/errors.ts`)
  return entry
}

function headerSchema(name: string) {
  const doc = HEADER_DOCS[name]
  if (!doc) throw new Error(`Header ${name} has no entry in HEADER_DOCS`)
  return doc
}

function describeCodes(entries: readonly ErrorEntry[]): string {
  const lines = entries.map((entry) => `\`${entry.code}\` — ${entry.meaning}`)
  return entries.length === 1 ? lines[0]! : md('One of:', lines)
}

/**
 * One status's response: `error` narrowed to exactly these codes with `enum` — never a union of
 * literals, which the serializer validates and would turn an unlisted code into a 500 — a
 * description naming each, one example per code keyed by it, and the headers they carry.
 */
export function errorResponse(entries: readonly ErrorEntry[]): TSchema {
  const headers = [...new Set(entries.flatMap((entry) => entry.headers))]
  return Type.Object(
    {
      error: Type.String({ ...ERROR_FIELD, enum: entries.map((entry) => entry.code) }),
      message: Type.String(MESSAGE_FIELD),
      details: Type.Optional(Type.Unknown(DETAILS_FIELD)),
    },
    {
      description: describeCodes(entries),
      'x-examples': Object.fromEntries(
        entries.map((entry) => [entry.code, { value: { error: entry.code, ...entry.example } }]),
      ),
      ...(headers.length > 0
        ? { headers: Object.fromEntries(headers.map((name) => [name, headerSchema(name)])) }
        : {}),
    },
  )
}

/** A route's own error responses, grouped by the status each class states. */
export function errorResponses(...classes: ErrorClass[]): Record<number, TSchema> {
  const byStatus = new Map<number, ErrorEntry[]>()
  for (const entry of classes.map(entryOfClass)) {
    byStatus.set(entry.status, [...(byStatus.get(entry.status) ?? []), entry])
  }
  return Object.fromEntries(
    [...byStatus].map(([status, entries]) => [status, errorResponse(entries)]),
  )
}

export interface RouteShape {
  methods: readonly string[]
  isPublic: boolean
  /** The route has a params, querystring or body schema. */
  validates: boolean
}

export interface SharedRule {
  status: number
  code: string
  appliesTo: (route: RouteShape) => boolean
}

/**
 * The methods Fastify 5.10 parses a body for, from its `bodywith` set, less `OPTIONS`, which no
 * route here serves. A body arriving on any of them can be too large or of a type no parser
 * accepts, whatever the route declares. The trigger dataset proves this list in both
 * directions, so it does not have to be taken on trust.
 */
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const takesBody = (route: RouteShape) => route.methods.some((method) => BODY_METHODS.has(method))

export const SHARED_RULES: readonly SharedRule[] = [
  // A malformed JSON body answers 400 through the framework translation even on a route that
  // validates nothing, so a body method is enough.
  {
    status: 400,
    code: 'validation_error',
    appliesTo: (route) => route.validates || takesBody(route),
  },
  { status: 401, code: 'unauthorized', appliesTo: (route) => !route.isPublic },
  { status: 403, code: 'forbidden_scope', appliesTo: (route) => !route.isPublic },
  { status: 413, code: 'payload_too_large', appliesTo: takesBody },
  { status: 415, code: 'unsupported_media_type', appliesTo: takesBody },
  // Public routes are limited too, keyed on the address.
  { status: 429, code: 'rate_limited', appliesTo: () => true },
  { status: 500, code: 'internal_error', appliesTo: () => true },
]

/** The codes a declared error response lists — readable only from one `errorResponse` built. */
export function declaredCodes(schema: unknown, where: string): string[] {
  const codes = (schema as { properties?: { error?: { enum?: unknown } } }).properties?.error?.enum
  if (!Array.isArray(codes)) {
    throw new Error(`${where} is declared without errorResponses(), so its codes cannot be merged`)
  }
  return codes as string[]
}

/**
 * A route's response map with every shared rule that applies merged in. Where the route already
 * declares that status its codes come first and the shared one last; merging twice changes
 * nothing, which matters because Fastify hands the `HEAD` twin of a `GET` the same schema.
 */
export function withSharedResponses(
  response: Record<string, unknown> | undefined,
  route: RouteShape,
  where: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...response }
  for (const rule of SHARED_RULES) {
    if (!rule.appliesTo(route)) continue
    const existing = result[rule.status]
    const codes = existing === undefined ? [] : declaredCodes(existing, `${where} ${rule.status}`)
    result[rule.status] = errorResponse([...new Set([...codes, rule.code])].map(lookup))
  }
  return result
}
```

If `npx tsc --noEmit` rejects `'x-examples'` or `headers` in the options object, they are TypeBox `SchemaOptions` (an open index signature in `typebox`); keep them in the options argument, not in the properties.

- [ ] **Step 5: Run it; expect PASS.** `npx vitest run tests/unit/responses.test.ts`, then `grep -n "db/" src/shared/responses.ts` returns nothing, then `npx tsc --noEmit`.

- [ ] **Step 6: Commit.** `./run check`, then `git add src/shared/responses.ts tests/unit/responses.test.ts tests/fixtures/datasets/response-rules.ts && git commit -m "refactor(openapi): build error response schemas from the error classes"`

---

### Task 3: Every route declares the shared statuses and its own errors

**Files:**

- Modify: `src/shared/auth.ts` (export `isDocsRoute`), `src/shared/responses.ts` (add `registerResponseRules`), `src/app.ts`, `src/modules/{resources,schedule,exceptions,availability,bookings}/*.routes.ts`, `src/modules/resources/resource.schemas.ts`, `tests/fixtures/bodies.ts`, `openapi.json` (regenerated), `docs/backlog.md`
- Test: `tests/integration/openapi.test.ts`

**Interfaces:**

- Consumes: Task 2's `errorResponses`, `withSharedResponses`, `ErrorBody`.
- Produces: `registerResponseRules(app: FastifyInstance): void`; `isDocsRoute(url: string): boolean` exported from `src/shared/auth.ts`.

- [ ] **Step 1: Write the failing tests.** In `tests/integration/openapi.test.ts`, widen the `document` type's operation to `Record<string, unknown>` (it is) and add, inside `describe('OpenAPI document')`:

```ts
interface DocumentedError {
  description: string
  headers?: Record<string, unknown>
  content: {
    'application/json': {
      schema: { properties: { error: { enum?: string[] } } }
      examples?: Record<string, { value: { error: string } }>
    }
  }
}

const errorResponsesOf = (method: string, path: string) =>
  Object.entries(
    document.paths[path]![method]!.responses as Record<string, DocumentedError>,
  ).filter(([status]) => Number(status) >= 400)

it.each(ROUTES)('narrows every error code of %s %s and gives each an example', (method, path) => {
  for (const [status, response] of errorResponsesOf(method, path)) {
    const media = response.content['application/json']
    const codes = media.schema.properties.error.enum
    expect(codes, `${status} has no enum`).toBeDefined()
    expect(Object.keys(media.examples ?? {}), `${status} examples`).toEqual(codes)
    expect(response.description, `${status} description`).not.toBe('Default Response')
  }
})

it.each(ROUTES)('declares 429 and 500 on %s %s', (method, path) => {
  const statuses = errorResponsesOf(method, path).map(([status]) => status)
  expect(statuses).toEqual(expect.arrayContaining(['429', '500']))
})

it('documents the rate-limit headers on a 429', () => {
  const [, tooMany] = errorResponsesOf('get', '/resources').find(([status]) => status === '429')!
  expect(Object.keys(tooMany.headers ?? {}).sort()).toEqual([
    'retry-after',
    'x-ratelimit-limit',
    'x-ratelimit-remaining',
    'x-ratelimit-reset',
  ])
})

it('lists the codes a booking can lose its slot with', () => {
  const [, conflict] = errorResponsesOf('post', '/resources/{id}/bookings').find(
    ([status]) => status === '409',
  )!
  expect(conflict.content['application/json'].schema.properties.error.enum).toEqual([
    'resource_inactive',
    'slot_unavailable',
    'idempotency_key_reused',
  ])
})
```

The full status-per-route proof is Task 5's; these pin the document's form.

- [ ] **Step 2: Run them; expect FAIL.** `npx vitest run tests/integration/openapi.test.ts` — no `enum`, no `429`.

- [ ] **Step 3: Register the hook.** In `src/shared/auth.ts` change `function isDocsRoute` to `export function isDocsRoute`. Append to `src/shared/responses.ts`:

```ts
import type { FastifyInstance } from 'fastify'
import { isDocsRoute } from './auth.js'

/**
 * Merges the shared rules into every documented route's real response schema, so a reply is
 * serialized against what the document shows. Registered before `@fastify/swagger`, whose own
 * `onRoute` hook reads the schema as it stands then.
 */
export function registerResponseRules(app: FastifyInstance): void {
  app.addHook('onRoute', (route) => {
    const schema = route.schema
    if (isDocsRoute(route.url) || schema === undefined || schema.hide === true) return
    const methods = [route.method].flat()
    schema.response = withSharedResponses(
      schema.response as Record<string, unknown> | undefined,
      {
        methods,
        isPublic: route.config?.public === true,
        validates: [schema.params, schema.querystring, schema.body].some(
          (part) => part !== undefined,
        ),
      },
      `${methods.join(',')} ${route.url}`,
    )
  })
}
```

(Put the two imports at the top of the file with the others.) `auth.ts` imports nothing from `responses.ts`, so there is no cycle. In `src/app.ts`, import `registerResponseRules` from `./shared/responses.js` and call it on the line after `registerAuth(...)`, above the swagger registration, with the comment: `// Before the generator: it reads each route's response schema as this hook leaves it.`

- [ ] **Step 4: Declare each route's own errors.** In every `*.routes.ts`, replace each `NNN: ErrorResponse` entry with one spread of `errorResponses(...)`, imported from `../../shared/responses.js`, with the classes from `../../shared/errors.js`. `ValidationError` is listed nowhere: the shared `400` rule adds `validation_error` to every route that validates. Leave success entries as they are.

| Route                                                | `...errorResponses(...)`                                                                                                                                                                                                |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /resources`                                    | `InvalidPoolMembershipError`                                                                                                                                                                                            |
| `GET /resources`                                     | — (remove `400: ErrorResponse`; no spread)                                                                                                                                                                              |
| `GET /resources/:id`                                 | `NotFoundError`                                                                                                                                                                                                         |
| `PATCH /resources/:id`                               | `InvalidPoolMembershipError, NotFoundError`                                                                                                                                                                             |
| `DELETE /resources/:id`                              | `NotFoundError, ResourceHasBookingsError, PoolHasMembersError, ConcurrentUpdateError`                                                                                                                                   |
| `GET .../schedule`                                   | `NotFoundError`                                                                                                                                                                                                         |
| `PUT .../schedule`                                   | `ScheduleShapeMismatchError, ScheduleOverlapError, NotFoundError`                                                                                                                                                       |
| `GET .../exceptions`                                 | `InvalidRangeError, NotFoundError`                                                                                                                                                                                      |
| `PUT .../exceptions/:date`                           | `ScheduleShapeMismatchError, NotFoundError`                                                                                                                                                                             |
| `DELETE .../exceptions/:date`                        | `NotFoundError`                                                                                                                                                                                                         |
| `GET .../availability`                               | `InvalidRangeError, NotFoundError`                                                                                                                                                                                      |
| `POST /resources/:id/bookings`                       | `InvalidIntervalError, InvalidSlotBoundaryError, OutsideScheduleError, UnsupportedConcurrencyModeError, NotFoundError, ResourceInactiveError, SlotUnavailableError, IdempotencyKeyReusedError, ConcurrentUpdateError`   |
| `GET /bookings/:id`                                  | `NotFoundError`                                                                                                                                                                                                         |
| `POST /bookings/:id/confirm`                         | `NotFoundError, InvalidStateTransitionError, HoldExpiredError, ConcurrentUpdateError`                                                                                                                                   |
| `POST /bookings/:id/cancel`, `/complete`, `/no-show` | `NotFoundError, InvalidStateTransitionError, ConcurrentUpdateError`                                                                                                                                                     |
| `POST /bookings/:id/reschedule`                      | `InvalidIntervalError, InvalidSlotBoundaryError, OutsideScheduleError, UnsupportedConcurrencyModeError, NotFoundError, InvalidStateTransitionError, ResourceInactiveError, SlotUnavailableError, ConcurrentUpdateError` |
| `GET /resources/:id/bookings`                        | `InvalidRangeError, NotFoundError`                                                                                                                                                                                      |
| `GET /bookings`                                      | `InvalidRangeError`                                                                                                                                                                                                     |

The order within a status is the order the classes are listed, which is why the test in Step 1 expects `resource_inactive` before `slot_unavailable` on the booking `409`: list them in the table's order. `UnsupportedConcurrencyModeError` is a guard a caller should never reach (the class comment says so); it is declared because the route can emit it.

For example, `POST /resources/:id/bookings` becomes:

```ts
        response: {
          200: BookingResponse,
          201: BookingResponse,
          ...errorResponses(
            InvalidIntervalError,
            InvalidSlotBoundaryError,
            OutsideScheduleError,
            UnsupportedConcurrencyModeError,
            NotFoundError,
            ResourceInactiveError,
            SlotUnavailableError,
            IdempotencyKeyReusedError,
            ConcurrentUpdateError,
          ),
        },
```

- [ ] **Step 5: Remove `ErrorResponse`.** Delete it from `src/modules/resources/resource.schemas.ts` and from every route import. In `tests/fixtures/bodies.ts`, replace the `ErrorResponse as ErrorSchema` import from `resource.schemas.js` with `import type { ErrorBody as ErrorSchema } from '../../src/shared/responses.js'`; the exported `ErrorResponse` type keeps its name. `npx tsc --noEmit` must pass — if the type provider rejects a handler's return type because the response map now has a numeric index from the spread, report it rather than casting.

- [ ] **Step 6: Regenerate and run.** `./run openapi`, then `npx vitest run tests/integration/openapi.test.ts tests/unit`. Expect PASS. Then `./run test` for the whole suite: error replies are now serialized against a schema, so a body field outside `{ error, message, details }` would be dropped — any test that fails here is reporting exactly that, and is investigated, not adjusted.

- [ ] **Step 7: Delete the backlog entry** `## \`openapi.json\` documents no \`401\`, \`403\` or \`429\` on any route`from`docs/backlog.md`, whole.

- [ ] **Step 8: Commit.** `./run check`, then `git add src/ tests/ openapi.json docs/backlog.md && git commit -m "fix(openapi): declare every status a route shares and its own error codes"`

---

### Task 4: A recorder fails any response its route does not declare

**Files:**

- Create: `tests/integration/contract.ts`, `tests/integration/contract.setup.ts`, `tests/fixtures/datasets/contract-recorder.ts`, `tests/unit/contract-recorder.test.ts`
- Modify: `tests/integration/helpers.ts` (`buildTestApp`), `vitest.config.ts`, and whichever `*.routes.ts` Step 6 finds

**Interfaces:**

- Consumes: `isDocsRoute` from `src/shared/auth.ts`.
- Produces: `recordContract(app: FastifyInstance): void`, `takeContractMismatches(): string[]`.

- [ ] **Step 1: Write the dataset `tests/fixtures/datasets/contract-recorder.ts`.** Each case is one route on a bare Fastify instance, one request, and the mismatches expected:

```ts
export interface RecorderCase {
  name: string
  method: 'GET' | 'HEAD' | 'POST'
  url: string
  /** What the route declares: status → codes, or `null` for a success body. */
  declares: Record<number, string[] | null>
  /** Header names declared on each status. */
  declaredHeaders?: Record<number, string[]>
  reply: { status: number; error?: string; headers?: Record<string, string> }
  request?: { method: 'GET' | 'HEAD' | 'POST'; url: string }
  expected: string[]
}

export const recorderCases: RecorderCase[] = [
  {
    name: 'a declared success',
    method: 'GET',
    url: '/thing',
    declares: { 200: null },
    reply: { status: 200 },
    expected: [],
  },
  {
    name: 'an undeclared status',
    method: 'GET',
    url: '/thing',
    declares: { 200: null },
    reply: { status: 409, error: 'slot_unavailable' },
    expected: ['GET /thing answered 409, which it does not declare'],
  },
  {
    name: 'a code the status does not list',
    method: 'POST',
    url: '/thing',
    declares: { 409: ['slot_unavailable'] },
    reply: { status: 409, error: 'resource_inactive' },
    expected: ['POST /thing answered 409 resource_inactive; declares 409 as [slot_unavailable]'],
  },
  {
    name: 'a declared header missing from the reply',
    method: 'GET',
    url: '/thing',
    declares: { 429: ['rate_limited'] },
    declaredHeaders: { 429: ['retry-after'] },
    reply: { status: 429, error: 'rate_limited' },
    expected: ['GET /thing answered 429 without retry-after, which it declares'],
  },
  {
    name: 'a declared header present',
    method: 'GET',
    url: '/thing',
    declares: { 429: ['rate_limited'] },
    declaredHeaders: { 429: ['retry-after'] },
    reply: { status: 429, error: 'rate_limited', headers: { 'retry-after': '1' } },
    expected: [],
  },
  {
    name: 'a HEAD error, which carries no body to read a code from',
    method: 'GET',
    url: '/thing',
    declares: { 200: null, 409: ['slot_unavailable'] },
    request: { method: 'HEAD', url: '/thing' },
    reply: { status: 409, error: 'slot_unavailable' },
    expected: [],
  },
  {
    name: 'a path no route matches',
    method: 'GET',
    url: '/thing',
    declares: { 200: null },
    request: { method: 'GET', url: '/nothing-here' },
    reply: { status: 200 },
    expected: [],
  },
]
```

- [ ] **Step 2: Write `tests/unit/contract-recorder.test.ts`.**

```ts
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { recordContract, takeContractMismatches } from '../integration/contract.js'
import { recorderCases, type RecorderCase } from '../fixtures/datasets/contract-recorder.js'

function responseMap({ declares, declaredHeaders }: RecorderCase) {
  return Object.fromEntries(
    Object.entries(declares).map(([status, codes]) => [
      status,
      codes === null
        ? { type: 'object', additionalProperties: true }
        : {
            type: 'object',
            properties: { error: { type: 'string', enum: codes }, message: { type: 'string' } },
            ...(declaredHeaders?.[Number(status)]
              ? {
                  headers: Object.fromEntries(
                    declaredHeaders[Number(status)]!.map((h) => [h, { type: 'string' }]),
                  ),
                }
              : {}),
          },
    ]),
  )
}

// This file creates mismatches on purpose, so it takes them itself before the setup file looks.
afterEach(() => void takeContractMismatches())

describe('the contract recorder', () => {
  it.each(recorderCases)('$name', async (testCase) => {
    const app = Fastify()
    recordContract(app)
    app.route({
      method: testCase.method,
      url: testCase.url,
      schema: { response: responseMap(testCase) },
      handler: async (_request, reply) => {
        void reply.headers(testCase.reply.headers ?? {})
        return reply
          .status(testCase.reply.status)
          .send(testCase.reply.error ? { error: testCase.reply.error, message: 'probe' } : {})
      },
    })
    await app.ready()
    try {
      await app.inject(testCase.request ?? { method: testCase.method, url: testCase.url })
      expect(takeContractMismatches()).toEqual(testCase.expected)
    } finally {
      await app.close()
    }
  })
})
```

- [ ] **Step 3: Run it; expect FAIL.** `npx vitest run tests/unit/contract-recorder.test.ts` — `contract.js` cannot be resolved.

- [ ] **Step 4: Write `tests/integration/contract.ts`.**

```ts
import type { FastifyInstance } from 'fastify'
import { isDocsRoute } from '../../src/shared/auth.js'

/**
 * Every reply the integration suite receives, checked against the route's own response schema —
 * the object the OpenAPI document is generated from, so the two cannot disagree. A status the
 * route does not declare, a code its status does not list, or a declared header the reply lacks
 * is recorded here; `contract.setup.ts` fails the test that drew it.
 *
 * Only replies to documented operations are checked: an unmatched path, the docs tree and hidden
 * routes are no operation in the document.
 */

interface DeclaredResponse {
  properties?: { error?: { enum?: readonly string[] } }
  headers?: Record<string, unknown>
}

const mismatches: string[] = []

/** Returns what has been recorded since the last call, and forgets it. */
export function takeContractMismatches(): string[] {
  return mismatches.splice(0)
}

function errorCodeOf(payload: unknown): string | undefined {
  if (typeof payload !== 'string') return undefined
  try {
    const body: unknown = JSON.parse(payload)
    if (typeof body !== 'object' || body === null || !('error' in body)) return undefined
    return typeof body.error === 'string' ? body.error : undefined
  } catch {
    return undefined
  }
}

export function recordContract(app: FastifyInstance): void {
  app.addHook('onSend', async (request, reply, payload) => {
    const url = request.routeOptions.url
    const schema = request.routeOptions.schema as
      { hide?: boolean; response?: Record<string, DeclaredResponse> } | undefined
    if (url === undefined || isDocsRoute(url) || schema === undefined || schema.hide === true) {
      return payload
    }

    const where = `${request.method} ${url}`
    const status = reply.statusCode
    const declared = schema.response?.[String(status)]
    if (declared === undefined) {
      mismatches.push(`${where} answered ${status}, which it does not declare`)
      return payload
    }

    const codes = declared.properties?.error?.enum
    // A HEAD reply carries no body, so there is no code to read.
    if (codes !== undefined && request.method !== 'HEAD') {
      const code = errorCodeOf(payload)
      if (code === undefined || !codes.includes(code)) {
        mismatches.push(
          `${where} answered ${status} ${code ?? '(no code)'}; declares ${status} as [${codes.join(', ')}]`,
        )
      }
    }

    for (const header of Object.keys(declared.headers ?? {})) {
      if (reply.getHeader(header) === undefined) {
        mismatches.push(`${where} answered ${status} without ${header}, which it declares`)
      }
    }
    return payload
  })
}
```

- [ ] **Step 5: Run the unit test; expect PASS.** `npx vitest run tests/unit/contract-recorder.test.ts`.

- [ ] **Step 6: Wire it into the suite.** Create `tests/integration/contract.setup.ts`:

```ts
import { afterAll, afterEach, expect } from 'vitest'
import { takeContractMismatches } from './contract.js'

/**
 * Each test file runs in its own module context, so the list is per file and nothing crosses a
 * worker boundary. `afterEach` names the test that drew the reply; `afterAll` catches requests
 * sent from `afterAll` hooks, and a `beforeAll` request is reported against the first test.
 */
const check = () =>
  expect(
    takeContractMismatches(),
    'replies the route does not declare — see tests/integration/contract.ts',
  ).toEqual([])

afterEach(check)
afterAll(check)
```

In `vitest.config.ts`, add `setupFiles: ['./tests/integration/contract.setup.ts'],` after `globalSetup`. In `tests/integration/helpers.ts`, import `recordContract` from `./contract.js` and in `buildTestApp` call `recordContract(app)` between `buildApp(...)` and `await app.ready()` — the route plugins load on `ready()`, so a root hook added before it reaches all of them.

- [ ] **Step 7: Run the whole suite and read every mismatch.** `./run test`. For each mismatch:
  - the route really throws that code (follow the service it calls) → add the class to that route's `errorResponses(...)`;
  - the reply is a defect (a code that route should not be able to send) → stop and report it; it goes to `docs/backlog.md`, not into this slice.
    Re-run until clean. Record every class added, with the test that drew it, for the final review.

- [ ] **Step 8: Commit, in two commits.** If Step 7 changed any route, first `./run openapi`, then `git add src/modules openapi.json && git commit -m "fix(openapi): declare the error codes the suite shows routes answer"`. Then `./run check`, then `git add tests/integration/contract.ts tests/integration/contract.setup.ts tests/integration/helpers.ts tests/unit/contract-recorder.test.ts tests/fixtures/datasets/contract-recorder.ts vitest.config.ts && git commit -m "test(openapi): fail any reply its route does not declare"`. Before the second `git add`, prove the first commit passes alone: `git stash push --include-untracked -- tests vitest.config.ts`, `./run check`, `git stash pop`.

---

### Task 5: Every shared status is proven on every route, in both directions

**Files:**

- Create: `tests/fixtures/datasets/shared-responses.ts`, `tests/integration/shared-responses.test.ts`
- Modify: `docs/backlog.md`

**Interfaces:**

- Consumes: `SHARED_RULES`, `RouteShape` from `src/shared/responses.ts`; `buildApp`; `app.routeAuthorizations`; `seedTenant`, `buildTestApp`, `getTestDb`, `resetDb`, `closeTestDb` from `./helpers.js`.

- [ ] **Step 1: Write the dataset `tests/fixtures/datasets/shared-responses.ts`.**

```ts
import type { InjectOptions } from 'fastify'

/** A documented operation, as the runner sends to it. */
export interface RouteUnderTest {
  method: string
  /** As the document writes it: `/resources/{id}`. */
  path: string
  /** Path parameters filled with values that pass validation. */
  url: string
  /** Path parameters filled with a value that passes no format. */
  invalidUrl: string
  hasPathParams: boolean
  hasBody: boolean
  hasQuery: boolean
  scope: string | undefined
}

/** Which credential the trigger sends. Authentication runs first, so most need a valid key. */
export type Credential = 'none' | 'holding the scope' | 'lacking the scope'

/** Which app the trigger runs on. */
export type AppUnderTest = 'default' | 'a limit of one' | 'a database that fails every query'

export interface SharedTrigger {
  status: number
  code: string
  app: AppUnderTest
  credential: Credential
  /** Sends the same request first: the limiter counts it, then refuses the next. */
  sendTwice?: true
  request: (route: RouteUnderTest, bodyLimit: number) => InjectOptions
}

const JSON_TYPE = { 'content-type': 'application/json' }

export const sharedTriggers: SharedTrigger[] = [
  {
    status: 400,
    code: 'validation_error',
    app: 'default',
    credential: 'holding the scope',
    // The first part the route validates: params, then body, then query.
    request: (route) =>
      route.hasPathParams
        ? { url: route.invalidUrl }
        : route.hasBody
          ? { url: route.url, headers: JSON_TYPE, payload: JSON.stringify({ __unexpected: true }) }
          : { url: `${route.url}?__unexpected=1` },
  },
  {
    status: 401,
    code: 'unauthorized',
    app: 'default',
    credential: 'none',
    request: (route) => ({ url: route.url }),
  },
  {
    status: 403,
    code: 'forbidden_scope',
    app: 'default',
    credential: 'lacking the scope',
    request: (route) => ({ url: route.url }),
  },
  {
    status: 413,
    code: 'payload_too_large',
    app: 'default',
    credential: 'holding the scope',
    request: (route, bodyLimit) => ({
      url: route.url,
      headers: JSON_TYPE,
      payload: JSON.stringify({ pad: 'x'.repeat(bodyLimit) }),
    }),
  },
  {
    status: 415,
    code: 'unsupported_media_type',
    app: 'default',
    credential: 'holding the scope',
    // Not text/plain: Fastify parses that by default, and the answer would be 400.
    request: (route) => ({
      url: route.url,
      headers: { 'content-type': 'application/xml' },
      payload: '<x/>',
    }),
  },
  {
    status: 429,
    code: 'rate_limited',
    app: 'a limit of one',
    credential: 'holding the scope',
    sendTwice: true,
    request: (route) => ({ url: route.url }),
  },
  {
    status: 500,
    code: 'internal_error',
    app: 'a database that fails every query',
    // Well-formed, so authentication reaches its lookup, which is the query that fails.
    credential: 'holding the scope',
    request: (route) => ({ url: route.url }),
  },
]

export interface TriggerSkip {
  status: number
  method: string
  path: string
  reason: string
}

export const triggerSkips: TriggerSkip[] = [
  {
    status: 500,
    method: 'get',
    path: '/health',
    reason:
      'runs no query, so nothing can make it fail; its 500 stays declared, since anything unexpected holds on every route',
  },
]

/** A value per path-parameter format that passes validation. A new format fails until it has one. */
export const validParameter: Record<string, () => string> = {
  uuid: () => crypto.randomUUID(),
  date: () => '2026-07-20',
}

export const INVALID_PARAMETER = 'not-valid'
```

- [ ] **Step 2: Write `tests/integration/shared-responses.test.ts`.**

```ts
import type { FastifyInstance, InjectOptions } from 'fastify'
import type { Kysely } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.js'
import { loadAppConfig } from '../../src/config.js'
import type { Database } from '../../src/db/schema.js'
import { TenantRepository } from '../../src/modules/tenants/tenant.repository.js'
import { TenantService } from '../../src/modules/tenants/tenant.service.js'
import { SHARED_RULES } from '../../src/shared/responses.js'
import { SCOPES, type Scope } from '../../src/shared/scopes.js'
import {
  INVALID_PARAMETER,
  sharedTriggers,
  triggerSkips,
  validParameter,
  type AppUnderTest,
  type RouteUnderTest,
  type SharedTrigger,
} from '../fixtures/datasets/shared-responses.js'
import { buildTestApp, closeTestDb, getTestDb, resetDb, seedTenant } from './helpers.js'

interface Operation {
  parameters?: Array<{ in: string; name: string; schema?: { format?: string } }>
  requestBody?: unknown
  responses: Record<
    string,
    {
      headers?: Record<string, unknown>
      content?: {
        'application/json'?: { schema?: { properties?: { error?: { enum?: string[] } } } }
      }
    }
  >
}

/**
 * The routes and their scopes come from the live app, not from a list here: what the engine
 * serves is what is tested. No handler runs while routes register, so no database is needed.
 */
async function inventory(): Promise<{
  routes: RouteUnderTest[]
  bodyLimit: number
  paths: Record<string, Record<string, Operation>>
}> {
  const app = await buildApp({
    config: { ...loadAppConfig({}), logLevel: 'silent' },
    db: {} as Kysely<Database>,
  })
  try {
    await app.ready()
    const document = app.swagger() as { paths: Record<string, Record<string, Operation>> }
    const routes = app.routeAuthorizations
      .filter((route) => route.method !== 'HEAD')
      .map((route) => ({
        ...route,
        path: route.url.replace(/:(\w+)/g, '{$1}'),
        method: route.method.toLowerCase(),
      }))
      .filter((route) => document.paths[route.path]?.[route.method] !== undefined)
      .map((route): RouteUnderTest => {
        const operation = document.paths[route.path]![route.method]!
        const pathParameters = (operation.parameters ?? []).filter(
          (parameter) => parameter.in === 'path',
        )
        const fill = (value: (format: string) => string) =>
          pathParameters.reduce(
            (url, parameter) =>
              url.replace(`{${parameter.name}}`, value(parameter.schema?.format ?? '')),
            route.path,
          )
        return {
          method: route.method,
          path: route.path,
          url: fill((format) => {
            const make = validParameter[format]
            if (!make)
              throw new Error(`No valid value for path format "${format}" in shared-responses.ts`)
            return make()
          }),
          invalidUrl: fill(() => INVALID_PARAMETER),
          hasPathParams: pathParameters.length > 0,
          hasBody: operation.requestBody !== undefined,
          hasQuery: (operation.parameters ?? []).some(
            (parameter) => parameter.in === 'querystring' || parameter.in === 'query',
          ),
          scope: route.scope,
        }
      })
    return { routes, bodyLimit: app.initialConfig.bodyLimit ?? 1_048_576, paths: document.paths }
  } finally {
    await app.close()
  }
}

const { routes, bodyLimit, paths } = await inventory()

const cases = routes.flatMap((route) =>
  sharedTriggers.map((trigger) => ({
    route,
    trigger,
    skip: triggerSkips.find(
      (skip) =>
        skip.status === trigger.status && skip.method === route.method && skip.path === route.path,
    ),
    applies: SHARED_RULES.find((rule) => rule.status === trigger.status)!.appliesTo({
      methods: [route.method.toUpperCase()],
      isPublic: route.scope === undefined,
      validates: route.hasPathParams || route.hasBody || route.hasQuery,
    }),
    name: `${route.method.toUpperCase()} ${route.path} — ${trigger.status} ${trigger.code}`,
  })),
)

let apps: Record<Exclude<AppUnderTest, 'a limit of one'>, FastifyInstance>
let holding: string
const lacking = new Map<Scope, string>()

beforeAll(async () => {
  await resetDb()
  const { tenantId, authHeader } = await seedTenant()
  holding = authHeader.authorization!
  const service = new TenantService(new TenantRepository(getTestDb()))
  for (const scope of SCOPES) {
    const { secret } = await service.issueKey(
      tenantId,
      `lacking ${scope}`,
      SCOPES.filter((other) => other !== scope),
    )
    lacking.set(scope, `Bearer ${secret}`)
  }
  apps = {
    default: await buildTestApp(),
    'a database that fails every query': await buildTestApp({}, {} as Kysely<Database>),
  }
})

afterAll(async () => {
  await apps.default.close()
  await apps['a database that fails every query'].close()
  await closeTestDb()
})

function credentialFor(trigger: SharedTrigger, route: RouteUnderTest): Record<string, string> {
  if (trigger.credential === 'none') return {}
  if (trigger.credential === 'holding the scope') return { authorization: holding }
  // A public route has no scope to lack; any key will do, and the route ignores it.
  return { authorization: route.scope === undefined ? holding : lacking.get(route.scope as Scope)! }
}

async function send(trigger: SharedTrigger, route: RouteUnderTest) {
  const request = trigger.request(route, bodyLimit)
  const options: InjectOptions = {
    ...request,
    method: route.method.toUpperCase() as InjectOptions['method'],
    headers: { ...request.headers, ...credentialFor(trigger, route) },
  }
  if (trigger.app !== 'a limit of one') return apps[trigger.app].inject(options)

  // The limiter counts in memory, so each route gets an app of its own.
  const limited = await buildTestApp({ rateLimitPerMinute: 1 })
  try {
    if (trigger.sendTwice) await limited.inject(options)
    return await limited.inject(options)
  } finally {
    await limited.close()
  }
}

describe('statuses every route shares', () => {
  it.each(cases.filter((c) => c.applies && !c.skip))(
    '$name: answered and declared',
    async ({ route, trigger }) => {
      const response = await send(trigger, route)
      expect(response.statusCode).toBe(trigger.status)
      expect(response.json<{ error: string }>().error).toBe(trigger.code)

      const declared = paths[route.path]![route.method]!.responses[String(trigger.status)]
      expect(declared?.content?.['application/json']?.schema?.properties?.error?.enum).toContain(
        trigger.code,
      )
      for (const header of Object.keys(declared?.headers ?? {})) {
        expect(response.headers[header], header).toBeDefined()
      }
    },
  )

  it.each(cases.filter((c) => !c.applies))(
    '$name: neither answered nor declared',
    async ({ route, trigger }) => {
      const declared = paths[route.path]![route.method]!.responses[String(trigger.status)]
      expect(
        declared?.content?.['application/json']?.schema?.properties?.error?.enum ?? [],
      ).not.toContain(trigger.code)
      const response = await send(trigger, route)
      expect(response.statusCode).not.toBe(trigger.status)
    },
  )

  it.each(cases.filter((c) => c.skip))(
    '$name: declared, not triggered — $skip.reason',
    ({ route, trigger }) => {
      const declared = paths[route.path]![route.method]!.responses[String(trigger.status)]
      expect(declared).toBeDefined()
    },
  )
})
```

`tests/integration/helpers.ts`'s `buildTestApp` already takes `(overrides, db)`. If `authHeader.authorization` is typed `string | undefined`, the `!` above is the existing `Record<string, string>` index; leave it. `app.initialConfig.bodyLimit` is Fastify's public read of the effective limit; the fallback is Fastify's documented default and is used only if the property is absent.

- [ ] **Step 3: Run it; expect PASS — then prove it can fail.** `npx vitest run tests/integration/shared-responses.test.ts`. It passes on this branch because Task 3 already declared the statuses; that the test is not vacuous has to be shown. Temporarily change the `413` rule in `responses.ts` to `appliesTo: () => false`, run again, and confirm every `POST`/`PUT`/`PATCH`/`DELETE` `413` case fails under "neither answered nor declared" with a `413` answer. Restore the rule. Note both runs for the final review.

- [ ] **Step 4: If a `400` case fails** because a route's first validated part accepts the generic invalid value, add a named override to the dataset (a `Record<string, (route) => InjectOptions>` keyed by `METHOD path`, consulted by the `400` trigger) with a comment saying why. Do not change the rule.

- [ ] **Step 5: Delete the backlog entry** `## The \`x-ratelimit-*\` headers on a \`429\` are not asserted`from`docs/backlog.md`, whole: the `429`cases assert every declared header on every route, and the recorder asserts them on every`429` the suite draws.

- [ ] **Step 6: Commit.** `./run check`, then `git add tests/integration/shared-responses.test.ts tests/fixtures/datasets/shared-responses.ts docs/backlog.md && git commit -m "test(openapi): prove the shared statuses on every route"`

---

### Task 6: Documents, backlog, archive

**Files:**

- Modify: `docs/conventions.md`, `docs/architecture.md`, `docs/backlog.md`, `docs/superpowers/specs/2026-10-06-openapi-shared-statuses-design.md` (status line only)
- Move: this plan to `docs/superpowers/plans/archive/`

- [ ] **Step 1: `docs/conventions.md`, "Documentation is generated, never written twice".** After the paragraph ending "…fails if a route is added without them or documented without existing.", add:

```markdown
Error responses are not written route by route. Every code carries its meaning and an example
on its class in `src/shared/errors.ts`, and `src/shared/responses.ts` builds each error
response from them: `error` narrowed with `enum` to exactly that status's codes, a description
naming each, one example per code, and the headers it carries. A route lists the classes it
throws with `errorResponses(...)`; the statuses many routes share come from one rule table,
merged into every route's real schema by an `onRoute` hook before the generator reads it:

| Status | Code                     | On                                                                                            |
| ------ | ------------------------ | --------------------------------------------------------------------------------------------- |
| `400`  | `validation_error`       | a route with a params, querystring or body schema, and any `POST`, `PUT`, `PATCH` or `DELETE` |
| `401`  | `unauthorized`           | every route that is not `public`                                                              |
| `403`  | `forbidden_scope`        | every route that is not `public`                                                              |
| `413`  | `payload_too_large`      | `POST`, `PUT`, `PATCH`, `DELETE` — the methods Fastify parses a body for                      |
| `415`  | `unsupported_media_type` | the same                                                                                      |
| `429`  | `rate_limited`           | every route, `/health` included                                                               |
| `500`  | `internal_error`         | every route                                                                                   |

`enum`, never a union of literals: the serializer ignores `enum`, but it validates an `anyOf`
and would turn a correct answer carrying an unlisted code into a `500`.

Two tests keep the statuses true. Every integration test's replies pass a recorder,
`tests/integration/contract.ts`, that fails the test when its route does not declare the
status, the code or a header the reply carries. And `shared-responses.test.ts` triggers each
row of the table on every route, asserting the route answers it where the rule applies and
neither answers nor declares it where it does not. A code a route declares but no test draws
is the one gap — see `docs/backlog.md`.
```

Then, in "The tables that cannot be generated are asserted instead", change "diffs them against `loadAppConfig`, the `AppError` subclasses together with `CLIENT_ERROR_CODES`," to "diffs them against `loadAppConfig`, the `AppError` subclasses together with `CLIENT_ERRORS` — codes, statuses and the Meaning column —,". Run `npx prettier --write docs/conventions.md`.

- [ ] **Step 2: `docs/architecture.md`, line 310.** After "…generated from the same TypeBox schemas the routes validate against.", add: "Error statuses are built from the error classes, the ones every route shares come from one rule table, and two tests hold every status to what the routes actually answer — see the conventions, _Documentation is generated_."

- [ ] **Step 3: `docs/backlog.md`.** Add at the top, newest first:

```markdown
## A declared error code that no test draws is not detected

- Where: `tests/integration/contract.ts`; every `errorResponses(...)` in `src/modules/*/*.routes.ts`
- Found: 2026-10-06, while making `openapi.json` declare every status
- Problem: the recorder fails a reply its route does not declare, and the shared-status
  dataset proves the shared rules in both directions. Nothing proves the other direction for a
  route's own codes: a class left in `errorResponses(...)` after the route stopped throwing it
  stays in the document. Remove `HoldExpiredError` from the code path of `confirm` and keep the
  declaration: every check passes.
- Impact: the document may promise a code that can no longer occur — a consumer handles a case
  that never comes. Each file sees only its own replies; collecting them across Vitest's workers
  in a global teardown would close it.

## `POST /resources` says the `pool` mode is rejected; it is not

- Where: `src/modules/resources/resource.routes.ts`, the `POST /resources` description
- Found: 2026-10-06, while declaring each route's error codes
- Problem: the description ends "`concurrency_mode: "pool"` is not implemented yet and is
  rejected." Spec 3 implemented it; `pool` is accepted. Read `/docs`, then create a pool.
- Impact: a consumer reading the reference believes pools do not exist.

## `method_not_allowed` is documented, but a wrong method answers `404`

- Where: `src/shared/errors.ts`, `CLIENT_ERRORS[405]`; the error table in `docs/conventions.md`
- Found: 2026-10-06, while deciding which statuses every route shares
- Problem: the table says `405 method_not_allowed` means "the framework matched the path but
  not the method". Fastify answers a known path with an unserved method as an unmatched route:
  `tests/integration/error-handler.test.ts` sends `DELETE /health` and gets `404 not_found`.
- Impact: a consumer branching on `method_not_allowed` waits for a code that never comes. The
  row and the translation are dead unless the not-found handler distinguishes the two.
```

Drop any of the three if Tasks 1–5 already removed its cause; add any defect Task 4 Step 7 stopped on.

- [ ] **Step 4: Spec status, archive.** In the spec, change `**Status:** approved, not implemented` to `**Status:** implemented`. `git mv docs/superpowers/plans/2026-10-06-openapi-shared-statuses.md docs/superpowers/plans/archive/`.

- [ ] **Step 5: Commit.** `npx prettier --check .`, `./run check`, then `git add docs && git commit -m "docs: record how response statuses are declared and checked, and archive the plan"`

---

## Deviations from the spec, decided here

- The `400` rule also covers every method Fastify parses a body for (Review Focus, fourth line). No route changes today — every body route also validates — but the rule is now right for one that does not.
- `ValidationError` is listed on no route: the shared `400` adds `validation_error` wherever the route validates, so listing it would only repeat it.
- The `415` trigger sends `application/xml`, not `text/plain`, which the spec did not state and Fastify parses.
- Merging reads a declared response's codes back from its `enum` and rebuilds from the catalogue, rather than carrying markers in the schema; a shared status declared any other way fails at startup.
- The description of a code uses its `meaning` verbatim, capitalised as in the table, so the spec's sample ("— the slots exist…") reads "— The slots exist…".
