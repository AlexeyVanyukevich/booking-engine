# Failed authentication and unmatched paths are counted

**Status:** implemented · **Date:** 2026-10-11

**This is a decision record, not current truth.** It states what was decided on the date above and is not revised as the system changes. For what the engine does today, read [architecture.md](../../architecture.md) and [conventions.md](../../conventions.md) — where they disagree with this document, they are right.

---

## 1. Purpose

Fixes the backlog entry _Requests the limiter never sees: rejected keys and unmatched paths_.

`@fastify/rate-limit` 11.2 attaches its hook to each route, and authentication is an
application-level `onRequest` hook, which Fastify runs first. Two kinds of request therefore
go uncounted:

- **A rejected credential.** It is answered `401` before the limiter runs. A well-formed key
  costs a SHA-256 and one indexed lookup in `api_keys` (`TenantService.authenticate`), so a
  caller holding nothing can make the engine query its database once per request, without
  limit. `tests/fixtures/datasets/rate-limit.ts` pins this today: three malformed requests
  under a limit of one all answer `401`.
- **An unmatched path.** It has no route, so no route hook. A valid key can draw `404`s
  without limit. The plugin's README says the not-found handler must opt in.

The secrets are long enough that guessing one stays infeasible. The cost is load, not access.

### Success

- An address that fails authentication `AUTH_FAILURES_PER_MINUTE` times in a minute is
  answered `429 rate_limited`, with `Retry-After`, before any key lookup, until the minute
  resets.
- A valid key's `404` on an unmatched path is counted against that key like any other
  request, and carries the three `x-ratelimit-*` headers.
- Behind a reverse proxy, the address counted is the client's, once the operator names the
  proxy in `TRUST_PROXY`.
- No caller can add to another address's failure count.

### Out of scope, left in the backlog knowingly

- _The rate limit is counted per process_. The failure count uses the plugin's own store, so
  whichever store that slice chooses covers both counts.
- _The rate-limit refusal ignores the plugin's `ban` context_. `ban` stays unset.
- _A malformed URL is answered by Fastify directly_. That is `frameworkErrors`, a different
  path through Fastify.

## 2. Behaviour

### 2.1 Failed authentication is counted per address

A new setting, `AUTH_FAILURES_PER_MINUTE`, default `30`, bounds how many key lookups one
address can cause per minute. Every `401` counts — no header, malformed, unknown key, wrong
secret, revoked, inactive tenant. Only some of them cost a lookup, but every authentication
failure answers identically, and one rule for all of them keeps the hook one branch.

In the authentication hook, wherever it demands a key today — every route that is not public
or under `/docs`, and every unmatched path:

1. Read the address's failure count without incrementing it.
2. If nothing remains, answer `429 rate_limited` with `Retry-After`, before parsing the key or
   touching the database.
3. Otherwise authenticate as today. On failure, increment the count, then answer `401` as
   today.

Once an address is refused, a valid key sent from it is refused too: knowing the key is valid
would take the lookup the refusal exists to save. A consumer's own valid traffic never counts
against it; only failures do.

A caller with no key aimed at an unmatched path is answered `401` today, so it falls under
this rule.

### 2.2 The refusal

The same code as the per-key refusal, `rate_limited`, with `Retry-After`, and its own message:
"Too many failed authentications from this address". A consumer handles both the same way —
wait, then retry.

It carries **no** `x-ratelimit-*` headers. Those describe the per-key budget, and filling them
from the failure count would make `x-ratelimit-limit` mean two different numbers. The `429`
status therefore declares the three headers without `required`, where today they are required.
`401` and `403` still carry none.

### 2.3 Unmatched paths are counted per key

The not-found handler is registered with `preHandler: app.rateLimit()`. Authentication runs
first, so only a valid key reaches it, and its `404`s now spend that key's ordinary budget and
carry the three headers. Unmatched paths are not in `openapi.json`, so nothing there changes.

### 2.4 `TRUST_PROXY`

The engine sets no `trustProxy` today, so `request.ip` is the socket peer. Behind a reverse
proxy every caller shares the proxy's address: one caller sending bad keys would have every
consumer refused for up to a minute. `GET /health`, counted by address when called without a
key, already has this problem.

`TRUST_PROXY` takes a comma-separated list of addresses or CIDRs and passes it to Fastify's
`trustProxy`; `X-Forwarded-For` from those proxies then names the client. Empty — the default —
behaves as today. Each entry is validated at startup: an IPv4 or IPv6 address, optionally with
a `/prefix` within range. A bad entry fails with `Invalid configuration: TRUST_PROXY …`, like
every other setting.

### 2.5 Store keys the caller cannot forge

