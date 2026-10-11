# Rate-limit headers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `openapi.json` declares `x-ratelimit-limit`, `-remaining` and `-reset` on every status whose replies the limiter has counted, marks every always-present header `required: true`, and the recorder checks headers in both directions.

**Architecture:** `src/shared/responses.ts` decides each status's headers from what each code carries: its own headers, plus the limiter's three unless the code is answered before the limiter (`LIMITER_REACH`). A header is `required` only when every code under the status always carries it. `withSharedResponses` gives every `2xx` the three as well. A pure `liftRequiredHeaders`, passed to `@fastify/swagger` as `transformObject`, moves `required` from the header's schema onto the header object. The recorder demands only `required` headers, and fails a reply carrying a header from `HEADER_DOCS` that its status does not declare.

**Tech Stack:** TypeScript (NodeNext, `.js` import extensions), Fastify 5.10, `typebox`, `@fastify/swagger` 9.8.1, `@fastify/rate-limit` 11.2, Vitest with Testcontainers (Docker must be running).

**Spec:** `docs/superpowers/specs/2026-10-10-rate-limit-headers-design.md`

## Global Constraints

- `git branch --show-current` is `fix/rate-limit-headers` before every commit; the user switches branches between turns.
- Commits: Conventional Commits, subject only — no body, no footers, no `Co-Authored-By`. `./run check` passes before each.
- `src/shared/responses.ts` imports nothing from `src/db/`.
- Test data lives in datasets under `tests/fixtures/datasets/`, consumed by `it.each`. Header names in datasets are written out, never imported from `src/` — a test reading the list from the code it checks proves nothing.
- No `any`. TypeBox is imported from `typebox`.
- `openapi.json` is written only by `./run openapi`, never by hand.
- A header declared without `required` omits the key entirely; `required: false` is never written.
- The backlog entry _The rate-limit headers on a success are sent but not documented_ is deleted in the commit that fixes it (Task 2).
- Code blocks below are not guaranteed Prettier-clean. Before each `./run check`, run `npx prettier --write` on the files the task touched.
- The limiter's header names are written out once, in `tests/fixtures/datasets/rate-limit.ts` (`LIMITER_HEADER_NAMES`, `COUNTED`, `SOMETIMES_COUNTED`), and every other dataset and test imports them from there.

## Review Focus

- **`HEAD` twins.** Fastify registers a `HEAD` for every `GET` with the same hooks and schema. The `HEAD` reply must carry the limiter's headers like its `GET`, and merging the schema twice must change nothing. No integration test sends a `HEAD` today. Pinned in Task 2 by a `HEAD /resources` row in the counted-reply dataset, and by the existing merge-twice test over the new rows.
- **A success schema shared across routes.** `BookingResponse` is the `200` of seven routes and a `201`; adding `headers` to it in place would leak into every route and every later merge. Pinned in Task 2 by "adds the headers to a copy".
- **`413` and `415` are answered after the limiter.** The spec reads this from Fastify's lifecycle: body limits and content-type parsing run after `onRequest`. If wrong, the shared-responses `413`/`415` triggers fail in Task 2 Step 7 on the missing `x-ratelimit-*`. The fix is then a `LIMITER_REACH` row, plus a deviation noted in the review.
- **A `500` with and without the headers.** The suite's `500`s come from a failing key lookup and carry none; a handler's `500` would carry them. Both must pass the recorder: the forward check demands only `required` headers, and the reverse check accepts declared optional ones. Pinned in Task 2 (the recorder row "an optional header absent") and Task 3 ("an optional header present").
- **`/docs/yaml` and the committed file go through the same transform.** `transformObject` runs inside `app.swagger()`, which feeds `/docs/json`, `/docs/yaml` and `./run openapi`. Pinned in Task 2 by the integration test that no header in the served document keeps `required` inside its schema, and by the byte-for-byte test of `openapi.json`.

---

## File structure

| File                                            | Responsibility                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------- |
| `src/shared/responses.ts` (modify)              | `liftRequiredHeaders`; `LIMITER_REACH`; per-status headers with `required`; 2xx merge |
| `src/app.ts` (modify)                           | `transformObject: liftRequiredHeaders`; one paragraph in `info.description`           |
| `tests/integration/contract.ts` (modify)        | Forward check narrowed to `required`; reverse check over `HEADER_DOCS`                |
| `tests/unit/responses.test.ts` (modify)         | Shapes with `required`; successes in merge cases; non-mutation; lift                  |
| `tests/unit/contract-recorder.test.ts`          | Header declarations carry `required`; successes may declare headers                   |
| `tests/integration/openapi.test.ts` (modify)    | Per-status header table; every 2xx; no `required` inside a schema; prose rule         |
| `tests/integration/shared-responses.test.ts`    | Demands only `required` headers                                                       |
| `tests/integration/rate-limit.test.ts`          | Which real replies carry the limiter's headers                                        |
| `tests/fixtures/datasets/response-rules.ts`     | Header expectations as name → required; new grouping and merge rows                   |
| `tests/fixtures/datasets/required-headers.ts`   | Create: lift rows                                                                     |
| `tests/fixtures/datasets/documented-headers.ts` | Create: status → headers rows for the generated document                              |
| `tests/fixtures/datasets/contract-recorder.ts`  | Header declarations with `required`; reverse-check rows                               |
| `tests/fixtures/datasets/rate-limit.ts`         | Counted-reply rows; the limiter's header names, once                                  |
| `openapi.json`                                  | Regenerated                                                                           |
| `docs/conventions.md`, `docs/architecture.md`   | Task 4                                                                                |

