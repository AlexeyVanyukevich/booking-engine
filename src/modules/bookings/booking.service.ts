import { DateTime } from 'luxon'
import type { BookingStatus, ConcurrencyMode } from '../../db/schema.js'
import {
  HoldExpiredError,
  IdempotencyKeyReusedError,
  InvalidIntervalError,
  InvalidSlotBoundaryError,
  InvalidStateTransitionError,
  NotFoundError,
  OutsideScheduleError,
  ResourceInactiveError,
  SlotUnavailableError,
  UnsupportedConcurrencyModeError,
  ValidationError,
  rethrowContention,
} from '../../shared/errors.js'
import { formatTime, parseSlotDuration } from '../../shared/time.js'
import { assertValidRange } from '../../shared/range.js'
import { generateSlots, type Slot } from '../availability/slot-generator.js'
import { resolveWindows } from '../availability/window-resolver.js'
import type { ExceptionRepository } from '../exceptions/exception.repository.js'
import type { PoolRepository } from '../resources/pool.repository.js'
import type { ResourceRow } from '../resources/resource.repository.js'
import type { ResourceService } from '../resources/resource.service.js'
import type { ScheduleRepository } from '../schedule/schedule.repository.js'
import { checkAgainstGrid, gridDatesFor, type BookingGridError } from './booking-validator.js'
import {
  holdExpiry,
  type BookingRepository,
  type BookingRow,
  type Trx,
} from './booking.repository.js'
import type {
  BookingResponse,
  CreateBookingBody,
  CustomerBookingsQuery,
  RescheduleBookingBody,
  ResourceBookingsQuery,
} from './booking.schemas.js'
import { countOccupying } from './occupancy.js'

export type BookingAction = 'confirm' | 'cancel' | 'complete' | 'no-show'

const TRANSITIONS: Record<BookingAction, { target: BookingStatus; from: BookingStatus[] }> = {
  confirm: { target: 'confirmed', from: ['held'] },
  cancel: { target: 'cancelled', from: ['held', 'confirmed'] },
  complete: { target: 'completed', from: ['confirmed'] },
  'no-show': { target: 'no_show', from: ['confirmed'] },
}

export interface BookingOptions {
  defaultHoldMinutes: number
  maxHoldMinutes: number
  maxRangeDays: number
}

export interface CreateResult {
  booking: BookingResponse
  /** False when an idempotency key replayed an existing booking. */
  created: boolean
}

function iso(value: Date, timezone: string): string {
  const formatted = DateTime.fromJSDate(value, { zone: timezone }).toISO({
    suppressMilliseconds: true,
  })
  if (!formatted) throw new Error(`Could not format ${value.toISOString()} as ISO-8601`)
  return formatted
}

export function toBookingResponse(row: BookingRow, timezone: string): BookingResponse {
  return {
    id: row.id,
    resource_id: row.resource_id,
    start_time: iso(row.start_time, timezone),
    end_time: iso(row.end_time, timezone),
    status: row.status,
    customer_id: row.customer_id,
    held_until: row.held_until === null ? null : iso(row.held_until, timezone),
  }
}

/**
 * A `switch` rather than a chain of `if`s, so a fourth `BookingGridError` is a compile error
 * here instead of being silently reported as `outside_schedule`.
 */
function gridError(error: BookingGridError, start: string, end: string): never {
  const details = { start_time: start, end_time: end }
  switch (error) {
    case 'invalid_interval':
      throw new InvalidIntervalError('end_time must be after start_time', details)
    case 'invalid_slot_boundary':
      throw new InvalidSlotBoundaryError(
        'start_time and end_time must fall on slot boundaries offered by this resource',
        details,
      )
    case 'outside_schedule':
      throw new OutsideScheduleError(
        'The requested interval is not a contiguous run of slots this resource offers',
        details,
      )
    default: {
      const _exhaustive: never = error
      throw new Error(`Unhandled booking grid error: ${String(_exhaustive)}`)
    }
  }
}

