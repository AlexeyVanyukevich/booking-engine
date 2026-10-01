# Rate-limit status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A request past a key's per-minute limit answers `429 rate_limited` with `Retry-After`, not `500 internal_error`.

**Architecture:** The rate-limit plugin throws whatever its `errorResponseBuilder` returns. The builder returns a new `AppError` subclass, `RateLimitedError`, so the existing error handler sends it like every other engine error. The `RATE_LIMITED_CODE` constant, which existed only because the code lived outside the `AppError` hierarchy, goes.

**Tech Stack:** Fastify 5.10, `@fastify/rate-limit` 11.2, Vitest, Testcontainers PostgreSQL.

**Spec:** `docs/superpowers/specs/2026-10-01-rate-limit-status-design.md`

## Global Constraints

- Every error response has the shape `{ error, message, details? }`.
- Test cases live in a typed dataset under `tests/fixtures/datasets/`, consumed by a parameterised runner.
- Commits: Conventional Commits, subject line only, no body, no trailer.
- `./run check` passes before every commit. It needs Docker running.

## Review Focus

- A request with no key past the limit: counted by address, answers `429` before authentication would answer `401`. Pinned by a dataset row in Task 1.
- A malformed key past the limit: counted by its raw header, answers `429`, not `401`. Pinned by a dataset row in Task 1.
- `Retry-After` is a positive whole number of seconds, not an HTTP date or `0`. Asserted on every `429` in Task 1.
- A second key on the **same** tenant is unaffected, which shows the limit is per key, not per tenant. Pinned by a dataset row in Task 1.
- Fastify's error path removes `content-type` and `content-length` only (`lib/error-handler.js`, 5.10), so `retry-after` set by the plugin before the throw survives. Asserted in Task 1 rather than assumed.

---

### Task 1: Answer a used-up limit with `429 rate_limited`

**Files:**

- Create: `tests/fixtures/datasets/rate-limit.ts`
- Create: `tests/integration/rate-limit.test.ts`
- Modify: `tests/integration/helpers.ts` (`buildTestApp`)
- Modify: `src/shared/errors.ts` (add `RateLimitedError`, remove `RATE_LIMITED_CODE`)
- Modify: `src/app.ts:20,97-100`
- Modify: `tests/unit/documented-tables.test.ts:85-107`
- Modify: `docs/conventions.md`, the `rate_limited` row
- Modify: `docs/backlog.md`, delete the entry _A used-up rate limit is answered `500`, not `429 rate_limited`_

**Interfaces:**

- Produces: `RateLimitedError extends AppError` with `statusCode = 429`, `code = 'rate_limited'`.
- Produces: `buildTestApp(overrides?: Partial<AppConfig>): Promise<FastifyInstance>`.

- [ ] **Step 1: Write the dataset**

`tests/fixtures/datasets/rate-limit.ts`:

```ts
/**
 * Who sends a request: one of two keys on the same tenant, a credential the engine could
 * never have issued, or no credential at all. Two keys on one tenant, rather than one key on
 * each of two tenants, are what show the limit is counted per key and not per tenant.
 */
export type Caller = 'first' | 'second' | 'malformed' | 'anonymous'

export interface RateLimitScenario {
  name: string
  limit: number
  requests: Caller[]
  /** The status each request in `requests` answers, in the same order. */
  expected: number[]
}

export const rateLimitScenarios: RateLimitScenario[] = [
  {
    name: 'requests up to the limit are served',
    limit: 3,
    requests: ['first', 'first', 'first'],
    expected: [200, 200, 200],
  },
  {
    name: 'every request past the limit is refused',
    limit: 2,
    requests: ['first', 'first', 'first', 'first'],
    expected: [200, 200, 429, 429],
  },
  {
    name: 'a second key is served while the first is exhausted',
    limit: 2,
    requests: ['first', 'first', 'first', 'second', 'second'],
    expected: [200, 200, 429, 200, 200],
  },
  {
    name: 'a second key is counted on its own',
    limit: 1,
    requests: ['first', 'second', 'first', 'second'],
    expected: [200, 200, 429, 429],
  },
  {
    name: 'a malformed key is counted before it is rejected',
    limit: 1,
    requests: ['malformed', 'malformed'],
    expected: [401, 429],
  },
  {
    name: 'a request with no key is counted by address',
    limit: 1,
    requests: ['anonymous', 'anonymous'],
    expected: [401, 429],
  },
]
```

- [ ] **Step 2: Let `buildTestApp` take a configuration override**

In `tests/integration/helpers.ts`, import `type AppConfig` from `../../src/config.js`, change the signature to `buildTestApp(overrides: Partial<AppConfig> = {})`, spread `...overrides` last inside `config`, and correct the comment on `rateLimitPerMinute`:

```ts
      // High enough that a suite firing hundreds of requests in one minute is not throttled;
      // the limiter's own behaviour is asserted in tests/integration/rate-limit.test.ts.
      rateLimitPerMinute: 100_000,
      ...overrides,
```

- [ ] **Step 3: Write the runner**

