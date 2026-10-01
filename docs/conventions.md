# Engine-wide conventions

The rules that hold across every slice of the engine, in one place. Each entry names the spec
that introduced it: this document is the current truth, the specs remain the record of why a
decision was made.

Other documents link here instead of restating these rules. If you find a rule spelled out
twice, the copy is the one to delete.

Rules that hold across projects — the error shape, the four-file module layout, tests first,
datasets over test bodies, commit messages — live in the shared `dev-kit` package and are
imported by [CLAUDE.md](../CLAUDE.md). This document holds what only the engine knows, and
where a section below builds on a shared rule it says which.

- System design: [architecture.md](architecture.md)
- Behaviour, case by case: [test-cases.md](test-cases.md)
- Why a decision went the way it did: [superpowers/specs/](superpowers/specs/) — decision records, not current truth
- How a slice was built: [superpowers/plans/archive/](superpowers/plans/archive/) — spent scaffolding, outside the reading path

---

## Vocabulary

| Term                   | Meaning                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| **Resource**           | An abstract bookable unit. The engine knows only its scheduling parameters, never what it is       |
| **Window**             | A stretch of a single date during which a resource is available, from the schedule or an exception |
| **Slot**               | One bookable quantum, produced by slicing a window by `slot_duration`                              |
| **Anchor**             | `slot_anchor_time` — where a day-based resource's day begins                                       |
| **Intraday resource**  | Slot shorter than a day; schedule rules carry both times                                           |
| **Day-based resource** | Slot measured in calendar days; schedule rules carry null times                                    |

---

## Time and date representation

_Introduced by spec 1._

| Kind        | Format                                               | Example                     |
| ----------- | ---------------------------------------------------- | --------------------------- |
| Date        | `YYYY-MM-DD`, interpreted in the resource's timezone | `2026-07-20`                |
| Time of day | `HH:MM`, 24-hour                                     | `14:00`                     |
| Timestamp   | ISO-8601 **with offset**                             | `2026-07-20T09:00:00+02:00` |
| Duration    | Restricted ISO-8601, see below                       | `PT30M`, `P1D`              |

**Timestamps always carry an offset.** Without one a client cannot recover the instant
unambiguously, and during a fall-back transition the same local time occurs twice. A resource
in UTC renders as `Z`, not `+00:00`.

**Date ranges are half-open** — `from` inclusive, `to` exclusive. A range wider than
`MAX_RANGE_DAYS` (default 366) or with `to <= from` is rejected with `invalid_range`.

### Duration grammar

Either `P<n>D`, or `PT[<n>H][<n>M]` with at least one non-zero component and a total below
24 hours.

Accepted: `PT1M`, `PT30M`, `PT1H`, `PT1H30M`, `PT23H59M`, `P1D`, `P7D`, `P366D`
Rejected: `PT24H`, `PT0M`, `P0D`, `P367D`, `P1M`, `P1Y`, `P1W`, `P1DT2H`, `PT1S`

**`P1D` and `PT24H` are not interchangeable, and the written form is load-bearing.** `P1D`
means "from anchor to anchor", which is 23, 24 or 25 real hours depending on daylight saving;
`PT24H` would mean exactly 24 elapsed hours. Treating them as equal breaks day-based resources
twice a year, so the `PT` form is capped below 24 hours and never produces a day-based
resource.

Durations are **canonicalised on input**: `PT0H30M` is stored and reported as `PT30M`.
Postgres normalizes intervals on storage regardless, so canonicalising first is what keeps a
resource's reported duration identical to the one that was submitted.

### Timezones

`timezone` must be a **named** IANA zone — `Europe/Warsaw`, `UTC`, `CET`. A fixed offset such
as `+02:00`, `-05:00` or `+0200` is rejected, even though `Intl` and Luxon accept it as a
zone: an offset carries no daylight-saving rules, so a Warsaw resource stored that way would
be an hour off for half the year.

### Local time versus absolute time

