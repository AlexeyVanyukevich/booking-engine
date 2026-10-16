import type { AppConfig } from '../../../src/config.js'

/**
 * Who sends a request. `first` and `second` are two keys on one tenant, which is what shows the
 * per-key limit is counted per key and not per tenant. `narrow` is a valid key without
 * `resources.read`. `malformed` could never have been issued; `unknown` is well formed and was
 * not. `forged` sends `ADDRESS_B` as its whole header, which an unprefixed store key would
 * share with a keyless request from `ADDRESS_B`.
 */
export type Caller =
  'first' | 'second' | 'narrow' | 'malformed' | 'unknown' | 'anonymous' | 'forged'

/**
 * Socket peers and forwarded clients, from the ranges RFC 5737 reserves for documentation, so
 * no row can be mistaken for a real host.
 */
export const ADDRESS_A = '203.0.113.1'
export const ADDRESS_B = '203.0.113.2'
export const CLIENT_X = '198.51.100.1'
export const CLIENT_Y = '198.51.100.2'
/** Two clients in one /64 of the IPv6 documentation range, RFC 3849, and one in the next. */
export const CLIENT_V6 = '2001:db8::1'
export const CLIENT_V6_SAME_64 = '2001:db8::2'
export const CLIENT_V6_NEXT_64 = '2001:db8:0:1::1'

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
  {
    name: 'a malformed key is refused once its address has failed too often',
    config: { authFailuresPerMinute: 2 },
    requests: ['malformed', 'malformed', 'malformed'],
    expected: [401, 401, 429],
  },
  {
    name: 'a well-formed key never issued is refused the same way',
    config: { authFailuresPerMinute: 2 },
    requests: ['unknown', 'unknown', 'unknown'],
    expected: [401, 401, 429],
  },
  {
    name: 'a request with no key is refused the same way',
    config: { authFailuresPerMinute: 2 },
    requests: ['anonymous', 'anonymous', 'anonymous'],
    expected: [401, 401, 429],
  },
  {
    name: 'an unmatched path without a key counts as a failure',
    config: { authFailuresPerMinute: 2 },
    requests: [
      { caller: 'anonymous', path: '/nope' },
      { caller: 'anonymous', path: '/nope' },
      { caller: 'anonymous', path: '/nope' },
    ],
    expected: [401, 401, 429],
  },
  {
    name: 'a refused address is refused a valid key too',
    config: { authFailuresPerMinute: 2 },
    requests: ['malformed', 'malformed', 'first'],
    expected: [401, 401, 429],
  },
  {
    name: 'the same valid key from another address is served',
    config: { authFailuresPerMinute: 2 },
    requests: ['malformed', 'malformed', { caller: 'first', from: ADDRESS_B }],
    expected: [401, 401, 200],
  },
  {
    name: "one address's failures leave another's count untouched",
    config: { authFailuresPerMinute: 2 },
    requests: ['malformed', 'malformed', { caller: 'malformed', from: ADDRESS_B }],
    expected: [401, 401, 401],
  },
  {
    name: "a valid key's requests add nothing to the failure count",
    config: { authFailuresPerMinute: 2 },
    requests: ['first', 'first', 'first', 'malformed', 'malformed', 'malformed'],
    expected: [200, 200, 200, 401, 401, 429],
  },
  {
    name: 'a valid key without the scope is not a failure',
    config: { authFailuresPerMinute: 1 },
    requests: ['narrow', 'narrow', 'malformed'],
    expected: [403, 403, 401],
  },
  {
    name: 'a refused address still reaches a public route',
    config: { authFailuresPerMinute: 1 },
    requests: ['malformed', { caller: 'anonymous', path: '/health' }, 'first'],
    expected: [401, 200, 429],
  },
  {
    name: "a header spelling an address does not spend that address's count",
    config: { rateLimitPerMinute: 1 },
    requests: [
      { caller: 'forged', path: '/health' },
      { caller: 'anonymous', path: '/health', from: ADDRESS_B },
    ],
    expected: [200, 200],
  },
  {
    name: 'behind a trusted proxy, failures are counted per client',
    config: { authFailuresPerMinute: 1, trustProxy: [ADDRESS_A] },
    requests: [
      { caller: 'malformed', forwardedFor: CLIENT_X },
      { caller: 'first', forwardedFor: CLIENT_Y },
      { caller: 'first', forwardedFor: CLIENT_X },
    ],
    expected: [401, 200, 429],
  },
  {
    name: 'an IPv6 client behind a trusted proxy is counted by its /64',
    config: { authFailuresPerMinute: 1, trustProxy: [ADDRESS_A] },
    requests: [
      { caller: 'malformed', forwardedFor: CLIENT_V6 },
      { caller: 'first', forwardedFor: CLIENT_V6_SAME_64 },
      { caller: 'first', forwardedFor: CLIENT_V6_NEXT_64 },
    ],
    expected: [401, 429, 200],
  },
  {
    name: 'a valid key is counted on an unmatched path',
    config: { rateLimitPerMinute: 1 },
    requests: [
      { caller: 'first', path: '/nope' },
      { caller: 'first', path: '/nope' },
    ],
    expected: [404, 429],
  },
  {
    name: 'an unmatched path spends the same budget as a route',
    config: { rateLimitPerMinute: 2 },
    requests: [{ caller: 'first', path: '/nope' }, 'first', 'first'],
    expected: [404, 200, 429],
  },
]

export interface FailureWindowCase {
  name: string
  /** Seconds after the failure that used the address's budget up. */
  waitSeconds: number
  /** What a valid key from that address answers then. */
  expected: number
}

/** The budget is one failure; the window is the plugin's minute. */
export const failureWindowCases: FailureWindowCase[] = [
  { name: 'a second before the minute ends it is still refused', waitSeconds: 59, expected: 429 },
  { name: 'once the minute ends it is served again', waitSeconds: 60, expected: 200 },
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
  /** Laid over `buildTestApp`'s defaults. */
  config?: Partial<AppConfig>
  /** Sent from the same address first, their answers ignored. */
  before?: Caller[]
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
  // The per-key headers describe a key's budget; this refusal is of an address.
  {
    name: 'a refusal of an address that failed authentication',
    caller: 'first',
    before: ['malformed'],
    config: { authFailuresPerMinute: 1 },
    method: 'GET',
    url: '/resources',
    status: 429,
    counted: false,
  },
  {
    name: 'an unmatched path with a valid key',
    caller: 'first',
    method: 'GET',
    url: '/nope',
    status: 404,
    counted: true,
  },
]
