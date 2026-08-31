import { IANAZone } from 'luxon'
import {
  NotFoundError,
  PoolHasMembersError,
  ResourceHasBookingsError,
  ValidationError,
  rethrowContention,
} from '../../shared/errors.js'
import {
  InvalidDurationError,
  formatTime,
  parseSlotDuration,
  type SlotDuration,
} from '../../shared/time.js'
import type { PoolService } from './pool.service.js'
import type { ResourceRepository, ResourceRow } from './resource.repository.js'
import type {
  CreateResourceBody,
  ResourceListQuery,
  ResourceResponse,
  UpdateResourceBody,
} from './resource.schemas.js'

const DEFAULT_ANCHOR = '00:00'

/** `+02:00`, `-05:00`, `+0200`, `+02` — a fixed offset written where a zone belongs. */
const NUMERIC_OFFSET = /^[+-]\d/

/**
 * Luxon accepts a bare numeric offset as a valid "zone", but such a value carries no DST
 * rules: a Warsaw resource stored as `+02:00` would silently be an hour off for half the
 * year. Only named zones are accepted here.
 */
function assertNamedTimezone(timezone: string): void {
  if (NUMERIC_OFFSET.test(timezone)) {
    throw new ValidationError(
      `timezone must be a named IANA zone such as "Europe/Warsaw", not the fixed offset "${timezone}"; an offset has no daylight-saving rules`,
      { field: 'timezone' },
    )
  }

  if (!IANAZone.isValidZone(timezone)) {
    throw new ValidationError(`Unknown IANA timezone "${timezone}"`, { field: 'timezone' })
  }
}

function parseDurationOrFail(value: string): SlotDuration {
  try {
    return parseSlotDuration(value)
  } catch (error) {
    if (error instanceof InvalidDurationError) {
      throw new ValidationError(error.message, { field: 'slot_duration' })
    }
    throw error
  }
}

/**
 * The anchor is only consulted for day-based resources. Silently ignoring a value the caller
 * explicitly set is a worse failure mode than rejecting it, so an intraday resource must
 * leave the anchor at its default.
 */
function assertAnchorMatchesDuration(duration: SlotDuration, anchor: string): void {
  if (duration.kind === 'intraday' && anchor !== DEFAULT_ANCHOR) {
    throw new ValidationError(
      `slot_anchor_time must be ${DEFAULT_ANCHOR} for an intraday resource; it only applies to P<n>D durations`,
      { field: 'slot_anchor_time' },
    )
  }
}

function assertCapacityMatchesMode(mode: string, capacity: number): void {
  if (mode === 'exclusive' && capacity !== 1) {
    throw new ValidationError('capacity must be 1 when concurrency_mode is "exclusive"', {
      field: 'capacity',
    })
  }
}

/**
 * The foreign key is the guard, and the service only translates its complaint. Counting
 * bookings first and then deleting would leave a window in which a booking arrives between
 * the two statements; letting the constraint decide has no such window.
 */
function isBookingReference(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { code?: unknown; constraint?: unknown }
  // Migration 003 replaced the single-column key with the composite `bookings_resource_fk`,
  // so the name matched here moved with it.
  return candidate.code === '23503' && candidate.constraint === 'bookings_resource_fk'
}

/** A delete blocked by a member still carrying this resource's id as its `pool_id`. */
function isMemberReference(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { code?: unknown; constraint?: unknown }
  return candidate.code === '23503' && candidate.constraint === 'resources_pool_fk'
}

export function toResponse(row: ResourceRow): ResourceResponse {
  return {
    id: row.id,
    timezone: row.timezone,
    slot_duration: row.slot_duration,
    slot_anchor_time: formatTime(row.slot_anchor_time),
    capacity: row.capacity,
    concurrency_mode: row.concurrency_mode,
    is_active: row.is_active,
    pool_id: row.pool_id,
  }
}

export class ResourceService {
  constructor(
    private readonly repository: ResourceRepository,
    private readonly pools: PoolService,
  ) {}

