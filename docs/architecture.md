# Universal Booking Engine — Architecture

## Overview

A domain-agnostic booking engine that operates on abstractions: resource, schedule, booking. It has no knowledge of what is being booked — doctors, tennis courts, hotel rooms, or anything else. Domain-specific logic lives in a separate layer above the engine, with its own tables referencing `resource_id`.

## Status

This document describes the whole system. It is delivered in three slices, each with its own spec in [superpowers/specs/](superpowers/specs/):

| Slice | Content                                                              | State                               |
| ----- | -------------------------------------------------------------------- | ----------------------------------- |
| 1     | Resources, schedule, exceptions, availability                        | **Implemented**                     |
| 2     | Bookings: `exclusive` and `shared`, lifecycle, hold expiry, listings | **Implemented**                     |
| 3     | `pool` concurrency mode                                              | Sketched here, needs its own design |
| 4     | Multitenancy, API keys, the key console                              | **Implemented**                     |

Where this document and a spec disagree about something already built, **the spec wins** — it was written against the implementation. This document stays the system-level map.

Formats, error codes, the technology stack, code layout and testing rules are **not** repeated here. They live in [conventions.md](conventions.md), which applies to every slice.

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

## Data Model

### Resource

An abstract bookable unit. Contains only the parameters the engine needs — no domain-specific fields.

| Column           | Type                    | Description                                                            |
| ---------------- | ----------------------- | ---------------------------------------------------------------------- |
| id               | UUID, PK                |                                                                        |
| tenant_id        | UUID, FK → Tenant       | The owner. Unique on `(tenant_id, id)`, which the children reference   |
| timezone         | text, NOT NULL          | **Named** IANA zone (e.g. `Europe/Warsaw`). Fixed offsets are rejected |
| is_active        | boolean, default true   | Soft-disable without deleting                                          |
| slot_duration    | interval, NOT NULL      | Booking quantum. `P1D` and `PT24H` are different values                |
| slot_anchor_time | time, NOT NULL, `00:00` | Where a day-based resource's day begins — a hotel with 14:00 check-in  |
| capacity         | integer, default 1      | Max concurrent bookings per slot                                       |
| concurrency_mode | text, NOT NULL          | `exclusive` · `shared` · `pool`                                        |
| created_at       | timestamptz, `now()`    |                                                                        |
| updated_at       | timestamptz, `now()`    |                                                                        |