Two kinds of time live in this system, and conflating them is the classic source of scheduling
bugs.

**Absolute instants** — booking start and end — use `timestamptz`. Despite the name, Postgres
stores no zone in that type: it normalizes to UTC and keeps a point on the timeline, applying
a zone only on input and output. Bookings are therefore already in UTC.

**Local wall-clock statements** — schedule times, exception dates — use `time` and `date`,
deliberately without a zone. "This doctor works 09:00–17:00" is a claim about a clock face,
not an instant. In `Europe/Warsaw`, 09:00 local is 08:00 UTC in winter and 07:00 UTC in
summer; storing 08:00 UTC would silently move the working day to 10:00 local from the last
Sunday in March.

This is why `timezone` is immutable after a resource is created. The obstacle is not data
migration but reinterpretation: no row would move, yet `09:00–17:00` would come to denote a
different set of instants.

### Day of week

**Monday = 0 … Sunday = 6.**

Three other conventions disagree, and all three are one import away:

| Source                  | Monday | Sunday |
| ----------------------- | ------ | ------ |
| This engine             | 0      | 6      |
| Luxon `weekday`         | 1      | 7      |
| Postgres `EXTRACT(DOW)` | 1      | 0      |
| JavaScript `getDay()`   | 1      | 0      |

Exactly one place — `src/shared/time.ts` — may convert between them, and its test asserts all
seven days explicitly. Without that discipline the resulting bug surfaces only on Sundays.

---

## API conventions

_Introduced by spec 1._

Every error response has the same shape:

```json
{ "error": "schedule_overlap", "message": "…", "details": {} }
```

The shape, `additionalProperties: false` on every body and the translation of framework 4xx
into this shape are the shared `http.md` rule. The table below is every code the engine can
emit at a fixed status — `documented-tables.test.ts` asserts it against the code, and consumers
read it as the contract. `bad_request`, which has no fixed status, is explained in prose further
down.

The shared rule also lists one code the engine never emits. Where the two disagree, this
engine answers as follows, and the same test keeps this table equal to the set of shared codes
the engine does not emit:

| Shared code | Shared status | This engine                  | Why                                                                                                                                                                                         |
| ----------- | ------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `conflict`  | 409           | `concurrent_update`, **503** | Contention rolled the transaction back before the engine reached a decision; a 409 would claim the slots are contested. A 503 with `Retry-After` leaves resending to the caller — see below |

| Code                           | Status | Meaning                                                                                 |
| ------------------------------ | ------ | --------------------------------------------------------------------------------------- |
| `validation_error`             | 400    | Body, query or path failed validation                                                   |
| `invalid_range`                | 400    | `to <= from`, or wider than `MAX_RANGE_DAYS`                                            |
| `schedule_overlap`             | 400    | Two rules on one weekday overlap                                                        |
| `schedule_shape_mismatch`      | 400    | Rule shape does not match the slot duration                                             |
| `unsupported_concurrency_mode` | 400    | A booking reached the write path carrying `pool`; selection should have chosen a member |
| `invalid_pool_membership`      | 400    | `pool_id` names a non-pool, a pool, or a resource on a different grid                   |
| `invalid_interval`             | 400    | `end_time <= start_time`                                                                |
| `invalid_slot_boundary`        | 400    | Start or end does not fall on a slot boundary                                           |
| `outside_schedule`             | 400    | A slot in the requested run is not offered                                              |
| `unauthorized`                 | 401    | Missing, malformed, unknown or revoked key; inactive tenant                             |
| `forbidden_scope`              | 403    | Valid key, but it does not hold the scope the route requires                            |
| `forbidden_origin`             | 403    | A console write whose `Origin` is not the console itself                                |
| `not_found`                    | 404    | No such resource or booking, or no such route                                           |
| `method_not_allowed`           | 405    | The framework matched the path but not the method                                       |
| `not_acceptable`               | 406    | The framework could not satisfy the `Accept` header                                     |
| `slot_unavailable`             | 409    | The slots exist and are offered, but capacity is taken                                  |
| `resource_inactive`            | 409    | The resource exists but `is_active` is false                                            |
| `invalid_state_transition`     | 409    | The requested transition is not legal from the current status                           |
| `resource_has_bookings`        | 409    | `DELETE /resources/:id` with bookings on record                                         |
| `pool_has_members`             | 409    | `DELETE /resources/:id` on a pool whose members have not left                           |
| `idempotency_key_reused`       | 409    | Same key, different request body                                                        |
| `hold_expired`                 | 410    | `confirm` on a hold whose `held_until` has passed                                       |
| `payload_too_large`            | 413    | Body beyond Fastify's body limit                                                        |
| `unsupported_media_type`       | 415    | Body sent with a content type the route cannot parse                                    |
| `rate_limited`                 | 429    | The per-key limit for this minute is used up                                            |
| `internal_error`               | 500    | Anything unexpected                                                                     |
| `concurrent_update`            | 503    | Contention rolled the transaction back; retry the request                               |