---

### Task 1: `required` lands on the header object, where OpenAPI reads it

`@fastify/swagger` 9.8.1 builds each response header as `{ schema: { ...declared }, description }`, so a `required: true` declared beside the type would land inside the JSON Schema. Nothing declares `required` yet, so `openapi.json` does not change in this task.

**Files:**

- Create: `tests/fixtures/datasets/required-headers.ts`
- Modify: `src/shared/responses.ts`, `src/app.ts:110`, `tests/unit/responses.test.ts`

**Interfaces:**

- Produces: `liftRequiredHeaders<T extends object>(document: T): T` exported from `src/shared/responses.ts` — returns a copy; the argument is not changed.

- [ ] **Step 1: Write the dataset**

`tests/fixtures/datasets/required-headers.ts`:

```ts
/** One response's `headers` as `@fastify/swagger` writes them, and as the lift must leave them. */
export interface LiftCase {
  name: string
  headers: Record<string, unknown> | undefined
  expected: Record<string, unknown> | undefined
}

export const liftCases: LiftCase[] = [
  {
    name: 'moves required from the schema onto the header',
    headers: {
      'x-ratelimit-limit': { schema: { type: 'integer', required: true }, description: 'Limit' },
    },
    expected: {
      'x-ratelimit-limit': { schema: { type: 'integer' }, description: 'Limit', required: true },
    },
  },
  {
    name: 'leaves a header with no required as it is',
    headers: { 'x-ratelimit-limit': { schema: { type: 'integer' }, description: 'Limit' } },
    expected: { 'x-ratelimit-limit': { schema: { type: 'integer' }, description: 'Limit' } },
  },
  {
    name: 'lifts each header of a response on its own',
    headers: {
      'retry-after': { schema: { type: 'integer', required: true }, description: 'Wait' },
      'x-ratelimit-limit': { schema: { type: 'integer' }, description: 'Limit' },
    },
    expected: {
      'retry-after': { schema: { type: 'integer' }, description: 'Wait', required: true },
      'x-ratelimit-limit': { schema: { type: 'integer' }, description: 'Limit' },
    },
  },
  {
    name: 'leaves a response with no headers as it is',
    headers: undefined,
    expected: undefined,
  },
]
```

- [ ] **Step 2: Write the failing test**

In `tests/unit/responses.test.ts`, add `liftRequiredHeaders` to the import from `../../src/shared/responses.js`, add `import { liftCases } from '../fixtures/datasets/required-headers.js'`, and append:

```ts
describe('liftRequiredHeaders', () => {
  const documentWith = (headers: Record<string, unknown> | undefined) => ({
    openapi: '3.1.0',
    paths: {
      '/x': {
        get: { responses: { '200': { description: 'ok', ...(headers ? { headers } : {}) } } },
      },
    },
  })

  it.each(liftCases)('$name', ({ headers, expected }) => {
    const lifted = liftRequiredHeaders(documentWith(headers))
    expect(lifted).toEqual(documentWith(expected))
  })

  it('leaves the document it was given unchanged', () => {
    const given = documentWith(liftCases[0]!.headers)
    const before = structuredClone(given)
    liftRequiredHeaders(given)
    expect(given).toEqual(before)
  })
})
```

- [ ] **Step 3: Run it and see it fail**

Run: `npx vitest run tests/unit/responses.test.ts`
Expected: FAIL — `liftRequiredHeaders` is not exported (`is not a function`).

- [ ] **Step 4: Implement the lift**

In `src/shared/responses.ts`, after `registerResponseRules`, append:

```ts
interface DocumentHeaders {
  paths?: Record<
    string,
    Record<
      string,
      {
        responses?: Record<
          string,
          { headers?: Record<string, { schema?: { required?: unknown }; required?: boolean }> }
        >
      }
    >
  >
}

/**
 * `@fastify/swagger` 9.8.1 copies everything a header declares except its description into the
 * header's `schema`, so `required: true` would land inside the JSON Schema, where `required` must
 * be an array of property names. This moves it onto the header object, where the OpenAPI Header
 * Object defines it. Passed to the generator as `transformObject`, so the served document and
 * the committed one both go through it. Returns a copy.
 */
export function liftRequiredHeaders<T extends object>(document: T): T {
  const copy = structuredClone(document)
  for (const operations of Object.values((copy as DocumentHeaders).paths ?? {})) {
    for (const operation of Object.values(operations)) {
      for (const response of Object.values(operation.responses ?? {})) {
        for (const header of Object.values(response.headers ?? {})) {
          if (header.schema?.required !== true) continue
          delete header.schema.required
          header.required = true
        }
      }
    }
  }
  return copy
}
```

- [ ] **Step 5: Run it and see it pass**

Run: `npx vitest run tests/unit/responses.test.ts`
Expected: PASS.

- [ ] **Step 6: Wire it into the generator**

In `src/app.ts`, add `liftRequiredHeaders` to the import from `./shared/responses.js`, and replace line 110:

```ts
void app.register(fastifySwagger, { openapi: openapiDocument(deps.config) })
```

with:

```ts
void app.register(fastifySwagger, {
  openapi: openapiDocument(deps.config),
  transformObject: (generated) =>
    'openapiObject' in generated
      ? liftRequiredHeaders(generated.openapiObject)
      : generated.swaggerObject,
})
```

- [ ] **Step 7: Check the document is unchanged, then the whole tree**

Run: `./run openapi && git diff --exit-code openapi.json`
Expected: exit 0 — nothing declares `required` yet.

Run: `./run check`
Expected: types clean, formatting clean, every test passes.

- [ ] **Step 8: Commit**

```bash
git branch --show-current   # fix/rate-limit-headers
git add src/shared/responses.ts src/app.ts tests/unit/responses.test.ts tests/fixtures/datasets/required-headers.ts
git commit -m "fix(openapi): put a response header's required flag where openapi reads it"
```

---

### Task 2: Every counted reply declares the limiter's headers

**Files:**

- Create: `tests/fixtures/datasets/documented-headers.ts`
- Modify: `src/shared/responses.ts`, `src/app.ts:41-54`, `tests/integration/contract.ts`, `tests/fixtures/datasets/response-rules.ts`, `tests/fixtures/datasets/contract-recorder.ts`, `tests/fixtures/datasets/rate-limit.ts`, `tests/unit/responses.test.ts`, `tests/unit/contract-recorder.test.ts`, `tests/integration/openapi.test.ts`, `tests/integration/shared-responses.test.ts`, `tests/integration/rate-limit.test.ts`, `openapi.json`, `docs/backlog.md`

**Interfaces:**

- Consumes: `liftRequiredHeaders` (Task 1), already wired.
- Produces: `HEADER_DOCS` exported from `src/shared/responses.ts` (`Record<string, { type: 'integer' | 'string'; description: string }>`), read by Task 3. A route's declared header is `{ type, description, required?: true }` in its schema, and `{ schema, description, required?: true }` in the document.

- [ ] **Step 1: Pin which real replies carry the headers**

This characterises the plugin, so it passes on `main` already; it is what the document is about to describe.

Append to `tests/fixtures/datasets/rate-limit.ts`:

```ts
/** The three headers `@fastify/rate-limit` writes on a request it counts. */
export const LIMITER_HEADER_NAMES = [
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
]

/** The three as a status declares them when every code under it is counted: all required. */
export const COUNTED: Record<string, boolean> = Object.fromEntries(
  LIMITER_HEADER_NAMES.map((name) => [name, true]),
)

/** The three on a status whose replies carry them only sometimes: declared, none required. */
export const SOMETIMES_COUNTED: Record<string, boolean> = Object.fromEntries(
  LIMITER_HEADER_NAMES.map((name) => [name, false]),
)

export interface CountedReplyCase {
  name: string
  caller: Caller
  method: 'GET' | 'HEAD'
  url: string
  status: number
  /** Whether the reply carries all three limiter headers; when false, it carries none. */
  counted: boolean
}

export const countedReplyCases: CountedReplyCase[] = [
  {
    name: 'a success',
    caller: 'first',
    method: 'GET',
    url: '/resources',
    status: 200,
    counted: true,
  },
  {
    name: "a success's HEAD twin",
    caller: 'first',
    method: 'HEAD',
    url: '/resources',
    status: 200,
    counted: true,
  },
  {
    name: 'a public route called without a key',
    caller: 'anonymous',
    method: 'GET',
    url: '/health',
    status: 200,
    counted: true,
  },
  {
    name: "a route's own error",
    caller: 'first',
    method: 'GET',
    url: `/resources/${crypto.randomUUID()}`,
    status: 404,
    counted: true,
  },
  // Answered by authentication, which Fastify runs before the limiter's route-level hook.
  {
    name: 'a malformed key',
    caller: 'malformed',
    method: 'GET',
    url: '/resources',
    status: 401,
    counted: false,
  },
  {
    name: 'no key on a scoped route',
    caller: 'anonymous',
    method: 'GET',
    url: '/resources',
    status: 401,
    counted: false,
  },
]
```

In `tests/integration/rate-limit.test.ts`, extend the dataset import to `{ countedReplyCases, LIMITER_HEADER_NAMES, rateLimitScenarios, type Caller }` and append:

```ts
describe('the headers of a counted reply', () => {
  it.each(countedReplyCases)('$name', async ({ caller, method, url, status, counted }) => {
    const callers = await seedCallers()
    const app = await buildTestApp()
    try {
      const response = await app.inject({ method, url, headers: callers[caller] })
      expect(response.statusCode).toBe(status)
      for (const header of LIMITER_HEADER_NAMES) {
        expect(response.headers[header] !== undefined, header).toBe(counted)
      }
    } finally {
      await app.close()
    }
  })
})
```

Run: `npx vitest run tests/integration/rate-limit.test.ts`
Expected: PASS — every row, `HEAD` included. If the `HEAD` row fails, stop: the design assumes the twin carries the limiter's hook.

- [ ] **Step 2: Rewrite the unit dataset**

Add `import { COUNTED, SOMETIMES_COUNTED } from './rate-limit.js'` to `tests/fixtures/datasets/response-rules.ts`, and replace `GroupingCase`, `groupingCases`, `MergeCase` and `mergeCases` (keep `RuleCase` and `ruleCases` as they are):

