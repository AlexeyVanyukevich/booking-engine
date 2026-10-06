# `openapi.json` declares every status a route can answer

**Status:** under review · **Date:** 2026-10-06

**This is a decision record, not current truth.** It states what was decided on the date above and is not revised as the system changes. For what the engine does today, read [architecture.md](../../architecture.md) and [conventions.md](../../conventions.md) — where they disagree with this document, they are right.

---

## 1. Purpose

Fixes the backlog entry _`openapi.json` documents no `401`, `403` or `429` on any route_, and
with it _The `x-ratelimit-*` headers on a `429` are not asserted_.

The README says `openapi.json` lists "every path, field and status code". It lists only what
each route declares by hand in its `response` map, and nothing checks those maps against what
the route answers. A consumer generating a client from the document gets no type for `401`,
`403`, `413`, `415`, `429` or `500`, and no hint that `429` exists to be retried. The gap is
wider than the entry says: a malformed path parameter answers `400 validation_error` on nine
routes that declare no `400` — `GET` and `DELETE /resources/{id}`, `GET .../schedule`,
`DELETE .../exceptions/{date}`, `GET /bookings/{id}`, and `confirm`, `cancel`, `complete` and
`no-show`.

The error responses that are declared say little: every one is described as "Default
Response" and carries the same `schedule_overlap` example, whatever the status.

### Success

- Every status a route can answer is in the document, and the README's claim is true as
  written.
- Each error status lists, as an `enum` on `error`, exactly the codes that route can send
  under it, with a description of each and an example keyed by code.
- Headers a status carries are documented: `WWW-Authenticate` on `401`; `Retry-After` and
  `x-ratelimit-limit`, `-remaining` and `-reset` on `429`; `Retry-After` on `503`.
- A test fails when any integration test draws a status, code or missing header its route does
  not declare; and a second fails when a status shared by many routes is declared where it
  cannot happen, or missing where it can.

---

## 2. Design

### 2.1 Statuses shared by many routes come from one rule table

`src/shared/responses.ts` holds a table of rules, one per shared status. An `onRoute` hook,
registered in `buildApp` before `@fastify/swagger`, merges the rules that apply into each
route's real `response` schema — so error replies are serialized against the declared shape,
as success replies already are, and the document is generated from that same schema.

| Status | Code                     | Headers                                                                          | Applies when                                                                |
| ------ | ------------------------ | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `400`  | `validation_error`       |                                                                                  | the route has a params, querystring or body schema                          |
| `401`  | `unauthorized`           | `WWW-Authenticate`                                                               | the route is not `public`                                                   |
| `403`  | `forbidden_scope`        |                                                                                  | the route is not `public`                                                   |
| `413`  | `payload_too_large`      |                                                                                  | the method is in Fastify's `bodywith` set: `POST`, `PUT`, `PATCH`, `DELETE` |
| `415`  | `unsupported_media_type` |                                                                                  | as `413`                                                                    |
| `429`  | `rate_limited`           | `Retry-After`, `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset` | every route, `/health` included                                             |
| `500`  | `internal_error`         |                                                                                  | every route                                                                 |

The `413`/`415` condition was read from Fastify 5.10's `bodywith` set, not assumed; Fastify
parses a `DELETE` body, so a `DELETE` can answer both.

Not in the table, on purpose: `405 method_not_allowed` and `404` for an unmatched path are
answered when no route matched, so they belong to no operation. `406 not_acceptable` is a
translation the handler keeps for the framework, and no route produces it today.
`forbidden_origin` is the console's, which the document does not describe.

The hook skips the routes `registerAuth` skips — the `/docs` tree — and routes whose schema
is `hide: true`.

### 2.2 Statuses particular to a route come from the error classes

A route lists the `AppError` subclasses it can throw:

```ts
response: {
  201: BookingResponse,
  200: BookingResponse,
  ...errorResponses(NotFoundError, SlotUnavailableError, ResourceInactiveError, IdempotencyKeyReusedError, ConcurrentUpdateError),
}
```

`errorResponses` groups the classes by their `statusCode`, so no status is written beside the
class that already states it. Where a rule from §2.1 also yields a status — `400` mostly — the
hook merges the two code lists into one response.

Each `AppError` subclass gains two abstract instance fields, beside `code` and `statusCode`,
so the compiler refuses a class without them:

- `meaning` — one line, Markdown allowed, e.g. "The slots exist and are offered, but capacity
  is taken"
