# Backlog

What is known to be wrong and not yet fixed, newest first. The rule for this file is the shared
`backlog.md`, imported by [CLAUDE.md](../CLAUDE.md): one entry per finding, deleted by the
commit that fixes it.

## Concurrent failed authentications can pass the address's limit

- Where: `src/shared/auth.ts`, the `onRequest` hook — the failure count is read, then the key
  looked up, then the count incremented
- Found: 2026-10-11, while planning the failed-authentication limit
- Problem: _n_ requests from one address sent at once all read the count before any of them
  increments it, so each reaches the key lookup. Send 100 bad keys in parallel with
  `AUTH_FAILURES_PER_MINUTE=30`: up to 100 lookups run, not 30.
- Impact: the bound is `max + n − 1` per burst, not `max`. Sequential traffic is held exactly.
  Incrementing before the lookup and refunding on success would close it; the plugin's store has
  no decrement.

## The test helper cannot raise the failed-authentication limit

- Where: `testing/src/index.ts`, `EngineOptions`
- Found: 2026-10-11, while planning the failed-authentication limit
- Problem: the helper passes `RATE_LIMIT_PER_MINUTE` through but not `AUTH_FAILURES_PER_MINUTE`.
  Every request a consumer's suite sends reaches the API container from one address, so a suite
  sending more than 30 bad keys a minute gets `429` where it expects `401`.
- Impact: a consumer testing its own handling of a rejected key many times in one file is
  throttled, with no option to say otherwise. An `authFailuresPerMinute` option, passed as the
  variable, would close it.

## A public route's count can be reset by changing the header

- Where: `src/shared/rate-limit.ts`, `limiterKey()`
- Found: 2026-10-11, while designing the failed-authentication limit
- Problem: a request carrying an `Authorization` header is counted by it, even on a public route
  that never reads it. A caller sending `GET /health` with a different made-up header each time
  gets a fresh count each time and is never refused.
- Impact: low — `/health` is cheap, and the plugin's in-memory store holds at most 5 000 keys,
  so the rotation cannot grow memory. Counting public routes by address alone would close it.

## A malformed URL is answered by Fastify directly, against the document

- Where: `src/app.ts`, the `Fastify({...})` options, which set no `frameworkErrors`; Fastify's
  `onBadUrl`
- Found: 2026-10-11, in the review of the rate-limit headers slice
- Problem: a path that is not valid percent-encoding is refused before any hook runs. Send
  `GET /resources/%E0%A4%A`: it answers `400 {"error":"Bad Request","code":"FST_ERR_BAD_URL",…}`,
  not `validation_error` in the shape `http.md` requires, and carries no `x-ratelimit-*` header,
  though `GET /resources/{id}` declares the three as required on its `400`. The recorder never
  sees it, because no route matched. An over-long path parameter (`onMaxParamLength`) likely
  takes the same path.
- Impact: a consumer branching on `error` gets a code the engine never documents. Rare: it needs
  a malformed URL. A `frameworkErrors` option routing these through the error handler would close it.

## `x-ratelimit-limit` is described as per key on routes called without one

- Where: `src/shared/responses.ts`, `HEADER_DOCS['x-ratelimit-limit']`
- Found: 2026-10-11, in the review of the rate-limit headers slice
- Problem: the description reads "Requests this key may send per minute". `GET /health` is
  public, usually called without a key, and counted by address — yet its `200` and `429` carry
  that description. Open `GET /health` at `/docs` and read its `200`'s headers.
- Impact: cosmetic; a reader of the public route is told about a key it does not send.

## The document's prose rules are asserted from a list in the test body

- Where: `tests/integration/openapi.test.ts`, "states the conventions a caller cannot guess"
- Found: 2026-10-11, in the review of the rate-limit headers slice
- Problem: the phrases the description must contain — `half-open`, `PT24H`, `x-ratelimit-remaining`
  and the rest — are an inline array, not a dataset, against the testing rule. Each new rule
  extends the array in the body.
- Impact: low; the check works. Adding a rule means editing a test rather than a row.

## The error catalogue lets a duplicate code overwrite the class's entry

- Where: `src/shared/responses.ts`, `catalogue()`
- Found: 2026-10-09, in the review of the shared-status slice
- Problem: `validation_error` and `not_found` enter the catalogue twice, from their classes and
  from `CLIENT_ERRORS`, and the second entry wins. The `CLIENT_ERRORS` entry always carries no
  headers, so a header later given to `ValidationError` or `NotFoundError` would vanish from
  every merged `400` or `404`. Give `ValidationError` a `headers` field, run `./run openapi`:
  the shared `400`s do not declare it.
- Impact: none today, since neither class sets a header. Skipping a code already present, or
  throwing on a mismatching duplicate, would make it impossible.

## Every error response's description appears twice in `openapi.json`

- Where: `src/shared/responses.ts`, `errorResponse()`
- Found: 2026-10-09, in the review of the shared-status slice
- Problem: the description is set on the schema, and `@fastify/swagger` copies it to the
  response while leaving it on the schema too. Open any `409` in `openapi.json`.
- Impact: cosmetic, and a larger document. Swagger UI shows the response description once.

## A declared error code that no test draws is not detected

- Where: `tests/integration/contract.ts`; every `errorResponses(...)` in `src/modules/*/*.routes.ts`
- Found: 2026-10-06, while making `openapi.json` declare every status
- Problem: the recorder fails a reply its route does not declare, and the shared-status
  dataset proves the shared rules in both directions. Nothing proves the other direction for a
  route's own codes: a class left in `errorResponses(...)` after the route stopped throwing it
  stays in the document. Add `HoldExpiredError` to `GET /bookings/:id`, run `./run openapi`,
  and every check passes.
- Impact: the document may promise a code that can no longer occur — a consumer handles a case
  that never comes. Each file sees only its own replies; collecting them across Vitest's workers
  in a global teardown would close it.

## `POST /resources` says the `pool` mode is rejected; it is not

- Where: `src/modules/resources/resource.routes.ts`, the `POST /resources` description
- Found: 2026-10-06, while declaring each route's error codes
- Problem: the description ends "`concurrency_mode: "pool"` is not implemented yet and is
  rejected." Spec 3 implemented it, and `pool` is accepted. Read `POST /resources` at `/docs`,
  then create a resource with `concurrency_mode: "pool"`: it answers `201`.
- Impact: a consumer reading the reference believes pools do not exist.

## `method_not_allowed` is documented, but a wrong method answers `404`

- Where: `src/shared/errors.ts`, `CLIENT_ERRORS[405]`; the error table in `docs/conventions.md`
- Found: 2026-10-06, while deciding which statuses every route shares
- Problem: the table says `405 method_not_allowed` means "the framework matched the path but
  not the method". Fastify answers a known path with an unserved method as an unmatched route:
  `tests/integration/error-handler.test.ts` sends `DELETE /health` and gets `404 not_found`.
- Impact: a consumer branching on `method_not_allowed` waits for a code that never comes. The
  row and the translation are dead unless the not-found handler tells the two apart.

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
