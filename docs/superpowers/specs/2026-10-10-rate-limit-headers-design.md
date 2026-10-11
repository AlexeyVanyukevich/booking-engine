# `openapi.json` declares the rate-limit headers on every reply that carries them

**Status:** implemented · **Date:** 2026-10-10

**This is a decision record, not current truth.** It states what was decided on the date above and is not revised as the system changes. For what the engine does today, read [architecture.md](../../architecture.md) and [conventions.md](../../conventions.md) — where they disagree with this document, they are right.

---

## 1. Purpose

Fixes the backlog entry _The rate-limit headers on a success are sent but not documented_.

`@fastify/rate-limit` 11.2 sets `x-ratelimit-limit`, `x-ratelimit-remaining` and
`x-ratelimit-reset` in a route-level `onRequest` hook, on every request it counts. The document
declares them only on `429`. A consumer pacing itself from `x-ratelimit-remaining` before it is
refused learns the header exists only by observing it, and a client generated from the
document has no type for it.

The gap is wider than the entry's title. Authentication is an application-level `onRequest`
hook, which Fastify runs before any route-level one, so the headers are on every reply the
limiter counted — not only successes:

| Reply                                                                          | Reaches the limiter        | Carries the three headers |
| ------------------------------------------------------------------------------ | -------------------------- | ------------------------- |
| every `2xx`                                                                    | yes                        | always                    |
| a route's own errors: `400`, `404`, `409`, `410`, `503`                        | yes                        | always                    |
| shared `400 validation_error`, `413`, `415` — validation and parsing run later | yes                        | always                    |
| `429 rate_limited`                                                             | it is the limiter's answer | always                    |
| `401 unauthorized`, `403 forbidden_scope` — thrown by the authentication hook  | no                         | never                     |
| `500 internal_error`                                                           | depends on where it failed | sometimes                 |

A `500` from a failing key lookup is answered before the limiter runs; a `500` from a handler,
after it.

The recorder did not notice because it checks one direction: a header the route declares must
be on the reply. Nothing checks that a header on the reply is declared.

### Success

- Every status whose replies always carry the three headers declares them as `required: true`.
- `500` declares them without `required`; `401` and `403` do not declare them.
- Headers the document already declares, which are always present, become `required: true`:
  `www-authenticate` on `401`, `retry-after` on `429` and `503`.
- The document's description says once, in prose, which replies carry the headers and why.
- The recorder fails a test whose reply carries a header the document describes but its status
  does not declare, and no longer demands a header declared without `required`.

---

## 2. Design

### 2.1 Which codes the limiter has counted

`src/shared/responses.ts` gains one small table: the codes answered before the limiter runs,
and the codes that can come from either side of it.

| Code                                | Limiter                |
| ----------------------------------- | ---------------------- |
| `unauthorized`, `forbidden_scope`   | before — never counted |
| `internal_error`                    | either side            |
| every other code, and every success | after — always counted |

A code counted after the limiter carries the three headers; one counted on either side carries
them sometimes.

### 2.2 A status declares a header by what its codes carry

A header a status declares has a `required` flag:

- `required: true` when every code under the status always carries it;
- declared without `required` when some code carries it, but not every code always does;
- not declared when no code carries it.

This one rule covers both sources of headers: the limiter's three, per §2.1, and those a code
carries on its own — `www-authenticate` from `UnauthorizedError`, `retry-after` from
`ConcurrentUpdateError`, and `retry-after` on `rate_limited`, which the plugin writes.
`PLUGIN_HEADERS` shrinks to `rate_limited: ['retry-after']`; the limiter's three come from the
rule in §2.1 instead.

### 2.3 Successes are merged too

`withSharedResponses` already merges the shared error statuses into every route's real
response schema. It now also gives each `2xx` the limiter's three headers, as `required: true`.

A success schema is often one object shared by many routes — `BookingResponse` is the `200` of
seven. The headers go on a shallow copy, never on the object the route passed in. Merging the
same map twice changes nothing, as it already must, because Fastify hands a `GET`'s `HEAD` twin
the same schema.

A `204` is declared as `Type.Null()`. `@fastify/swagger` reads a response's headers before it
checks for a `null` body, so a `204` documents its headers like any other status.

### 2.4 `required` placed where OpenAPI defines it

`@fastify/swagger` 9.8.1 builds each response header as `{ schema: { …declared }, description }`:
everything declared except the description goes into the header's `schema`. A `required: true`
declared beside the type would land inside the JSON Schema, where `required` must be an array of
property names and the document becomes invalid.

A pure function in `src/shared/responses.ts` walks the generated document's response headers and
moves `required` from each header's `schema` onto the header object, where the OpenAPI Header
Object defines it. `buildApp` passes it to `@fastify/swagger` as `transformObject`, so `/docs/json`,
`/docs/yaml` and the committed `openapi.json` all go through it.