Both counts share the plugin's store. The per-key limiter is keyed today on the raw
`Authorization` header, which the caller controls. Were the failure count keyed
`auth-failures:1.2.3.4`, a caller could send `GET /health` with
`Authorization: auth-failures:1.2.3.4` and fill another address's failure count, locking it
out. Every store key therefore carries a prefix only the engine writes:

| Count                       | Store key            |
| --------------------------- | -------------------- |
| a request with a credential | `key:<header>`       |
| a request without one       | `address:<ip>`       |
| a failed authentication     | `auth-failures:<ip>` |

## 3. Design

- **`src/config.ts`** — `authFailuresPerMinute` through the existing `positiveInt`, default
  `30`; `trustProxy: string[]` from a small pure parser that splits on commas, trims, and
  validates each entry with `node:net`.
- **`src/shared/rate-limit.ts`**, new — `limiterKey(request)` and `failureKey(request)`,
  producing the keys of §2.5. Pure, and unit-tested.
- **`src/app.ts`** — `Fastify({ trustProxy })`, given the list, or `false` when it is empty.
  The limiter's `keyGenerator` becomes `limiterKey`. `registerErrorHandler` moves after
  `await app.register(fastifyRateLimit)`, because the not-found handler needs the
  `app.rateLimit()` decorator; routes register later and still inherit the error handler.
- **`src/shared/errors.ts`** — `setNotFoundHandler({ preHandler: app.rateLimit() }, …)`.
- **`src/shared/auth.ts`** — `registerAuth` builds the failure count once with
  `app.createRateLimit({ max: authFailuresPerMinute, keyGenerator: failureKey })`. The hook
  reads it with `{ increment: false }`; when `remaining === 0` it sets `retry-after` to
  `ttlInSeconds` and throws `RateLimitedError`. Each `UnauthorizedError` it throws is preceded
  by an increment. The test is `remaining === 0`, not the plugin's `isExceeded`: a read never
  takes the count past `max`, so `isExceeded` would let the thirty-first failure reach the
  database. The plugin's `LocalStore` implements `read`, which `{ increment: false }` requires.
- **`src/shared/responses.ts`** — `LIMITER_REACH` gains `rate_limited: 'either'`, which is
  what declares the `429`'s three headers without `required`.
- **`openapiDocument`** in `src/app.ts` — one sentence: repeated failed authentications from
  one address are refused with `429` and `Retry-After`, without the `x-ratelimit-*` headers.
  `openapi.json` is regenerated.

## 4. Testing

Written before the implementation; cases in datasets.

- **Unit, `tests/unit/config.test.ts`** — `TRUST_PROXY`: empty, one IPv4, IPv4 CIDR, IPv6
  CIDR, a list with spaces; refused: `not-an-ip`, `10.0.0.1/33`, an empty item in `a,,b`.
  `AUTH_FAILURES_PER_MINUTE`: default, a set value, `0`, a non-number.
- **Unit, `tests/unit/rate-limit.test.ts`**, new — the store keys of §2.5: inputs that could
  collide map to distinct keys, with a named case for a header of `auth-failures:1.2.3.4`
  against the failure key of `1.2.3.4`.
- **Integration, `tests/fixtures/datasets/rate-limit.ts`** — a request becomes
  `{ caller, from?, path?, forwardedFor? }` and a scenario may set `authFailures` and
  `trustProxy`; `from` is `inject`'s `remoteAddress`. Rows:
  - `malformed`, `unknown` (a well-formed key never issued) and `anonymous`, three times each
    under a failure limit of 2: `401, 401, 429` — replacing the three rows that pin the gap
  - a valid key from a refused address: `429`; the same key from another address: `200`
  - failures from address A leave address B's count untouched
  - a valid key's `200`s add nothing to its address's failure count
  - `GET /health` with `Authorization: auth-failures:<ip>` past the limit, then a valid key
    from that `ip`: `200`
  - a valid key under a per-key limit of 1, twice to an unmatched path: `404, 429`
  - `TRUST_PROXY` naming the inject address: two `X-Forwarded-For` clients are counted
    apart; without it, the header is ignored and they share one count
- **`countedReplyCases`** — an unmatched-path `404`, counted; a failure `429`, not counted.
  The suite-wide recorder then holds every `429` it sees to the declared-not-required headers.

## 5. Documentation

The slice's last task:

- `docs/conventions.md` — the configuration table's two rows; the `rate_limited` row, now
  either budget; the counted-replies paragraph and `LIMITER_REACH`; a note on running behind a
  proxy.
- `docs/architecture.md` — wherever it states the order of authentication and the limiter.
- `README.md` — configuration, and running behind a proxy.
- `docs/backlog.md` — this entry deleted; a new one for the older gap found while designing
  this: a caller without a key can rotate the `Authorization` header on a public route to get
  a fresh per-header count. Cheap, and bounded by the store's 5 000-entry cache, which is why
  it is not taken here.
- The plan archived.
