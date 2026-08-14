# Spec 2 — Bookings

**Status:** awaiting approval
**Date:** 2026-08-05
**Source of truth for the overall system:** [docs/architecture.md](../../architecture.md)
**Preceding slice:** [spec 1 — resources, schedule, availability](2026-07-27-resources-schedule-availability-design.md)

---

## 1. Purpose

Build the write side of the engine: the `Booking` entity, its lifecycle, hold expiry, and the
two concurrency modes the engine can serve today — `exclusive` and `shared`.

At the end of this spec the service answers _"can I take these slots, and are they mine now"_
over HTTP, and the `available` flag that spec 1 shipped as a constant becomes a real
computation.

### Why this slice

Spec 1 delivered every read path and no write path. Availability is already correct,
DST-aware and covered by tests; what it cannot yet do is subtract anything, because there is
nothing to subtract. This spec adds the thing to subtract and the rules for creating it.

| Spec             | Content                                                             |
| ---------------- | ------------------------------------------------------------------- |
| 1                | Skeleton, migrations, resources, schedule, exceptions, availability |
| **2 (this one)** | Bookings, lifecycle, hold expiry, listings, `shared` capacity       |
| 3                | `pool` concurrency mode                                             |

### In scope

- The `bookings` table, its constraints and its indexes
- Booking creation, in both flows: instant confirmation and hold-then-confirm
- The lifecycle: confirm, cancel, reschedule, complete, no-show, expire
- Hold expiry, both as a correctness mechanism and as background hygiene
- Capacity enforcement for `shared`, overlap prevention for `exclusive`
- Optional idempotency key on creation
- Listings by resource and by customer
- `available` computed against real bookings
- Unit and integration tests, and the smoke suite that shares their datasets

### Out of scope

- The `pool` concurrency mode — spec 3. §12 records what this spec guarantees for it.
- **Protecting a schedule edit that would leave existing bookings outside the working
  windows.** `PUT /schedule` and the exception endpoints keep behaving exactly as in spec 1.
  Refusing such an edit would make a schedule practically uneditable — a single booking a year
  out would freeze it — and deciding what to do with the affected bookings is a business
  question the engine has no standing to answer. See §13.
- **Pagination on the listing endpoints.** Both are bounded by a required `from`/`to` window
  no wider than `MAX_RANGE_DAYS`, which is the same bound spec 1 relies on everywhere else.
- **Automatic completion.** A booking does not become `completed` because its end time passed.
  The architecture defines an explicit `POST /complete`, and an automatic transition would
  make `no_show` unreachable — the two states are distinguished by a judgement only the caller
  can make.
- Authentication, multi-tenancy, rate limiting, caching — unchanged from spec 1.

---

## 2. Data model

One new table. Migration `002_bookings.ts`.

### 2.1 `bookings`

| Column             | Type                                                                   | Notes                                         |
| ------------------ | ---------------------------------------------------------------------- | --------------------------------------------- |
| `id`               | `uuid` PK, default `gen_random_uuid()`                                 |                                               |
| `resource_id`      | `uuid NOT NULL REFERENCES resources(id) ON DELETE RESTRICT`            | Always a concrete resource — see §12          |
| `start_time`       | `timestamptz NOT NULL`                                                 | An instant                                    |
| `end_time`         | `timestamptz NOT NULL`                                                 | An instant                                    |
| `time_range`       | `tstzrange GENERATED ALWAYS AS tstzrange(start_time, end_time) STORED` | Read, never written                           |
| `status`           | `text NOT NULL`                                                        | Six values, see below                         |
| `customer_id`      | `text NOT NULL`                                                        | Opaque external identifier                    |
| `held_until`       | `timestamptz NULL`                                                     | Set exactly on `held` and `expired`           |
| `idempotency_key`  | `text NULL`                                                            | Optional, supplied by the caller              |
| `concurrency_mode` | `text NOT NULL`                                                        | Copied from the resource on insert — see §2.3 |
| `created_at`       | `timestamptz NOT NULL DEFAULT now()`                                   |                                               |
| `updated_at`       | `timestamptz NOT NULL DEFAULT now()`                                   |                                               |

**`ON DELETE RESTRICT`, not `CASCADE`.** Spec 1 left a note that `DELETE /resources/:id` must
stop being unconditional once bookings exist; the foreign key enforces that in the database,
and the service turns the violation into a clear error before the request reaches Postgres.
The rule is deliberately blunt: one booking in any status, terminal or not, and the resource
cannot be deleted. History is not discarded as a side effect of a delete, and `is_active =
false` already exists for retiring a resource.