/**
 * Whether this mode's capacity has to be counted under a row lock, and the one place a
 * concurrency mode is branched on before a booking row is written.
 *
 * It is exhaustive on purpose. Spec §12.1 records `pool` as fail-open: the exclusion
 * constraint's predicate names `exclusive` only, and the capacity count runs for `shared`
 * only, so a booking row carrying `pool` would be governed by neither and could overbook
 * without limit. A booking always points at a member, whose own mode is `exclusive`, so no
 * row should ever reach here carrying `pool` — if one does, member selection is broken, and
 * the trap springs quietly unless it is closed here rather than merely written down. A
 * fourth mode does not compile until this function decides what it means.
 */
export function capacityIsCounted(mode: ConcurrencyMode): boolean {
  switch (mode) {
    case 'exclusive':
      return false
    case 'shared':
      return true
    case 'pool':
      throw new UnsupportedConcurrencyModeError(
        'concurrency_mode "pool" is not implemented yet; a pool booking would be governed by neither the exclusion constraint nor the capacity count',
        { concurrency_mode: mode },
      )
    default: {
      const _exhaustive: never = mode
      throw new Error(`Unhandled concurrency mode: ${String(_exhaustive)}`)
    }
  }
}

/**
 * A resource deleted between validation and the insert leaves the foreign key to object, as
 * SQLSTATE 23503 on `bookings_resource_id_fkey`. The resource is gone, so `404` is the honest
 * answer — the same one `loadOrFail` would have given a moment earlier.
 */
function isMissingResource(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { code?: unknown; constraint?: unknown }
  // Migration 003 replaced the single-column key with the composite `bookings_resource_fk`.
  return candidate.code === '23503' && candidate.constraint === 'bookings_resource_fk'
}

/**
 * The exclusion constraint reports a conflict as SQLSTATE 23P01. It is matched on the
 * constraint name rather than the message text, which is free to change.
 */
function isOverlapViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { code?: unknown; constraint?: unknown }
  return candidate.code === '23P01' && candidate.constraint === 'bookings_no_overlap'
}

export class BookingService {
  constructor(
    private readonly bookings: BookingRepository,
    private readonly resources: ResourceService,
    private readonly schedule: ScheduleRepository,
    private readonly exceptions: ExceptionRepository,
    private readonly pools: PoolRepository,
    private readonly options: BookingOptions,
  ) {}