- `example` — `{ message, details? }`, the illustration shown in the document

`errorResponses` reads them by instantiating each class with a probe message, as
`documented-tables.test.ts` already does to read `code` and `statusCode`. A class's declared
headers come from the `headers` field `AppError` already has — `www-authenticate` on
`UnauthorizedError`, `retry-after` on `ConcurrentUpdateError` — so they too are stated once.
The `x-ratelimit-*` headers and the `429`'s `retry-after` are set by the rate-limit plugin, not
by `RateLimitedError`, so the `429` rule names them. The framework codes
and `internal_error`, which have no class, get the same two fields in the table that replaces
`CLIENT_ERROR_CODES`' bare values: `{ code, meaning, example }` per status. The handler's
lookup changes to read `.code`; nothing else about the translation changes.

### 2.3 What one error response contains

The `ErrorResponse` schema in `src/modules/resources/resource.schemas.ts`, which every route
shares today, is replaced by one built per status and route:

- `error` is `{ type: 'string', enum: [...] }` with exactly that response's codes. **`enum`, not
  a union of literals:** `fast-json-stringify` ignores `enum`, but it validates an `anyOf` of
  `const`s and throws when the value matches none — a code missing from a declaration would
  then turn a correct `409` into a `500` in production. Verified against the installed
  serializer on 2026-10-06.
- The description lists every code with its `meaning`, built by `md()`.
- Examples are keyed by code through `@fastify/swagger`'s `x-examples`, so Swagger UI's picker
  reads `slot_unavailable` rather than `example1`.
- Headers are declared through the response schema's `headers`, which `@fastify/swagger` 9.8
  turns into OpenAPI response headers.

For `POST /resources/{id}/bookings`, the `409` becomes:

```json
"409": {
  "description": "One of:\n\n- `slot_unavailable` — the slots exist and are offered, but capacity is taken\n- `resource_inactive` — the resource exists but `is_active` is false\n- `idempotency_key_reused` — same key, different request body",
  "content": {
    "application/json": {
      "schema": {
        "type": "object",
        "required": ["error", "message"],
        "properties": {
          "error": { "type": "string", "enum": ["slot_unavailable", "resource_inactive", "idempotency_key_reused"] },
          "message": { "type": "string" },
          "details": {}
        }
      },
      "examples": {
        "slot_unavailable": { "value": { "error": "slot_unavailable", "message": "Those slots are offered, but they are already taken", "details": { "start_time": "2026-07-20T09:00:00+02:00", "end_time": "2026-07-20T10:00:00+02:00" } } },
        "resource_inactive": { "value": { "error": "resource_inactive", "message": "…" } },
        "idempotency_key_reused": { "value": { "error": "idempotency_key_reused", "message": "That idempotency key was used for a different booking; this is a caller error, not a retry" } }
      }
    }
  }
}
```

(Descriptions of `error`, `message` and `details` are kept as today; elided here.)

**Two changes a consumer will see.** `error` narrows from `string` to an `enum` per response,
so a regenerated client's types change. And an example's message is written once on the class:
where a class is thrown with several messages — `slot_unavailable` has three — the example
shows one. The description already says the message may change; examples are not checked
against throw sites.

### 2.4 The error table's Meaning column is asserted, not written twice

The meaning of each code lives today only in the Meaning column of the error table in
`docs/conventions.md`. It moves onto the class, and `documented-tables.test.ts` asserts each
row's Meaning cell equals the `meaning` of that code. The document and the table then read one
source.

---

## 3. How it is proven

### 3.1 A recorder over the whole integration suite

`buildTestApp` in `tests/integration/helpers.ts` attaches an `onSend` hook — in the tests only;
production code is not touched. Every integration file builds its app through it, none
registers routes of its own, and the shared fixture suites drive that same app through
`app.inject`, so every request in the suite passes through the hook.

For each reply it compares against `request.routeOptions.schema.response` — the object the
document is generated from, so it cannot disagree with `openapi.json` — and records a mismatch
when:

- the status is not declared;
- the status is an error and its `error` code is not in that response's `enum`;
- a header that response declares is absent from the reply.

It skips what is no operation in the document: the not-found handler
(`routeOptions.url` undefined), the `/docs` tree, and hidden routes.

A new `tests/integration/contract.setup.ts`, listed in Vitest's `setupFiles`, registers an
`afterEach` that asserts the mismatch list is empty and clears it. Each test file runs in its
own module context, so the list is per file and nothing crosses Vitest's worker boundary; the
failure is reported against the test that drew the response:

```
POST /resources/:id/bookings answered 409 resource_inactive; declares 409 as [slot_unavailable, idempotency_key_reused]
```

The first run will fail wherever the suite already draws an undeclared status. Correcting those
declarations is part of this slice, not a follow-up.

### 3.2 A dataset proving the shared rules in both directions

The recorder sees only what tests happen to send, and no test sends `413` to every route. So
`tests/fixtures/datasets/shared-responses.ts` holds one row per rule of §2.1, naming how to
trigger it, the app configuration it needs, and the code and headers it must produce:

| Status | Trigger                                                                                | Needs                                          |
| ------ | -------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `400`  | an invalid value for the first part the route validates: params, then body, then query | a valid key holding the route's scope          |
| `401`  | no `Authorization` header                                                              | —                                              |
| `403`  | a key holding every scope but the one the route requires, derived from `SCOPES`        | —                                              |
| `413`  | a JSON body one byte over `app.initialConfig.bodyLimit`                                | a valid key                                    |
| `415`  | a `text/plain` body                                                                    | a valid key                                    |
| `429`  | the same request twice                                                                 | `rateLimitPerMinute: 1`; a valid key           |
| `500`  | any request                                                                            | an app on a database whose every query rejects |

The "Needs" column follows from the hook order: authentication runs first, then the limiter,
body parsing and validation. Without a valid key every trigger after `401` would answer `401`
— and a rejected key is never counted by the limiter, the open backlog entry on requests the
limiter never sees.

The runner takes the routes from `app.routeAuthorizations`, minus `HEAD` and hidden routes, and
crosses them with every row — about 21 × 7 named cases, such as
`POST /resources/:id/bookings answers 415 unsupported_media_type`. Where the rule applies, the
route must answer that status with that code and the declared headers, and the document must
declare it. Where it does not, the document must not declare it and the trigger must not
produce it: a `GET` with an oversized body is not `413`, `/health` without a key is not `401`.

**One named exception.** `/health` gets `500` by the rule — "anything unexpected" holds on
every route — but runs no query, so nothing can make it fail. Its `500` stays declared, and the
dataset carries a named row excluding it from the trigger, with that reason.

A route whose `400` cannot be reached by a generic invalid value gets a named override row in
the dataset. The rule is not relaxed to fit it.

### 3.3 Unit tests

No database:

- the rule table: route shapes as a dataset — public or not, which schema parts, which method —
  each with the statuses it must yield;
- `errorResponses`: grouping by status, merging with the shared rules, the `enum`, examples
  keyed by code, the description list;
- `documented-tables.test.ts`: the Meaning column against `meaning`, per §2.4.

All written before the implementation, and failing on `main`.

---

## 4. Rejected

- **The shared statuses alone, without the recorder.** It fixes the entry, but a
  route-specific status added without its declaration would go unseen, as the missing `400`s
  did.
- **Schemathesis**, run against the document from a Python container in `./run check`. It
  would find inputs that crash a handler, which nothing here does, but it cannot reach `429`,
  `413` or the state-dependent `409`/`410`, and it adds a container, a seeded key and data, and
  minutes per run with inputs that change between runs. A candidate for a later slice.
- **`@fastify/swagger`'s `transform` to add the statuses to the document only.** The
  declaration and the serializer would then read different schemas, which is the kind of
  second description this repository avoids.
- **A union of literals for `error`.** See §2.3.
- **A per-run aggregate in global teardown.** Needed only to check the other direction for
  route-specific codes; §5 records it instead.

---

## 5. Documentation and backlog

The slice's last task:

- `docs/conventions.md`, "Documentation is generated, never written twice": the rule table, the
  recorder, and that statuses are now checked; the error table's Meaning column is asserted.
- `docs/architecture.md`: the paragraph on the document says statuses are checked as well as
  generated.
- `README.md`: the `openapi.json` row's claim stands as written, now true.
- `docs/backlog.md`: both entries this slice fixes are deleted in the commits that fix them.
  One new entry: a route-specific code declared but drawn by no test is not detected, because
  each file sees only its own replies.

### Unproven by design

- The UI suite (`tests/ui/`) and `./run smoke` against a live engine are not recorded; they
  build or reach the app another way. The integration suite covers the same routes.
- An example's message is illustration and is not compared with the messages the code throws.
