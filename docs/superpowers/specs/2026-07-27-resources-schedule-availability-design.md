# Spec 1 — Resources, Schedule, Availability

**Status:** implemented · **Date:** 2026-07-27

**This is a decision record, not current truth.** It states what was decided on the date above and is not revised as the system changes. For what the engine does today, read [architecture.md](../../architecture.md) and [conventions.md](../../conventions.md) — where they disagree with this document, they are right.

---

## 1. Purpose

Build the foundation of the universal booking engine and the entire read side of it: project skeleton, database migrations, the `Resource`, `Schedule` and `ScheduleException` entities, and the availability calculation.

At the end of this spec the service answers the question _"which slots does this resource offer between two dates"_ over HTTP, for both intraday resources (a doctor, a tennis court) and day-based ones (a hotel room). Bookings do not exist yet, so every returned slot is free.

### Why this slice

The architecture document covers a large surface: resources, schedules, exceptions, availability, the full booking lifecycle, hold expiry and three concurrency modes. It is split into three specs:

| Spec             | Content                                                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| **1 (this one)** | Skeleton, migrations, resources, schedule, exceptions, availability                                              |
| 2                | Bookings: `exclusive` and `shared` modes, hold/confirm/cancel/reschedule/complete/no-show, hold expiry, listings |
| 3                | `pool` concurrency mode                                                                                          |

`pool` is deferred because the architecture document does not define how a pool is represented in data (a members table? a parent resource? how does `capacity` relate to the number of members?). That is a design conversation of its own and must not block the rest.

### In scope

- Project skeleton, configuration, logging, error handling
- Database migrations
- CRUD for `Resource`
- Full replacement of a resource's weekly `Schedule`
- Per-date `ScheduleException` management
- Availability calculation, timezone- and DST-correct
- Unit and integration tests

### Out of scope

- Bookings and the `bookings` table — spec 2
- The `pool` concurrency mode — spec 3
- Authentication and authorization — explicitly deferred by the project owner. The design leaves an extension point (see §7.6) but implements no checks.
- Multi-tenancy, rate limiting, caching
- Overnight availability windows (a window crossing midnight, e.g. 22:00–02:00) — see §9
- Pagination on list endpoints: schedules hold at most a few rows per resource, and exception listings are bounded by a 366-day query window

---

## 2. Technology stack