`slot_unavailable` and `outside_schedule` mean different things and must not be conflated: the
first says the slots are offered but taken, the second that they were never offered.

Every authentication failure answers the same `unauthorized` with the same message, whatever
went wrong. Distinguishing "no such key" from "wrong secret" would turn key-prefix enumeration
into a usable probe. `forbidden_scope` is different: it names the scope it wanted in `details`,
which leaks nothing — the caller already knows which route it called — and turns a
misconfigured key from a guessing game into a one-line fix.

### Authentication and scopes

_Introduced by spec 4._

Every route except `GET /health`, `GET /` and the `/docs` tree requires
`Authorization: Bearer bk_live_...`. A key belongs to one tenant and sees only that tenant's
rows; another tenant's id answers `404`, never `403`, so the response cannot be used to learn
that an id exists.

A key holds a **set** of scopes, and each route requires exactly one of them by membership.
Nothing implies anything else:

| Scope               | Routes                                                    |
| ------------------- | --------------------------------------------------------- |
| `resources.read`    | `GET /resources`, `GET /resources/:id`                    |
| `resources.write`   | `POST` / `PATCH` / `DELETE /resources`                    |
| `schedule.read`     | `GET .../schedule`, `GET .../exceptions`                  |
| `schedule.write`    | `PUT .../schedule`, `PUT` / `DELETE .../exceptions/:date` |
| `availability.read` | `GET .../availability`                                    |
| `bookings.read`     | `GET /bookings/:id`                                       |
| `bookings.write`    | `POST .../bookings`, every `POST /bookings/:id/...`       |
| `bookings.list`     | `GET /resources/:id/bookings`, `GET /bookings`            |

`bookings.write` does not confer `bookings.read`, and neither confers `bookings.list`. That is
the point of the model rather than an oversight: a partner channel that may create bookings
must not be able to read the tenant's whole calendar, and nested tiers cannot express it.

Routes declare their requirement as `config: { scope }` beside the schema, or `config:
{ public: true }`. A route that declares neither fails at **startup**, so a route added later
cannot quietly admit any key.

`concurrent_update` is not a third kind of conflict. Postgres reports a deadlock as SQLSTATE
`40P01` and a serialization failure as `40001`; both mean the transaction was rolled back
through no fault of the request, so the answer is `503` with a `Retry-After` header rather than
a `409`, which would claim the slots are contested when the engine never reached a decision.
The engine translates and does not retry: retry machinery was deliberately rejected, so the
decision to send the request again stays with the caller.

Framework-level 4xx are translated into this shape too — a caller's mistake must never
surface as `internal_error`. Four of the rows above exist only for that translation and are
never thrown by a handler: `method_not_allowed`, `not_acceptable`, `payload_too_large` and
`unsupported_media_type`. A framework 400 reuses `validation_error` and a framework 404 reuses
`not_found`; any other 4xx becomes `bad_request`, which is the one code with no fixed status of
its own. Unexpected exceptions are logged with a stack trace and returned bare: database
structure never reaches the client through error text.

