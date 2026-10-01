# A used-up rate limit answers `429 rate_limited`

**Status:** implemented · **Date:** 2026-10-01

**This is a decision record, not current truth.** It states what was decided on the date above and is not revised as the system changes. For what the engine does today, read [architecture.md](../../architecture.md) and [conventions.md](../../conventions.md) — where they disagree with this document, they are right.

---

## 1. Purpose

Fixes the backlog entry _A used-up rate limit is answered `500`, not `429 rate_limited`_. A
consuming project's browser journeys, run in two browsers at once, crossed a key's per-minute
limit and got `500 internal_error` where `docs/conventions.md` promises `429 rate_limited`. A
consumer that retries `429`, as the conventions invite, cannot tell that answer from a defect.

### Success

- A request past the per-key limit answers `429` with the uniform error shape,
  `{ "error": "rate_limited", "message": "…" }`, and a `Retry-After` header.
- A refusal is not logged as an unhandled error, which follows from the first: the handler
  logs that only on the branch that answers `500`.
- A test crosses the limit, so the behaviour cannot regress unseen again.

---

## 2. Cause

`@fastify/rate-limit` 11.2 builds a context with `statusCode: 429`, sets `retry-after` and the
`x-ratelimit-*` headers on the reply, and then **throws** whatever `errorResponseBuilder`
returns. The engine's builder in `src/app.ts` returns a plain object, `{ error, message }`,
with no `statusCode`. The error handler in `src/shared/errors.ts` therefore matches none of its
branches — not an `AppError`, no `validation`, no 4xx `statusCode` — and falls through to the
last: log at error level as "unhandled error", answer `500`.

It went unseen because no test ever crosses the limit. `buildTestApp` and the browser suite's
global set-up both raise it to 100 000, and the comment beside the integration value claims the
limiter is asserted in `tests/integration/auth.test.ts`, which never mentions it.

---

## 3. Design

**The refusal becomes an ordinary engine error.** `src/shared/errors.ts` gains

```ts
export class RateLimitedError extends AppError {
  readonly statusCode = 429
  readonly code = 'rate_limited'
}
```

and the builder returns `new RateLimitedError('Too many requests; slow down and retry')`. The
handler's `AppError` branch then sends it exactly as it sends every other engine error, with
no case of its own.

**`RATE_LIMITED_CODE` is removed.** It existed only because the code was built outside the
`AppError` hierarchy. The documented-tables test finds codes by walking the `AppError`
subclasses, so `rate_limited 429` is found the same way as the rest, and the line that added
it by hand goes.

**Headers.** The plugin has already set `retry-after` and `x-ratelimit-limit`,
`-remaining` and `-reset` on the reply when it throws. The tests assert that `retry-after`
reaches the client. If Fastify's error path turns out to drop headers set before the throw,
`RateLimitedError` carries `retry-after` through the `headers` field `AppError` already has,
computed from the plugin's context, as `ConcurrentUpdateError` does.

**Rejected: adding `statusCode: 429` to the plain object.** The handler would then take its
generic 4xx branch, which maps statuses through `CLIENT_ERROR_CODES`. 429 is not in that map,
so the answer would be relabelled `bad_request`. Adding 429 to the map would put a code the
engine chooses among the framework's translations, which it is not.

**Unchanged.** The limit stays per key, counted in memory per process, keyed on the raw
`Authorization` header, and registered before authentication, so it still counts requests
whose key turns out to be invalid. `ban` stays unset, so the plugin's `403` path is never
taken.

_As built:_ the order stated above is wrong, and was wrong before this slice. The plugin
attaches its hook to each route through `onRoute`, and authentication is an application-level
`onRequest` hook, which Fastify runs first. A request whose key is rejected is answered `401`
and never counted. The tests pin that order rather than the one written here, the comment
above the registration in `src/app.ts` that claimed the opposite was corrected, and whether
rejected requests should be counted is left to `docs/backlog.md`. The headers needed no
fallback: Fastify 5.10's error path removes only `content-type` and `content-length`, so the
plugin's `retry-after` reaches the client.

---

## 4. Tests

Written first, and failing on `main`.

`tests/integration/rate-limit.test.ts` builds an app with a small limit. `buildTestApp` takes
an optional configuration override for this; every existing caller keeps the 100 000 default.
Cases live in a dataset, each naming the limit, the requests sent under which keys, and the
expected status per request:

| Case                                      | Expectation                                                    |
| ----------------------------------------- | -------------------------------------------------------------- |
| Requests up to the limit                  | None answers `429`                                             |
| Each request past the limit               | `429`, the uniform shape, `error: rate_limited`, `retry-after` |
| A second key while the first is exhausted | The second key's requests are served                           |

_As built:_ two further rows send a malformed key, and no key at all, past a limit of one;
both answer `401` every time, for the reason the _As built_ note in §3 gives.

There is no case asserting the log. The handler logs "unhandled error" in exactly one branch,
and that branch answers `500`, so a `429` already proves the refusal did not reach it.
Capturing the log would mean giving `buildApp` a logger destination that only a test uses.

The comment in `tests/integration/helpers.ts` is corrected to point at the new file.

---

## 5. Documentation

- `docs/conventions.md`: the `rate_limited` row says the answer carries `Retry-After`.
- `docs/backlog.md`: the entry this slice fixes is deleted in the fix commit.
- `docs/backlog.md`: a new entry records that `openapi.json` documents no `401`, `403` or
  `429` on any route, although the README says it lists every status code. That is a gap in
  how statuses that apply to every route are documented, separate from this defect, and is
  left out of this slice.

The harness entry's statement that the rate limit "has no setting" is wrong —
`RATE_LIMIT_PER_MINUTE` exists and is documented. It is corrected by the slice that takes that
entry, not here.
