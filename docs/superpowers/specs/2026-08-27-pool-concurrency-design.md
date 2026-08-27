# Spec 3 — The `pool` concurrency mode

**Status:** awaiting approval
**Date:** 2026-08-27
**Source of truth for the overall system:** [docs/architecture.md](../../architecture.md)
**Preceding slices:** [spec 1 — resources, schedule, availability](2026-07-27-resources-schedule-availability-design.md), [spec 2 — bookings](2026-08-05-bookings-design.md), [spec 4 — multitenancy](2026-08-14-multitenancy-design.md)

Formats, error shapes, the technology stack, code layout and the testing rules are not repeated
here — they live in [conventions.md](../../conventions.md).

---

## 1. Purpose

Implement the third and last concurrency mode. A pool is a group of interchangeable resources
booked as one: a caller asks the pool for an interval, and the engine picks a member.

Spec 2 settled the data model in its §12 so that it could avoid closing doors, and left three
seams cut for this slice. This spec builds member selection and the rules that keep a pool
coherent.

### Why the mode exists at all

**A hotel with ten interchangeable rooms is already expressible as `shared` with
`capacity = 10`**, and which physical room a guest receives is a domain concern. If that were
the whole requirement, `pool` would not be worth a table column.

It earns its place on exactly one property: **a member can be individually unavailable.** Room
101 goes out of service on the 20th while 102 keeps selling. A scalar capacity cannot express
that — it can only say "ten", and then nine. A pool can, because each member is a full resource
with its own schedule, exceptions and `is_active`.

Every decision below follows from that. Where a choice would be justified only by something a
scalar capacity already covers, it is not made here.

### In scope

- `resources.pool_id`, its constraints, and the rules governing membership
- Booking a pool: validating the request, selecting a member, and what each refusal means
- A pool's availability as the union over its members
- Lifting the creation refusal on `concurrency_mode: 'pool'`
- Unit and integration tests, and the smoke suites that share their datasets

### Out of scope

| Left out                                   | Why                                                                                                                                                              |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nested pools                               | A pool may not join a pool. Nothing asks for it, and the derived-capacity rule would have to become recursive                                                    |
| Choosing _which_ member a caller gets      | Selection order is an implementation detail, not a contract. A caller that cares about a specific member books that member directly — it is an ordinary resource |
| A "rooms remaining" count on availability  | §6 records the reasoning. The slot shape stays the same for every resource type                                                                                  |
| Moving an existing booking between members | `reschedule` keeps its row and its `resource_id`. Re-homing a booking is a different operation and nothing needs it yet                                          |
| Load-balancing across members              | Even wear is a domain concern; the engine does not know these are rooms                                                                                          |

---

## 2. Data model

One migration, `004_pools.ts`. One nullable column, and no new table: a pool is a resource and
a member is a resource, which is what makes the whole slice cheap.

### 2.1 `resources.pool_id`

| Column    | Type        | Notes                                                    |
| --------- | ----------- | -------------------------------------------------------- |
| `pool_id` | `uuid NULL` | NULL for a standalone resource and for a pool row itself |

```sql
ALTER TABLE resources ADD COLUMN pool_id uuid;

ALTER TABLE resources
  ADD CONSTRAINT resources_pool_fk
  FOREIGN KEY (tenant_id, pool_id) REFERENCES resources (tenant_id, id)
  ON DELETE RESTRICT;

ALTER TABLE resources ADD CONSTRAINT resources_pool_not_self CHECK (pool_id <> id);

CREATE INDEX resources_pool_idx ON resources (tenant_id, pool_id) WHERE pool_id IS NOT NULL;
```

**The foreign key is composite, on `(tenant_id, pool_id)`.** This is the pattern spec 4
established for the child tables, applied to a self-reference: a member whose tenant disagrees
with its pool's has no referent and cannot be written. It reuses the `resources_tenant_id_unique`
constraint spec 4 already added for exactly this purpose. Scoping a pool to a tenant is
therefore structural rather than a filter someone has to remember.

`ON DELETE RESTRICT` rather than `SET NULL`: silently detaching ten rooms because someone
deleted the pool is the kind of quiet data change design principle #8 exists to refuse.