Unknown fields in a request body are **rejected**, not ignored. An attempt to patch an
immutable field therefore fails loudly instead of appearing to succeed.

Responses are serialized against a declared schema, so a field outside the contract cannot
physically reach the client. This mechanically enforces the engine's first design principle.

### Documentation is generated, never written twice

The OpenAPI document at `/docs/json` is produced from the same TypeBox schemas the routes
validate against, and the Swagger UI at `/docs` renders it. There is no second description of
the API to keep in step — a schema change is a documentation change.

Descriptions are built by one function, `md()` in `src/shared/docs.ts`, because Markdown
spacing has two rules that pull in opposite directions and are easy to get backwards:
paragraphs need a blank line between them, or they collapse into a single very long line;
list items need a bare newline between them, or the list renders with a paragraph around every
item. Pass a string for a paragraph and an array for a list, and both come out right. Tests
assert the output directly and again on the generated document.

Every route therefore carries `tags`, `summary` and a `response` map in its schema; a test
asserts this for all of them, and fails if a route is added without them or documented
without existing.

The document is also committed, as `openapi.json` at the repository root, and written only by
`./run openapi`. A consumer generating its types then needs no running engine, and a contract
change is visible in the diff of the pull request that makes it rather than in a consumer's
build days later. `tests/integration/openapi.test.ts` asserts the file equals the live
document, both as a contract and byte for byte, which is what makes regenerating it a step of
changing a schema rather than an optional courtesy.

The generator reads an **empty environment** rather than the ambient one. Two fields of the
document are configured — the server URL carries `PORT`, and the range rule in the description
carries `MAX_RANGE_DAYS` — so a developer with `PORT=3100` in their `.env` would otherwise
produce a diff that says nothing about the API. It takes those defaults from `loadAppConfig`
instead of restating them, so a changed default reaches the file without anyone remembering it
should. `openapi.json` is in `.prettierignore`: Prettier packs short arrays onto one line,
which would fight the generator and make every regeneration a diff.

It also needs **no database**, which is why `AppConfig` exists: `buildApp` never connects — an
entrypoint creates the handle and passes it in — so the connection string is not part of what
the app reads, and `loadAppConfig` is the half of the loader that has defaults for everything.
The route plugins are handed a database their repositories only store, because generating the
document calls no handler and so builds no query.

### The tables that cannot be generated are asserted instead

Four tables restate something the code already states exactly once, and cannot be generated
away without losing the prose they sit in: the configuration table below, the error table and
the scope table above, and the endpoint table in the README.

`tests/unit/documented-tables.test.ts` reads them out of the Markdown and diffs them against
`loadAppConfig`, the `AppError` subclasses together with `CLIENT_ERROR_CODES`, the scopes the
routes actually require, and `openapi.json`. A variable added without a row, a row whose
default no longer matches, an error code nothing documents, a scope nothing requires, an
endpoint added without a line — each fails the suite instead of waiting to be noticed. Two of
the four had already drifted when the tests were written.

The scope table's **Routes** column is the one part not diffed: it is prose, because spelling
all twenty routes out would make it unreadable for the person it is written for. That each
route requires the scope it claims is asserted separately, against the running engine, by the
scope dataset in `auth.test.ts`.

That is the rule at the top of this document made mechanical: if something is spelled out
twice, delete the copy, and where the copy has to stay, make it checkable. Prose that can be
neither is proof-read by hand, which is to say not at all.

---

## Configuration

Environment variables, read and validated once in `src/config.ts`. A malformed value fails
fast at startup rather than surfacing later as an unexplained 500.

