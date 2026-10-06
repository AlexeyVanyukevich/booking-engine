import type { RouteShape } from '../../../src/shared/responses.js'

export interface RuleCase {
  name: string
  route: RouteShape
  /** The shared statuses the rules must add, sorted. */
  statuses: number[]
}

export const ruleCases: RuleCase[] = [
  {
    name: 'a public GET with no schema parts',
    route: { methods: ['GET'], isPublic: true, validates: false },
    statuses: [429, 500],
  },
  {
    name: 'a public GET with a query',
    route: { methods: ['GET'], isPublic: true, validates: true },
    statuses: [400, 429, 500],
  },
  {
    name: 'a scoped GET with params',
    route: { methods: ['GET'], isPublic: false, validates: true },
    statuses: [400, 401, 403, 429, 500],
  },
  {
    name: 'a scoped HEAD with params',
    route: { methods: ['HEAD'], isPublic: false, validates: true },
    statuses: [400, 401, 403, 429, 500],
  },
  {
    name: 'a scoped GET with no schema parts',
    route: { methods: ['GET'], isPublic: false, validates: false },
    statuses: [401, 403, 429, 500],
  },
  {
    name: 'a scoped POST with no schema parts',
    route: { methods: ['POST'], isPublic: false, validates: false },
    statuses: [400, 401, 403, 413, 415, 429, 500],
  },
  {
    name: 'a scoped POST with params and a body',
    route: { methods: ['POST'], isPublic: false, validates: true },
    statuses: [400, 401, 403, 413, 415, 429, 500],
  },
  {
    name: 'a scoped PUT',
    route: { methods: ['PUT'], isPublic: false, validates: true },
    statuses: [400, 401, 403, 413, 415, 429, 500],
  },
  {
    name: 'a scoped PATCH',
    route: { methods: ['PATCH'], isPublic: false, validates: true },
    statuses: [400, 401, 403, 413, 415, 429, 500],
  },
  {
    name: 'a scoped DELETE, whose body Fastify parses',
    route: { methods: ['DELETE'], isPublic: false, validates: true },
    statuses: [400, 401, 403, 413, 415, 429, 500],
  },
]

export interface GroupingCase {
  name: string
  /** Export names from `src/shared/errors.ts`, resolved by the test. */
  classes: string[]
  /** status → codes in the `enum`, in order. */
  expected: Record<number, string[]>
  /** status → header names the response declares. */
  headers: Record<number, string[]>
}

export const groupingCases: GroupingCase[] = [
  {
    name: 'one class, one status',
    classes: ['NotFoundError'],
    expected: { 404: ['not_found'] },
    headers: {},
  },
  {
    name: 'two classes sharing a status become one response',
    classes: ['NotFoundError', 'SlotUnavailableError', 'IdempotencyKeyReusedError'],
    expected: { 404: ['not_found'], 409: ['slot_unavailable', 'idempotency_key_reused'] },
    headers: {},
  },
  {
    name: "a class's own headers are declared",
    classes: ['ConcurrentUpdateError'],
    expected: { 503: ['concurrent_update'] },
    headers: { 503: ['retry-after'] },
  },
]

export interface MergeCase {
  name: string
  route: RouteShape
  /** Export names declared by the route itself. */
  declared: string[]
  expected: Record<number, string[]>
  headers: Record<number, string[]>
}

export const mergeCases: MergeCase[] = [
  {
    name: "a route's own 400 codes come first, the shared one last",
    route: { methods: ['GET'], isPublic: false, validates: true },
    declared: ['InvalidRangeError', 'NotFoundError'],
    expected: {
      400: ['invalid_range', 'validation_error'],
      401: ['unauthorized'],
      403: ['forbidden_scope'],
      404: ['not_found'],
      429: ['rate_limited'],
      500: ['internal_error'],
    },
    headers: {
      401: ['www-authenticate'],
      429: ['retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset'],
    },
  },
  {
    name: 'a public route gets no 401 or 403',
    route: { methods: ['GET'], isPublic: true, validates: false },
    declared: [],
    expected: { 429: ['rate_limited'], 500: ['internal_error'] },
    headers: {
      429: ['retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset'],
    },
  },
]