**`slot_duration` is a real Postgres `interval`, not a minute count**, so that `P1D` and `PT24H` remain distinguishable — see [the duration grammar](conventions.md#duration-grammar) and [the timezone rules](conventions.md#timezones) for the formats and why they matter.

**`slot_anchor_time` exists so a day that does not begin at midnight is expressible.** A hotel with 14:00 check-in sets `14:00`, and its nightly slot runs 14:00 → 14:00. Without it, every domain would re-implement the same translation between calendar dates and engine timestamps. The field is not a domain concept: it is a slicing parameter of the same class as `slot_duration`, and the engine still does not know a hotel is behind it.

The slot grid for a date starts at the schedule window's `start_time`, or at `slot_anchor_time` when that is NULL. Calendar-day semantics are simply the default value `00:00`, so there is one rule and no branch.

**Concurrency modes:**

- **exclusive** (`capacity = 1`) — one slot, one booking. Doctor, tennis court.
- **shared** (`capacity = N`) — one slot, up to N bookings. Group class, restaurant table.
- **pool** — a group of interchangeable resources. Hotel rooms of the same type. **Not implemented:** the engine currently refuses `pool` with `400 unsupported_concurrency_mode`. The data model is settled: a pool is a resource whose members are ordinary resources carrying a `pool_id` foreign key back to it, each with its own schedule, exceptions and `is_active`; the pool's capacity is derived from the count of its active members rather than stored; and `bookings.resource_id` always points at a member, never at the pool itself. Wiring up member selection and enforcing the invariant is spec 3.

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

| Column      | Type                       | Description                                                              |
| ----------- | -------------------------- | ------------------------------------------------------------------------ |
| id          | UUID, PK                   |                                                                          |
| tenant_id   | UUID, FK → Tenant          | Composite FK with `resource_id`                                          |
| resource_id | UUID, FK → Resource        |                                                                          |
| start_time  | timestamptz, NOT NULL      |                                                                          |
| end_time    | timestamptz, NOT NULL      |                                                                          |
| status      | text, NOT NULL             | `held` · `confirmed` · `cancelled` · `completed` · `no_show` · `expired` |
| customer_id | text                       | Opaque external identifier. Optional — see below                         |
| held_until  | timestamptz                | Set on `held` and `expired`; NULL otherwise                              |
| created_at  | timestamptz, default now() |                                                                          |

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
  ADD CONSTRAINT no_overlap
    EXCLUDE USING gist (
      resource_id WITH =,
      time_range  WITH &&
    )
    WHERE (status IN ('held', 'confirmed'));
```

For `capacity > 1`: use `SELECT COUNT(*) ... FOR UPDATE` inside a transaction.

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

Step 3 arrives with spec 2; until then every returned slot is free, and the `available` flag ships already so the contract does not change when bookings land.

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

### Resources

```
GET    /resources?is_active=
  → 200 [ { id, timezone, slot_duration, slot_anchor_time, capacity, concurrency_mode, is_active }, ... ]

POST   /resources
  body: { timezone, slot_duration, slot_anchor_time?, capacity?, concurrency_mode }
  → 201 { id, timezone, slot_duration, slot_anchor_time, capacity, concurrency_mode, is_active }

GET    /resources/:id
  → 200 { id, timezone, slot_duration, slot_anchor_time, capacity, concurrency_mode, is_active }

PATCH  /resources/:id
  body: { slot_duration?, slot_anchor_time?, capacity?, is_active? }
  → 200 { id, ... }

DELETE /resources/:id
  → 204
```

`timezone` and `concurrency_mode` are absent from the PATCH body on purpose: both are immutable, and an unknown field is rejected rather than ignored, so an attempt to change them fails loudly instead of appearing to succeed.

### Schedule

```
GET    /resources/:id/schedule
  → 200 [ { id, day_of_week, start_time, end_time }, ... ]

PUT    /resources/:id/schedule
  body: [ { day_of_week, start_time, end_time }, ... ]
  → 200 [ ... ]
```

PUT replaces the entire schedule atomically.

### Schedule Exceptions

```
GET    /resources/:id/exceptions?from=&to=
  → 200 [ { id, date, start_time, end_time }, ... ]

PUT    /resources/:id/exceptions/:date
  body: { start_time, end_time }
  → 200 { id, date, start_time, end_time }

DELETE /resources/:id/exceptions/:date
  → 204
```

PUT by date is idempotent — repeated calls overwrite.

### Availability (read-only)

```
GET    /resources/:id/availability?from=2026-07-20&to=2026-07-22
  → 200 {
      slots: [
        { start: "2026-07-20T09:00:00+02:00", end: "2026-07-20T10:00:00+02:00", available: true },
        { start: "2026-07-20T10:00:00+02:00", end: "2026-07-20T11:00:00+02:00", available: false },
        ...
      ]
    }
```

Unified format for all resource types — hourly, daily, or otherwise. Timestamp and range formats follow [the shared conventions](conventions.md#time-and-date-representation).

An inactive resource answers with an empty slot list: it exists, so 404 would be wrong, but it is not bookable, so slots would mislead.

### Bookings

```
POST   /resources/:id/bookings
  body: {
    customer_id?,
    start_time,
    end_time,
    hold?: true,
    hold_minutes?: 10
  }
  → 201 { id, resource_id, start_time, end_time, status, held_until }
  → 409 { error: "slot_unavailable" }

GET    /bookings/:id
  → 200 { id, resource_id, start_time, end_time, status, customer_id, held_until }
  → 404 { error: "not_found" }

POST   /bookings/:id/confirm
  → 200 { id, status: "confirmed" }
  → 410 { error: "hold_expired" }

POST   /bookings/:id/cancel
  → 200 { id, status: "cancelled" }

POST   /bookings/:id/reschedule
  body: { start_time, end_time }
  → 200 { id, start_time, end_time, status }
  → 400 { error: "invalid_slot_boundary" }
  → 404 { error: "not_found" }
  → 409 { error: "slot_unavailable" }

POST   /bookings/:id/complete
  → 200 { id, status: "completed" }

POST   /bookings/:id/no-show
  → 200 { id, status: "no_show" }
```

`reschedule` updates the times of the same row, keeping its id and status. An exclusion constraint never compares a row with itself, so a single `UPDATE` is safe; if the new slots are unavailable the booking is left unchanged.

### Listing Bookings

```
GET    /resources/:id/bookings?from=&to=&status=
  → 200 [ { id, start_time, end_time, status, customer_id }, ... ]

GET    /bookings?customer_id=&from=&to=&status=
  → 200 [ ... ]
```

Two perspectives: by resource ("what's booked on this court") and by customer ("all my bookings").

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

## Notes for spec 2

Collected while building spec 1, so they are not rediscovered later:

- The exclusion constraint on `bookings` needs the `btree_gist` extension, to combine `uuid WITH =` and `tstzrange WITH &&` in one GiST index. The spec 1 migration does not create it.
- `DELETE /resources/:id` is currently a hard delete. Once bookings exist it must refuse to delete a resource that has any.
- Booking validation reuses the availability grid rather than duplicating it. The slot generator is already a pure function taking windows, a timezone, a duration and an anchor, so the boundary check should call it rather than reimplement the stepping.
- Availability already returns `available: true` for every slot, so spec 2 changes behaviour without changing the response contract.