```ts
/** status → header name → whether it is declared `required`. A status with none is absent. */
export type DeclaredHeaders = Record<number, Record<string, boolean>>

export interface GroupingCase {
  name: string
  /** Export names from `src/shared/errors.ts`, resolved by the test. */
  classes: string[]
  /** status → codes in the `enum`, in order. */
  expected: Record<number, string[]>
  headers: DeclaredHeaders
}

export const groupingCases: GroupingCase[] = [
  {
    name: 'one class, one status',
    classes: ['NotFoundError'],
    expected: { 404: ['not_found'] },
    headers: { 404: COUNTED },
  },
  {
    name: 'two classes sharing a status become one response',
    classes: ['NotFoundError', 'SlotUnavailableError', 'IdempotencyKeyReusedError'],
    expected: { 404: ['not_found'], 409: ['slot_unavailable', 'idempotency_key_reused'] },
    headers: { 404: COUNTED, 409: COUNTED },
  },
  {
    name: "a class's own headers are declared beside the limiter's",
    classes: ['ConcurrentUpdateError'],
    expected: { 503: ['concurrent_update'] },
    headers: { 503: { 'retry-after': true, ...COUNTED } },
  },
  {
    name: "the limiter's refusal carries retry-after and the three",
    classes: ['RateLimitedError'],
    expected: { 429: ['rate_limited'] },
    headers: { 429: { 'retry-after': true, ...COUNTED } },
  },
  {
    name: 'a code answered before the limiter carries only its own headers',
    classes: ['UnauthorizedError'],
    expected: { 401: ['unauthorized'] },
    headers: { 401: { 'www-authenticate': true } },
  },
  {
    name: 'a code answered before the limiter, with none of its own, declares none',
    classes: ['ForbiddenScopeError'],
    expected: { 403: ['forbidden_scope'] },
    headers: {},
  },
  {
    name: 'a status mixing a counted code with an uncounted one declares the three, not required',
    classes: ['ForbiddenScopeError', 'ForbiddenOriginError'],
    expected: { 403: ['forbidden_scope', 'forbidden_origin'] },
    headers: { 403: SOMETIMES_COUNTED },
  },
]

export interface MergeCase {
  name: string
  route: RouteShape
  /** Success statuses the route declares, and whether each has a body. */
  successes: Record<number, 'body' | 'none'>
  /** Export names declared by the route itself. */
  declared: string[]
  /** status → codes in the `enum`, or `null` for a success. */
  expected: Record<number, string[] | null>
  headers: DeclaredHeaders
}

export const mergeCases: MergeCase[] = [
  {
    name: "a route's own 400 codes come first, the shared one last",
    route: { methods: ['GET'], isPublic: false, validates: true },
    successes: { 200: 'body' },
    declared: ['InvalidRangeError', 'NotFoundError'],
    expected: {
      200: null,
      400: ['invalid_range', 'validation_error'],
      401: ['unauthorized'],
      403: ['forbidden_scope'],
      404: ['not_found'],
      429: ['rate_limited'],
      500: ['internal_error'],
    },
    headers: {
      200: COUNTED,
      400: COUNTED,
      401: { 'www-authenticate': true },
      404: COUNTED,
      429: { 'retry-after': true, ...COUNTED },
      500: SOMETIMES_COUNTED,
    },
  },
  {
    name: 'a public route gets no 401 or 403',
    route: { methods: ['GET'], isPublic: true, validates: false },
    successes: { 200: 'body' },
    declared: [],
    expected: { 200: null, 429: ['rate_limited'], 500: ['internal_error'] },
    headers: {
      200: COUNTED,
      429: { 'retry-after': true, ...COUNTED },
      500: SOMETIMES_COUNTED,
    },
  },
  {
    name: 'a 204 with no body declares the three like any success',
    route: { methods: ['DELETE'], isPublic: false, validates: true },
    successes: { 204: 'none' },
    declared: ['NotFoundError'],
    expected: {
      204: null,
      400: ['validation_error'],
      401: ['unauthorized'],
      403: ['forbidden_scope'],
      404: ['not_found'],
      413: ['payload_too_large'],
      415: ['unsupported_media_type'],
      429: ['rate_limited'],
      500: ['internal_error'],
    },
    headers: {
      204: COUNTED,
      400: COUNTED,
      401: { 'www-authenticate': true },
      404: COUNTED,
      413: COUNTED,
      415: COUNTED,
      429: { 'retry-after': true, ...COUNTED },
      500: SOMETIMES_COUNTED,
    },
  },
]
```

- [ ] **Step 3: Update the unit test to read `required` and successes**

In `tests/unit/responses.test.ts`, extend the dataset import to `{ groupingCases, mergeCases, ruleCases, type MergeCase }`, and replace `Built`, `built` and `shapeOf` with:

```ts
interface Built {
  description?: string
  headers?: Record<string, { required?: boolean }>
  'x-examples'?: Record<string, { value: { error: string } }>
  properties?: { error?: { enum?: string[] } }
}

const built = (schema: unknown) => schema as Built

const codesOf = (schema: unknown) => built(schema).properties?.error?.enum ?? []

function shapeOf(response: Record<string, unknown>) {
  const codes: Record<number, string[] | null> = {}
  const headers: Record<number, Record<string, boolean>> = {}
  for (const [status, schema] of Object.entries(response)) {
    codes[Number(status)] = built(schema).properties?.error?.enum ?? null
    const declared = Object.entries(built(schema).headers ?? {})
    if (declared.length > 0) {
      headers[Number(status)] = Object.fromEntries(
        declared.map(([name, header]) => [name, header.required === true]),
      )
    }
  }
  return { codes, headers }
}

/** What a route declares before the merge: its successes, then its own error classes. */
function declaredBy({ successes, declared }: MergeCase): Record<string, unknown> {
  return {
    ...Object.fromEntries(
      Object.entries(successes).map(([status, body]) => [
        status,
        body === 'none' ? Type.Null() : Type.Object({ status: Type.String() }),
      ]),
    ),
    ...errorResponses(...declared.map(classNamed)),
  }
}
```