The route's own schema keeps `required` beside the type, which is where the recorder reads it.
Fastify does not validate response headers, and the serializer ignores the `headers` keyword, as
it already does for the error responses that declare headers today.

### 2.5 The document says it once in prose

The `info.description` gains one paragraph: every reply the rate limiter has counted carries
`x-ratelimit-limit`, `x-ratelimit-remaining` and `x-ratelimit-reset`; `401` and `403` are
answered before it counts; a `500` carries them only when the failure came after. Per-response
`required` flags are what a generator reads; the paragraph is what a person reads.

### 2.6 The recorder checks both directions

`tests/integration/contract.ts`, run over every reply of the integration suite:

- **Forward, narrowed.** A declared header with `required: true` that the reply lacks is a
  mismatch, as today. A header declared without `required` is not demanded.
- **Reverse, new.** A header the document describes — a key of `HEADER_DOCS`, exported for the
  purpose — that the reply carries and its status does not declare is a mismatch:
  `GET /health answered 200 with x-ratelimit-limit, which it does not declare`.

Only the headers the document describes are checked in reverse. A reply also carries
`content-type`, `content-length`, `date` and others, which belong to HTTP and not to this
contract.

With both directions, the table in §1 is proven by the suite itself rather than taken on trust:
a `401` carrying the headers fails, and so does a `2xx` without them.

---

## 3. How it is proven

All written before the implementation, and failing on `main`. Cases are dataset rows.

### 3.1 Unit, no database

- `tests/fixtures/datasets/response-rules.ts`: header expectations become name → `required`.
  New rows: a `200` and a `204` success get the three as required; `401` and `403` get none of
  them; `500` gets the three without `required`; `429` gets `retry-after` and the three, all
  required; a route's own `404` gets the three; `ConcurrentUpdateError`'s `503` gets
  `retry-after` and the three.
- `withSharedResponses` leaves the success schema it was given unchanged, and merging its result
  again yields the same map.
- The lift in §2.4, as its own rows: `required` moves out of `schema`; a header with none is left
  as it is; a response with no headers is left as it is.
- `tests/fixtures/datasets/contract-recorder.ts`: a described header present and undeclared
  fails; a header the document does not describe passes; a declared header without `required`,
  absent, passes; a required one, absent, fails as today.

### 3.2 Integration

- `openapi.test.ts`: the test of the `429` headers becomes a test per route — every `2xx`
  declares the three with `required: true`, and no header in the document has `required` inside
  its `schema`.
- The recorder, over the whole suite, proves §1's table against real replies.
- `openapi.json` is regenerated; the byte-for-byte test keeps it current.

---

## 4. Rejected

- **Successes only, as the entry's title says.** The route's own errors and the shared
  `400`/`413`/`415` carry the headers too, and would stay undocumented. The reverse check could
  not be added, because it would fail on them.
- **One paragraph of prose and nothing per response.** Nothing a generator could read, and
  nothing the recorder could check.
- **Not declaring the headers on `500`, and exempting `500` from the reverse check.** The
  document would omit headers a handler's `500` does carry. Declaring them without `required` is
  what OpenAPI provides for "may be present".
- **Leaving every declared header optional, as the document does today, and keeping the
  recorder's stricter reading.** The `500` case cannot be expressed, and a generator would type
  `www-authenticate` and `retry-after` as optional when they never are.
- **Checking every header a reply carries in reverse.** HTTP's own headers would each need
  declaring, which documents Fastify rather than the engine.

---

## 5. Documentation and backlog

The slice's last task:

- `docs/conventions.md`, "Documentation is generated, never written twice": headers declared
  with `required`, the limiter's three on every counted reply, and that the recorder now checks
  headers in both directions — replacing "A header the reply carries and the route does not
  declare is not checked."
- `docs/architecture.md`: the paragraph on the document stands; checked against the result.
- `README.md`: unchanged — nothing about running or deploying changes.
- `docs/backlog.md`: the entry is deleted in the commit that fixes it.

Left in the backlog knowingly:

- _The error catalogue lets a duplicate code overwrite the class's entry_ touches
  `catalogue()` in the same file. The limiter's headers come from §2.1's rule, not from a
  catalogue entry's `headers`, so this slice does not trigger it.
- _Requests the limiter never sees_: if it is fixed by counting before authentication, §2.1's
  table changes, and the recorder fails the `401`s that newly carry the headers until it does.

### Unproven by design

- A `500` from a handler is drawn by no test — the suite's `500`s come from a failing key
  lookup. That a handler's `500` carries the headers is read from the plugin's hook order, not
  observed.