### 2.2 Check constraints

```sql
status IN ('held','confirmed','cancelled','completed','no_show','expired')
end_time > start_time
(status IN ('held','expired')) = (held_until IS NOT NULL)
```

**The status list includes `expired`, which resolves a contradiction in the architecture
document.** Its lifecycle diagram shows `expired` as a state; its column table lists five
statuses without it. The state has to exist as a stored value, because the exclusion
constraint below is predicated on `status`, and a predicate over `held_until` cannot go into
an index — `now()` is not immutable. An expired hold must therefore stop being `held` for the
slot to become free again.

The third constraint keeps `held_until` meaningful: it is set exactly on the rows for which an
expiry is a real thing — a hold that is still outstanding, or one that ran out. Leaving `held`
for any other status clears it, so `confirm` and `cancel` set `held_until = NULL` in the same
statement that changes the status. Without the constraint a seventh state appears —
"confirmed, but with an expiry" — that nothing in the engine knows how to interpret.

`expired` has to keep its `held_until` rather than clear it: it is the only record of when the
hold lapsed, and the sweep of §7.1 changes the status alone.

### 2.3 Overlap prevention

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE bookings ADD CONSTRAINT bookings_no_overlap
  EXCLUDE USING gist (resource_id WITH =, time_range WITH &&)
  WHERE (status IN ('held','confirmed') AND concurrency_mode = 'exclusive');
```

`btree_gist` is required to combine `uuid WITH =` and `tstzrange WITH &&` in one GiST index;
spec 1 flagged this and did not create it.

This constraint is the entire concurrency story for `exclusive`. It holds at any isolation
level, including the READ COMMITTED default, and needs no lock in application code. `shared`
cannot be expressed through it — capacity is a count, not a disjointness property — which is
what §6 is about.

**The mode has to be on the booking row, which is why `concurrency_mode` is duplicated
there.** An index predicate cannot reach into another table, so a constraint that must apply
to `exclusive` rows and not to `shared` ones has nowhere else to read the mode from. Without
the predicate the constraint governs every booking, and a `shared` resource with capacity 3
would have its second overlapping booking refused before any count was consulted — the whole
mode would be unreachable.

The duplication is safe **because `concurrency_mode` is immutable on a resource**, which spec
1 established for its own reasons: changing it would reinterpret bookings that already exist.
A copy of a value that can never change cannot drift from its source. The service sets it from
the loaded resource on insert, and nothing ever updates it.

### 2.4 Idempotency

```sql
UNIQUE (resource_id, idempotency_key)
```

Postgres treats NULLs as distinct in a unique index, so bookings created without a key do not
conflict with each other and the column stays optional.

A replay carrying the same key and the same request returns the existing booking with `200`
instead of `201`. The same key describing a different booking is `409
idempotency_key_reused`: that is not a retry, it is a caller error, and silently handing back
an unrelated booking would be the worse failure.

"The same" is compared on `customer_id`, `start_time` and `end_time` — the three fields that
identify what was booked. `hold` and `hold_minutes` are excluded deliberately: they describe
how the booking was created, not what it is, and `hold_minutes` has already been consumed into
a `held_until` by the time a replay arrives.

### 2.5 Indexes

| Index                                       | Serves                                                                     |
| ------------------------------------------- | -------------------------------------------------------------------------- |
| the GiST index behind `bookings_no_overlap` | Overlap checks and the capacity count, both over active bookings only      |
| `(resource_id, start_time)`                 | `GET /resources/:id/bookings`, which includes terminal statuses            |
| `(customer_id, start_time)`                 | `GET /bookings?customer_id=`                                               |
| `(held_until) WHERE status = 'held'`        | The expiry sweep. Partial, so it stays small no matter how the table grows |

### 2.6 Kysely types

`BookingsTable` is added to `db/schema.ts`. `time_range` is declared
`ColumnType<string, never, never>`: a generated column is readable and never writable, and the
type system should say so rather than leave it to discipline.

---

## 3. Validation

### 3.1 A booking must match the grid

The rule comes from the architecture document: **the requested interval must equal a
contiguous run of the slots `getAvailability` returns for that period.** Booking and
availability then share one definition — anything offered is bookable, anything bookable was
offered.

It is implemented by calling the existing `generateSlots`. There is no second implementation
of the stepping, which is the point: the DST-sensitive arithmetic exists once.

```
validate(resource, start, end):
  1. end > start                                  else 400 invalid_interval
  2. resource.is_active                           else 409 resource_inactive
  3. dates := local dates in the resource's zone,
       from date(start) − 1 through date(end − 1ms)
  4. slots := the availability grid over those dates (schedule + exceptions)
  5. locate the slot whose start equals start     else 400 invalid_slot_boundary
  6. walk forward while slots[i].end == slots[i+1].start:
       landed exactly on end                      → valid
       the run ended before end                   → 400 outside_schedule
       stepped past end                           → 400 invalid_slot_boundary