The index is partial because the overwhelming majority of resources are not members, and the
only query it serves is "the members of this pool".

### 2.2 What a pool row carries, and what it does not

A pool is a `resources` row, so every column exists on it whether or not it means anything.
This is what each one means:

| Column                                          | On a pool                                                            |
| ----------------------------------------------- | -------------------------------------------------------------------- |
| `timezone`, `slot_duration`, `slot_anchor_time` | **The canonical grid.** Every member must match it — see §3          |
| `is_active`                                     | Retires the whole pool, as for any resource                          |
| `capacity`                                      | Always 1, and meaningless. Effective capacity is derived — see below |
| Schedule and exception rows                     | **Refused.** A pool has no availability of its own — see §6          |

**A pool's effective capacity is derived from its count of active members and never stored.**
Storing both would create a divergence with no owner: a `capacity` of 10 beside eight active
members is a contradiction the engine could not resolve, and it would have to be maintained on
every member activation, deactivation and delete. A pool row therefore keeps `capacity = 1`,
and any other value is refused on create and patch. The number is not reported anywhere; what a
caller can observe is availability, which is the honest form of the same information.

---

## 3. Membership rules

`pool_id` is set on `POST /resources` and changed on `PATCH /resources/:id`. It joins neither
`timezone` nor `concurrency_mode` in being immutable, and the reason is specific:
**`DELETE /resources/:id` is already refused once a resource has any booking.** Were membership
immutable, a room that had ever been booked could never be moved to another pool or taken out
of one — permanently, with no remedy, because the delete-and-recreate escape hatch is closed to
exactly the rows that would need it.

Four rules are checked whenever `pool_id` is set to a non-NULL value:

1. **The target exists and belongs to the caller's tenant.** The composite foreign key makes a
   cross-tenant pool unwritable, but a `404`-shaped answer is better than a constraint
   violation, and the service checks first so the caller learns nothing about other tenants.
2. **The target is a pool** — `concurrency_mode = 'pool'`. Attaching a room to another room is
   not a relationship the engine has a meaning for.
3. **The joining resource is `exclusive`.** This is the rule that forbids nesting, and it also
   forbids a `shared` member. Derived capacity is a **count of active members**, which is only
   true while each member holds one booking at a time; a pool of `shared` members would make it
   a sum of capacities instead, and two rules for one number is one too many. A domain wanting
   twenty seats in each of three rooms has `shared` for the seats and does not need a pool.
4. **The grid matches.** `timezone`, `slot_duration` and `slot_anchor_time` must be identical to
   the pool's.

Rules 2 and 3 cannot be `CHECK` constraints because they read another row, and rule 4 could be
a trigger but is not: the engine keeps cross-row rules in services, as it already does for
`exclusive` requiring `capacity = 1`. Each is covered by a test rather than by the database.

**Why the grid must match.** Booking validation checks a request against a slot grid, and a grid
comes from a resource's timezone, duration and anchor. A pool has to have exactly one grid to
validate against _before_ any member is chosen — otherwise `invalid_slot_boundary` loses its
meaning at the pool level, and the error a caller receives would depend on which member the
engine happened to check last. Members still differ where the mode's justification lives: the
schedule, the exceptions and `is_active`.

A patch that would break rule 4 — changing a member's `slot_duration`, or a pool's — is refused
for the same reason. The engine validates the resulting state, not the patch, which is the rule
spec 1 established for `slot_anchor_time`.

---

## 4. API

**No new routes, and no new scope.** A pool is a resource and a member is a resource, so
`resources.read`, `resources.write`, `availability.read` and the `bookings.*` scopes already
cover everything here. The scope table in `conventions.md` does not change, and the test that
now asserts it against the routes stays green.

Two request bodies gain one optional field each:

```
POST   /resources
  body: { ..., pool_id? }

PATCH  /resources/:id
  body: { ..., pool_id? }
```

`pool_id` is returned on every resource response, NULL for a standalone resource or a pool.

