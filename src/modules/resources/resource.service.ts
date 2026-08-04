import { IANAZone } from 'luxon'
import {
  NotFoundError,
  UnsupportedConcurrencyModeError,
  ValidationError,
} from '../../shared/errors.js'
import {
  InvalidDurationError,
  formatTime,
  parseSlotDuration,
  type SlotDuration,
} from '../../shared/time.js'
import type { ResourceRepository, ResourceRow } from './resource.repository.js'
import type {
  CreateResourceBody,
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

export function toResponse(row: ResourceRow): ResourceResponse {
  return {
    id: row.id,
    timezone: row.timezone,
    slot_duration: row.slot_duration,
    slot_anchor_time: formatTime(row.slot_anchor_time),
    capacity: row.capacity,
    concurrency_mode: row.concurrency_mode,
    is_active: row.is_active,
  }
}

export class ResourceService {
  constructor(private readonly repository: ResourceRepository) {}

  async create(body: CreateResourceBody): Promise<ResourceResponse> {
    if (body.concurrency_mode === 'pool') {
      throw new UnsupportedConcurrencyModeError(
        'concurrency_mode "pool" is not implemented yet; storing a resource the engine cannot serve availability for would be worse than refusing it',
      )
    }

    assertNamedTimezone(body.timezone)

    const duration = parseDurationOrFail(body.slot_duration)
    const anchor = body.slot_anchor_time ?? DEFAULT_ANCHOR
    const capacity = body.capacity ?? 1

    assertAnchorMatchesDuration(duration, anchor)
    assertCapacityMatchesMode(body.concurrency_mode, capacity)

    const row = await this.repository.insert({
      timezone: body.timezone,
      slot_duration: duration.iso,
      slot_anchor_time: anchor,
      capacity,
      concurrency_mode: body.concurrency_mode,
    })

    return toResponse(row)
  }

  async getById(id: string): Promise<ResourceResponse> {
    return toResponse(await this.loadOrFail(id))
  }

  async update(id: string, body: UpdateResourceBody): Promise<ResourceResponse> {
    const current = await this.loadOrFail(id)

    // Validate the resulting state, not the patch: changing only the duration can invalidate
    // an anchor that was legal before.
    const duration = parseDurationOrFail(body.slot_duration ?? current.slot_duration)
    const anchor = body.slot_anchor_time ?? formatTime(current.slot_anchor_time)
    const capacity = body.capacity ?? current.capacity

    assertAnchorMatchesDuration(duration, anchor)
    assertCapacityMatchesMode(current.concurrency_mode, capacity)

    const row = await this.repository.update(id, {
      slot_duration: duration.iso,
      slot_anchor_time: anchor,
      capacity,
      ...(body.is_active === undefined ? {} : { is_active: body.is_active }),
    })

    if (!row) throw new NotFoundError(`Resource ${id} not found`)
    return toResponse(row)
  }

  async delete(id: string): Promise<void> {
    const deleted = await this.repository.delete(id)
    if (!deleted) throw new NotFoundError(`Resource ${id} not found`)
  }

  async loadOrFail(id: string): Promise<ResourceRow> {
    const row = await this.repository.findById(id)
    if (!row) throw new NotFoundError(`Resource ${id} not found`)
    return row
  }
}
