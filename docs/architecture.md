# Universal Booking Engine — Architecture

## Overview

A domain-agnostic booking engine that operates on abstractions: resource, schedule, booking. It has no knowledge of what is being booked — doctors, tennis courts, hotel rooms, or anything else. Domain-specific logic lives in a separate layer above the engine, with its own tables referencing `resource_id`.

## Status

This document is **authoritative for what the system does today**. Where it disagrees with a slice spec, this document is right and the spec is stale: a spec states what was decided on its date and is not revised to match later work. Closing such a gap means correcting this document, not consulting the spec.

The system was delivered in four slices, all implemented:

| Slice | Content                                                              |
| ----- | -------------------------------------------------------------------- |
| 1     | Resources, schedule, exceptions, availability                        |
| 2     | Bookings: `exclusive` and `shared`, lifecycle, hold expiry, listings |
| 3     | `pool` concurrency mode                                              |
| 4     | Multitenancy, API keys, the key console                              |

The specs in [superpowers/specs/](superpowers/specs/) are **decision records**. Read one to learn _why_ something has the shape it does — never to learn what it does. The executed plans in [superpowers/plans/archive/](superpowers/plans/archive/) are spent scaffolding, kept for provenance and outside the reading path.

Formats, error codes, the technology stack, code layout and testing rules are **not** repeated here. They live in [conventions.md](conventions.md), authoritative on the same terms and applying to every slice. Rules that hold across projects come from the shared `dev-kit` package, imported by [CLAUDE.md](../CLAUDE.md); `tsconfig.json` extends its Node base and Prettier takes its configuration.

---

## Tenancy

_Spec 4._ Every row belongs to a tenant. `resources`, `schedule`, `schedule_exceptions` and
`bookings` each carry a `tenant_id`, and the child tables reference their resource through a
**composite** foreign key on `(tenant_id, resource_id)`, so a row whose tenant disagrees with
its resource's has no referent and cannot be written. Repositories take `tenantId` as a
required first parameter, which makes a forgotten filter a compile error rather than a leak.

