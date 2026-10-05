# Pool booking and pool availability share one member-slot computation

**Status:** implemented · **Date:** 2026-10-03

**This is a decision record, not current truth.** It states what was decided on the date above and is not revised as the system changes. For what the engine does today, read [architecture.md](../../architecture.md) and [conventions.md](../../conventions.md) — where they disagree with this document, they are right.

---

## 1. Purpose

Fixes the backlog entry _The pool booking path re-scans members one query pair at a time_.

To narrow a pool to the members that offer a run, `BookingService.createInPool` awaits
`offeredSlots(member, …)` once per active member, in turn; each issues its own schedule and
exception query. An eight-member pool costs sixteen sequential queries before the booking's
transaction opens. `AvailabilityService.computeForPool` answers the same question for every
member with two batched queries. Spec 3 §5.1 says the two are "one code path, called from
both"; they are not, and they have drifted once: availability reads the slot grid from the pool
row, booking from each member's row — equal today only because membership rule 4 forbids a
member whose grid differs.

The backlog entry placed the scan "inside the transaction", with its cost paid "while the
resource lock is held". The scan runs **before** `inPoolWrite` opens the transaction. Its costs
are latency, and the width of the window between reading the pool row and the transaction
re-checking it, which the comment in `createInPool` already names.

### Success

- A pool booking issues the same number of queries whatever the pool's member count.
- Pool availability and pool booking turn members into slots through one function.
- Every existing pool behaviour — which error a refused run gets, which member is claimed —
  is unchanged.

---

## 2. Design

**One pure function.** `src/modules/availability/member-slots.ts`:

```ts
export interface PoolGrid {
  timezone: string
  slotDuration: SlotDuration
  anchorTime: string
}

export function memberSlots(input: {
  memberIds: string[]
  dates: string[]
  grid: PoolGrid
  scheduleRows: Array<ScheduleRow & { resource_id: string }>
  exceptionRows: Array<ExceptionRow & { resource_id: string }>
}): Map<string, Slot[]>
```

It splits the batched rows by member and runs `resolveWindows` and `generateSlots` for each, on
the one grid. It is what `computeForPool`'s loop does today, lifted out. It imports nothing from
`db/`.

**Availability.** `computeForPool` calls `memberSlots` in place of its loop. Its queries and its
result are unchanged.

**Booking.** `createInPool` loads every active member's schedule and exceptions with the two
batched queries availability uses, `listByResourceIds` and `listInRangeForResources`, over the
dates `gridDatesFor` gives for the interval, and calls `memberSlots`. `checkAgainstGrid` then runs
per member exactly as before, so `invalid_slot_boundary` and `outside_schedule` are decided by
the same rule. A pool with no active member skips the queries — `in ()` is not valid SQL — and
reaches the refusal it reaches today.

_As built:_ the empty-pool skip was not needed. `listByResourceIds` and
`listInRangeForResources` already return `[]` for an empty id list without querying, which a run
with the skip removed showed; the service passes the list through, and a test pins the empty
pool's `outside_schedule` either way.

**One grid source.** Booking takes the grid from the pool row, as availability does, instead of
each member's row. Rule 4 makes them equal; this makes them one source.

`offeredSlots` remains for a single resource's booking.

---

## 3. Tests

Written first.

- **Unit**, `tests/unit/member-slots.test.ts`, from a dataset: two members with different weekly
  windows each get their own slots; a member with no rows gets none; a day off on one member
  leaves the other untouched; and across a daylight-saving date, each member's slots equal what
  `generateSlots` gives that member alone, with the transition taken from the tz-derived dataset
  rather than written down.
- **Integration**, in `tests/integration/pools.test.ts`: a pool booking's queries are counted —
  through a Kysely plugin on the test's database handle, which `transformQuery` reaches once per
  query — for pools of 1, 3 and 8 members, and the three counts must be equal. On `main` they
  differ by two per member.
- **Regression:** the existing pool tests and the smoke suites pass unchanged.

---

## 4. Documentation

- Spec 3 gets an _As built_ note: from this slice, availability and booking share
  `memberSlots`, which makes §5.1's sentence true.
- The comment in `createInPool` about "N sequential round trips" is corrected.
- `docs/backlog.md`: the entry is deleted.
- `docs/architecture.md`, where it describes booking a pool, if it says how members are
  narrowed.
