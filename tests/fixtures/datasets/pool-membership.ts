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