In the two `errorResponses` tests that read `properties.error.enum` ("keys one example per code…" and "describes every code…"), replace `properties.error.enum` / `built(schema).properties.error.enum` with `codesOf(schema)`; in the first, drop `properties` from the destructuring:

```ts
const { 'x-examples': examples } = built(schema)
expect(Object.keys(examples ?? {})).toEqual(codesOf(schema))
```

```ts
      for (const code of codesOf(schema)) {
```

Replace the `withSharedResponses` describe's first three tests (the two `it.each(mergeCases)` and "leaves success responses as they are") with:

```ts
it.each(mergeCases)('$name', (testCase) => {
  const merged = withSharedResponses(declaredBy(testCase), testCase.route, 'probe')
  expect(shapeOf(merged)).toEqual({ codes: testCase.expected, headers: testCase.headers })
})

it.each(mergeCases)('gives the same answer applied twice: $name', (testCase) => {
  const once = withSharedResponses(declaredBy(testCase), testCase.route, 'probe')
  expect(withSharedResponses(once, testCase.route, 'probe')).toEqual(once)
})

it('adds the headers to a copy, leaving the success schema it was given unchanged', () => {
  const ok: TSchema = Type.Object({ status: Type.String() })
  const merged = withSharedResponses({ 200: ok }, ruleCases[0]!.route, 'probe')
  expect(ok).toEqual(Type.Object({ status: Type.String() }))
  expect(merged['200']).not.toBe(ok)
  expect(merged['200']).toEqual({ ...ok, headers: expect.any(Object) })
})
```

- [ ] **Step 4: Narrow the recorder's dataset and runner to `required`**

In `tests/fixtures/datasets/contract-recorder.ts`, change the field to:

```ts
  /** status → header name → whether it is declared `required`. */
  declaredHeaders?: Record<number, Record<string, boolean>>
```

In the rows "a declared header missing from the reply" and "a declared header present", change `declaredHeaders: { 429: ['retry-after'] }` to `declaredHeaders: { 429: { 'retry-after': true } }`. Rename the first to `'a required header missing from the reply'`. Append, before "a HEAD error…":

```ts
  {
    name: 'an optional header absent',
    method: 'GET',
    url: '/thing',
    declares: { 500: ['internal_error'] },
    declaredHeaders: { 500: { 'x-ratelimit-limit': false } },
    reply: { status: 500, error: 'internal_error' },
    expected: [],
  },
  {
    name: 'a required header missing from a success',
    method: 'GET',
    url: '/thing',
    declares: { 200: null },
    declaredHeaders: { 200: { 'x-ratelimit-limit': true } },
    reply: { status: 200 },
    expected: ['GET /thing answered 200 without x-ratelimit-limit, which it declares'],
  },
```

In `tests/unit/contract-recorder.test.ts`, replace `responseMap` with:

```ts
function headersOf(declared: Record<string, boolean> | undefined) {
  if (declared === undefined) return {}
  return {
    headers: Object.fromEntries(
      Object.entries(declared).map(([name, required]) => [
        name,
        { type: 'string', ...(required ? { required: true } : {}) },
      ]),
    ),
  }
}

function responseMap({ declares, declaredHeaders }: RecorderCase) {
  return Object.fromEntries(
    Object.entries(declares).map(([status, codes]) => [
      status,
      codes === null
        ? {
            type: 'object',
            additionalProperties: true,
            ...headersOf(declaredHeaders?.[Number(status)]),
          }
        : {
            type: 'object',
            properties: { error: { type: 'string', enum: codes }, message: { type: 'string' } },
            ...headersOf(declaredHeaders?.[Number(status)]),
          },
    ]),
  )
}
```

- [ ] **Step 5: Write the document's header table**

`tests/fixtures/datasets/documented-headers.ts`:

```ts
import { COUNTED, SOMETIMES_COUNTED } from './rate-limit.js'

export interface DocumentedHeadersCase {
  method: string
  /** As the document writes it: `/resources/{id}`. */
  path: string
  status: string
  /** header name → whether the document marks it `required`. Empty: it declares none. */
  headers: Record<string, boolean>
}

export const documentedHeadersCases: DocumentedHeadersCase[] = [
  { method: 'get', path: '/health', status: '200', headers: COUNTED },
  { method: 'post', path: '/resources/{id}/bookings', status: '201', headers: COUNTED },
  { method: 'delete', path: '/resources/{id}', status: '204', headers: COUNTED },
  { method: 'get', path: '/resources/{id}', status: '400', headers: COUNTED },
  { method: 'get', path: '/resources', status: '401', headers: { 'www-authenticate': true } },
  { method: 'get', path: '/resources', status: '403', headers: {} },
  { method: 'get', path: '/resources/{id}', status: '404', headers: COUNTED },
  { method: 'post', path: '/resources/{id}/bookings', status: '409', headers: COUNTED },
  { method: 'post', path: '/bookings/{id}/confirm', status: '410', headers: COUNTED },
  { method: 'post', path: '/resources', status: '413', headers: COUNTED },
  { method: 'post', path: '/resources', status: '415', headers: COUNTED },
  { method: 'get', path: '/health', status: '429', headers: { 'retry-after': true, ...COUNTED } },
  {
    method: 'get',
    path: '/resources',
    status: '429',
    headers: { 'retry-after': true, ...COUNTED },
  },
  { method: 'get', path: '/resources', status: '500', headers: SOMETIMES_COUNTED },
  {
    method: 'post',
    path: '/bookings/{id}/confirm',
    status: '503',
    headers: { 'retry-after': true, ...COUNTED },
  },
]
```