```

All comparisons are on instants. ISO-8601 strings carrying different offsets do not compare
lexicographically by the moment they denote, and mixing the two is the kind of bug that only
appears across a transition.

**Step 3 deliberately reaches one day further back than the start date.** With an anchor of,
say, `02:00`, the slot belonging to date D runs until D+1 at 02:00, so a booking starting at
D+1 01:00 belongs to the previous date's grid. One extra date in the enumeration costs
nothing and removes the whole class of anchor-related edge cases.

### 3.2 Hold parameters

- `hold: true` produces `status = 'held'` and `held_until = now() + hold_minutes`.
  Otherwise the booking is created `confirmed` with `held_until = NULL`.
- `hold_minutes` defaults to `DEFAULT_HOLD_MINUTES` and must be between 1 and
  `MAX_HOLD_MINUTES`.
- `hold_minutes` supplied without `hold: true` is `400 validation_error`. Accepting and
  ignoring it would look to the caller like a hold was created.

### 3.3 The engine has no opinion about the present

A booking whose slots are in the past is accepted. Spec 1's availability never reads a clock
and returns past slots alongside future ones; the "anything offered is bookable" rule inherits
that. Entering a booking after the fact is a legitimate administrative action, and deciding
whether the present matters is exactly the kind of judgement the engine leaves to the domain.
Recorded in [conventions.md](../../conventions.md#deliberate-limitations).

---

## 4. API

```
POST   /resources/:id/bookings
  body: { customer_id, start_time, end_time, hold?, hold_minutes?, idempotency_key? }
  201 { id, resource_id, start_time, end_time, status, customer_id, held_until }
  200 same body, when the idempotency key replays an existing booking
  400 invalid_interval | invalid_slot_boundary | outside_schedule | validation_error
  409 slot_unavailable | resource_inactive | idempotency_key_reused
  404 not_found

GET    /bookings/:id                200 | 404 not_found
POST   /bookings/:id/confirm        200 | 410 hold_expired | 409 invalid_state_transition
POST   /bookings/:id/cancel         200 | 409 invalid_state_transition
POST   /bookings/:id/reschedule     200 | 409 slot_unavailable | invalid_state_transition
  body: { start_time, end_time }        | 400 grid errors as above
POST   /bookings/:id/complete       200 | 409 invalid_state_transition
POST   /bookings/:id/no-show        200 | 409 invalid_state_transition

GET    /resources/:id/bookings?from=&to=&status=   200 [ ... ]
GET    /bookings?customer_id=&from=&to=&status=    200 [ ... ]
```

`GET /bookings/:id` does not appear in the architecture document. Its absence is a gap rather
than a decision — a booking can be confirmed, cancelled and rescheduled but not read — so it
is added here and the document is corrected.

The booking response carries `{ id, resource_id, start_time, end_time, status, customer_id,
held_until }`. `idempotency_key`, `created_at` and `time_range` are outside the contract and
therefore cannot reach the client: Fastify serializes against the declared schema.

### 4.1 Listings

`from` and `to` are required on both, half-open, and no wider than `MAX_RANGE_DAYS`. A booking
is included when its interval overlaps the window. Results are ordered by `start_time`
ascending. `status` is a single optional value from the enumeration; omitting it returns every
status.

**The two windows are interpreted in different zones, and the difference is deliberate.** The
per-resource listing has an obvious zone — the resource's own, the same one availability and
exceptions use. The per-customer listing has none: it spans resources in different zones and
no one of them outranks the others, so its dates are interpreted in UTC. Stated in the
endpoint documentation rather than left to be discovered.

`customer_id` is required on `GET /bookings`. Without it the query has no bound but the date
window, across every resource in the system.

---

## 5. Lifecycle

```
held ──→ confirmed ──→ completed
  │           │
  │           ├──→ cancelled
  │           └──→ no_show
  ├──→ cancelled
  └──→ expired        (held_until elapsed)