**Members are first-class.** `GET /resources` lists them alongside pools, and
`POST /resources/{memberId}/bookings` books one directly. This costs no new code — a member is
an ordinary `exclusive` resource that happens to carry a `pool_id`, and the exclusion constraint
already governs it — and it serves the domain that has to honour "the guest asked for room 101".
The consequence, accepted deliberately, is that the pool abstraction is porous: a caller can
bypass selection. Hiding members would mean a guard on every route that takes a resource id, and
a booking response that returns a member id the caller is not supposed to know.

---

## 5. Booking a pool

`POST /resources/{poolId}/bookings`. The pool path is entered when the loaded resource has
`concurrency_mode = 'pool'`; every other mode runs exactly the path spec 2 built.

### 5.1 The order of the checks

`conventions.md` insists that `outside_schedule` and `slot_unavailable` are not
interchangeable — the first says the slots were never offered, the second that they are offered
and taken. Preserving that distinction across a set of members is what fixes the order:

```
bookPool(pool, start, end):
  1. interval and boundary checks, against the pool's own grid
       → 400 invalid_interval / invalid_slot_boundary
  2. narrow to active members whose schedule and exceptions offer the whole run
       → none: 400 outside_schedule
  3. claim one of those that has no conflicting active booking
       → none: 409 slot_unavailable
  4. insert against the claimed member
```

Step 1 is member-independent precisely because §3 forces every member onto the pool's grid. A
boundary error is therefore a property of the request, answerable before a single member is
considered, and it reads the same whether the pool has one member or two hundred.

Step 2 asks the same question §6 asks — which members offer these slots — and uses the same
batched window resolution, over the requested interval rather than a date range. It is one code
path, called from both, for the reason spec 2 gave for reusing the grid in booking validation:
anything offered is bookable, anything bookable was offered, and there is one implementation
rather than two that can drift apart.

Throughout, "an active booking" means one whose status is `held` or `confirmed` — the same set
`bookings_no_overlap` and the capacity count already use.

A pool with no members at all, or none active, falls out of step 2 as `outside_schedule`:
nothing offers the run. That is the truthful answer — the slots were never on offer — and it
needs no special case.

### 5.2 Member selection

```sql
SELECT id FROM resources
 WHERE tenant_id = $1 AND pool_id = $2 AND is_active
   AND id = ANY($3)          -- the members that offer the run, from step 2
   AND NOT EXISTS (...)      -- no active booking overlapping [start, end)
 ORDER BY created_at, id
   FOR UPDATE SKIP LOCKED
 LIMIT 1
```

**`SKIP LOCKED` is the whole concurrency story for the mode.** Two requests arriving together
for a pool with two free rooms take different rows and neither waits; a request arriving when
one room is left finds it locked, skips it, and returns nothing rather than blocking. That is
the canonical claim-a-free-unit pattern, and spec 2 §12 anticipated it.

There is deliberately **no retry loop** across members. `SKIP LOCKED` makes the collision rare
rather than handled after the fact, and the exclusion constraint remains the backstop: if a
member is claimed and the insert still conflicts, the booking is refused as
`409 slot_unavailable` and the caller decides. Spec 2 rejected retry machinery for the same
reason, and nothing here argues differently.

`ORDER BY created_at, id` is a stable order, not a policy. It makes the mode deterministic under
no contention, which is what lets a test assert which member won.

**No pool-level lock is taken on this path** — see §5.3 for the one case that does take one.
Capacity is derived rather than counted, so there is no aggregate to protect; each member's
disjointness is carried by `bookings_no_overlap` alone, atomic at READ COMMITTED, exactly as for
any other `exclusive` resource.

### 5.3 Idempotency, and where the parent-before-member rule fires

`conventions.md` records that **where a resource has a parent, the parent is locked before the
member** — written down during spec 2, which had nothing to apply it to, so that pools would not
discover it as an intermittent deadlock. It fires exactly once in this slice, and it is
load-bearing.

The idempotency constraint is `bookings_idempotency_key_unique` on
`(resource_id, idempotency_key)`, and for a pool booking `resource_id` is the **member**. Two
concurrent replays of one key could therefore select two different members and both insert: the
unique index would not fire, because the rows differ in `resource_id`. The key would have
created two bookings, which is the one thing it exists to prevent.