`tests/integration/rate-limit.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { TenantRepository } from '../../src/modules/tenants/tenant.repository.js'
import { TenantService } from '../../src/modules/tenants/tenant.service.js'
import { SCOPES } from '../../src/shared/scopes.js'
import { rateLimitScenarios, type Caller } from '../fixtures/datasets/rate-limit.js'
import { buildTestApp, closeTestDb, getTestDb, resetDb, seedTenant } from './helpers.js'

beforeEach(resetDb)
afterAll(closeTestDb)

async function seedCallers(): Promise<Record<Caller, Record<string, string>>> {
  const { tenantId, authHeader } = await seedTenant()
  const service = new TenantService(new TenantRepository(getTestDb()))
  const { secret } = await service.issueKey(tenantId, 'second', [...SCOPES])
  return {
    first: authHeader,
    second: { authorization: `Bearer ${secret}` },
    malformed: { authorization: 'Bearer garbage' },
    anonymous: {},
  }
}

describe('the per-key rate limit', () => {
  // Each case builds its own app: the limit differs per case, and the plugin counts in memory,
  // so a shared app would carry one case's requests into the next.
  it.each(rateLimitScenarios)('$name', async ({ limit, requests, expected }) => {
    const callers = await seedCallers()
    const app = await buildTestApp({ rateLimitPerMinute: limit })
    try {
      const statuses: number[] = []
      for (const caller of requests) {
        const response = await app.inject({
          method: 'GET',
          url: '/resources',
          headers: callers[caller],
        })
        statuses.push(response.statusCode)
        if (response.statusCode === 429) {
          expect(response.json()).toEqual({ error: 'rate_limited', message: expect.any(String) })
          expect(response.headers['retry-after']).toMatch(/^[1-9]\d*$/)
        }
      }
      expect(statuses).toEqual(expected)
    } finally {
      await app.close()
    }
  })
})
```

- [ ] **Step 4: Run it and see it fail**

Run: `npx vitest run tests/integration/rate-limit.test.ts` (`./run test` takes no file argument; vitest's global set-up starts PostgreSQL itself).
Expected: the three cases that cross the limit fail with `500` where `429` is expected, and the anonymous and malformed cases fail the same way on their second request. "requests up to the limit are served" passes.

- [ ] **Step 5: Add `RateLimitedError` and remove `RATE_LIMITED_CODE`**

In `src/shared/errors.ts`, after `HoldExpiredError`:

```ts
/**
 * The per-key limit for this minute is used up. The rate-limit plugin in `src/app.ts` throws
 * whatever its `errorResponseBuilder` returns, and returns this, so the refusal is sent like any
 * other engine error. The plugin has already set `retry-after` and `x-ratelimit-*` on the reply,
 * and Fastify's error path keeps them.
 */
export class RateLimitedError extends AppError {
  readonly statusCode = 429
  readonly code = 'rate_limited'
}
```

Delete the `RATE_LIMITED_CODE` export and its comment.

In `src/app.ts`, import `RateLimitedError` in place of `RATE_LIMITED_CODE`, and:

```ts
    errorResponseBuilder: () => new RateLimitedError('Too many requests; slow down and retry'),
```

- [ ] **Step 6: Let the documented-tables test find the code like any other**

In `tests/unit/documented-tables.test.ts`, delete `pairs.add(\`${errors.RATE_LIMITED_CODE} 429\`)` and change the comment's "plus the two the plugins and the handler build directly" to "plus the one the handler builds directly".

- [ ] **Step 7: Update the documents**

In `docs/conventions.md`, the `rate_limited` row's meaning becomes "The per-key limit for this minute is used up; carries `Retry-After`", re-padding the table. In `docs/backlog.md`, delete the whole entry this task fixes.

- [ ] **Step 8: Run the full check**

Run: `./run check`
Expected: types, formatting and the full suite pass, including all six rate-limit cases.

- [ ] **Step 9: Commit**

```bash
git add src/shared/errors.ts src/app.ts tests/fixtures/datasets/rate-limit.ts tests/integration/rate-limit.test.ts tests/integration/helpers.ts tests/unit/documented-tables.test.ts docs/conventions.md docs/backlog.md
git commit -m "fix: answer a used-up rate limit with 429 rate_limited"
```

---

### Task 2: Record the `openapi.json` status gap

**Files:**

- Modify: `docs/backlog.md`

- [ ] **Step 1: Add the entry at the top**

```markdown
## `openapi.json` documents no `401`, `403` or `429` on any route

- Where: `openapi.json`, generated by `scripts/openapi.ts` from the route schemas; the README's
  row for `openapi.json`
- Found: 2026-10-01, while fixing the rate-limit status
- Problem: the README says the document lists "every path, field and status code". It lists the
  statuses each route declares (`400`, `404`, `409`, `503`), but none of those every route can
  answer: `401 unauthorized`, `403 forbidden_scope`, `429 rate_limited`, `413` and `415`. Search
  `openapi.json` for `"401"` or `"429"`; there are none.
- Impact: a consumer generating a client from the document has no type for those answers and no
  hint that `429` exists to be retried. The conventions table is the only place they appear.
```

- [ ] **Step 2: Check and commit**

Run: `./run check`. Then:

```bash
git add docs/backlog.md
git commit -m "docs: record that openapi.json omits the statuses every route can answer"
```

---

### Task 3: Close the slice

**Files:**

- Modify: `docs/superpowers/specs/2026-10-01-rate-limit-status-design.md` (status line)
- Move: `docs/superpowers/plans/2026-10-01-rate-limit-status.md` → `docs/superpowers/plans/archive/`

`docs/architecture.md` does not mention the rate limit, and running and deploying do not change, so neither it nor the README is touched. Verify that with `grep -n -i "rate.limit" docs/architecture.md README.md` before skipping them.

- [ ] **Step 1:** Change the spec's status line to `**Status:** implemented · **Date:** 2026-10-01`. If the headers turned out to need the fallback the spec describes, add an _As built_ note saying so.
- [ ] **Step 2:** `git mv docs/superpowers/plans/2026-10-01-rate-limit-status.md docs/superpowers/plans/archive/`
- [ ] **Step 3:** `./run check`, then:

```bash
git add -A docs/superpowers
git commit -m "docs: mark the rate-limit status fix implemented and archive its plan"
```