```

`cancelled`, `completed`, `no_show` and `expired` are terminal.

One rule replaces a table of special cases:

> A transition into the state the booking is already in is a successful no-op and returns
> `200`. Any other transition out of a terminal state is `409 invalid_state_transition`, with
> the current status in `details`.

A `confirm` retried after a network timeout therefore succeeds instead of failing on the
second attempt, while cancelling a completed booking fails honestly. The idempotency key of
§2.4 covers creation only; this rule is what makes the transitions safe to retry.

`confirm` on an expired hold is the one carve-out: `410 hold_expired`, because the reason for
the refusal is different from a bad transition and the caller needs to tell them apart.

**`reschedule` updates the times of the same row**, preserving `id` and `status`, and is
allowed only from `held` and `confirmed`. An exclusion constraint never compares a row with
itself, so a single `UPDATE` is safe and the "cancel plus book in one transaction" phrasing in
the architecture document describes the effect rather than the implementation. In `shared` the
capacity count must exclude the booking being moved, or it blocks itself.

---

## 6. Concurrency

### 6.1 The write transaction

Every write that contends for capacity runs at READ COMMITTED in this shape:

```
BEGIN
  1. lock the resource row          -- shared only, see below
  2. UPDATE bookings SET status = 'expired'
       WHERE resource_id = $1 AND status = 'held' AND held_until <= now()
  3. capacity check                 -- shared only
  4. INSERT (or UPDATE, for reschedule)