  async create(
    tenantId: string,
    resourceId: string,
    body: CreateBookingBody,
  ): Promise<CreateResult> {
    const resource = await this.resources.loadOrFail(tenantId, resourceId)
    if (resource.concurrency_mode === 'pool') {
      return this.createInPool(tenantId, resource, body)
    }

    const { start, end, slots } = await this.validateTarget(
      resource,
      body.start_time,
      body.end_time,
      `Resource ${resourceId} is not active and cannot be booked`,
    )
    const holdMinutes = this.resolveHoldMinutes(body)

    // The lock is taken when the invariant spans more than one row, or when a
    // read-then-write has to be atomic. `exclusive` is a disjointness property that the
    // exclusion constraint enforces atomically at READ COMMITTED, so it needs neither on
    // its own; `shared` is a count, which does. An idempotency key adds the second reason
    // regardless of mode: without the lock, two concurrent replays each read no existing
    // row, then both race `insertIfKeyFree`, which can deadlock (40P01) when the table also
    // carries the exclusion constraint both rows violate against each other. The lock makes
    // the lookup-then-insert pair atomic, so the second request finds the first one's
    // committed row instead of racing it; `ON CONFLICT` remains as a safety net, not the
    // mechanism.
    const key = body.idempotency_key ?? null
    const countsCapacity = capacityIsCounted(resource.concurrency_mode)
    const needsLock = countsCapacity || key !== null

    const outcome = await this.inWrite(tenantId, resource.id, needsLock, async (trx, current) => {
      if (key !== null) {
        const existing = await this.bookings.findByIdempotencyKey(trx, tenantId, resource.id, key)
        if (existing) return { row: this.sameOrFail(existing, body, start, end), created: false }
      }

      // From here on the decision is made on the row read inside the transaction. The one
      // `validateTarget` saw is older than the lock, so a PATCH that retired the resource or
      // lowered its capacity in between would otherwise be acted on stale.
      const locked = this.stillThere(current, resource.id)
      if (!locked.is_active) {
        throw new ResourceInactiveError(
          `Resource ${resource.id} is not active and cannot be booked`,
          { resource_id: resource.id },
        )
      }

      if (countsCapacity) {
        await this.assertCapacity(trx, locked, slots, start, end)
      }

      const values = {
        tenant_id: tenantId,
        resource_id: resource.id,
        start_time: start,
        end_time: end,
        status: (holdMinutes === null ? 'confirmed' : 'held') as 'confirmed' | 'held',
        // Normalised once, here: `undefined` and `null` must not read as different customers
        // to the idempotency comparison in `sameOrFail`.
        customer_id: body.customer_id ?? null,
        concurrency_mode: resource.concurrency_mode,
        held_until: holdMinutes === null ? null : holdExpiry(holdMinutes),
        idempotency_key: key,
      }

      try {
        if (key === null) {
          return { row: await this.bookings.insert(trx, values), created: true }
        }

        const inserted = await this.bookings.insertIfKeyFree(trx, values)
        if (inserted) return { row: inserted, created: true }

        // A concurrent request claimed the key between the lookup and the insert. The
        // unique index closed the race; re-read and apply the same comparison.
        const raced = await this.bookings.findByIdempotencyKey(trx, tenantId, resource.id, key)
        if (!raced) throw new Error(`Idempotency key ${key} conflicted but no row was found`)
        return { row: this.sameOrFail(raced, body, start, end), created: false }
      } catch (error) {
        if (isOverlapViolation(error)) {
          throw new SlotUnavailableError('Those slots are offered, but they are already taken', {
            start_time: body.start_time,
            end_time: body.end_time,
          })
        }
        if (isMissingResource(error)) {
          throw new NotFoundError(`Resource ${resource.id} not found`)
        }
        throw error
      }
    })

    return {
      booking: toBookingResponse(outcome.row, resource.timezone),
      created: outcome.created,
    }
  }

