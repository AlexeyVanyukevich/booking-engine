# Backlog

What is known to be wrong and not yet fixed, newest first. The rule for this file is the shared
`backlog.md`, imported by [CLAUDE.md](../CLAUDE.md): one entry per finding, deleted by the
commit that fixes it.

## Casts written for untyped bodies outlived them

- Where: `tests/integration/availability.test.ts` (`slots as Slot[]`, three times),
  `tests/integration/pools.test.ts`, `tests/fixtures/suites/availability.ts`, and about five
  more: a `json<T>()` read followed by `as …`, or a `.map((row: { … }) => …)` annotation
- Found: 2026-10-02, while typing response bodies
- Problem: these casts and annotations were written when `json()` returned `any`, to give the
  value a shape. Each read now has its contract type, so they are redundant, and a cast keeps
  compiling if the contract changes under it. Search `tests/` for `json<` followed by `as`.
- Impact: low today, since the casts agree with the contract. They are where a future contract
  change would slip past the type check that the typed reads were added for.

## `issue-keys` can leave a tenant with only some of its keys

- Where: `src/issue-keys.ts`, `issueKeys()`, the loop after `createTenant`
- Found: 2026-10-02, in the review of the consumer test harness
- Problem: every refusal is decided before the first write, but the tenant and its keys are not
  written in one transaction. If the database fails after the tenant is created, the command
  exits `1` and leaves a tenant holding the keys issued so far. `TenantService` takes no
  transaction, which is why it was not done here.
- Impact: a retry creates a second tenant of the same name; the first is an orphan only an
  operator would notice. Rare: it needs the database to fail mid-command.

## The helper's test finds leftover containers by a label every run shares

- Where: `tests/integration/helper.test.ts`, `stillRunning()`; `testing/src/index.ts`,
  `CONTAINER_LABEL`
- Found: 2026-10-02, in the review of the consumer test harness
- Problem: every container the helper starts carries `booking-engine-testing=true`, the same
  value for every run. The test asserts no container with that label is running, so a
  consumer's suite using the helper on the same machine at the same time would fail it.
- Impact: a false failure of `./run check` while another project's suite runs. A per-run value
  exposed on `StartedEngine` would make the check exact.

## Nothing runs the check on a pull request or a push to `main`

- Where: `.github/workflows/`, which holds only `release.yml`
- Found: 2026-10-02, while adding the release workflow
- Problem: CI runs `./run check` only when a version tag is pushed. A commit that breaks `main`
  is caught by whoever next runs the check locally, or by the next release.
- Impact: a release can be blocked by a failure introduced many commits earlier, and the rule
  that `main` always passes is enforced by habit alone.

## `./run smoke` cannot run against `./run up`

- Where: `scripts/smoke.ts`, `bootstrapKey()`; `docker-compose.yml`, the `console` service
- Found: 2026-10-02, while fixing the README's first run
- Problem: smoke issues its key through the console's forms at `CONSOLE_URL`. Under `./run up`
  the console binds `127.0.0.1` inside its container, so the published port reaches nothing and
  smoke fails before its first case. Run `./run up`, then `./run smoke`.
- Impact: the end-to-end check runs only against `./run dev`. Issuing its key with
  `issue-keys`, or through `./run key`, would let it run against both.

## The rate limit is counted per process, not across the deployment

- Where: `src/app.ts`, the `@fastify/rate-limit` registration, which passes no store; until
  2026-10-01 a row in `docs/conventions.md`'s deliberate limitations
- Found: 2026-10-01, moved here from the deliberate limitations, where it had been accepted
- Problem: the plugin keeps each key's count for the current minute in the memory of the
  process that served the request. Every API instance therefore counts on its own, and a
  restart forgets every count. Run two `app` containers against one database behind a
  round-robin balancer, with `RATE_LIMIT_PER_MINUTE=600`, and send one key 1 200 requests in a
  minute: none is refused. Restart the one container mid-minute and the key's budget starts over.
- Impact: `RATE_LIMIT_PER_MINUTE` means "per key, per process", so the real ceiling scales with
  the instance count and nobody reading the setting can tell. Whether a request is refused
  depends on which instance the balancer picked, so a consumer pacing itself on `429` and
  `x-ratelimit-remaining` sees inconsistent answers. A single instance, as `./run up` and the
  compose file run it, behaves exactly as documented. The plugin takes a Redis client through
  its `redis` option, or any object implementing its `store` interface, so the counts can live
  in Redis or in the engine's own PostgreSQL.

## The rate-limit refusal ignores the plugin's `ban` context

- Where: `src/app.ts`, the `errorResponseBuilder` passed to `@fastify/rate-limit`
- Found: 2026-10-01, in the review of the rate-limit status fix
- Problem: the plugin passes the builder a context whose `statusCode` becomes `403` and `ban`
  becomes `true` once a client passes the `ban` threshold. The builder ignores the context and
  always returns `RateLimitedError`, a `429`. `ban` is not set today, so the path is never taken.
- Impact: none today. Whoever sets `ban` gets `429` where the plugin documents `403`, with no
  test to say so.

## The `x-ratelimit-*` headers on a `429` are not asserted

- Where: `tests/integration/rate-limit.test.ts`; the comment on `RateLimitedError` in
  `src/shared/errors.ts`
- Found: 2026-10-01, in the review of the rate-limit status fix
- Problem: the comment says the plugin's `retry-after` and `x-ratelimit-*` headers survive
  Fastify's error path. The test asserts `retry-after` on every `429`, but none of
  `x-ratelimit-limit`, `-remaining` or `-reset`.
- Impact: a consumer pacing itself from `x-ratelimit-remaining` would lose it without a failing
  test. Low today, because nothing in the engine touches those headers.

## Requests the limiter never sees: rejected keys and unmatched paths

- Where: `src/app.ts`, the `@fastify/rate-limit` registration; `src/shared/auth.ts`, the
  `onRequest` hook; `src/shared/errors.ts`, `setNotFoundHandler`
- Found: 2026-10-01, while fixing the rate-limit status
- Problem: the limiter attaches its `onRequest` hook to each route, and authentication is an
  application-level `onRequest` hook, which Fastify runs first. A request whose key is missing,
  malformed, unknown or revoked is answered `401` before the limiter sees it, so no number of
  them is ever refused. `tests/fixtures/datasets/rate-limit.ts` pins this: three requests with
  a malformed key under a limit of one all answer `401`. A request to a path no route matches
  has no route hook at all, so a valid key can draw `404`s without limit; the plugin's README
  says the not-found handler must opt in for those to count.
- Impact: a well-formed key costs a database lookup per request, unthrottled, either from a
  caller holding no credential or from a valid key aimed at unmatched paths. The secrets are
  long enough that guessing one stays infeasible, so the cost is load, not access. Counting by
  address before authentication, or giving failed authentication its own lower limit, and
  registering the not-found handler with the limiter, would close it.