COMMIT
```

### 6.2 Where the lock is taken, and why not everywhere

**The lock is taken when the invariant spans more than one row.**

- `exclusive` — the invariant is disjointness of one range, and `bookings_no_overlap` enforces
  it atomically at any isolation level. No lock. Bookings on different dates for the same
  resource proceed in parallel.
- `shared` — the invariant is a count over a set of rows, and a count cannot be protected by a
  constraint. Two transactions would each read "2 of 3 taken" and both insert. The resource
  row is locked with `SELECT id FROM resources WHERE id = $1 FOR UPDATE`, which serializes
  bookings for that resource and nothing else. The exclusion constraint does not apply to
  these rows at all — §2.3's predicate excludes them — so the lock is not a second mechanism
  layered on the first, it is the only one.

**A second condition was added after the fact, and the reason is worth keeping.** The lock is
also taken when the request carries an idempotency key, in any mode:

```ts
const needsLock = resource.concurrency_mode === 'shared' || body.idempotency_key !== undefined
if (needsLock) await lockResource(trx, resource.id)
```

Without it, two concurrent replays of the same key **deadlock**. `INSERT … ON CONFLICT
(resource_id, idempotency_key) DO NOTHING` uses Postgres's speculative-insertion protocol,
which resolves a conflict on the _arbiter_ index cleanly. `bookings_no_overlap` is not the
arbiter, so it is checked by the ordinary path — and when both rows violate it against each
other, each transaction ends up holding a speculative token the other is waiting on. Postgres
breaks the cycle with SQLSTATE `40P01`, which is neither `23P01` nor an `AppError`, so it
reaches the client as a `500`. Observed roughly once in ten runs of the racing test.

That is precisely the failure an idempotency key exists to prevent: an honest retry after a
timeout answered with a server error. The lock removes it at the root rather than papering
over it — the second transaction waits, then finds the first one's row through
`findByIdempotencyKey` and returns the replay, never reaching a speculative insert at all. It
also makes the read-then-insert pair genuinely atomic, which it was not before; the
`ON CONFLICT` clause survives as a safety net rather than as the mechanism.

Keyless bookings are unaffected: with no arbiter index there are no speculative tokens, and
two racing inserts simply meet the exclusion constraint, one of them becoming an honest `409`.

The rule therefore reads: **lock when the invariant spans more than one row, or when a
read-then-write has to be atomic.**

Its second clause caught a second case almost immediately, in the lifecycle transitions of §5.
`apply` reads a booking's status, decides against the transition table, and writes the new
one. Under READ COMMITTED that read is stale by the time the write lands: two concurrent
requests with different actions — `cancel` and `complete` on one `confirmed` booking — both
read `confirmed`, and the loser's `UPDATE … WHERE id = $1` re-evaluates a predicate that still
matches after the winner commits, overwriting `cancelled` with `completed`. A terminal booking
transitions, which is precisely what the one rule of §5 exists to forbid.

The lock there is on the **booking** row rather than the resource row — `findIn` selects
`FOR UPDATE` — because that is the granularity the invariant actually has. The loser then
blocks before reading, sees the committed status, and the existing rule produces its `409`
with no new error path. A compare-and-swap on the update would work too, at the cost of a
conditional write, a zero-rows branch, a re-read and a re-derived error, to reach the same
place.

`exclusive` is still safe without the lock, including around the sweep. If transaction A
expires a stale hold and inserts over it, a concurrent B blocks on that hold's row lock inside
its own sweep, re-evaluates the `WHERE` clause after A commits, finds the row no longer
`held`, and skips it — and B's insert then meets the exclusion constraint and becomes a
`409`. The constraint is the arbiter; a resource lock would add nothing.

### 6.3 Why not SERIALIZABLE, and why not a queue

Both were considered and both are recorded in
[conventions.md](../../conventions.md#deliberate-limitations) with the cost of adopting them.

**SERIALIZABLE** would express the invariant declaratively and allow non-conflicting bookings
to proceed in parallel, at the cost of a bounded retry loop around every write, a new failure
mode when retries are exhausted, and probabilistic tests. Its decisive weakness is spec 3: a
pool's invariant is "some member has no overlapping booking", a negative condition over a set,
which is the worst case for predicate locks. Two bookings for different rooms of the same
hotel would conflict on the predicate despite writing disjoint rows, and the false-abort rate
would grow with the size of the pool — removing exactly the parallelism a pool exists to
provide.

**A queue with one consumer per resource** removes concurrency by construction, and is the
right answer under flash-sale load on a single resource. It is the wrong answer here twice
over: it turns `POST /bookings` into an asynchronous endpoint returning a job id rather than
`201`/`409`, changing how the domain layer asks "is it free" and "is it mine"; and at-least-
once delivery needs an idempotent consumer, whose idempotency is enforced by a unique
constraint in Postgres anyway. The broker would sit on top of the arbiter, not replace it.
The engine's write volume per resource is low; its load lives on the read path, which takes no
locks at all.

### 6.4 Error translation

An exclusion violation arrives as SQLSTATE `23P01`. It is matched on the constraint name
`bookings_no_overlap`, not on the message text, and becomes `409 slot_unavailable`.

The idempotency path uses `INSERT ... ON CONFLICT (resource_id, idempotency_key) DO NOTHING
RETURNING *`. An empty return means a concurrent request won the race, so the row is re-read
and compared exactly as in §2.4. The unique index closes the race; no lock is involved.

### 6.5 Lock ordering

Recorded in the conventions now, though this spec has nothing to apply it to:

> Where a resource has a parent, the parent is locked before the member.

Spec 3 introduces pools and would otherwise discover this rule as an intermittent deadlock.

---

## 7. Hold expiry

Two mechanisms with two different jobs, and the spec states which is which because the
distinction is easy to lose later.

**The sweep inside the write transaction is the correctness mechanism.** Step 2 of §6.1
expires stale holds for the resource before anything else contends for its capacity. Freeing
a slot and taking it become one atomic operation, so there is no window in which a caller is
refused a slot that is in fact free.

**The background worker is hygiene.** It is not required for correctness, and the
in-transaction sweep must not be removed on the grounds that the worker exists. What it does
provide is that listings stop showing `held` on dead rows, and that resources nobody is
currently booking do not accumulate stale holds indefinitely.

### 7.1 The worker

`setInterval` every `HOLD_SWEEP_INTERVAL_SECONDS`, running:

```sql
UPDATE bookings SET status = 'expired', updated_at = now()
 WHERE status = 'held' AND held_until <= now()
