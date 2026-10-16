import type { RouteShape } from '../../../src/shared/responses.js'
import { COUNTED, SOMETIMES_COUNTED } from './rate-limit.js'

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

/** status → header name → whether it is declared `required`. A status with none is absent. */
export type DeclaredHeaders = Record<number, Record<string, boolean>>

export interface GroupingCase {
  name: string
  /** Export names from `src/shared/errors.ts`, resolved by the test. */
  classes: string[]
  /** status → codes in the `enum`, in order. */
  expected: Record<number, string[]>
  headers: DeclaredHeaders
}

export const groupingCases: GroupingCase[] = [
  {
    name: 'one class, one status',
    classes: ['NotFoundError'],
    expected: { 404: ['not_found'] },
    headers: { 404: COUNTED },
  },
  {
    name: 'two classes sharing a status become one response',
    classes: ['NotFoundError', 'SlotUnavailableError', 'IdempotencyKeyReusedError'],
    expected: { 404: ['not_found'], 409: ['slot_unavailable', 'idempotency_key_reused'] },
    headers: { 404: COUNTED, 409: COUNTED },
  },
  {
    name: "a class's own headers are declared beside the limiter's",
    classes: ['ConcurrentUpdateError'],
    expected: { 503: ['concurrent_update'] },
    headers: { 503: { 'retry-after': true, ...COUNTED } },
  },
  {
    name: 'a refusal carries retry-after, and the three only when the limiter wrote it',
    classes: ['RateLimitedError'],
    expected: { 429: ['rate_limited'] },
    headers: { 429: { 'retry-after': true, ...SOMETIMES_COUNTED } },
  },
  {
    name: 'a code answered before the limiter carries only its own headers',
    classes: ['UnauthorizedError'],
    expected: { 401: ['unauthorized'] },
    headers: { 401: { 'www-authenticate': true } },
  },
  {
    name: 'a code answered before the limiter, with none of its own, declares none',
    classes: ['ForbiddenScopeError'],
    expected: { 403: ['forbidden_scope'] },
    headers: {},
  },
  {
    name: 'a status mixing a counted code with an uncounted one declares the three, not required',
    classes: ['ForbiddenScopeError', 'ForbiddenOriginError'],
    expected: { 403: ['forbidden_scope', 'forbidden_origin'] },
    headers: { 403: SOMETIMES_COUNTED },
  },
]

export interface MergeCase {
  name: string
  route: RouteShape
  /** Success statuses the route declares, and whether each has a body. */
  successes: Record<number, 'body' | 'none'>
  /** Export names declared by the route itself. */
  declared: string[]
  /** status → codes in the `enum`, or `null` for a success. */
  expected: Record<number, string[] | null>
  headers: DeclaredHeaders
}

export const mergeCases: MergeCase[] = [
  {
    name: "a route's own 400 codes come first, the shared one last",
    route: { methods: ['GET'], isPublic: false, validates: true },
    successes: { 200: 'body' },
    declared: ['InvalidRangeError', 'NotFoundError'],
    expected: {
      200: null,
      400: ['invalid_range', 'validation_error'],
      401: ['unauthorized'],
      403: ['forbidden_scope'],
      404: ['not_found'],
      429: ['rate_limited'],
      500: ['internal_error'],
    },
    headers: {
      200: COUNTED,
      400: COUNTED,
      401: { 'www-authenticate': true },
      404: COUNTED,
      429: { 'retry-after': true, ...SOMETIMES_COUNTED },
      500: SOMETIMES_COUNTED,
    },
  },
  {
    name: 'a public route gets no 401 or 403',
    route: { methods: ['GET'], isPublic: true, validates: false },
    successes: { 200: 'body' },
    declared: [],
    expected: { 200: null, 429: ['rate_limited'], 500: ['internal_error'] },
    headers: {
      200: COUNTED,
      429: { 'retry-after': true, ...SOMETIMES_COUNTED },
      500: SOMETIMES_COUNTED,
    },
  },
  {
    name: 'a 204 with no body declares the three like any success',
    route: { methods: ['DELETE'], isPublic: false, validates: true },
    successes: { 204: 'none' },
    declared: ['NotFoundError'],
    expected: {
      204: null,
      400: ['validation_error'],
      401: ['unauthorized'],
      403: ['forbidden_scope'],
      404: ['not_found'],
      413: ['payload_too_large'],
      415: ['unsupported_media_type'],
      429: ['rate_limited'],
      500: ['internal_error'],
    },
    headers: {
      204: COUNTED,
      400: COUNTED,
      401: { 'www-authenticate': true },
      404: COUNTED,
      413: COUNTED,
      415: COUNTED,
      429: { 'retry-after': true, ...SOMETIMES_COUNTED },
      500: SOMETIMES_COUNTED,
    },
  },
]