- [ ] **Step 6: Write the document tests**

In `tests/integration/openapi.test.ts`, add:

```ts
import { documentedHeadersCases } from '../fixtures/datasets/documented-headers.js'
import { LIMITER_HEADER_NAMES } from '../fixtures/datasets/rate-limit.js'
```

Add `'x-ratelimit-remaining'` to the array in "states the conventions a caller cannot guess".

Add a header type beside `DocumentedError`, and give `DocumentedError.headers` that type:

```ts
interface DocumentedHeader {
  schema?: Record<string, unknown>
  description?: string
  required?: boolean
}
```

```ts
    headers?: Record<string, DocumentedHeader>
```

Replace "documents the rate-limit headers on a 429" with:

```ts
const headersOf = (method: string, path: string, status: string) => {
  const responses = document.paths[path]![method]!.responses as Record<
    string,
    { headers?: Record<string, DocumentedHeader> }
  >
  const response = responses[status]
  expect(response, `${method} ${path} declares no ${status}`).toBeDefined()
  return response!.headers ?? {}
}

const requiredness = (headers: Record<string, DocumentedHeader>) =>
  Object.fromEntries(
    Object.entries(headers).map(([name, header]) => [name, header.required === true]),
  )

it.each(documentedHeadersCases)(
  'declares the headers of $method $path $status',
  ({ method, path, status, headers }) => {
    expect(requiredness(headersOf(method, path, status))).toEqual(headers)
  },
)

it.each(ROUTES)(
  'declares the limiter headers as required on every success of %s %s',
  (method, path) => {
    const successes = Object.keys(document.paths[path]![method]!.responses as object).filter(
      (status) => status.startsWith('2'),
    )
    for (const status of successes) {
      const declared = requiredness(headersOf(method, path, status))
      for (const name of LIMITER_HEADER_NAMES) {
        expect(declared[name], `${status} ${name}`).toBe(true)
      }
    }
  },
)

it('places required on the header object, never inside its schema', () => {
  for (const [method, path] of ROUTES) {
    const responses = document.paths[path]![method]!.responses as Record<
      string,
      { headers?: Record<string, DocumentedHeader> }
    >
    for (const [status, response] of Object.entries(responses)) {
      for (const [name, header] of Object.entries(response.headers ?? {})) {
        expect(header.schema, `${method} ${path} ${status} ${name}`).not.toHaveProperty('required')
      }
    }
  }
})
```

In `tests/integration/shared-responses.test.ts`, change the `Operation` header type to `headers?: Record<string, { required?: boolean }>` and replace the header loop in "answered and declared" with:

```ts
for (const [header, declaration] of Object.entries(declared?.headers ?? {})) {
  if (declaration.required === true) expect(response.headers[header], header).toBeDefined()
}
```

- [ ] **Step 7: Run them and see them fail**

Run: `npx vitest run tests/unit/responses.test.ts tests/unit/contract-recorder.test.ts tests/integration/openapi.test.ts`
Expected: FAIL — merge and grouping rows report missing `x-ratelimit-*` and `required`; "adds the headers to a copy" sees the schema returned unchanged; the documented-header rows fail on every `2xx`; "a required header missing from a success" passes already and "an optional header absent" fails (the recorder still demands every declared header); "states the conventions" fails on `x-ratelimit-remaining`.

- [ ] **Step 8: Implement the rule**

In `src/shared/responses.ts`:

Replace the `ErrorEntry.headers` line with:

```ts
  /** Headers this code's replies always carry on their own, apart from the limiter's three. */
  headers: readonly string[]
```

Replace `PLUGIN_HEADERS` and its comment with:

```ts
/**
 * Headers a code carries that its class does not set: the rate-limit plugin writes `retry-after`
 * on the reply before it throws, and Fastify's error path keeps it. The limiter's other three
 * are not here: they are on every reply it counted, not on one code — see `LIMITER_REACH`.
 */
const PLUGIN_HEADERS: Record<string, readonly string[]> = {
  rate_limited: ['retry-after'],
}
```

Rename `HEADER_DOCS` to an export and type it once:

```ts
interface HeaderDoc {
  type: 'integer' | 'string'
  description: string
}

/** Every header the document describes. The recorder fails a reply carrying one undeclared. */
export const HEADER_DOCS: Record<string, HeaderDoc> = {
```

(the entries stay as they are). After `HEADER_DOCS`, add:

```ts
/** The three headers `@fastify/rate-limit` writes on every request it counts. */
const LIMITER_HEADERS = ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset']

/**
 * Where a code is answered relative to the limiter. Authentication is an application-level
 * `onRequest` hook and the limiter a route-level one, which Fastify runs after it, so what
 * authentication throws is answered before the request is counted. `internal_error` comes from
 * either side: a failing key lookup, or a failing handler. Every other code, and every success,
 * is answered after.
 */
const LIMITER_REACH: Record<string, 'before' | 'either'> = {
  unauthorized: 'before',
  forbidden_scope: 'before',
  internal_error: 'either',
}

type Presence = 'always' | 'sometimes'

function limiterPresence(reach: 'after' | 'before' | 'either'): Array<[string, Presence]> {
  if (reach === 'before') return []
  const presence: Presence = reach === 'after' ? 'always' : 'sometimes'
  return LIMITER_HEADERS.map((name) => [name, presence])
}

/** The headers one code's replies carry, and whether always or only sometimes. */
function presenceOf(entry: ErrorEntry): ReadonlyMap<string, Presence> {
  return new Map([
    ...entry.headers.map((name): [string, Presence] => [name, 'always']),
    ...limiterPresence(LIMITER_REACH[entry.code] ?? 'after'),
  ])
}

const SUCCESS_PRESENCE: ReadonlyMap<string, Presence> = new Map(limiterPresence('after'))

/**
 * A status's headers: every header any of its codes carries, `required` only where every code
 * always carries it. A header some code carries only sometimes is declared without `required`,
 * which OpenAPI reads as "may be present".
 */
function declaredHeaders(
  presences: ReadonlyArray<ReadonlyMap<string, Presence>>,
): Record<string, HeaderDoc & { required?: true }> {
  const names = [...new Set(presences.flatMap((presence) => [...presence.keys()]))]
  return Object.fromEntries(
    names.map((name) => {
      const required = presences.every((presence) => presence.get(name) === 'always')
      return [name, { ...headerSchema(name), ...(required ? { required: true as const } : {}) }]
    }),
  )
}

const isSuccess = (status: string) => Number(status) >= 200 && Number(status) < 300
```

Give `headerSchema` the return type `HeaderDoc`, unchanged otherwise.

In `errorResponse`, replace

```ts
const headers = [...new Set(entries.flatMap((entry) => entry.headers))]
```

with

```ts
const headers = declaredHeaders(entries.map(presenceOf))
```

and the spread at the end with

```ts
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
```

Update `errorResponse`'s doc comment's last clause to: `…one example per code keyed by it, and the headers they carry, each \`required\` only where every code always carries it.`

In `withSharedResponses`, before `return result`, add:

```ts
// Every success has been counted by the limiter. A copy, never the route's own object: one
// success schema is often shared by many routes.
for (const [status, schema] of Object.entries(result)) {
  if (isSuccess(status)) {
    result[status] = { ...(schema as object), headers: declaredHeaders([SUCCESS_PRESENCE]) }
  }
}
```

and change its doc comment's first sentence to: `A route's response map with every shared rule that applies merged in, and the limiter's headers on every success.`

- [ ] **Step 9: Narrow the recorder's forward check**

In `tests/integration/contract.ts`, change `DeclaredResponse.headers` to:

```ts
  headers?: Record<string, { required?: boolean }>
```

and replace the header loop with:

```ts
for (const [header, declaration] of Object.entries(declared.headers ?? {})) {
  if (declaration.required === true && reply.getHeader(header) === undefined) {
    mismatches.push(`${where} answered ${status} without ${header}, which it declares`)
  }
}
```

In its file comment, change "or a declared header the reply lacks" to "or a header declared `required` that the reply lacks".

- [ ] **Step 10: Say it once in the document's prose**

In `src/app.ts`, in `openapiDocument`, add after the scopes paragraph (the last argument of `md(...)`):

```ts
        'Every reply the rate limiter has counted carries `x-ratelimit-limit`, `x-ratelimit-remaining` and `x-ratelimit-reset`, so a caller can pace itself before it is refused. A `401` or `403` is answered before the request is counted and carries none of them; a `500` carries them only when the failure came after it.',
```

- [ ] **Step 11: Regenerate and run the changed tests**

Run: `./run openapi`
Then: `npx vitest run tests/unit tests/integration/openapi.test.ts tests/integration/shared-responses.test.ts tests/integration/rate-limit.test.ts`
Expected: PASS. If a `413` or `415` trigger fails on a missing `x-ratelimit-*`, Review Focus item 3 applies: add the code to `LIMITER_REACH` as `'before'`, change its rows, and report the deviation.

Check the diff of `openapi.json` reads as intended: `git diff --stat openapi.json`, and spot-check `GET /health` `200`, `GET /resources` `401` and `500`.

- [ ] **Step 12: Delete the backlog entry**

In `docs/backlog.md`, delete the section `## The rate-limit headers on a success are sent but not documented` with its four bullets and the blank line after it.

- [ ] **Step 13: Run the whole check**

Run: `./run check`
Expected: types clean, formatting clean, every test passes — the recorder now sees every reply of the suite against the new declarations. If `helper.test.ts` fails on foreign `booking-engine-testing=true` containers, another project's suite is running; wait and re-run.

- [ ] **Step 14: Commit**

```bash
git branch --show-current   # fix/rate-limit-headers
git add src/shared/responses.ts src/app.ts openapi.json docs/backlog.md tests/
git commit -m "fix(openapi): declare the rate-limit headers on every counted reply"
```