Callers authenticate with an API key carrying a set of scopes; the rules are in
[conventions.md](conventions.md#authentication-and-scopes). Keys are issued from a console that
runs as a **separate entrypoint bound to `127.0.0.1`** and has no authentication of its own —
that is safe only because the port is unreachable from elsewhere, which is why the bind address
is hard-coded rather than configurable.

Where the console cannot be reached — a consumer's test harness, or the compose stack, where
the console's loopback bind leaves no published port that reaches it — `issue-keys` does the
same job as a one-shot command: it creates a tenant, issues one key per preset, prints them as
one JSON line and exits. It needs `DATABASE_URL`, the trust the migrator already has, and opens
no port. A version tag publishes the image and a test helper, `testing/`, that starts that
image's Postgres, migrations, `issue-keys` and API for a consumer's suite.

## Data Model

### Tenant

The owner of every other row. Created only from the console or `issue-keys`; the API never creates one.

| Column     | Type                  | Description                                                                 |
| ---------- | --------------------- | --------------------------------------------------------------------------- |
| id         | UUID, PK              |                                                                             |
| name       | text, NOT NULL        | A human label for the console. CHECKed non-blank; the engine never reads it |
| is_active  | boolean, default true | False retires every key the tenant owns at once, without revoking each      |
| created_at | timestamptz, `now()`  |                                                                             |

The owned tables reference this with `ON DELETE RESTRICT`. A tenant with rows cannot be deleted out from under them, and deactivating is the reversible way to switch one off.

### ApiKey

One key belongs to one tenant and carries a set of scopes. The secret half is never stored.

| Column       | Type                   | Description                                                                        |
| ------------ | ---------------------- | ---------------------------------------------------------------------------------- |
| id           | UUID, PK               |                                                                                    |
| tenant_id    | UUID, FK → Tenant      | `ON DELETE CASCADE` — a key has no meaning without its tenant                      |
| name         | text, NOT NULL         | What the key is for, shown in the console. CHECKed non-blank                       |
| key_prefix   | text, NOT NULL, UNIQUE | The lookup handle, stored in the clear                                             |
| key_hash     | text, NOT NULL         | SHA-256 of the secret half                                                         |
| scopes       | text[], NOT NULL       | CHECKed non-empty and contained in the known set — a second copy of the vocabulary |
| created_at   | timestamptz, `now()`   |                                                                                    |
| last_used_at | timestamptz            | Stamped at most once a minute: a liveness signal, not a request count              |
| revoked_at   | timestamptz            | Set rather than deleted, so the audit trail survives the key                       |

A key is `bk_live_` followed by an 8-character prefix and a 43-character secret. The prefix is what the lookup index finds; the secret is compared against `key_hash` in constant time and appears in one HTTP response, ever.

**SHA-256 rather than argon2 or bcrypt.** Those are slow on purpose because human passwords have little entropy and must survive an offline attack. This secret is 43 base62 characters from a CSPRNG — roughly 256 bits — so there is no search to slow down, and a per-request argon2 would add ~100 ms to every call to defend against an attack that cannot succeed either way.

The lookup index is partial, `WHERE revoked_at IS NULL`: authentication only ever asks for live keys, and revoked ones accumulate forever.

### Resource

An abstract bookable unit. Contains only the parameters the engine needs — no domain-specific fields.

| Column           | Type                      | Description                                                                                                                                                                       |
| ---------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id               | UUID, PK                  |                                                                                                                                                                                   |
| tenant_id        | UUID, FK → Tenant         | The owner. Unique on `(tenant_id, id)`, which the children reference                                                                                                              |
| timezone         | text, NOT NULL            | **Named** IANA zone (e.g. `Europe/Warsaw`). Fixed offsets are rejected                                                                                                            |
| is_active        | boolean, default true     | Soft-disable without deleting                                                                                                                                                     |
| slot_duration    | interval, NOT NULL        | Booking quantum. `P1D` and `PT24H` are different values                                                                                                                           |
| slot_anchor_time | time, NOT NULL, `00:00`   | Where a day-based resource's day begins — a hotel with 14:00 check-in                                                                                                             |
| capacity         | integer, default 1        | Max concurrent bookings per slot                                                                                                                                                  |
| concurrency_mode | text, NOT NULL            | `exclusive` · `shared` · `pool`                                                                                                                                                   |
| pool_id          | UUID, FK → Resource, NULL | The pool this resource belongs to. NULL for a standalone resource and for a pool row itself. Composite FK on `(tenant_id, pool_id)`, `ON DELETE RESTRICT`. Membership rules below |
| created_at       | timestamptz, `now()`      |                                                                                                                                                                                   |
| updated_at       | timestamptz, `now()`      |                                                                                                                                                                                   |

**`slot_duration` is a real Postgres `interval`, not a minute count**, so that `P1D` and `PT24H` remain distinguishable — see [the duration grammar](conventions.md#duration-grammar) and [the timezone rules](conventions.md#timezones) for the formats and why they matter.

**`slot_anchor_time` exists so a day that does not begin at midnight is expressible.** A hotel with 14:00 check-in sets `14:00`, and its nightly slot runs 14:00 → 14:00. Without it, every domain would re-implement the same translation between calendar dates and engine timestamps. The field is not a domain concept: it is a slicing parameter of the same class as `slot_duration`, and the engine still does not know a hotel is behind it.

The slot grid for a date starts at the schedule window's `start_time`, or at `slot_anchor_time` when that is NULL. Calendar-day semantics are simply the default value `00:00`, so there is one rule and no branch.

**Concurrency modes:**

- **exclusive** (`capacity = 1`) — one slot, one booking. Doctor, tennis court.
- **shared** (`capacity = N`) — one slot, up to N bookings. Group class, restaurant table.
- **pool** — a group of interchangeable resources. Hotel rooms of the same type. A pool is a resource whose members are ordinary `exclusive` resources carrying a `pool_id` foreign key back to it, each with its own schedule, exceptions and `is_active`; the pool's capacity is derived from the count of its active members rather than stored; and `bookings.resource_id` always points at a member, never at the pool itself. Booking a pool claims a free member with `FOR UPDATE SKIP LOCKED`, availability is the union over active members — both resolve every member's slots through one function, `memberSlots`, from two batched queries, whatever the member count — and an idempotency key locks the pool row before a member is selected, so a replayed key cannot land on two different members.

The mode earns its place on one property that a scalar `capacity` cannot express: **a member can be individually unavailable.** Room 101 goes out of service on the 20th while 102 keeps selling. Ten interchangeable rooms with no such requirement are already expressible as `shared` with `capacity = 10`.

**Domain layer** stores characteristics in its own tables:

```
DoctorProfile
  ├── resource_id       → FK to Resource
  ├── specialization
  └── license_number

TennisCourt
  ├── resource_id       → FK to Resource
  ├── surface_type
  └── is_indoor
```

The engine never sees these tables. Grouping, filtering, and categorization are the domain's responsibility.

### Pool membership

`pool_id` is set on `POST /resources` and changed on `PATCH /resources/:id`. It is **not** immutable, unlike `timezone` and `concurrency_mode`, because `DELETE /resources/:id` is refused once a resource has any booking — an immutable membership would strand a room that had ever been booked in its original pool forever, with the delete-and-recreate escape hatch closed to exactly the rows needing it.

Four rules are checked whenever `pool_id` is set to a non-NULL value:

1. **The target exists and belongs to the caller's tenant.** The composite foreign key already makes a cross-tenant pool unwritable; the service checks first so the answer is a `404` rather than a constraint violation, and so the caller learns nothing about other tenants.
2. **The target is a pool** — `concurrency_mode = 'pool'`. Attaching a room to another room has no meaning here.
3. **The joining resource is `exclusive`.** This forbids both nesting and a `shared` member. Derived capacity is a count of active members, true only while each holds one booking at a time.
4. **The grid matches.** `timezone`, `slot_duration` and `slot_anchor_time` must be identical to the pool's, because a pool needs exactly one grid to validate a request against _before_ a member is chosen — otherwise `invalid_slot_boundary` would depend on which member was checked last. Members still differ where the mode's justification lives: schedule, exceptions and `is_active`.

Rules 2 and 3 cannot be `CHECK` constraints because they read another row; rule 4 could be a trigger but is not, since cross-row rules live in services here. A patch that would break rule 4 — changing a member's `slot_duration`, or a pool's — is refused, because the engine validates the resulting state rather than the patch.

**Members are first-class.** `GET /resources` lists them alongside pools, and `POST /resources/{memberId}/bookings` books one directly, which serves the domain that must honour "the guest asked for room 101". The accepted consequence is that the abstraction is porous: a caller can bypass selection.

### Schedule

Regular weekly availability for a resource.

| Column      | Type                | Description                           |
| ----------- | ------------------- | ------------------------------------- |
| id          | UUID, PK            |                                       |
| tenant_id   | UUID, FK → Tenant   | Composite FK with `resource_id`       |
| resource_id | UUID, FK → Resource |                                       |
| day_of_week | integer, 0–6        | Monday = 0, Sunday = 6                |
| start_time  | time                | NULL for day-based resources (hotels) |
| end_time    | time                | NULL for day-based resources (hotels) |

When the schedule changes, delete old rules and insert new ones. The engine stores only the current state — no history. Audit logging, if needed, is handled above.

Three rules govern a submitted schedule as a whole, because they span rows and cannot be expressed as column constraints:

- **Shape must match the duration.** A day-based resource (`P<n>D`) takes rules with NULL times, at most one per weekday. An intraday resource (`PT…`) requires both times on every rule.
- **Windows on one weekday must not overlap.** Touching endpoints are fine: 09:00–12:00 and 12:00–17:00 are two windows, not an overlap.
- **`start_time < end_time`.** A window crossing midnight is refused — see [the limitations table](conventions.md#deliberate-limitations) for why, and what lifting it would cost.

### ScheduleException

Overrides for specific dates: a day off or altered hours.

| Column      | Type                | Description                     |
| ----------- | ------------------- | ------------------------------- |
| id          | UUID, PK            |                                 |
| tenant_id   | UUID, FK → Tenant   | Composite FK with `resource_id` |
| resource_id | UUID, FK → Resource |                                 |
| date        | date, NOT NULL      | The date being overridden       |
| start_time  | time                | NULL = day off                  |
| end_time    | time                | NULL = day off                  |

Unique on `(resource_id, date)`, which is what makes `PUT …/exceptions/:date` idempotent. An exception **replaces** the weekly schedule for its date entirely; it never merges with it. A day off is expressible for any resource, but altered hours only make sense for an intraday one — a day-based resource has no hours to alter.

### Why some times are stored local and others absolute

Booking timestamps are absolute instants and use `timestamptz`; schedule times and exception dates are wall-clock statements and keep their local form. [conventions.md](conventions.md#local-time-versus-absolute-time) explains the distinction and why converting a schedule to UTC breaks it twice a year.

Applied to this model: `timezone` and `concurrency_mode` are immutable after creation. The obstacle is not data migration — bookings are already stored in UTC and no row would move — but reinterpretation: `09:00–17:00` would come to denote a different set of instants, and existing bookings could fall outside the working windows.

### Booking

A booking record. No domain fields (notes, guest count, etc.) — those belong to the domain layer.

| Column           | Type                       | Description                                                              |
| ---------------- | -------------------------- | ------------------------------------------------------------------------ |
| id               | UUID, PK                   |                                                                          |
| tenant_id        | UUID, FK → Tenant          | Composite FK with `resource_id`                                          |
| resource_id      | UUID, FK → Resource        |                                                                          |
| start_time       | timestamptz, NOT NULL      |                                                                          |
| end_time         | timestamptz, NOT NULL      |                                                                          |
| status           | text, NOT NULL             | `held` · `confirmed` · `cancelled` · `completed` · `no_show` · `expired` |
| customer_id      | text                       | Opaque external identifier. Optional — see below                         |
| concurrency_mode | text, NOT NULL             | Copied from the resource, because the exclusion predicate cannot read it |
| held_until       | timestamptz                | Set on `held` and `expired`; NULL otherwise                              |
| idempotency_key  | text                       | Optional; unique per `(resource_id, idempotency_key)`. Never returned    |
| created_at       | timestamptz, default now() |                                                                          |
| updated_at       | timestamptz, default now() |                                                                          |

`customer_id` is optional because a caller keeping its own guest records has no need for the
engine to hold one. It survived rather than being dropped because the engine **queries** by it:
it is indexed, it backs `GET /bookings?customer_id=`, and it is one of the three fields that
define what an idempotency key stands for. That is what separates it from arbitrary domain
payload, which the engine still refuses to store.

**Overlap prevention (exclusive, capacity = 1):**

```sql
ALTER TABLE bookings
  ADD COLUMN time_range tstzrange
    GENERATED ALWAYS AS (tstzrange(start_time, end_time)) STORED;

ALTER TABLE bookings
  ADD CONSTRAINT bookings_no_overlap
    EXCLUDE USING gist (
      resource_id WITH =,
      time_range  WITH &&
    )
    WHERE (status IN ('held', 'confirmed') AND concurrency_mode = 'exclusive');
```

The mode is part of the predicate, not just of the heading: without it the second overlapping booking on a `shared` resource would be refused here and the mode would be unreachable. The predicate cannot read `resources`, which is why the mode is copied onto the booking — it is immutable on the resource, so the copy cannot drift.

For `capacity > 1` the invariant is a count rather than disjointness, so it is carried by `SELECT COUNT(*)` under the resource row lock inside a transaction — see [the concurrency rules](conventions.md#concurrency).

---

## Booking Lifecycle

```
held ──→ confirmed ──→ completed
  │           │
  │           ├──→ cancelled
  │           └──→ no_show
  ├──→ cancelled
  └──→ expired (held_until elapsed, swept in-transaction or by the background worker)
```

Two flows, chosen per booking, but both are a single `INSERT`:

- **Instant:** `hold` omitted or false → the row is inserted `confirmed`, `held_until = NULL`.
- **Two-step:** `hold: true` → the row is inserted `held`, `held_until` set from
  `hold_minutes`; a later `confirm` moves it to `confirmed`.

The status is resolved before the transaction opens; there is no separate `hold()` call
composed with `confirm()` underneath `POST /resources/:id/bookings`.

---

## Availability Calculation

```
getAvailability(resource, from, to):

  for each date in [from, to):
    1. Check ScheduleException for this date
       → start/end are NULL  → day off, skip
       → start/end are set   → use them
       → no exception exists → use Schedule by day_of_week

    2. Get the availability window for the date

  3. Subtract existing bookings (status IN held, confirmed)
  4. Slice by slot_duration, starting the grid at the window's start_time
     or, when that is NULL, at the resource's slot_anchor_time
  5. Return list of slots with available flag
```

Step 3 arrived with spec 2. Occupancy is counted **per slot**, and a booking counts against a slot when it overlaps it: a slot is `available: false` once `capacity` active bookings overlap it, and one multi-slot booking marks every slot it touches.

All local-time arithmetic runs through a timezone-aware library with the resource's zone, which is what makes a `P1D` slot span 23, 24 or 25 real hours across a transition while still running from local anchor to local anchor. A trailing remainder shorter than one slot is dropped: a 09:00–17:30 window with a one-hour slot yields eight slots.

**Booking validation:**

A booking must line up with the slots the engine actually offers, so the rule is stated in terms of the grid rather than as arithmetic on durations:

```
validate(resource, start, end):
  1. end must be after start                → 400 invalid_interval
  2. start must fall on a slot boundary     → 400 invalid_slot_boundary
  3. end must fall on a slot boundary       → 400 invalid_slot_boundary
  4. every slot in between must be offered  → 400 outside_schedule
     by the schedule or an exception
```

Equivalently: **the requested interval must equal a contiguous run of the slots `getAvailability` returns for that period.** Booking and availability then share a single definition — anything offered is bookable, anything bookable was offered — and there is one implementation of the grid rather than two that can drift apart.

Slot boundaries are positions in the resource's local time, produced by the same cursor that generates availability: start at the window's `start_time` or at `slot_anchor_time`, then step by `slot_duration` with a timezone-aware `plus`.

Why not `duration % slot_duration == 0`, as an earlier draft of this document had it:

- **The anchor moves the grid off midnight.** `14:00 → 14:00` and `15:00 → 15:00` are both 24 hours, but on a hotel anchored at 14:00 only the first lands on the grid. A duration alone cannot tell them apart.
- **Elapsed time is not slot count across a DST transition.** A night from the 28th 14:00 to the 29th 14:00 is 23 real hours in `Europe/Warsaw`, so a modulo over 24 hours rejects a perfectly ordinary booking twice a year.
- **A day-based stay is not a whole number of hours anyway.** Two nights from the 20th at 14:00 to the 22nd at 11:00 is 45 hours. Expressed against the grid it is exactly two slots — `[20th 14:00, 22nd 14:00)` — and the 11:00–14:00 gap becomes cleaning buffer inside the second slot. That is design principle #3 applied literally: the engine books whole slots, and the domain presents the 11:00 checkout.

`409 slot_unavailable` is a separate answer, and it means something different: the slots exist and are offered, but capacity for them is already taken.

---

## API Contracts

Every path, parameter, request field, response field and status code is generated from the same TypeBox schemas the routes validate against. Error statuses are built from the error classes, the ones every route shares come from one rule table, and two tests fail any status a route answers without declaring it — see the conventions, _Documentation is generated, never written twice_. It lives in [openapi.json](../openapi.json), committed at the repository root and rendered at `/docs`.

**It is deliberately not restated here.** A second description of the API is a copy, and a copy drifts — this section used to hold one, and it did. `tests/integration/openapi.test.ts` asserts the generated document against the running routes, which is a guarantee no prose can offer.

What follows is what a schema cannot express: why a contract has the shape it does.

**Resources.** `timezone` and `concurrency_mode` are absent from the `PATCH` body on purpose. Both are immutable, and an unknown field is rejected rather than ignored, so an attempt to change either fails loudly instead of appearing to succeed.

**Schedule.** `PUT .../schedule` replaces the whole schedule atomically. It is not a merge, and a rejected submission writes nothing.

**Schedule exceptions.** `PUT .../exceptions/:date` is idempotent by date — repeated calls overwrite. An exception replaces the weekly schedule for its date entirely and never merges with it.

**Availability.** One slot format for every kind of resource, hourly or daily or otherwise; timestamp and range formats follow [the shared conventions](conventions.md#time-and-date-representation). An inactive resource answers `200` with an empty slot list: it exists, so `404` would be wrong, but it is not bookable, so offering slots would mislead.

**Bookings.** Every lifecycle action answers the whole booking, in the same shape `GET /bookings/:id` returns. `idempotency_key` is never one of those fields: it is what the caller sent, not something the engine reports back. A request replaying a key answers `200` where the original answered `201`.

`reschedule` updates the times of the same row, keeping its id and its status. An exclusion constraint never compares a row with itself, so a single `UPDATE` is safe; if the new slots are unavailable the booking is left unchanged.

**Listing bookings.** Two perspectives: by resource ("what's booked on this court") and by customer ("all my bookings"). Both require a `from`/`to` window, which is what stands in for pagination — see [the limitations table](conventions.md#deliberate-limitations).

---

## Design Principles

1. **The engine is domain-agnostic.** No domain fields, types, or categories. Ever.
2. **Domain stores its own data** in separate tables with a FK to `resource_id`.
3. **Buffer time is the domain's responsibility** — bake it into `slot_duration` (e.g. 60 min slot for a 45 min appointment + 15 min cleanup). For a day-based resource the same principle works through `slot_anchor_time`: a hotel's 11:00–14:00 cleaning gap sits inside the slot.
4. **No schedule history** in the engine. Audit trails are handled above.
5. **Concurrency safety** via Postgres exclusion constraints for exclusive resources, and transactional `COUNT + FOR UPDATE` for shared resources.
6. **Unified slot format** for availability responses regardless of slot duration (minutes or days).
7. **Wall-clock time is stored as wall-clock time.** Anything that is a statement about a clock face or a calendar keeps its local form; only actual instants become `timestamptz`.
8. **Reject rather than silently accept.** A fixed offset where a zone belongs, an unknown field in a patch body, a concurrency mode the engine cannot serve — all fail loudly. Each of these would otherwise produce a system that looks like it worked.

---

## Implementation notes

- The exclusion constraint on `bookings` needs the `btree_gist` extension, to combine `uuid WITH =` and `tstzrange WITH &&` in one GiST index. `002_bookings.ts` creates it as its first statement.
- `DELETE /resources/:id` answers `409 resource_has_bookings` once a resource has any booking, with `ON DELETE RESTRICT` behind it.
- Booking validation reuses the availability grid rather than duplicating it: `booking.service.ts` calls `generateSlots`, and `booking-validator.ts` checks the request against the slots it produced. Neither reimplements the stepping, and the validator imports nothing from `src/db/`.
