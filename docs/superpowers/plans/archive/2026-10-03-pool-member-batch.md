# Pool member batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pool booking issues the same number of queries whatever its member count, and pool availability and pool booking turn members into slots through one pure function.

**Architecture:** `memberSlots` is lifted out of `computeForPool` into its own file; availability calls it, then booking loads every member's rows in two batched queries and calls it too, with the pool's grid.

**Tech Stack:** TypeScript, Kysely (plugin API for counting queries), Luxon, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-03-pool-member-batch-design.md`

## Global Constraints

- `member-slots.ts` imports nothing from `db/`.
- No change to any response, error code, or member selection.
- Test data lives in datasets under `tests/fixtures/datasets/`; tz facts come from `tests/fixtures/datasets/dst.ts`.
- Commits: Conventional Commits, subject only, no body, no trailer; `./run check` before each; `git branch --show-current` is `perf/pool-member-batch`.

## Review Focus

- A pool with no active member: `in ()` is invalid SQL, so the booking path must skip the batched queries and still answer the refusal it answers today. Pinned by the existing pool tests if they book an empty pool; if none does, Task 2 adds a row.
- The grid now comes from the pool row in booking. Equal to the member's by rule 4; a reviewer should confirm nothing else in `createInPool` read the member's grid.
- The query counter counts what reaches the executor; `BEGIN`/`COMMIT` do not pass `transformQuery`. The test compares counts across pool sizes, so a constant offset does not matter.

---

### Task 1: `memberSlots`, used by availability

**Files:** Create `src/modules/availability/member-slots.ts`, `tests/fixtures/datasets/member-slots.ts`, `tests/unit/member-slots.test.ts`. Modify `src/modules/availability/availability.service.ts` (`computeForPool`).

**Produces:** `memberSlots(input: MemberSlotsInput): Map<string, Slot[]>`, `PoolGrid`.

- [ ] **Step 1: Dataset and unit test.** Cases, each naming members' weekly rows and exceptions, the dates, a grid, and the expected `[start, end]` pairs per member:
  - two members with different Monday windows on a `PT1H` grid, 2026-07-20 (a Monday): each gets only its own slots;
  - a member with no rows: `[]`;
  - a day off on one member: that member `[]`, the other unchanged;
  - plus one property row run separately: on a `P1D` grid across the Warsaw fall-back date from `fallBacks` in `dst.ts`, each member's slots equal `generateSlots(resolveWindows(...that member's rows only...))` — so no offset is written by hand.
- [ ] **Step 2: Run it; expect FAIL** — `member-slots.js` cannot be resolved.
- [ ] **Step 3: Write `member-slots.ts`:**

```ts
import type { SlotDuration } from '../../shared/time.js'
import type { ExceptionRow } from '../exceptions/exception.repository.js'
import type { ScheduleRow } from '../schedule/schedule.repository.js'
import { generateSlots, type Slot } from './slot-generator.js'
import { resolveWindows } from './window-resolver.js'

/** The one grid every member of a pool shares (membership rule 4). */
export interface PoolGrid {
  timezone: string
  slotDuration: SlotDuration
  /** 'HH:MM' */
  anchorTime: string
}

export interface MemberSlotsInput {
  memberIds: string[]
  /** 'YYYY-MM-DD' dates, in the pool's timezone */
  dates: string[]
  grid: PoolGrid
  scheduleRows: Array<ScheduleRow & { resource_id: string }>
  exceptionRows: Array<ExceptionRow & { resource_id: string }>
}

/**
 * Each member's slots over `dates`, on the pool's one grid. Pure, and the one place a pool's
 * members become slots: availability unions the result, booking checks a run against each
 * member's list. The rows arrive batched for every member and are split here.
 */
export function memberSlots(input: MemberSlotsInput): Map<string, Slot[]> {
  const { memberIds, dates, grid } = input
  return new Map(
    memberIds.map((id) => [
      id,
      generateSlots({
        dates,
        windowsByDate: resolveWindows({
          dates,
          timezone: grid.timezone,
          scheduleRows: input.scheduleRows.filter((row) => row.resource_id === id),
          exceptionRows: input.exceptionRows.filter((row) => row.resource_id === id),
        }),
        timezone: grid.timezone,
        slotDuration: grid.slotDuration,
        anchorTime: grid.anchorTime,
      }),
    ]),
  )
}
```

- [ ] **Step 4: `computeForPool` calls it.** Replace the per-member `generateSlots(...)` in its loop with one `memberSlots({ memberIds: ids, dates, grid: { timezone: pool.timezone, slotDuration: parseSlotDuration(pool.slot_duration), anchorTime: formatTime(pool.slot_anchor_time) }, scheduleRows, exceptionRows })` before the loop, and `const slots = slotsByMember.get(member.id) ?? []` inside it.
- [ ] **Step 5: Run** the unit test, `tests/integration/availability.test.ts` and `tests/integration/pools.test.ts`; expect PASS. `grep -n "db/" src/modules/availability/member-slots.ts` prints nothing.
- [ ] **Step 6:** `./run check`; commit `refactor(availability): compute pool member slots in one function`.

---

### Task 2: The booking path uses it

**Files:** Create `tests/fixtures/query-counter.ts`. Modify `tests/integration/helpers.ts` (`buildTestApp` takes an optional `db`), `tests/fixtures/datasets/pool-availability.ts` (`poolSizesForQueryCount = [1, 3, 8]`), `tests/integration/pools.test.ts`, `src/modules/bookings/booking.service.ts`, `docs/backlog.md`.

- [ ] **Step 1: The counter.**

```ts
import type {
  KyselyPlugin,
  PluginTransformQueryArgs,
  PluginTransformResultArgs,
  QueryResult,
  RootOperationNode,
  UnknownRow,
} from 'kysely'

/** Counts the queries a Kysely instance executes. Attach with `db.withPlugin(counter)`. */
export class QueryCounter implements KyselyPlugin {
  count = 0

  reset(): void {
    this.count = 0
  }

  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    this.count++
    return args.node
  }

  async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    return args.result
  }
}
```

`buildTestApp(overrides: Partial<AppConfig> = {}, db: Kysely<Database> = getTestDb())`, passing `db` to `buildApp`.

- [ ] **Step 2: The test.** In `pools.test.ts`, build the file's app with `getTestDb().withPlugin(counter)`, and add:

```ts
describe('a pool booking', () => {
  it('issues the same number of queries however many members the pool has', async () => {
    const counts: number[] = []
    for (const size of poolSizesForQueryCount) {
      const pool = await aPoolWith(Array.from({ length: size }, () => ({ windows: wholeWeek })))
      counter.reset()
      expect((await api.createBooking(pool.id, night)).statusCode).toBe(201)
      counts.push(counter.count)
    }
    expect(counts).toEqual(counts.map(() => counts[0]))
  })
})
```

- [ ] **Step 3: Run it; expect FAIL** — the counts grow by two per member.
- [ ] **Step 4: Batch the scan.** In `createInPool`, replace the per-member `offeredSlots` loop with: if `members.length > 0`, one call to a private `poolMemberSlots(pool, memberIds, start_time, end_time)` that computes `gridDatesFor` over the pool's timezone, runs `listByResourceIds` and `listInRangeForResources` (half-open on the day after the last date, as `offeredSlots` does) in parallel, and returns `memberSlots(...)` with the pool's grid; then `checkAgainstGrid(slotsByMember.get(member.id) ?? [], …)` per member as before. Extract the "first date, day after the last" computation shared with `offeredSlots` into one private helper. Correct the comment that says the scan is "N sequential round trips" to say it is two batched queries.
- [ ] **Step 5: Run** `pools.test.ts`, `bookings.test.ts`, `availability.test.ts`; expect PASS. If no existing case books a pool with no active member, add one asserting today's refusal, and confirm it passes.
- [ ] **Step 6:** Delete the backlog entry; `./run check`; commit `perf: batch the member scan of a pool booking`.

---

### Task 3: Documents, and close

- [ ] `docs/superpowers/specs/2026-08-27-pool-concurrency-design.md`: an _As built_ note under §5.1 — from 2026-10-03 both paths call `memberSlots`, which makes "one code path, called from both" true; before that they were two paths that agreed.
- [ ] `docs/architecture.md`: if the pool paragraph says how members are narrowed, add that both availability and booking resolve members through `memberSlots` in batched queries.
- [ ] Spec status to implemented; `git mv` this plan to `archive/`; `./run check`; commit `docs: record the shared pool member computation and archive its plan`.