  /**
   * Booking a pool means: validate the interval against the pool's own grid, narrow to the
   * members that offer the whole run, then claim one that is free.
   *
   * The check order is spec 3 §5.1, and it is what keeps `outside_schedule` and
   * `slot_unavailable` meaning different things across a set of members rather than just one
   * resource: the interval itself first (member-independent — every member shares the pool's
   * timezone and grid), then which members offer the run at all (none → the pool answers as
   * its members would, see below), then which of those is free (none → `slot_unavailable`,
   * offered but taken).
   */
  private async createInPool(
    tenantId: string,
    pool: ResourceRow,
    body: CreateBookingBody,
  ): Promise<CreateResult> {
    if (!pool.is_active) {
      throw new ResourceInactiveError(`Resource ${pool.id} is not active and cannot be booked`, {
        resource_id: pool.id,
      })
    }

    // Step 1: the interval itself — shape and range — against the pool's own timezone. This is
    // member-independent, since every member shares the pool's grid, and is decided before any
    // member is loaded. Boundary alignment is necessarily per-member: `conventions.md` anchors
    // the slot grid per window, not globally, so whether a given instant starts a slot depends
    // on which windows that member has open — exactly what step 2 resolves next.
    const { start, end } = this.parseInterval(body.start_time, body.end_time, pool.timezone)

    // Step 2: the members that offer the whole run. A pool must answer as its members would:
    // for one resource, `checkAgainstGrid` already distinguishes "no slot begins here"
    // (`invalid_slot_boundary` — TC-BK-R01 off-grid, TC-BK-R04 a day the resource does not
    // work) from "a slot begins here, but the run is not fully offered" (`outside_schedule` —
    // TC-BK-R03). A pool of such members must draw the same line: if every member that fails
    // says nothing starts there, the pool has no slot starting there either, and the honest
    // answer is `invalid_slot_boundary`; if even one member's grid starts a slot at that
    // instant, the run *was* offered somewhere, and failing to complete it is `outside_schedule`.
    const members = await this.pools.listMembers(tenantId, pool.id, true)
    const offering: ResourceRow[] = []
    const failures: BookingGridError[] = []
    for (const member of members) {
      const slots = await this.offeredSlots(member, body.start_time, body.end_time)
      const check = checkAgainstGrid(slots, body.start_time, body.end_time)
      if (check.ok) offering.push(member)
      else failures.push(check.error)
    }
    if (offering.length === 0) {
      if (failures.length > 0 && failures.every((error) => error === 'invalid_slot_boundary')) {
        throw new InvalidSlotBoundaryError(
          `No member of pool ${pool.id} has a slot starting at ${body.start_time}`,
          { pool_id: pool.id, start_time: body.start_time, end_time: body.end_time },
        )
      }
      throw new OutsideScheduleError(
        `No member of pool ${pool.id} offers every slot between ${body.start_time} and ${body.end_time}`,
        { pool_id: pool.id },
      )
    }

    const holdMinutes = this.resolveHoldMinutes(body)
    const key = body.idempotency_key ?? null

    const outcome = await this.inPoolWrite(tenantId, pool.id, key !== null, async (trx, locked) => {
      if (key !== null) {
        const existing = await this.bookings.findByPoolIdempotencyKey(trx, tenantId, pool.id, key)
        if (existing) return { row: this.sameOrFail(existing, body, start, end), created: false }
      }

      // From here on the decision is made on the pool row read inside the transaction, exactly
      // as `create` does. The row this method opened with is older than the per-member scan
      // above — N sequential round trips — so a PATCH retiring the pool, or a DELETE of an
      // emptied one, commits inside a window that is not small.
      const current = this.stillThere(locked, pool.id)
      if (!current.is_active) {
        throw new ResourceInactiveError(`Resource ${pool.id} is not active and cannot be booked`, {
          resource_id: pool.id,
        })
      }

      // Step 3: claim one. `undefined` means every member that offers the run is taken.
      const memberId = await this.pools.claimMember(
        trx,
        tenantId,
        pool.id,
        offering.map((member) => member.id),
        start,
        end,
      )
      if (memberId === undefined) {
        throw new SlotUnavailableError(
          'Those slots are offered, but every member of the pool is already booked for them',
          { pool_id: pool.id },
        )
      }

      return {
        row: await this.bookings.insert(trx, {
          tenant_id: tenantId,
          resource_id: memberId,
          start_time: start,
          end_time: end,
          status: (holdMinutes === null ? 'confirmed' : 'held') as 'confirmed' | 'held',
          customer_id: body.customer_id ?? null,
          // The member's mode, never the pool's: a booking row carrying `pool` would be
          // governed by neither the exclusion constraint nor the capacity count.
          concurrency_mode: 'exclusive',
          held_until: holdMinutes === null ? null : holdExpiry(holdMinutes),
          idempotency_key: key,
        }),
        created: true,
      }
    })

    return {
      booking: toBookingResponse(outcome.row, pool.timezone),
      created: outcome.created,
    }
  }