So **when a pool booking carries an idempotency key, the pool row is locked with `FOR UPDATE`
before member selection begins.** Replays of that key against that pool serialize, the second
finds the first one's committed row, and the lookup is by pool rather than by member:

```sql
SELECT b.* FROM bookings b
  JOIN resources r ON r.tenant_id = b.tenant_id AND r.id = b.resource_id
 WHERE r.pool_id = $pool AND b.idempotency_key = $key
```

This extends spec 2's existing rule — the resource row is already locked whenever a key is
present, in any mode — one level up the hierarchy. Parent first, then member, which is the only
path in the engine that holds both.

The alternative is denormalising `pool_id` onto `bookings` so a single unique index can span the
pool. It was rejected: a second copy of the relationship has to be kept true forever, and the
lock is needed on this path anyway.

---

## 6. Availability

`GET /resources/{poolId}/availability` returns the union over the pool's active members: a slot
is `available` when **at least one active member offers it and has no conflicting booking**.

Spec 2 left the seam for this. `AvailabilityService.computeForResource` already takes an
already-loaded resource row, with a comment naming this slice; the pure functions beneath it —
`resolveWindows`, `generateSlots`, `countOccupying` — take a resource's own data and touch no
database. All three are reused unchanged.

**The three queries are batched over the member ids rather than run per member.** Members carry
different schedules, so per-member windows genuinely have to be resolved; what does not have to
happen is three round trips each. `listByResource`, `listInRange` and `activeInRange` gain an
ids variant, and the union is computed in memory. A pool's availability is three queries whatever
its size. The loop-per-member alternative is about ten lines and obviously correct, but a
forty-room pool queried across the 366-day maximum would be a hundred and twenty round trips for
one request, and nothing in the engine bounds pool size.

**The response shape does not change.** A slot is `{ start, end, available }` for a pool exactly
as for every other resource — design principle #6, one slot format regardless of what is behind
it. A count of free members is not reported. It is real information a booking widget might want,
and it is recorded in §9 as a limitation rather than smuggled in: adding a field to one mode's
response forks a contract that is currently uniform, and the domain can count members itself.

An inactive pool answers with an empty slot list, as any inactive resource does. So does a pool
whose members are all inactive — by the same union, with no special case.

---

## 7. What this spec does not change

Worth stating, because the temptation on reading §12.1 of spec 2 is to go and change it:

**`capacityIsCounted` keeps throwing on `pool`, permanently.** Spec 2 recorded that a booking
row carrying `concurrency_mode = 'pool'` would be governed by neither the exclusion constraint
nor the capacity count, and closed the trap with an exhaustive `switch`. That switch is not a
stub this slice removes. `bookings.concurrency_mode` is copied from the resource the booking
points at, and a pool booking points at a **member**, whose own mode is `exclusive` — so the row
is governed by `bookings_no_overlap` exactly as today. A booking row carrying `pool` is not an
unimplemented case; it is a bug in member selection, and that `throw` is the assertion that
catches it.

Unchanged for the same reason: the predicate on `bookings_no_overlap`, the slot generator, the
window resolver, `occupancy.ts`, the lifecycle and its transition table, hold expiry, and the
scope vocabulary.

---

## 8. Error codes

Two new, both added to the table in `conventions.md` — which is now asserted against the code by
`tests/unit/documented-tables.test.ts`, so the suite fails until they are documented.

| Code                      | Status | Meaning                                                                       |
| ------------------------- | ------ | ----------------------------------------------------------------------------- |
| `invalid_pool_membership` | 400    | The target is not a pool, or the joining resource is one, or the grid differs |
| `pool_has_members`        | 409    | `DELETE /resources/:id` on a pool that still has members                      |

`invalid_pool_membership` names the disagreement in `details` — which of the four rules of §3
failed, and for the grid, which of the three fields. The caller already knows both ids it sent,
so this leaks nothing and turns a rejected write into a one-line fix.

A pool being refused a schedule or exception write answers `validation_error` with a message
saying so, rather than earning a third code. It is a narrow case and the message carries it.