```

guarded by `pg_try_advisory_xact_lock` so that only one instance sweeps per tick. The lock is
transaction-scoped, not session-scoped: it is released on commit and therefore cannot leak
through a connection pool. A session-scoped advisory lock would be returned to the pool still
held, and with a transaction-mode pooler in front it would be handed to another client.

Two alternatives were weighed. `pg_cron` moves the schedule into the database and off the
application, but `postgres:16` does not ship it: the compose service and the Testcontainers
image would both have to become a custom build, and the suite would stop running against a
stock Postgres. A job framework such as `graphile-worker` brings retries and observability,
along with a dependency and its own migrations inside our schema — a large answer to one
periodic `UPDATE`.

The sweep is started by an entrypoint, never by `buildApp`. `buildApp` stays pure, so the
`app.inject()` suite never starts a timer, and the sweep is tested by calling it directly.
Where a timer is used it is `unref()`d so it cannot hold the process open, and is cleared on
shutdown alongside the existing teardown.

### 7.2 Deployment topology is a runtime choice

The sweep is hygiene, not correctness (§7), so the engine must run correctly whether it is
performed in the API process, in a process of its own, or by the platform's scheduler.
Rather than pick one and bake it into the code, a second entrypoint — `src/worker.ts`,
alongside `src/server.ts` — makes all three available from the same image:

| Command                          | Behaviour                             | Suits                                                    |
| -------------------------------- | ------------------------------------- | -------------------------------------------------------- |
| `node dist/src/server.js`        | API, with the sweep on a timer inside | Development, a single-instance deployment                |
| `node dist/src/worker.js`        | Sweep only, looping                   | A separate service or deployment                         |
| `node dist/src/worker.js --once` | One sweep, then exit                  | A Kubernetes CronJob, a systemd timer, a cloud scheduler |

Compose gains a `worker` service built from the same image with a different `command`, which
is exactly the shape the existing `migrate` service already uses. The Dockerfile does not
change.

The one-shot mode is what makes an external scheduler possible without new code, and it is
strictly better than the obvious alternative of having a scheduler call an HTTP endpoint: the
engine has no authentication, and exposing a mutating internal route would be a poor trade.

**This is where the advisory lock stops being a precaution and starts paying for itself.**
Any combination of the three — three API instances with timers, a worker service beside them,
and a CronJob left over from a previous arrangement — is safe, because exactly one holder wins
each tick and the rest skip. No coordination is needed, because it is already there.

### 7.3 `HOLD_SWEEP_ENABLED` defaults to true, and the default is the point

The flag controls only whether the API process runs the sweep on a timer; `worker.js` always
sweeps.

The tempting configuration when a worker service is deployed is to set it to `false` on the
API instances for a clean separation of duties. **Do not make that the default.** A dead
worker is an invisible failure: correctness does not depend on it, requests keep being served,
nothing alerts, and stale holds accumulate for months. Leaving the API timers on means a
failed worker is covered automatically — whichever process is alive takes the lock — and the
separate service becomes an optimisation rather than a dependency.

Setting it to `false` is a deliberate act, for when request-serving processes should do no
background work at all.

### 7.4 What reads do

Availability never waits for either mechanism: a `held` row whose `held_until` has passed is
excluded by predicate at query time.

Listings report the stored status. A listing is a view of records, and showing `held` for at
most one sweep interval is more honest than reporting a computed status that is not in the
table. The apparent inconsistency resolves itself coherently: a caller who sees `held` and
calls `confirm` receives `410 hold_expired`, which is the truth.

---

## 8. Availability becomes real

For each generated slot:

```
available = (number of active bookings containing the slot) < capacity
```

Active means `confirmed`, or `held` with `held_until > now()`.

**Containing, not overlapping.** Every booking is aligned to the grid, so any active booking
that overlaps a slot contains it entirely, and per-slot occupancy is the count of containing
bookings. Counting overlaps with the requested interval instead would be wrong on a
multi-slot booking in `shared`: two bookings touching opposite ends of a range would report
the middle as occupied when no single slot is.

One query loads the active bookings intersecting the requested range; the counting happens in
memory next to the grid, so the SQL stays simple and the behaviour stays testable without a
database.

The response contract does not change. This is precisely why spec 1 shipped `available` as a
constant.

---

## 9. Code structure

```
src/modules/bookings/
  booking.routes.ts        HTTP layer and TypeBox schemas
  booking.service.ts       lifecycle rules, transactions
  booking.repository.ts    SQL, including lockResource
  booking.schemas.ts
  booking-validator.ts     pure: grid ↔ requested interval
  hold-sweeper.ts          one sweep, and the timer that repeats it
