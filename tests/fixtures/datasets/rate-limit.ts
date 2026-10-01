/**
 * Who sends a request: one of two keys on the same tenant, a credential the engine could
 * never have issued, or no credential at all. Two keys on one tenant, rather than one key on
 * each of two tenants, are what show the limit is counted per key and not per tenant.
 */
export type Caller = 'first' | 'second' | 'malformed' | 'anonymous'

export interface RateLimitScenario {
  name: string
  limit: number
  requests: Caller[]
  /** The status each request in `requests` answers, in the same order. */
  expected: number[]
}

export const rateLimitScenarios: RateLimitScenario[] = [
  {
    name: 'requests up to the limit are served',
    limit: 3,
    requests: ['first', 'first', 'first'],
    expected: [200, 200, 200],
  },
  {
    name: 'every request past the limit is refused',
    limit: 2,
    requests: ['first', 'first', 'first', 'first'],
    expected: [200, 200, 429, 429],
  },
  {
    name: 'a second key is served while the first is exhausted',
    limit: 2,
    requests: ['first', 'first', 'first', 'second', 'second'],
    expected: [200, 200, 429, 200, 200],
  },
  {
    name: 'a second key is counted on its own',
    limit: 1,
    requests: ['first', 'second', 'first', 'second'],
    expected: [200, 200, 429, 429],
  },
  // Authentication is an application-level `onRequest` hook and the limiter a route-level one,
  // so Fastify runs authentication first: a rejected credential is answered before it is ever
  // counted. These rows pin that order; `docs/backlog.md` records why it is a gap.
  {
    name: 'a malformed key is rejected without being counted',
    limit: 1,
    requests: ['malformed', 'malformed', 'malformed'],
    expected: [401, 401, 401],
  },
  {
    name: 'a request with no key is rejected without being counted',
    limit: 1,
    requests: ['anonymous', 'anonymous', 'anonymous'],
    expected: [401, 401, 401],
  },
]