  private async inPoolWrite<T>(
    tenantId: string,
    poolId: string,
    lockPool: boolean,
    work: (trx: Trx, pool: ResourceRow | undefined) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.bookings.inPoolWriteTransaction(tenantId, poolId, lockPool, work)
    } catch (error) {
      if (isOverlapViolation(error)) {
        throw new SlotUnavailableError(
          'Those slots are offered, but a member was taken between selection and the insert',
          { pool_id: poolId },
        )
      }
      rethrowContention(error, 'The booking')
    }
  }

  /**
   * "The same" is compared on customer, start and end — the three fields that identify what
   * was booked. `hold` and `hold_minutes` describe how it was created, not what it is, and
   * `hold_minutes` has already been consumed into a `held_until` by the time a replay
   * arrives.
   */
  private sameOrFail(
    existing: BookingRow,
    body: CreateBookingBody,
    start: Date,
    end: Date,
  ): BookingRow {
    const matches =
      existing.customer_id === (body.customer_id ?? null) &&
      existing.start_time.getTime() === start.getTime() &&
      existing.end_time.getTime() === end.getTime()

    if (!matches) {
      throw new IdempotencyKeyReusedError(
        'That idempotency key was used for a different booking; this is a caller error, not a retry',
        { idempotency_key: body.idempotency_key },
      )
    }
    return existing
  }

  /**
   * Every write goes through here, so contention has one translation point rather than three.
   * It wraps the whole transaction, not just the caller's body: the stale-hold sweep runs
   * before that body and is one of the two statements that can deadlock.
   */
  private async inWrite<T>(
    tenantId: string,
    resourceId: string,
    lockResource: boolean,
    work: (trx: Trx, resource: ResourceRow | undefined) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.bookings.inWriteTransaction(tenantId, resourceId, lockResource, work)
    } catch (error) {
      rethrowContention(error, 'The booking')
    }
  }

  /** The resource as the transaction sees it, or a 404 if it was deleted in the meantime. */
  private stillThere(resource: ResourceRow | undefined, id: string): ResourceRow {
    if (!resource) throw new NotFoundError(`Resource ${id} not found`)
    return resource
  }

  /** Rejects the write once any offered slot has already reached capacity. */
  private async assertCapacity(
    trx: Trx,
    resource: ResourceRow,
    slots: Slot[],
    start: Date,
    end: Date,
    excludeId?: string,
  ): Promise<void> {
    const active = await this.bookings.activeOverlapping(
      trx,
      resource.tenant_id,
      resource.id,
      start,
      end,
      excludeId,
    )

    for (const slot of slots) {
      const taken = countOccupying(active, slot)

      if (taken >= resource.capacity) {
        throw new SlotUnavailableError(
          'Those slots are offered, but capacity for them is already taken',
          { slot_start: slot.start, capacity: resource.capacity },
        )
      }
    }
  }

  async getById(tenantId: string, id: string): Promise<BookingResponse> {
    const row = await this.loadOrFail(tenantId, id)
    return toBookingResponse(row, row.timezone)
  }

  /**
   * One rule instead of a table of special cases: a transition into the state the booking
   * is already in is a successful no-op, and any other transition out of a terminal state
   * is refused. A `confirm` retried after a network timeout therefore succeeds, while
   * cancelling a completed booking fails honestly.
   *
   * The work happens inside the write transaction so the stale-hold sweep runs first: a
   * hold whose `held_until` has passed is already `expired` by the time it is read, and the
   * decision uses the database's clock rather than this process's.
   */
  async apply(tenantId: string, id: string, action: BookingAction): Promise<BookingResponse> {
    const initial = await this.loadOrFail(tenantId, id)
    const { target, from } = TRANSITIONS[action]

    const row = await this.inWrite(tenantId, initial.resource_id, false, async (trx) => {
      const current = await this.bookings.findIn(trx, tenantId, id)
      if (!current) throw new NotFoundError(`Booking ${id} not found`)

      if (current.status === target) return current

      if (!from.includes(current.status)) {
        // A hold that ran out is refused with its own code: the caller needs to tell an
        // expiry apart from an illegal transition.
        if (action === 'confirm' && current.status === 'expired') {
          throw new HoldExpiredError('That hold expired before it was confirmed', {
            status: current.status,
          })
        }
        throw new InvalidStateTransitionError(
          `A booking in status "${current.status}" cannot become "${target}"`,
          { status: current.status, requested: target },
        )
      }

      // held_until is meaningful only while a hold is outstanding or after it lapsed; every
      // other status clears it, which the CHECK constraint enforces.
      return this.bookings.setStatus(trx, id, target, null)
    })

    return toBookingResponse(row, initial.timezone)
  }

  /**
   * The same row is updated, so the id and the status survive. An exclusion constraint never
   * compares a row with itself, which is why "cancel plus book in one transaction" describes
   * the effect rather than the implementation — a single UPDATE is safe.
   */
  async reschedule(
    tenantId: string,
    id: string,
    body: RescheduleBookingBody,
  ): Promise<BookingResponse> {
    const initial = await this.loadOrFail(tenantId, id)
    const resource = await this.resources.loadOrFail(tenantId, initial.resource_id)

    const { start, end, slots } = await this.validateTarget(
      resource,
      body.start_time,
      body.end_time,
      `Resource ${resource.id} is not active and its bookings cannot be moved`,
    )

    const needsLock = capacityIsCounted(resource.concurrency_mode)

    const row = await this.inWrite(tenantId, resource.id, needsLock, async (trx, locked) => {
      const booking = await this.bookings.findIn(trx, tenantId, id)
      if (!booking) throw new NotFoundError(`Booking ${id} not found`)

      if (booking.status !== 'held' && booking.status !== 'confirmed') {
        throw new InvalidStateTransitionError(
          `A booking in status "${booking.status}" cannot be rescheduled`,
          { status: booking.status },
        )
      }

      const current = this.stillThere(locked, resource.id)
      if (!current.is_active) {
        throw new ResourceInactiveError(
          `Resource ${resource.id} is not active and its bookings cannot be moved`,
          { resource_id: resource.id },
        )
      }

      if (needsLock) {
        // Excluding itself is what keeps the booking from blocking its own move.
        await this.assertCapacity(trx, current, slots, start, end, id)
      }

      try {
        return await this.bookings.updateTimes(trx, id, start, end)
      } catch (error) {
        if (isOverlapViolation(error)) {
          throw new SlotUnavailableError('Those slots are offered, but they are already taken', {
            start_time: body.start_time,
            end_time: body.end_time,
          })
        }
        throw error
      }
    })

    return toBookingResponse(row, resource.timezone)
  }

  /**
   * The two listings interpret their window in different zones, and the difference is
   * deliberate. A per-resource listing has an obvious zone — the resource's own, the same
   * one availability and exceptions use. A per-customer listing has none: it spans resources
   * in different zones and no one of them outranks the others, so its dates are UTC.
   */
  private window(from: string, to: string, timezone: string): { from: Date; to: Date } {
    assertValidRange(from, to, this.options.maxRangeDays)
    return {
      from: DateTime.fromISO(from, { zone: timezone }).startOf('day').toJSDate(),
      to: DateTime.fromISO(to, { zone: timezone }).startOf('day').toJSDate(),
    }
  }

  async listForResource(
    tenantId: string,
    resourceId: string,
    query: ResourceBookingsQuery,
  ): Promise<BookingResponse[]> {
    const resource = await this.resources.loadOrFail(tenantId, resourceId)
    const window = this.window(query.from, query.to, resource.timezone)

    const rows = await this.bookings.list({
      tenantId,
      resourceId: resource.id,
      from: window.from,
      to: window.to,
      status: query.status,
    })
    return rows.map((row) => toBookingResponse(row, row.timezone))
  }

  async listForCustomer(
    tenantId: string,
    query: CustomerBookingsQuery,
  ): Promise<BookingResponse[]> {
    const window = this.window(query.from, query.to, 'utc')

    const rows = await this.bookings.list({
      tenantId,
      customerId: query.customer_id,
      from: window.from,
      to: window.to,
      status: query.status,
    })
    return rows.map((row) => toBookingResponse(row, row.timezone))
  }

  async loadOrFail(tenantId: string, id: string) {
    const row = await this.bookings.findById(tenantId, id)
    if (!row) throw new NotFoundError(`Booking ${id} not found`)
    return row
  }

  /**
   * The precondition every write against a resource shares before opening a transaction: the
   * resource must be active, the interval must parse, and it must equal a contiguous run of
   * the grid. `create` and `reschedule` differ only in the error text for the first check —
   * one says the resource cannot be booked, the other that its bookings cannot be moved —
   * which is why that message is a parameter rather than being fixed here.
   *
   * Order is load-bearing: `parseInterval` rejects an unparseable or inverted interval and
   * enforces `maxRangeDays` before `offeredSlots` is asked to generate dates from it, and
   * `offeredSlots` must run before the result can be checked against the grid.
   */
  private async validateTarget(
    resource: ResourceRow,
    startIso: string,
    endIso: string,
    inactiveMessage: string,
  ): Promise<{ start: Date; end: Date; slots: Slot[] }> {
    if (!resource.is_active) {
      throw new ResourceInactiveError(inactiveMessage, { resource_id: resource.id })
    }

    const { start, end } = this.parseInterval(startIso, endIso, resource.timezone)
    const slots = await this.offeredSlots(resource, startIso, endIso)
    const check = checkAgainstGrid(slots, startIso, endIso)
    if (!check.ok) gridError(check.error, startIso, endIso)

    return { start, end, slots: check.slots }
  }

  /** Both instants, plus the bound that keeps a wild interval from generating a huge grid. */
  private parseInterval(
    startIso: string,
    endIso: string,
    timezone: string,
  ): { start: Date; end: Date } {
    const start = DateTime.fromISO(startIso, { zone: timezone })
    const end = DateTime.fromISO(endIso, { zone: timezone })

    if (!start.isValid || !end.isValid) {
      throw new InvalidIntervalError('start_time and end_time must be ISO-8601 timestamps', {
        start_time: startIso,
        end_time: endIso,
      })
    }
    if (end <= start) {
      throw new InvalidIntervalError('end_time must be after start_time', {
        start_time: startIso,
        end_time: endIso,
      })
    }

    // Bounded like every other span in the engine. Without this a booking ending in the far
    // future would ask the generator for millions of dates.
    const days = end.diff(start, 'days').days
    if (days > this.options.maxRangeDays) {
      throw new InvalidIntervalError(
        `A booking may not span more than ${this.options.maxRangeDays} days`,
        { days },
      )
    }

    return { start: start.toJSDate(), end: end.toJSDate() }
  }

  /**
   * Null means "confirm immediately"; a number is how many minutes the hold lasts. The
   * deadline itself is computed by Postgres — see `holdExpiry` — so only the count travels
   * from here. The bound stays in the service, because it is a rule about what a caller may
   * ask for rather than part of the write.
   */
  private resolveHoldMinutes(body: CreateBookingBody): number | null {
    if (body.hold !== true) {
      if (body.hold_minutes !== undefined) {
        throw new ValidationError(
          'hold_minutes is only valid together with hold: true; accepting it alone would look like a hold was created',
          { field: 'hold_minutes' },
        )
      }
      return null
    }

    const minutes = body.hold_minutes ?? this.options.defaultHoldMinutes
    if (minutes > this.options.maxHoldMinutes) {
      throw new ValidationError(`hold_minutes must not exceed ${this.options.maxHoldMinutes}`, {
        field: 'hold_minutes',
      })
    }
    return minutes
  }

  /** The slots this resource offers over the dates the interval can touch. */
  private async offeredSlots(
    resource: ResourceRow,
    startIso: string,
    endIso: string,
  ): Promise<Slot[]> {
    const dates = gridDatesFor(startIso, endIso, resource.timezone)
    const first = dates[0]!
    const afterLast = DateTime.fromISO(dates[dates.length - 1]!, { zone: resource.timezone })
      .plus({ days: 1 })
      .toISODate()!

    const [scheduleRows, exceptionRows] = await Promise.all([
      this.schedule.listByResource(resource.tenant_id, resource.id),
      // listInRange is half-open on `to`, so the day after the last date is what includes it.
      this.exceptions.listInRange(resource.tenant_id, resource.id, first, afterLast),
    ])

    return generateSlots({
      dates,
      windowsByDate: resolveWindows({
        dates,
        timezone: resource.timezone,
        scheduleRows,
        exceptionRows,
      }),
      timezone: resource.timezone,
      slotDuration: parseSlotDuration(resource.slot_duration),
      anchorTime: formatTime(resource.slot_anchor_time),
    })
  }
}