---

### Task 3: The recorder fails a reply carrying a header its status does not declare

**Files:**

- Modify: `tests/integration/contract.ts`, `tests/fixtures/datasets/contract-recorder.ts`

**Interfaces:**

- Consumes: `HEADER_DOCS` from `src/shared/responses.ts` (Task 2).

- [ ] **Step 1: Write the failing rows**

Append to `recorderCases`, before "a HEAD error…":

```ts
  {
    name: 'a described header the status does not declare',
    method: 'GET',
    url: '/thing',
    declares: { 200: null },
    reply: { status: 200, headers: { 'x-ratelimit-limit': '600' } },
    expected: ['GET /thing answered 200 with x-ratelimit-limit, which it does not declare'],
  },
  {
    name: 'a header the document does not describe',
    method: 'GET',
    url: '/thing',
    declares: { 200: null },
    reply: { status: 200, headers: { 'x-request-id': 'probe' } },
    expected: [],
  },
  {
    name: 'an optional header present',
    method: 'GET',
    url: '/thing',
    declares: { 500: ['internal_error'] },
    declaredHeaders: { 500: { 'x-ratelimit-limit': false } },
    reply: { status: 500, error: 'internal_error', headers: { 'x-ratelimit-limit': '600' } },
    expected: [],
  },
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run tests/unit/contract-recorder.test.ts`
Expected: FAIL — "a described header the status does not declare" records nothing.

- [ ] **Step 3: Add the reverse check**

In `tests/integration/contract.ts`, add `import { HEADER_DOCS } from '../../src/shared/responses.js'`, and after the forward loop:

```ts
// Only the headers the document describes: content-type, date and the rest are HTTP's.
for (const header of Object.keys(HEADER_DOCS)) {
  if (reply.getHeader(header) !== undefined && declared.headers?.[header] === undefined) {
    mismatches.push(`${where} answered ${status} with ${header}, which it does not declare`)
  }
}
```

In the file comment, after "or a header declared `required` that the reply lacks", add: ", or a header the document describes that the reply carries and its status does not declare".

- [ ] **Step 4: Run the recorder's test, then everything**

Run: `npx vitest run tests/unit/contract-recorder.test.ts`
Expected: PASS.

Run: `./run check`
Expected: every test passes — which proves the spec's §1 table against every reply the suite draws. A failure here names a route and status that carries a header it does not declare; that is a finding about the rule, not the recorder: stop and report it.

- [ ] **Step 5: Commit**

```bash
git branch --show-current   # fix/rate-limit-headers
git add tests/integration/contract.ts tests/fixtures/datasets/contract-recorder.ts
git commit -m "test(openapi): fail a reply carrying a header its status does not declare"
```

---

### Task 4: Documentation, and the plan archived

**Files:**

- Modify: `docs/conventions.md` (section "Documentation is generated, never written twice"), `docs/architecture.md:310`, `docs/superpowers/specs/2026-10-10-rate-limit-headers-design.md:3`
- Move: `docs/superpowers/plans/2026-10-10-rate-limit-headers.md` → `docs/superpowers/plans/archive/`

- [ ] **Step 1: Conventions — how headers are declared**

In `docs/conventions.md`, after the paragraph beginning "`enum`, never a union of literals", insert:

```markdown
Headers are declared the same way, from what each code carries. A header is `required` on a
status when every code under it always carries it, and declared without `required` when only
some do. `@fastify/rate-limit` writes `x-ratelimit-limit`, `x-ratelimit-remaining` and
`x-ratelimit-reset` on every request it counts, and it counts after authentication, so every
success and every error status declares the three as required, with three exceptions: `401`
and `403` are answered before the count and declare none, and `500` — answered before the count
by a failing key lookup, after it by a failing handler — declares them without `required`.
`LIMITER_REACH` in `src/shared/responses.ts` is that table. `@fastify/swagger` would put
`required` inside the header's schema, where it is invalid; `liftRequiredHeaders`, passed to it
as `transformObject`, moves it onto the header.
```

- [ ] **Step 2: Conventions — what the recorder checks**

In the paragraph beginning "Two tests keep the statuses true", replace

```markdown
reply's status or code, or when the reply lacks a header its route declares. A header the reply
carries and the route does not declare is not checked. And
```

with

```markdown
reply's status or code, when the reply lacks a header its status declares as required, or when
it carries a header the document describes — a key of `HEADER_DOCS` — that its status does not
declare. HTTP's own headers are not checked. And
```

Then re-wrap the paragraph to 100 columns with `npx prettier --write docs/conventions.md`.

- [ ] **Step 3: Architecture**

In `docs/architecture.md:310`, replace "two tests fail any status a route answers without declaring it" with "two tests fail any status, or any header the document describes, that a route answers without declaring it".

- [ ] **Step 4: Spec status, plan archived**

In the spec, change `**Status:** approved` to `**Status:** implemented`.

```bash
git mv docs/superpowers/plans/2026-10-10-rate-limit-headers.md docs/superpowers/plans/archive/
```

- [ ] **Step 5: Check and commit**

Run: `./run check`
Expected: passes; `documented-tables.test.ts` is unaffected (no table row changed).

```bash
git branch --show-current   # fix/rate-limit-headers
git add docs/
git commit -m "docs: record which replies carry the rate-limit headers, and archive the plan"
```
