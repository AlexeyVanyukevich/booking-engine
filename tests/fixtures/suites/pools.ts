import { rejectedMemberships, type RejectedMembership } from '../datasets/pool-membership.js'
import { expectStatus, type Suite } from './types.js'

const poolBase = {
  timezone: 'Europe/Warsaw',
  slot_duration: 'P1D',
  slot_anchor_time: '14:00',
  concurrency_mode: 'pool' as const,
}
const memberBase = { ...poolBase, concurrency_mode: 'exclusive' as const }

export const poolMembershipSuite: Suite<RejectedMembership> = {
  name: 'Pools — membership validation',
  cases: rejectedMemberships,
  describe: (testCase) => `refuses when ${testCase.name}`,
  run: async ({ api, newResource }, testCase) => {
    // newResource records what it creates, so the run cleans up after itself.
    const poolId = await newResource({ ...poolBase, ...testCase.pool })
    const response = await api.createResource({
      ...memberBase,
      ...testCase.member,
      pool_id: poolId,
    })

    const status = expectStatus(response, 400)
    if (status) return status

    const body = response.json()
    if (body?.error !== 'invalid_pool_membership') {
      return `expected error "invalid_pool_membership", got "${body?.error}"`
    }
    if (body?.details?.rule !== testCase.rule) {
      return `expected details.rule "${testCase.rule}", got "${body?.details?.rule}"`
    }
    return null
  },
}

interface PoolMembershipAcceptedCase {
  name: string
}

const acceptedMembershipCases: readonly PoolMembershipAcceptedCase[] = [
  { name: 'a member that matches its pool exactly' },
]

/**
 * The membership suite above is all rejections — Task 3's review flagged that smoke coverage
 * of pools never once exercised the happy path. This proves a member whose grid matches its
 * pool is actually accepted and comes back carrying the pool's id.
 *
 * The pool is created via `api.givenResource` rather than `newResource`, and only tracked for
 * cleanup after the member — cleanup runs in creation order, and a pool that still has a
 * member refuses to delete (`pool_has_members`), so the pool must be tracked last.
 */
export const poolMembershipAcceptedSuite: Suite<PoolMembershipAcceptedCase> = {
  name: 'Pools — membership acceptance',
  cases: acceptedMembershipCases,
  describe: (testCase) => testCase.name,
  run: async ({ api, newResource, track }) => {
    const poolId = await api.givenResource(poolBase)
    const memberId = await newResource({ ...memberBase, pool_id: poolId })
    track(poolId)

    const fetched = await api.getResource(memberId)
    const status = expectStatus(fetched, 200)
    if (status) return status
    return fetched.json()?.pool_id === poolId
      ? null
      : `expected pool_id "${poolId}", got "${fetched.json()?.pool_id}"`
  },
}

interface PoolBookingCase {
  name: string
  members: number
  /** How many bookings for the same night must be accepted before one is refused. */
  accepted: number
}

const poolBookingCases: readonly PoolBookingCase[] = [
  { name: 'one member takes one booking, then refuses', members: 1, accepted: 1 },
  { name: 'two members take two bookings, then refuse', members: 2, accepted: 2 },
]

export const poolBookingSuite: Suite<PoolBookingCase> = {
  name: 'Pools — booking claims a member',
  cases: poolBookingCases,
  describe: (testCase) => testCase.name,
  run: async ({ api, newResource }, testCase) => {
    const poolId = await newResource(poolBase)
    const memberIds: string[] = []

    for (let i = 0; i < testCase.members; i += 1) {
      const memberId = await newResource({ ...memberBase, pool_id: poolId })
      await api.putSchedule(
        memberId,
        [0, 1, 2, 3, 4, 5, 6].map((day_of_week) => ({
          day_of_week,
          start_time: null,
          end_time: null,
        })),
      )
      memberIds.push(memberId)
    }

    const night = {
      start_time: '2026-07-20T14:00:00+02:00',
      end_time: '2026-07-21T14:00:00+02:00',
    }

    const landedOn = new Set<string>()
    for (let i = 0; i < testCase.accepted; i += 1) {
      const response = await api.createBooking(poolId, night)
      const status = expectStatus(response, 201)
      if (status) return `booking ${i + 1}: ${status}`

      const resourceId = response.json()?.resource_id
      if (resourceId === poolId) return 'the booking points at the pool rather than a member'
      if (!memberIds.includes(resourceId)) return `resource_id ${resourceId} is not a member`
      if (landedOn.has(resourceId)) return `two bookings landed on the same member ${resourceId}`
      landedOn.add(resourceId)
    }

    const refused = await api.createBooking(poolId, night)
    const status = expectStatus(refused, 409)
    if (status) return `after ${testCase.accepted} bookings: ${status}`
    return refused.json()?.error === 'slot_unavailable'
      ? null
      : `expected error "slot_unavailable", got "${refused.json()?.error}"`
  },
}

interface PoolDeletionCase {
  name: string
}

const poolDeletionCases: readonly PoolDeletionCase[] = [
  { name: 'refuses to delete a pool that still has a member' },
]

/**
 * Also carried over from Task 3's review: deleting a pool out from under its members was
 * covered in-process but never replayed over HTTP. Same tracking-order rule as the acceptance
 * suite above — the pool is tracked after its member, so the final cleanup pass can actually
 * remove both.
 */
export const poolDeletionSuite: Suite<PoolDeletionCase> = {
  name: 'Pools — deletion',
  cases: poolDeletionCases,
  describe: (testCase) => testCase.name,
  run: async ({ api, newResource, track }) => {
    const poolId = await api.givenResource(poolBase)
    await newResource({ ...memberBase, pool_id: poolId })
    track(poolId)

    const response = await api.deleteResource(poolId)
    const status = expectStatus(response, 409)
    if (status) return status
    return response.json()?.error === 'pool_has_members'
      ? null
      : `expected error "pool_has_members", got "${response.json()?.error}"`
  },
}
