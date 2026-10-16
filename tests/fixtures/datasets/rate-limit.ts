import type { AppConfig } from '../../../src/config.js'

/**
 * Who sends a request: one of two keys on the same tenant, a credential the engine could
 * never have issued, or no credential at all. Two keys on one tenant, rather than one key on
 * each of two tenants, are what show the limit is counted per key and not per tenant.
 */
export type Caller = 'first' | 'second' | 'malformed' | 'anonymous'

/**
 * Socket peers and forwarded clients, from the ranges RFC 5737 reserves for documentation, so
 * no row can be mistaken for a real host.
 */
export const ADDRESS_A = '203.0.113.1'
export const ADDRESS_B = '203.0.113.2'
export const CLIENT_X = '198.51.100.1'
export const CLIENT_Y = '198.51.100.2'

export interface LimitedRequest {
  caller: Caller
  /** The socket peer. Default `ADDRESS_A`. */
  from?: string
  /** Default `/resources`. */
  path?: string
  /** Sent as `X-Forwarded-For`. */
  forwardedFor?: string
}

export interface RateLimitScenario {
  name: string
  /** Laid over `buildTestApp`'s defaults, which are high enough never to throttle. */
  config: Partial<AppConfig>
  /** A bare caller is a request from `ADDRESS_A` to `/resources`. */
  requests: Array<Caller | LimitedRequest>
  /** The status each request in `requests` answers, in the same order. */
  expected: number[]
}

export const rateLimitScenarios: RateLimitScenario[] = [
  {
    name: 'requests up to the limit are served',
    config: { rateLimitPerMinute: 3 },
    requests: ['first', 'first', 'first'],
    expected: [200, 200, 200],
  },
  {
    name: 'every request past the limit is refused',
    config: { rateLimitPerMinute: 2 },
    requests: ['first', 'first', 'first', 'first'],
    expected: [200, 200, 429, 429],
  },
  {
    name: 'a second key is served while the first is exhausted',
    config: { rateLimitPerMinute: 2 },
    requests: ['first', 'first', 'first', 'second', 'second'],
    expected: [200, 200, 429, 200, 200],
  },
  {
    name: 'a second key is counted on its own',
    config: { rateLimitPerMinute: 1 },
    requests: ['first', 'second', 'first', 'second'],
    expected: [200, 200, 429, 429],
  },
  // Authentication is an application-level `onRequest` hook and the limiter a route-level one,
  // so Fastify runs authentication first: a rejected credential is answered before it is ever
  // counted. These rows pin that order; `docs/backlog.md` records why it is a gap.
  {
    name: 'a malformed key is rejected without being counted',
    config: { rateLimitPerMinute: 1 },
    requests: ['malformed', 'malformed', 'malformed'],
    expected: [401, 401, 401],
  },
  {
    name: 'a request with no key is rejected without being counted',
    config: { rateLimitPerMinute: 1 },
    requests: ['anonymous', 'anonymous', 'anonymous'],
    expected: [401, 401, 401],
  },
  {
    name: 'a public route called without a key is counted by address',
    config: { rateLimitPerMinute: 1 },
    requests: [
      { caller: 'anonymous', path: '/health' },
      { caller: 'anonymous', path: '/health', from: ADDRESS_B },
      { caller: 'anonymous', path: '/health' },
    ],
    expected: [200, 200, 429],
  },
  {
    name: 'X-Forwarded-For from an untrusted peer is ignored',
    config: { rateLimitPerMinute: 1 },
    requests: [
      { caller: 'anonymous', path: '/health', forwardedFor: CLIENT_X },
      { caller: 'anonymous', path: '/health', forwardedFor: CLIENT_Y },
    ],
    expected: [200, 429],
  },
  {
    name: "a trusted proxy's X-Forwarded-For names the client",
    config: { rateLimitPerMinute: 1, trustProxy: [ADDRESS_A] },
    requests: [
      { caller: 'anonymous', path: '/health', forwardedFor: CLIENT_X },
      { caller: 'anonymous', path: '/health', forwardedFor: CLIENT_Y },
      { caller: 'anonymous', path: '/health', forwardedFor: CLIENT_X },
    ],
    expected: [200, 200, 429],
  },
  // The client writes the left of the header and the proxy appends the right; only the rightmost
  // entry a trusted hop added can be believed.
  {
    name: 'a client behind a trusted proxy cannot choose its address',
    config: { rateLimitPerMinute: 1, trustProxy: [ADDRESS_A] },
    requests: [
      { caller: 'anonymous', path: '/health', forwardedFor: CLIENT_X },
      { caller: 'anonymous', path: '/health', forwardedFor: `${CLIENT_Y}, ${CLIENT_X}` },
    ],
    expected: [200, 429],
  },
]

/** The three headers `@fastify/rate-limit` writes on a request it counts. */
export const LIMITER_HEADER_NAMES = [
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
]

/** The three as a status declares them when every code under it is counted: all required. */
export const COUNTED: Record<string, boolean> = Object.fromEntries(
  LIMITER_HEADER_NAMES.map((name) => [name, true]),
)

/** The three on a status whose replies carry them only sometimes: declared, none required. */
export const SOMETIMES_COUNTED: Record<string, boolean> = Object.fromEntries(
  LIMITER_HEADER_NAMES.map((name) => [name, false]),
)

export interface CountedReplyCase {
  name: string
  caller: Caller
  method: 'GET' | 'HEAD'
  url: string
  status: number
  /** Whether the reply carries all three limiter headers; when false, it carries none. */
  counted: boolean
}

export const countedReplyCases: CountedReplyCase[] = [
  {
    name: 'a success',
    caller: 'first',
    method: 'GET',
    url: '/resources',
    status: 200,
    counted: true,
  },
  {
    name: "a success's HEAD twin",
    caller: 'first',
    method: 'HEAD',
    url: '/resources',
    status: 200,
    counted: true,
  },
  {
    name: 'a public route called without a key',
    caller: 'anonymous',
    method: 'GET',
    url: '/health',
    status: 200,
    counted: true,
  },
  {
    name: "a route's own error",
    caller: 'first',
    method: 'GET',
    url: `/resources/${crypto.randomUUID()}`,
    status: 404,
    counted: true,
  },
  // Answered by authentication, which Fastify runs before the limiter's route-level hook.
  {
    name: 'a malformed key',
    caller: 'malformed',
    method: 'GET',
    url: '/resources',
    status: 401,
    counted: false,
  },
  {
    name: 'no key on a scoped route',
    caller: 'anonymous',
    method: 'GET',
    url: '/resources',
    status: 401,
    counted: false,
  },
]
