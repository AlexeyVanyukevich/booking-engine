import type { ConcurrencyMode } from '../../db/schema.js'
import { InvalidPoolMembershipError, ValidationError } from '../../shared/errors.js'
import { formatTime } from '../../shared/time.js'
import type { ResourceRepository, ResourceRow } from './resource.repository.js'

/** The fields a membership decision reads, on a resource that may not exist yet. */
export interface MembershipCandidate {
  timezone: string
  slot_duration: string
  slot_anchor_time: string
  concurrency_mode: ConcurrencyMode
}

const GRID_FIELDS = ['timezone', 'slot_duration', 'slot_anchor_time'] as const

export class PoolService {
  constructor(private readonly resources: ResourceRepository) {}

  /**
   * The four rules of spec 3 §3. The composite foreign key already makes a cross-tenant pool
   * unwritable; checking here first is what turns a constraint violation into an answer that
   * tells the caller nothing about other tenants.
   */
  async assertMembership(
    tenantId: string,
    joining: MembershipCandidate,
    poolId: string,
  ): Promise<void> {
    const pool = await this.resources.findById(tenantId, poolId)
    if (!pool) {
      throw new InvalidPoolMembershipError(`No pool ${poolId} in this tenant`, {
        rule: 'tenant',
        pool_id: poolId,
      })
    }

    if (pool.concurrency_mode !== 'pool') {
      throw new InvalidPoolMembershipError(
        `Resource ${poolId} is not a pool; only a resource with concurrency_mode "pool" can have members`,
        { rule: 'kind', pool_id: poolId },
      )
    }

    // One rule, two exclusions: a `pool` member would be nesting, and a `shared` member would
    // make derived capacity a sum of capacities rather than a count of members.
    if (joining.concurrency_mode !== 'exclusive') {
      throw new InvalidPoolMembershipError(
        `A pool member must be exclusive, not "${joining.concurrency_mode}"`,
        { rule: 'member_mode', concurrency_mode: joining.concurrency_mode },
      )
    }

    const mismatched = GRID_FIELDS.filter(
      (field) => normalise(field, joining) !== normalise(field, pool),
    )
    if (mismatched.length > 0) {
      throw new InvalidPoolMembershipError(
        `A member must share its pool's grid; ${mismatched.join(', ')} differ from pool ${poolId}`,
        { rule: 'grid', fields: mismatched, pool_id: poolId },
      )
    }
  }

  /** A pool's stored capacity is meaningless, so only the value that says so is accepted. */
  assertPoolShape(mode: ConcurrencyMode, capacity: number): void {
    if (mode === 'pool' && capacity !== 1) {
      throw new ValidationError(
        'capacity must be 1 on a pool; effective capacity is derived from the count of active members and is never stored',
        { field: 'capacity' },
      )
    }
  }
}

/** `slot_anchor_time` reads back as `HH:MM:SS` from Postgres but arrives as `HH:MM`. */
function normalise(
  field: (typeof GRID_FIELDS)[number],
  row: MembershipCandidate | ResourceRow,
): string {
  const value = row[field]
  return field === 'slot_anchor_time' ? formatTime(value) : value
}