  async create(tenantId: string, body: CreateResourceBody): Promise<ResourceResponse> {
    assertNamedTimezone(body.timezone)

    const duration = parseDurationOrFail(body.slot_duration)
    const anchor = body.slot_anchor_time ?? DEFAULT_ANCHOR
    const capacity = body.capacity ?? 1

    assertAnchorMatchesDuration(duration, anchor)
    assertCapacityMatchesMode(body.concurrency_mode, capacity)
    this.pools.assertPoolShape(body.concurrency_mode, capacity)
    if (body.pool_id !== undefined) {
      await this.pools.assertMembership(
        tenantId,
        {
          timezone: body.timezone,
          slot_duration: duration.iso,
          slot_anchor_time: anchor,
          concurrency_mode: body.concurrency_mode,
        },
        body.pool_id,
      )
    }

    const row = await this.repository.insert({
      tenant_id: tenantId,
      timezone: body.timezone,
      slot_duration: duration.iso,
      slot_anchor_time: anchor,
      capacity,
      concurrency_mode: body.concurrency_mode,
      pool_id: body.pool_id ?? null,
    })

    return toResponse(row)
  }

  async getById(tenantId: string, id: string): Promise<ResourceResponse> {
    return toResponse(await this.loadOrFail(tenantId, id))
  }

  async list(tenantId: string, query: ResourceListQuery): Promise<ResourceResponse[]> {
    const rows = await this.repository.list(tenantId, { isActive: query.is_active })
    return rows.map(toResponse)
  }

  async update(tenantId: string, id: string, body: UpdateResourceBody): Promise<ResourceResponse> {
    const current = await this.loadOrFail(tenantId, id)

    // Validate the resulting state, not the patch: changing only the duration can invalidate
    // an anchor that was legal before.
    const duration = parseDurationOrFail(body.slot_duration ?? current.slot_duration)
    const anchor = body.slot_anchor_time ?? formatTime(current.slot_anchor_time)
    const capacity = body.capacity ?? current.capacity

    assertAnchorMatchesDuration(duration, anchor)
    assertCapacityMatchesMode(current.concurrency_mode, capacity)
    this.pools.assertPoolShape(current.concurrency_mode, capacity)

    const resulting = {
      timezone: current.timezone,
      slot_duration: duration.iso,
      slot_anchor_time: anchor,
      concurrency_mode: current.concurrency_mode,
    }

    // The two halves of the grid rule are mutually exclusive — a pool may not itself be a
    // member — so this branch and the one below never both run.
    if (current.concurrency_mode === 'pool') {
      await this.pools.assertGridStableForMembers(tenantId, current, resulting)
    }

    const poolId = body.pool_id === undefined ? current.pool_id : body.pool_id
    if (poolId !== null) {
      await this.pools.assertMembership(tenantId, resulting, poolId)
    }

    const row = await this.repository.update(tenantId, id, {
      slot_duration: duration.iso,
      slot_anchor_time: anchor,
      capacity,
      ...(body.is_active === undefined ? {} : { is_active: body.is_active }),
      ...(body.pool_id === undefined ? {} : { pool_id: body.pool_id }),
    })

    if (!row) throw new NotFoundError(`Resource ${id} not found`)
    return toResponse(row)
  }

  async delete(tenantId: string, id: string): Promise<void> {
    let deleted: boolean
    try {
      deleted = await this.repository.delete(tenantId, id)
    } catch (error) {
      if (isMemberReference(error)) {
        throw new PoolHasMembersError(
          `Pool ${id} still has members; move them out with PATCH pool_id: null before deleting it`,
          { pool_id: id },
        )
      }
      if (isBookingReference(error)) {
        throw new ResourceHasBookingsError(
          `Resource ${id} has bookings on record and cannot be deleted; set is_active to false to retire it instead`,
          { resource_id: id },
        )
      }
      // This statement locks the resource row and then key-share-locks its bookings for the
      // RESTRICT check — the opposite order to a booking insert, so it is one side of a
      // possible deadlock and must not surface as a 500.
      rethrowContention(error, 'The delete')
    }

    if (!deleted) throw new NotFoundError(`Resource ${id} not found`)
  }

  async loadOrFail(tenantId: string, id: string): Promise<ResourceRow> {
    const row = await this.repository.findById(tenantId, id)
    if (!row) throw new NotFoundError(`Resource ${id} not found`)
    return row
  }
}
