/** Which of the four rules of spec 3 §3 a rejected case violates. */
export type MembershipRule = 'tenant' | 'kind' | 'member_mode' | 'grid'

export interface RejectedMembership {
  name: string
  /** Overrides applied to the joining resource, on top of a P1D/14:00/Europe/Warsaw base. */
  member: Record<string, unknown>
  /** Overrides applied to the pool, on the same base. */
  pool: Record<string, unknown>
  rule: MembershipRule
}

export const rejectedMemberships: readonly RejectedMembership[] = [
  {
    name: 'the target is an ordinary resource, not a pool',
    member: {},
    pool: { concurrency_mode: 'exclusive' },
    rule: 'kind',
  },
  {
    name: 'the joining resource is itself a pool',
    member: { concurrency_mode: 'pool' },
    pool: {},
    rule: 'member_mode',
  },
  {
    name: 'the joining resource is shared',
    member: { concurrency_mode: 'shared', capacity: 4 },
    pool: {},
    rule: 'member_mode',
  },
  { name: 'the timezone differs', member: { timezone: 'UTC' }, pool: {}, rule: 'grid' },
  {
    name: 'the slot duration differs',
    member: { slot_duration: 'PT1H', slot_anchor_time: '00:00' },
    pool: {},
    rule: 'grid',
  },
  { name: 'the anchor differs', member: { slot_anchor_time: '15:00' }, pool: {}, rule: 'grid' },
]

/**
 * The other half of rule 4, read from the pool's side: spec 3 §3 refuses "changing a member's
 * `slot_duration`, or a pool's" for the same reason. Each patch is applied to a pool that
 * already has one member sharing the base grid.
 */
export interface RejectedPoolGridPatch {
  name: string
  /** The PATCH body sent to the pool itself. */
  patch: Record<string, unknown>
  /** Which grid fields the refusal must name. */
  fields: string[]
}

export const rejectedPoolGridPatches: readonly RejectedPoolGridPatch[] = [
  // P7D rather than an intraday duration: changing to PT1H under a 14:00 anchor is refused by
  // the anchor rule first, which would make this case pass without saying anything about pools.
  {
    name: 'the slot duration is changed',
    patch: { slot_duration: 'P7D' },
    fields: ['slot_duration'],
  },
  {
    name: 'the anchor is changed',
    patch: { slot_anchor_time: '15:00' },
    fields: ['slot_anchor_time'],
  },
  {
    name: 'both are changed at once',
    patch: { slot_duration: 'PT1H', slot_anchor_time: '00:00' },
    fields: ['slot_duration', 'slot_anchor_time'],
  },
]
