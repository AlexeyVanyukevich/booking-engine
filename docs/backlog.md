# Backlog

What is known to be wrong and not yet fixed, newest first. The rule for this file is the shared
`backlog.md`, imported by [CLAUDE.md](../CLAUDE.md): one entry per finding, deleted by the
commit that fixes it.

## The pool booking path re-scans members one query pair at a time

- Where: `src/modules/bookings/booking.service.ts`, `createInPool()`, the step-2 member loop
  that calls `offeredSlots(member, …)`; compare `AvailabilityService.computeForPool()` in
  `src/modules/availability/availability.service.ts`
- Found: 2026-08-28, in the final review of spec 3
- Problem: to narrow a pool to the members that offer a run, the booking path awaits
  `offeredSlots` once per member, in turn. Each call issues its own `listByResource` and
  `listInRange` pair, so a pool of N members costs N sequential round trips inside the
  transaction. `computeForPool` answers the same question for every member at once with two
  batched queries (`listByResourceIds`, `listInRangeForResources`). Spec 3 §5.1 states the two
  are "one code path, called from both"; they are not, and the spec's _As built_ note corrects
  only the error-code divergence. The two have drifted once already: availability reads the
  grid from the pool row and booking from the member row, which is harmless only because a
  pool's grid cannot be patched while it has members.
- Impact: booking latency grows linearly with pool size while the resource lock is held, and a
  decision record makes a false claim. The fix extracts the per-member slot generation into one
  helper taking `(members, dates, grid, scheduleRows, exceptionRows)`, calls it from both paths
  with the booking path passing `gridDatesFor`'s dates, and corrects the sentence in §5.1.