| Variable                      | Default    | Meaning                                                                                                                              |
| ----------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`                | _required_ | Postgres connection string                                                                                                           |
| `PORT`                        | `3000`     | HTTP port                                                                                                                            |
| `LOG_LEVEL`                   | `info`     | Fastify/Pino log level                                                                                                               |
| `MAX_RANGE_DAYS`              | `366`      | Widest `from`/`to` window accepted anywhere in the engine                                                                            |
| `DEFAULT_HOLD_MINUTES`        | `10`       | Applied when `hold: true` carries no minutes                                                                                         |
| `MAX_HOLD_MINUTES`            | `60`       | Upper bound accepted from a caller for `hold_minutes`                                                                                |
| `HOLD_SWEEP_INTERVAL_SECONDS` | `60`       | How often the hold sweep runs, in either entrypoint                                                                                  |
| `HOLD_SWEEP_ENABLED`          | `true`     | Whether the API process sweeps on a timer; `worker.js` sweeps regardless — see [the sweep topologies](../README.md#background-sweep) |
| `CONSOLE_PORT`                | `3001`     | Port for the key console. There is deliberately no `CONSOLE_HOST` — the bind address is hard-coded to `127.0.0.1`                    |
| `RATE_LIMIT_PER_MINUTE`       | `600`      | Requests a single key may make per minute before `429 rate_limited`                                                                  |

`HOLD_SWEEP_ENABLED` defaulting to true is load-bearing, not cosmetic: a dead worker service
would otherwise be an invisible failure. See the README for why.

---

## Technology stack

_Chosen in spec 1._

| Concern    | Choice                                                                            |
| ---------- | --------------------------------------------------------------------------------- |
| Runtime    | Node.js 24 LTS — pinned by minor in the image, declared in `.nvmrc` and `engines` |
| Language   | TypeScript, `strict: true`, NodeNext modules                                      |
| HTTP       | Fastify 5 with TypeBox schemas                                                    |
| Database   | PostgreSQL 16                                                                     |
| DB access  | Kysely + `pg` — a typed query builder, not an ORM                                 |
| Date/time  | Luxon                                                                             |
| Tests      | Vitest + Testcontainers                                                           |
| Formatting | Prettier                                                                          |

Rationale for the load-bearing choices — why a query builder rather than an ORM, why response
serialization matters — is in [the spec that made them](superpowers/specs/2026-07-27-resources-schedule-availability-design.md).

---

## Code layout

Modules follow the shared `layout.md` rule: one directory per entity under `src/modules/`,
split into routes, schemas, service and repository where each is needed. Here `availability`
computes rather than stores and has no repository, and `health` is routes alone.
`slot-generator.ts`, `occupancy.ts` and `booking-validator.ts` are each a pure function pulled
out of a service for the reasons below.

Cross-cutting helpers live in `src/shared/`, database wiring in `src/db/`. Entrypoints sit at
`src/`: `server.ts` for the API, `console.ts` for the key console, `worker.ts` for the sweep.

**One structural rule is absolute:** `src/modules/availability/slot-generator.ts` must not
import anything from `src/db/`. It takes windows, a timezone, a duration and an anchor, and
returns slots. All DST-sensitive arithmetic — the part where bugs actually live — stays a pure
function testable without Postgres. A `grep` for `db/` in that file must come back empty.

**Where a resource has a parent, the parent is locked before the member.** Spec 2 has nothing
to apply this to; it is written down now so spec 3's pools do not discover it as an
intermittent deadlock.

---

## Concurrency

_Established by spec 2._

**Lock when the invariant spans more than one row, or when a read-then-write has to be
atomic.** A single-row invariant — `exclusive`'s disjointness — is carried by a database
exclusion constraint alone, atomic at READ COMMITTED, and needs no application lock. A count
over a set of rows — `shared`'s capacity — cannot be expressed as a constraint, so the resource
row is locked first with `SELECT id FROM resources WHERE id = $1 FOR UPDATE`, serializing
writes for that resource only.

The same lock is also taken whenever a request carries an idempotency key, in any mode. Without
it, two concurrent replays of one key each race a speculative insertion that can deadlock
against `bookings_no_overlap` (Postgres SQLSTATE `40P01`) — precisely the failure an
idempotency key exists to prevent. Locking the resource first makes the lookup-then-insert pair
atomic instead: the second request finds the first one's committed row rather than racing it.

A same-row read-decide-write sequence needs the same discipline at a different granularity: the
lifecycle transitions (`confirm`, `cancel`, `complete`, `no-show`) read a booking's status,
decide against a transition table, then write the new one, so the **booking** row — not the
resource row — is locked with `FOR UPDATE`. Otherwise two conflicting actions on one booking can
both read the same starting status and the loser's write silently overwrites the winner's
terminal state.

---

## Testing conventions

The shared `testing.md` rule applies: tests first, a real PostgreSQL through Testcontainers,
data in datasets rather than test bodies, facts about the world derived rather than remembered.
What follows is where those live in this repository.

Datasets are typed tables in `tests/fixtures/datasets/`, consumed by a parameterised runner
(`it.each`); shared entities go behind factories in `tests/fixtures/`. The DST transition dates
in `tests/fixtures/data/dst-transitions.json` came from the tz database via Luxon; covering
another zone means adding a row there.

**The same datasets drive two runs.** The `Api` client in `tests/fixtures/api.ts` takes a
transport: `injectTransport` uses Fastify's `app.inject()` for the in-process suite, binding
no socket, and `httpTransport` speaks real HTTP for `./run smoke` against a running engine.
Neither the suite nor the smoke runner contains a case of its own — both read
`tests/fixtures/datasets/`, so a case added or corrected there is picked up by both without
editing either runner.

### Extending the smoke run

`scripts/smoke.ts` knows nothing about any endpoint. It iterates **suites**, each of which
pairs a dataset with the way to execute one of its cases:

```ts
export interface Suite<TCase> {
  name: string
  cases: readonly TCase[]
  describe: (testCase: TCase) => string
  /** null when the case passes, `skip(reason)` when HTTP alone cannot reach it, or a sentence explaining the mismatch */
  run: (context: SuiteContext, testCase: TCase) => Promise<CaseResult>
}
```

`index.ts` lists each suite as `seal(suite)`, which binds every case to its own `describe` and
`run`. That is what lets suites over different case types share one list without `any`; the
runner only ever sees a name and its checks.

Three sizes of change, three amounts of work:

| Change                                       | What to touch                                                                                                               |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| A new case                                   | One row in a dataset. Nothing else — the test suite and the smoke run both pick it up                                       |
| A new kind of check over an existing dataset | A new suite in `tests/fixtures/suites/`, plus one `seal(…)` line in its `index.ts`                                          |
| A whole new area                             | A dataset, a suite, one `seal(…)` line in `index.ts`. The runner does not change — bookings in spec 2 is the worked example |

`SuiteContext` gives a suite the typed `api` client, the raw `send` transport for requests
the client deliberately cannot express, and `newResource`, which records what it creates so
the run cleans up after itself against a development database.

`./run smoke <filter>` runs only the suites whose name contains the filter — useful while
fixing one area. An unmatched filter lists the available suites rather than passing silently.

---

## Deliberate limitations

Recorded so they are not rediscovered as bugs.

| Limitation                                                   | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Cost to lift                                                                             |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| No windows crossing midnight                                 | A window would belong to two dates at once, complicating slicing, weekday resolution and exception replacement                                                                                                                                                                                                                                                                                                                                                                            | Algorithm rewrite; at the database level only a CHECK is dropped, with no data migration |
| No schedule history                                          | Audit trails belong above the engine                                                                                                                                                                                                                                                                                                                                                                                                                                                      | New table, if ever needed                                                                |
| Slot grid anchored per window, not globally                  | Two windows on a day each start their own grid, so 09:00–12:00 and 12:30–17:00 are offset by 30 minutes. The alternative silently drops the first half hour of the second window                                                                                                                                                                                                                                                                                                          | Intentional; not planned to change                                                       |
| The console has no authentication of its own                 | Spec 4 authenticated the data plane with API keys; the console that issues them did not follow, because it binds to `127.0.0.1` and reaching that port already means holding the machine. The bind address is hard-coded rather than configurable, which makes that structural instead of a promise                                                                                                                                                                                       | A session or an operator identity, once the console is not the operator's own machine    |
| Bookings in the past are accepted                            | Nothing on the booking path reads the clock — only hold expiry does — so availability offers past slots, and "anything offered is bookable" follows. Back-dated entry is legitimate                                                                                                                                                                                                                                                                                                       | A validation rule, if a domain ever wants it                                             |
| A schedule edit may leave bookings off the new grid          | Refusing it would freeze a schedule around a single distant booking, and the remedy is a business decision. Such a booking is not loose: occupancy is counted as overlap per slot, so it still occupies every slot of the new grid it touches. The resource can therefore look fuller than the domain intends, never emptier                                                                                                                                                              | A conflict query on `PUT`, and a policy to apply                                         |
| `shared` serializes writes per resource                      | One row lock is the whole mechanism; bookings for one resource on unrelated dates still queue behind each other                                                                                                                                                                                                                                                                                                                                                                           | SERIALIZABLE plus a retry loop; schema unchanged                                         |
| No pagination on listings                                    | Both booking listings are bounded by a required window of at most `MAX_RANGE_DAYS`, as everywhere else in the engine. `GET /resources` is the exception: it has no window to bound it and returns every resource the tenant owns                                                                                                                                                                                                                                                          | Keyset pagination on `(start_time, id)`; for resources, on `(created_at, id)`            |
| No automatic completion                                      | An automatic transition at `end_time` would make `no_show` unreachable                                                                                                                                                                                                                                                                                                                                                                                                                    | Not planned; the distinction is the caller's                                             |
| The rate limit is per process, not per cluster               | `@fastify/rate-limit` counts in memory, so `RATE_LIMIT_PER_MINUTE` is what one API process allows a key. Two instances behind a balancer allow twice that. It exists so one tenant cannot exhaust the engine by accident, and for that a per-process bound is enough                                                                                                                                                                                                                      | A shared store — the plugin takes a Redis client                                         |
| Availability does not report how many members are free       | The slot shape is uniform across every resource type, and forking it for one mode is a contract change every consumer pays for. The domain can count members itself                                                                                                                                                                                                                                                                                                                       | A field on the slot, and a decision about the other modes                                |
| A pool cannot mix slicing parameters                         | Every member must share its pool's grid, so meeting rooms at `PT1H` and bedrooms at `P1D` cannot share a pool. Arguably correct — they are not interchangeable                                                                                                                                                                                                                                                                                                                            | A grid per member, and a booking path that tries each                                    |
| A pool member must be `exclusive`                            | Derived capacity is a count of active members, which holds only while each takes one booking at a time. A pool of `shared` members would make it a sum of capacities                                                                                                                                                                                                                                                                                                                      | Sum instead of count, and a second rule for one number                                   |
| Member selection order is not a contract                     | Stable under no contention, but `SKIP LOCKED` means a concurrent request may receive a later member. A caller needing a specific one books it directly                                                                                                                                                                                                                                                                                                                                    | Intentional; not planned to change                                                       |
| No nested pools                                              | Derived capacity would have to become recursive, and nothing asks for it                                                                                                                                                                                                                                                                                                                                                                                                                  | A recursive count, and a cycle check                                                     |
| A pool's idempotency key stops matching if its member leaves | The replay lookup finds the original booking by joining through `resources.pool_id`, because the key spans the pool while the unique index spans `(resource_id, idempotency_key)`. Move that member out of the pool and the join no longer reaches the booking, so a replay creates a second one. Widening the lookup to any booking carrying the key in this tenant would break spec 2's per-resource key scope, and denormalising `pool_id` onto `bookings` was rejected in spec 3 §5.3 | A `pool_id` column on `bookings`, and a second copy of the relationship to keep true     |