This spec chose the stack the whole engine now uses; the list lives in [conventions.md](../../conventions.md#technology-stack). The three choices that were genuinely contested are recorded here.

### Why Fastify rather than Express

Express is the more familiar of the two, but the engine's contracts are dense with rules — three legal values for `concurrency_mode`, weekdays bounded 0–6, dates in a fixed shape — and Fastify declares them in the route rather than in hand-written middleware. It also gives OpenAPI generation from the same schemas and a single `setErrorHandler` for async routes. The cost is a narrower plugin ecosystem, which this service does not need.

### Why response serialization matters here

Fastify serializes responses against the declared schema, so a field that is not in the contract cannot physically reach the client. This mechanically enforces design principle #1 — the engine never leaks anything domain-shaped, even by accident.

### Why not an ORM

Prisma cannot express range types, generated columns of this kind, or exclusion constraints in its schema language, and offers no explicit row locking — meaning the most safety-critical queries of spec 2 (`SELECT ... FOR UPDATE`, overlap checks) would fall back to untyped raw SQL. Sequelize supports both but its TypeScript story is weak. The engine has four flat tables and no object graph, so the usual reasons to adopt an ORM do not apply: a typed query builder gives types in the same places an ORM would, without standing between us and the Postgres features the design depends on.

---

## 3. Project layout

This spec established the module shape the engine still uses — routes, service, repository per entity, with `shared/` and `db/` alongside. It is described in [conventions.md](../../conventions.md#code-layout).

Four modules are created here: `resources`, `schedule`, `exceptions`, `availability`. The existing empty `booking_engine/` directory is removed in favour of `src/`.

### The one structural decision that matters

`availability/slot-generator.ts` must not import anything from `db/`. It receives availability windows, a timezone, a slot duration and an anchor time, and returns slots.

The reason is not tidiness. All DST-sensitive arithmetic — the part where bugs actually live — becomes a pure function testable without Postgres, so the cases that matter (a 23-hour day, a 25-hour day, an anchor that must not drift) can be covered exhaustively in milliseconds instead of through HTTP and a database. The surrounding service stays a thin layer of queries.

---

## 4. Data model

Three tables. `bookings` is created in spec 2.

### 4.1 `resources`

| Column             | Type                                   | Notes                                                       |
| ------------------ | -------------------------------------- | ----------------------------------------------------------- |
| `id`               | `uuid` PK, default `gen_random_uuid()` |                                                             |
| `timezone`         | `text NOT NULL`                        | IANA zone, e.g. `Europe/Warsaw`                             |
| `is_active`        | `boolean NOT NULL DEFAULT true`        | Soft-disable                                                |
| `slot_duration`    | `interval NOT NULL`                    | Booking quantum                                             |
| `slot_anchor_time` | `time NOT NULL DEFAULT '00:00'`        | Start of the day for day-based resources                    |
| `capacity`         | `integer NOT NULL DEFAULT 1`           | `CHECK (capacity >= 1)`                                     |
| `concurrency_mode` | `text NOT NULL`                        | `CHECK (concurrency_mode IN ('exclusive','shared','pool'))` |
| `created_at`       | `timestamptz NOT NULL DEFAULT now()`   |                                                             |
| `updated_at`       | `timestamptz NOT NULL DEFAULT now()`   |                                                             |

**`slot_duration` is a real Postgres `interval`, not a minute count.** In Postgres `'1 day'` and `'24 hours'` are different values that behave differently under timezone arithmetic across a DST boundary, and that difference is exactly what day-based resources need. The API therefore expresses duration as an ISO-8601 duration string (§6.1).

**`slot_anchor_time`** exists so that a resource whose day does not start at midnight — a hotel with 14:00 check-in, a car rental with 09:00 pickup — is expressible in the engine. Without it, every domain would re-implement the same translation between calendar dates and engine timestamps, each with its own boundary bugs. The field is not a domain concept: it is a slicing parameter of the same class as `slot_duration`, and the engine still has no idea a hotel is behind it.

It also collapses two possible designs into one code path. The slot grid for a date starts at `schedule.start_time`, or at `slot_anchor_time` when that is `NULL`. Calendar-day semantics are simply the default value `00:00`. No branch in the algorithm.

### 4.1.1 Why some times are stored local and others absolute

This spec settled the rule now recorded in [conventions.md](../../conventions.md#local-time-versus-absolute-time): schedule times and exception dates keep their local form, only instants become `timestamptz`.

Its consequence for this data model is that `timezone` must be immutable (§5.1). The obstacle is not data migration — no row would move — but reinterpretation: `09:00–17:00` would come to denote a different set of instants, and existing bookings could fall outside the working windows. A genuine relocation also has to decide whether to preserve each appointment's instant or its wall-clock time, which is a business decision rather than a `PATCH` field. If the need arises it belongs in a dedicated operation that recomputes the schedule and reports affected bookings.

### 4.2 `schedule`

| Column        | Type                                                       | Notes                                             |
| ------------- | ---------------------------------------------------------- | ------------------------------------------------- |
| `id`          | `uuid` PK, default `gen_random_uuid()`                     |                                                   |
| `resource_id` | `uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE` |                                                   |
| `day_of_week` | `smallint NOT NULL`                                        | `CHECK (day_of_week BETWEEN 0 AND 6)`, Monday = 0 |
| `start_time`  | `time NULL`                                                | `NULL` for day-based resources                    |
| `end_time`    | `time NULL`                                                | `NULL` for day-based resources                    |

Index on `(resource_id, day_of_week)`.

`CHECK ((start_time IS NULL) = (end_time IS NULL))` — the two are always both set or both null.
`CHECK (start_time IS NULL OR start_time < end_time)`.

A weekday may carry several rules (a morning window and an evening one), provided they do not overlap. Validation lives in the service layer (§5.2) because it spans multiple rows.

### 4.3 `schedule_exceptions`

| Column        | Type                                                       | Notes                                  |
| ------------- | ---------------------------------------------------------- | -------------------------------------- |
| `id`          | `uuid` PK, default `gen_random_uuid()`                     |                                        |
| `resource_id` | `uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE` |                                        |
| `date`        | `date NOT NULL`                                            | Interpreted in the resource's timezone |
| `start_time`  | `time NULL`                                                | Both `NULL` = day off                  |
| `end_time`    | `time NULL`                                                |                                        |

`UNIQUE (resource_id, date)` — this is what makes `PUT .../exceptions/:date` idempotent.
Same two `CHECK` constraints as `schedule`.

An exception **replaces** the weekly schedule for that date entirely; it never merges with it.

### 4.4 Note for spec 2

The exclusion constraint on `bookings` requires the `btree_gist` extension (to combine `uuid WITH =` and `tstzrange WITH &&` in one GiST index). It is not needed in this spec, but the migration in spec 2 must create it. — _Done:_ `002_bookings.ts` creates it as its first statement.

---

## 5. Validation rules

### 5.1 Resource

- `timezone` must be a **named** IANA zone. `IANAZone.isValidZone` alone is not sufficient: it accepts bare numeric offsets such as `+02:00`, `-05:00` and `+0200`, which carry no daylight-saving rules. A Warsaw resource stored as `+02:00` would be an hour off for half the year, so offset forms are rejected explicitly and only named zones (`Europe/Warsaw`, `UTC`, `CET`, …) are accepted.
- `slot_duration` must parse under the restricted grammar of §6.1 and be between 1 minute and 366 days.
- `concurrency_mode`:
  - `exclusive` requires `capacity = 1`; anything else is `validation_error`.
  - `shared` requires `capacity >= 1`.
  - `pool` is **rejected** with 400 `unsupported_concurrency_mode` until spec 3. Storing resources the engine cannot serve availability for would be worse than refusing them.
- **A resource is day-based if and only if its `slot_duration` is written in the `P<n>D` form.** The distinction is the written form, not the magnitude: `P1D` means "anchor to anchor", which is 23, 24 or 25 real hours depending on DST, while `PT24H` means exactly 24 hours of elapsed time. Treating them as interchangeable would silently break day-based resources twice a year. A `PT…` duration must therefore be shorter than 24 hours — a longer one could never fit inside an intraday window anyway.
- `slot_anchor_time` may only differ from `00:00` on a day-based resource. On an intraday resource the anchor is unused, and silently ignoring a value the caller set is a worse failure mode than rejecting it. Validated against the resulting state on both create and patch.
- `timezone` and `concurrency_mode` are immutable after creation. Changing them retroactively would reinterpret bookings that already exist. `PATCH` accepts only `slot_duration`, `slot_anchor_time`, `capacity` and `is_active`.

### 5.2 Schedule (validated over the whole submitted set)

- Shape must match the slot duration:
  - Day-based resource (`P<n>D`) → every rule must have `NULL` times, and at most one rule per weekday.
  - Intraday resource (`PT…`) → every rule must have both times set.
  - Violation → 400 `schedule_shape_mismatch`.
- Two rules on the same weekday must not overlap → 400 `schedule_overlap`. Touching endpoints (09:00–12:00 and 12:00–17:00) do not overlap and are allowed.
- `start_time < end_time`. A window crossing midnight is rejected; see §9.

### 5.3 Exceptions

- Both times set, or both `NULL` (day off). One set and one `NULL` → 400 `validation_error`.
- `start_time < end_time`.
- Shape must match the slot duration, same rule as §5.2.

---

## 6. API

All request bodies and all responses are validated and serialized against TypeBox schemas. `GET /health` returns `200 { "status": "ok" }`.

### 6.1 Representation conventions

Formats — durations, timestamps, times of day, dates, half-open ranges — were settled here and are now recorded in [conventions.md](../../conventions.md#time-and-date-representation). Two of them departed from the architecture document as it stood, and the departures are the point:

- **Timestamps carry an offset.** The architecture document showed offset-less strings such as `2026-07-20T09:00`. Without an offset a client cannot unambiguously recover the instant, and during a fall-back transition a local time occurs twice.
- **Durations are a restricted ISO-8601 grammar rather than a minute count**, so that `P1D` and `PT24H` stay distinguishable. A minute count makes both 1440 and breaks day-based resources twice a year.

### 6.2 Resources

```
POST /resources
  body: { timezone, slot_duration, capacity?, concurrency_mode, slot_anchor_time? }
  201 { id, timezone, slot_duration, slot_anchor_time, capacity, concurrency_mode, is_active }

GET /resources/:id
  200 { ...same shape... }
  404 not_found

PATCH /resources/:id
  body: { slot_duration?, slot_anchor_time?, capacity?, is_active? }
  200 { ...same shape... }
  404 not_found

DELETE /resources/:id
  204
  404 not_found
```

`DELETE` is a hard delete and cascades to schedule and exceptions. `is_active = false` already covers soft-disable, so `DELETE` means what it says. Spec 2 will additionally refuse to delete a resource that has bookings.

### 6.3 Schedule

```
GET /resources/:id/schedule
  200 [ { id, day_of_week, start_time, end_time }, ... ]

PUT /resources/:id/schedule
  body: [ { day_of_week, start_time, end_time }, ... ]
  200 [ { id, day_of_week, start_time, end_time }, ... ]
  400 schedule_overlap | schedule_shape_mismatch | validation_error
```

`PUT` replaces the whole schedule inside a single transaction: delete all rows for the resource, insert the new set. An empty array is valid and means "never available". The submitted set is validated as a whole before anything is written.

### 6.4 Exceptions

```
GET /resources/:id/exceptions?from=YYYY-MM-DD&to=YYYY-MM-DD
  200 [ { id, date, start_time, end_time }, ... ]

PUT /resources/:id/exceptions/:date
  body: { start_time, end_time }     // both null = day off
  200 { id, date, start_time, end_time }

DELETE /resources/:id/exceptions/:date
  204
```

`from` and `to` are required on `GET`. `PUT` is an upsert keyed on `(resource_id, date)`, so repeated calls overwrite. `DELETE` returns 204 whether or not an exception existed — it is idempotent, matching `PUT`.

### 6.5 Availability

```
GET /resources/:id/availability?from=YYYY-MM-DD&to=YYYY-MM-DD
  200 {
    slots: [
      { start: "2026-07-20T09:00:00+02:00", end: "2026-07-20T10:00:00+02:00", available: true },
      ...
    ]
  }
  400 invalid_range
  404 not_found
```

Slots are returned in ascending order of `start`.

`available` is always `true` in this spec — there is nothing to subtract yet. The field is present from the start so that the contract does not change when spec 2 lands.

A resource with `is_active = false` returns `{ "slots": [] }`. It exists, so 404 would be wrong; it is not bookable, so returning slots would be misleading.

---

## 7. Availability algorithm

### 7.1 Procedure

For each date `D` in `[from, to)`, enumerated in the resource's timezone:

1. **Resolve the windows for `D`.**
   - An exception exists for `D` with `NULL` times → day off, emit nothing.
   - An exception exists with times → those are the windows for `D`, replacing the weekly schedule entirely.
   - No exception → all `schedule` rows whose `day_of_week` matches `D`'s weekday.
2. **Slice each window.**
   - `cursor := D at (window.start_time ?? resource.slot_anchor_time)`, materialized in the resource's timezone.
   - `window_end := D at window.end_time`, or `cursor + slot_duration` when `window.end_time` is `NULL`.
   - While `cursor + slot_duration <= window_end`, emit `[cursor, cursor + slot_duration)` and advance `cursor` by `slot_duration`.
   - A day-based resource has both times `NULL`, so the cursor starts at the anchor and the loop runs exactly once — one slot per available day.
3. Sort all emitted slots by `start`.

A trailing remainder shorter than one slot is dropped: a 09:00–17:30 window with a one-hour slot yields eight slots and discards the final half hour.

### 7.2 Timezone and DST

Every local-time-to-instant conversion goes through Luxon with the resource's zone, and `cursor` advances with Luxon's `plus()`, which is DST-aware. Two consequences follow for free:

- On a spring-forward date, a `P1D` slot is 23 hours of real time; on a fall-back date, 25. The slot still runs from local anchor to local anchor, which is what a "day" means to a hotel.
- Intraday grids shift correctly on transition days rather than drifting by an hour.

Adding hours to a naive `Date` would silently produce wrong results twice a year, which is the reason Luxon is a dependency rather than a convenience.

### 7.3 The day-of-week trap

The architecture document defines `day_of_week` as Monday = 0. Postgres `EXTRACT(DOW)` uses Sunday = 0, JavaScript `Date.getDay()` uses Sunday = 0, and Luxon's `weekday` uses Monday = 1. Four conventions for one concept.

A single conversion helper lives in `shared/time.ts` and is the only place allowed to map between them. It is covered by a test asserting all seven days explicitly. Without this, the resulting bug surfaces only on Sundays.

### 7.4 Where the work happens

Windows are loaded from the database in two queries per request (schedule rows for the resource, exceptions within the range). All slicing happens in `slot-generator.ts` in memory. The volume is bounded by the 366-day cap, so this is not a performance concern, and it keeps the DST logic in a pure, testable function instead of inside SQL.

### 7.5 Error handling

A single `setErrorHandler` maps an `AppError` hierarchy to the uniform response body defined in [conventions.md](../../conventions.md#api-conventions), which also holds the full code catalogue.

This spec introduces `validation_error`, `invalid_range`, `schedule_overlap`, `schedule_shape_mismatch`, `unsupported_concurrency_mode`, `not_found` and `internal_error`. Framework-level 4xx are translated into the same shape rather than falling through to `internal_error` — a caller's mistake must not be reported as a server failure.

### 7.6 Authentication extension point

No authentication is implemented. All routes are registered through a single Fastify plugin, so the future `preHandler` hook attaches in one place without touching any handler.

---

## 8. Configuration

Read from the environment at startup and validated with TypeBox; the process refuses to start on invalid config.

| Variable         | Default      | Meaning                                            |
| ---------------- | ------------ | -------------------------------------------------- |
| `DATABASE_URL`   | — (required) | Postgres connection string                         |
| `PORT`           | `3000`       |                                                    |
| `LOG_LEVEL`      | `info`       | Pino level                                         |
| `MAX_RANGE_DAYS` | `366`        | Upper bound for availability and exception queries |

Migrations run via `npm run migrate`, using Kysely's built-in `Migrator` against files in `src/db/migrations`.

---

## 9. Known limitations

Every limitation this spec accepted, with its reasoning and the cost to lift it, is tabulated in [conventions.md](../../conventions.md#deliberate-limitations): no overnight windows, `pool` rejected rather than stored, no schedule history, a slot grid anchored per window, and no authentication.

One of them was checked rather than assumed, and the answer is worth keeping close to the schema. **Lifting the overnight-window restriction costs nothing at the database level.** The only schema trace is the `start_time < end_time` CHECK on `schedule` and `schedule_exceptions`; dropping a CHECK neither rewrites the table nor touches data, and the column types already accommodate the values. Rows written before the change stay valid, because the old rule is strictly narrower than the new one. The entire cost sits in the slicing algorithm, the weekday resolution, and deciding which date owns a window that starts on the 20th and ends on the 21st.

---

## 10. Testing strategy

Test-driven: each behaviour gets a failing test before its implementation.

### 10.1 Unit tests — `slot-generator.ts` and `shared/time.ts`

These cover the cases where real bugs live:

- Spring-forward date in `Europe/Warsaw`: a `P1D` slot spans 23 real hours; an intraday grid does not drift.
- Fall-back date: a `P1D` slot spans 25 real hours; a local time occurring twice resolves deterministically.
- `slot_anchor_time = 14:00` with `P1D`: the slot runs 14:00 → 14:00 next day, and two consecutive days form a contiguous pair.
- Anchor `00:00` with `P1D`: calendar-day semantics.
- Trailing remainder shorter than a slot is dropped (09:00–17:30, `PT1H` → 8 slots).
- Two windows on one day produce two independent grids.
- Empty window set produces no slots.
- Day-of-week mapping: all seven days asserted explicitly against Luxon and Postgres conventions.
- Duration parsing: accepts `PT30M`, `PT1H30M`, `P1D`; rejects `P1M`, `P1Y`, `P1DT2H`, `PT0M`, garbage.

### 10.2 Integration tests — real Postgres

Vitest `globalSetup` starts one Testcontainers Postgres instance per run and applies migrations; tables are truncated between tests. HTTP is exercised through Fastify's `app.inject()`, so no socket is bound.

- Migrations apply cleanly to an empty database.
- Resource lifecycle: create → read → patch → delete, including cascade deletion of schedule and exceptions.
- `POST /resources` rejects an invalid timezone, `exclusive` with `capacity > 1`, `pool`, a non-default anchor on an intraday resource, and a malformed duration.
- `PATCH` rejects attempts to change `timezone` or `concurrency_mode`.
- `PUT /schedule` replaces the previous schedule atomically; a rejected submission leaves the old schedule intact.
- `PUT /schedule` rejects overlapping rules on one weekday, and accepts touching ones.
- `PUT /schedule` rejects a shape mismatched to `slot_duration`, in both directions.
- Exception with times replaces the weekly schedule for that date.
- Exception with `NULL` times produces no slots for that date.
- `PUT` on an existing date overwrites; `DELETE` on a missing date returns 204.
- Availability over a week returns the expected slots for an intraday resource and for a day-based one with a 14:00 anchor.
- Availability respects the half-open range: a slot on the `to` date is not returned.
- `to <= from` and an over-wide range both return 400 `invalid_range`.
- An inactive resource returns an empty slot list; a nonexistent one returns 404.

---

## 11. Definition of done

- All endpoints of §6 implemented and covered by the tests of §10.
- `npm test` passes from a clean checkout with Docker running.
- `npm run migrate` brings an empty database to the schema of §4.
- TypeScript compiles with no errors under `strict`.
- A README documents how to run the service, the migrations and the tests.
