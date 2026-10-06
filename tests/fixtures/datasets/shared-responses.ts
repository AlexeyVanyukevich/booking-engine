import type { InjectOptions } from 'fastify'

/** A documented operation, as the runner sends to it. */
export interface RouteUnderTest {
  method: string
  /** As the document writes it: `/resources/{id}`. */
  path: string
  /** Path parameters filled with values that pass validation. */
  url: string
  /** Path parameters filled with a value that passes no format. */
  invalidUrl: string
  hasPathParams: boolean
  hasBody: boolean
  hasQuery: boolean
  scope: string | undefined
}

/** Which credential the trigger sends. Authentication runs first, so most need a valid key. */
export type Credential = 'none' | 'holding the scope' | 'lacking the scope'

/** Which app the trigger runs on. */
export type AppUnderTest = 'default' | 'a limit of one' | 'a database that fails every query'

export interface SharedTrigger {
  status: number
  code: string
  app: AppUnderTest
  credential: Credential
  /** Sends the same request first: the limiter counts it, then refuses the next. */
  sendTwice?: true
  request: (route: RouteUnderTest, bodyLimit: number) => InjectOptions
}

const JSON_TYPE = { 'content-type': 'application/json' }

export const sharedTriggers: SharedTrigger[] = [
  {
    status: 400,
    code: 'validation_error',
    app: 'default',
    credential: 'holding the scope',
    // The first part the route validates: params, then body, then query.
    request: (route) =>
      route.hasPathParams
        ? { url: route.invalidUrl }
        : route.hasBody
          ? { url: route.url, headers: JSON_TYPE, payload: JSON.stringify({ __unexpected: true }) }
          : { url: `${route.url}?__unexpected=1` },
  },
  {
    status: 401,
    code: 'unauthorized',
    app: 'default',
    credential: 'none',
    request: (route) => ({ url: route.url }),
  },
  {
    status: 403,
    code: 'forbidden_scope',
    app: 'default',
    credential: 'lacking the scope',
    request: (route) => ({ url: route.url }),
  },
  {
    status: 413,
    code: 'payload_too_large',
    app: 'default',
    credential: 'holding the scope',
    request: (route, bodyLimit) => ({
      url: route.url,
      headers: JSON_TYPE,
      payload: JSON.stringify({ pad: 'x'.repeat(bodyLimit) }),
    }),
  },
  {
    status: 415,
    code: 'unsupported_media_type',
    app: 'default',
    credential: 'holding the scope',
    // Not text/plain: Fastify parses that by default, and the answer would be 400.
    request: (route) => ({
      url: route.url,
      headers: { 'content-type': 'application/xml' },
      payload: '<x/>',
    }),
  },
  {
    status: 429,
    code: 'rate_limited',
    app: 'a limit of one',
    credential: 'holding the scope',
    sendTwice: true,
    request: (route) => ({ url: route.url }),
  },
  {
    status: 500,
    code: 'internal_error',
    app: 'a database that fails every query',
    // Well-formed, so authentication reaches its lookup, which is the query that fails.
    credential: 'holding the scope',
    request: (route) => ({ url: route.url }),
  },
]

export interface TriggerSkip {
  status: number
  method: string
  path: string
  reason: string
}

export const triggerSkips: TriggerSkip[] = [
  {
    status: 500,
    method: 'get',
    path: '/health',
    reason:
      'runs no query, so nothing can make it fail; its 500 stays declared, since anything unexpected holds on every route',
  },
]

/**
 * A value per path-parameter format that passes validation, for a parameter the document gives no
 * example of. A new format fails until it has one.
 */
export const validParameter: Record<string, () => string> = {
  uuid: () => crypto.randomUUID(),
}

export const INVALID_PARAMETER = 'not-valid'