`unsupported_concurrency_mode` **stays in the table**: `capacityIsCounted` still throws it, for
the reason §7 gives. Its meaning narrows from "`pool`, until spec 3" to "a booking row somehow
reached the write path carrying `pool`", and the row's description changes accordingly.

---

## 9. Known limitations

Added to [conventions.md](../../conventions.md#deliberate-limitations) alongside those of specs
1, 2 and 4. The `pool` mode rejected row is removed in the same edit.

| Limitation                                             | Why                                                                                                                                                                  | Cost to lift                                              |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Availability does not report how many members are free | The slot shape is uniform across every resource type, and forking it for one mode is a contract change every consumer pays for. The domain can count members itself  | A field on the slot, and a decision about the other modes |
| A pool cannot mix slicing parameters                   | §3 requires an identical grid, so meeting rooms at `PT1H` and bedrooms at `P1D` cannot share a pool. Arguably correct — they are not interchangeable                 | A grid per member, and a booking path that tries each     |
| A member must be `exclusive`                           | Derived capacity is a count of active members, which holds only while each takes one booking at a time. A pool of `shared` members would make it a sum of capacities | Sum instead of count, and a second rule for one number    |
| Member selection order is not a contract               | Stable under no contention, but `SKIP LOCKED` means a concurrent request may receive a later member. A caller needing a specific one books it directly               | Intentional; not planned to change                        |
| No nested pools                                        | Derived capacity would have to become recursive, and nothing asks for it                                                                                             | A recursive count, and a cycle check                      |

---

## 10. Testing strategy

Test-driven, and following the conventions: cases live in `tests/fixtures/datasets/` as typed
tables consumed by parameterised runners, and the same datasets drive both the suite and
`./run smoke`.

**Unit, no database**

- Membership validation: the four rules of §3, accepted and rejected, as a dataset
- The check ordering of §5.1, over a set of members with differing schedules

**Integration, real Postgres**

- The composite foreign key refuses a member whose tenant differs from its pool's
- `resources_pool_not_self` refuses a row pointing at itself
- Deleting a pool with members is refused; deleting one whose members have left is not
- A pool's availability is the union over active members, and shrinks when one is deactivated
- A booking against a pool lands on a member, and its `resource_id` is the member's
- Two concurrent bookings for a two-member pool both succeed, on different members
- The last free member is given to exactly one of two racing requests
- An idempotency key replayed against a pool returns the same booking, not a second one on
  another member — the case §5.3 exists for
- `outside_schedule` when no member offers the run; `slot_unavailable` when all that do are busy

**Smoke** — a dataset and a suite for pool membership validation and pool booking, plus one line
in `tests/fixtures/suites/index.ts`. The runner does not change.

---

## 11. Documents to update

- **architecture.md** — the slice status table; the `pool` bullet under Concurrency modes, which
  currently says "Not implemented"; `pool_id` in the Resource column table
- **conventions.md** — the two error codes of §8 and the narrowed meaning of
  `unsupported_concurrency_mode`; the limitations of §9, and removal of the `pool` mode rejected
  row
- **README.md** — the "The `pool` concurrency mode arrives in spec 3" line, and the
  known-limitations sentence
- **test-cases.md** — the behaviour of §10 as runnable cases with their coverage, and
  **TC-RES-C16**, which asserts a resource response has exactly seven keys and now has eight.
  That case is doing its job: adding `pool_id` to the contract has to be a deliberate edit to
  the document that pins the contract, not a silent widening
- **openapi.json** — regenerated by `./run openapi`, since two request bodies and every resource
  response gain `pool_id`

---

## 12. Definition of done

- Every rule of §3 and §5 implemented and covered by the tests of §10
- `./run check` is clean from a clean checkout with Docker running
- `./run smoke` passes against a running engine, exercising the same datasets
- `npm run migrate` brings a spec 4 database to the schema of §2, and `004_pools.ts` has a
  `down` that reverses it
- `capacityIsCounted` still throws on `pool`, and a test asserts it
- The documents of §11 are updated in the same branch, not left for later