```

Plus one file outside the module: `src/worker.ts`, the second entrypoint of §7.2, beside the
existing `src/server.ts`.

`booking-validator.ts` follows the rule that governs `slot-generator.ts`: **no import from
`src/db/`.** It takes slots, a start and an end, and returns a verdict. The grid arithmetic
that matters is testable in milliseconds without Postgres.

### 9.1 Two changes to spec 1 code

Both are needed by this spec, and both are cheap now and expensive later.

**Window resolution moves out of `AvailabilityService`.** It currently sits inline in
`getAvailability`: exception overrides the weekday schedule, a day off contributes nothing.
Booking validation needs exactly the same resolution, and a copy would diverge from the
original at the first bug fixed in one of them. It becomes its own module consumed by both.

**The availability core takes a loaded resource row instead of an id.** `getAvailability`
currently loads the resource itself, which prevents a caller from computing availability for
several resources it has already loaded. Five lines, and without them spec 3 cannot assemble a
pool's availability as the union over its members.

---

## 10. Configuration

Four additions, read and validated exactly like the existing ones.

| Variable                      | Default | Meaning                                                       |
| ----------------------------- | ------- | ------------------------------------------------------------- |
| `DEFAULT_HOLD_MINUTES`        | `10`    | Applied when `hold: true` carries no minutes                  |
| `MAX_HOLD_MINUTES`            | `60`    | Upper bound accepted from a caller                            |
| `HOLD_SWEEP_INTERVAL_SECONDS` | `60`    | How often the sweep runs, in either entrypoint                |
| `HOLD_SWEEP_ENABLED`          | `true`  | Whether the API process sweeps; `worker.js` sweeps regardless |

The default of `HOLD_SWEEP_ENABLED` is load-bearing rather than cosmetic — §7.3.

---

## 11. Error codes

Added to the catalogue in [conventions.md](../../conventions.md#api-conventions).

| Code                       | Status | Meaning                                                       |
| -------------------------- | ------ | ------------------------------------------------------------- |
| `invalid_interval`         | 400    | `end_time <= start_time`                                      |
| `invalid_slot_boundary`    | 400    | Start or end does not fall on a slot boundary                 |
| `outside_schedule`         | 400    | A slot in the requested run is not offered                    |
| `slot_unavailable`         | 409    | The slots exist and are offered, but capacity is taken        |
| `resource_inactive`        | 409    | The resource exists but `is_active` is false                  |
| `invalid_state_transition` | 409    | The requested transition is not legal from the current status |
| `resource_has_bookings`    | 409    | `DELETE /resources/:id` with bookings on record               |
| `idempotency_key_reused`   | 409    | Same key, different request body                              |
| `hold_expired`             | 410    | `confirm` on a hold whose `held_until` has passed             |

`slot_unavailable` and `outside_schedule` mean different things and must not be conflated: the
first says the slots are offered but taken, the second that they were never offered.

---

## 12. What this spec guarantees for spec 3

The pool data model was settled during this design so that spec 2 could avoid closing doors.
It is not built here.

**A pool is a resource with `concurrency_mode = 'pool'`; its members are ordinary resources
carrying a `pool_id` foreign key back to it.** Each member is a full resource with its own
schedule, exceptions and `is_active`.

That last property is the entire justification for the mode. A hotel with ten interchangeable
rooms is already expressible as `shared` with `capacity = 10`, and which physical room a guest
receives is a domain concern. `pool` earns its place only because a member can be individually
unavailable — room 101 goes out of service on the 20th while 102 keeps selling — which a
scalar capacity cannot express. The pool's effective capacity is therefore **derived** from
its count of active members and not stored; storing both would create a divergence with no
owner.

Three properties of this spec are what make that addition cheap:

1. **`bookings.resource_id` always references a concrete resource, never a pool.** Booking
   against a pool becomes "choose a member, then run the path this spec already implements".
   The exclusion constraint keys on `resource_id`, so a booking pointing at a pool would
   silently disable it.
2. **The lock is a named primitive, not an inline statement.** Spec 3 adds a `pool` branch
   beside the `shared` one, most likely selecting a free member with `FOR UPDATE SKIP LOCKED`
   — the canonical claim-a-free-unit pattern, which gives concurrent bookings different
   members without waiting.
3. **The availability core takes a resource row** (§9.1), so a pool's availability is the
   union over its members with no change to the generator.

### 12.1 One trap this spec sets for spec 3, deliberately recorded

**`pool` is now fail-open rather than fail-closed, and spec 3 must close it before it stores a
single pool booking.**

The mode-aware predicate of §2.3 names `exclusive` only, and the capacity count of §6.2 runs
only for `shared`. A booking row carrying `concurrency_mode = 'pool'` would therefore be
governed by neither: overlapping bookings on it would be accepted without limit. Before the
predicate was narrowed, the constraint over-restricted such a row, which was the safe
direction to be wrong in.

Nothing can reach that state today — a resource with `concurrency_mode: 'pool'` is refused at
creation with `400 unsupported_concurrency_mode` — so this is a latent trap rather than a live
defect. It is recorded because the trap springs quietly: spec 3 could lift the creation
refusal, wire up member selection, and silently overbook every pool until someone counted.

The cheap guard, if spec 3 wants one before it is ready to implement pooling properly, is to
make the mode branch in `BookingService.create` exhaustive — a `switch` that throws on an
unhandled mode rather than an `if` that falls through to "no lock, no count".

Added to [conventions.md](../../conventions.md#deliberate-limitations) alongside spec 1's.

| Limitation                                   | Why                                                                                                                                   | Cost to lift                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Bookings in the past are accepted            | The engine reads no clock; availability offers past slots, and "anything offered is bookable" follows. Back-dated entry is legitimate | A validation rule, if a domain ever wants it     |
| A schedule edit may orphan existing bookings | Refusing it would freeze a schedule around a single distant booking, and the remedy is a business decision                            | A conflict query on `PUT`, and a policy to apply |
| `shared` serializes writes per resource      | One row lock is the whole mechanism; bookings for one resource on unrelated dates still queue behind each other                       | SERIALIZABLE plus a retry loop; schema unchanged |
| No pagination on listings                    | Both listings are bounded by a required window of at most `MAX_RANGE_DAYS`, as everywhere else in the engine                          | Keyset pagination on `(start_time, id)`          |
| No automatic completion                      | An automatic transition at `end_time` would make `no_show` unreachable                                                                | Not planned; the distinction is the caller's     |

---

## 14. Testing strategy

Test-driven, and following the conventions: cases live in datasets, suites consume them, and
the same datasets drive both the in-process suite and `./run smoke`. A new area costs a
dataset, a suite and one line in `tests/fixtures/suites/index.ts`; the runner is untouched.

### 14.1 Unit — `booking-validator.ts`, no database

- Start exactly on a boundary, one minute before it, one minute after it.
- A run that leaves the offered window part-way through → `outside_schedule`.
- An end that steps past the last slot → `invalid_slot_boundary`.
- A two-night hotel stay anchored at 14:00 across the spring transition: 47 real hours, two
  slots, valid. The same interval expressed as 48 hours is not.
- A booking that starts before its own date's grid because of a small anchor, exercising the
  extra day of §3.1.

### 14.2 Integration — real Postgres

- The exclusion constraint rejects an overlapping booking; touching bookings are accepted.
- An expired hold stops blocking within the same request, with no worker running.
- `shared` with capacity N: the Nth booking succeeds, the N+1st is `409 slot_unavailable`.
- **Two genuinely concurrent requests for the last unit: exactly one `201` and one `409`.**
  Both promises are started before either is awaited, so the contention at the database is
  real.
- `reschedule` does not block itself, in both modes.
- `DELETE /resources/:id` with bookings is `409 resource_has_bookings`, and `RESTRICT` holds
  independently at the database level.
- Idempotency: a replay returns the same booking with `200`; the same key with a different
  body is `409`.
- The transition matrix as a dataset: every from/to pair with its expected status or code,
  including the no-op successes of §5.
- Availability reflects bookings: a booked slot comes back `available: false`, and a slot at
  capacity in `shared` likewise.
- The sweep expires exactly the stale holds and leaves live ones alone, and a second sweeper
  running concurrently takes no lock and does no work rather than duplicating it.
- `HOLD_SWEEP_ENABLED` parses like the other configuration values, defaulting to true — a unit
  test beside the existing ones in `config.test.ts`.

**Time is controlled through the database, not through JavaScript.** `held_until` is compared
against Postgres's `now()`, so faking timers in Node would change nothing. Tests set
`held_until` into the past with SQL — deterministic, and with no waiting.

---

## 15. Documents to update

- **architecture.md** — the slice status table; `expired` in the booking status list; `GET
/bookings/:id`; the note that `reschedule` updates one row rather than performing cancel plus
  book; the pool model settled in §12.
- **conventions.md** — the nine error codes of §11; the lock-ordering rule of §6.5; the five
  limitations of §13; the four configuration variables of §10.
- **test-cases.md** — every behaviour promised here as a runnable case with its coverage.
- **README.md** — the endpoint table, the configuration variables, the known-limitations
  paragraph, and the three sweep topologies of §7.2.
- **docker-compose.yml** — a `worker` service from the same image with a different `command`,
  mirroring the existing `migrate` service.
- **.env.example** — the four new variables.

---

## 16. Definition of done

- Every endpoint of §4 implemented and covered by the tests of §14.
- `npm test` passes from a clean checkout with Docker running.
- `npm run migrate` brings a spec 1 database to the schema of §2.
- `./run smoke` passes against a running engine, exercising the same datasets.
- TypeScript compiles with no errors under `strict`; `npm run check` is clean.
- A `grep` for `db/` in `booking-validator.ts` comes back empty.
- All three sweep topologies of §7.2 start from the built image: `server.js`, `worker.js`, and
  `worker.js --once`, the last exiting with status 0.
- The documents of §15 are updated in the same branch, not left for later.
