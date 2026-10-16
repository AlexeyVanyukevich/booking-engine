import type { FastifyInstance, FastifyRequest } from 'fastify'
import { ForbiddenScopeError, RateLimitedError, UnauthorizedError } from './errors.js'
import { failureKey } from './rate-limit.js'
import type { Scope } from './scopes.js'
import type { TenantService } from '../modules/tenants/tenant.service.js'

declare module 'fastify' {
  interface FastifyRequest {
    tenantId: string
    apiKeyId: string
    scopes: Scope[]
  }
  interface FastifyContextConfig {
    /** The one scope this route requires. Membership, not rank: nothing implies anything else. */
    scope?: Scope
    /** Reachable without a key at all. Only health, the root redirect and the docs tree. */
    public?: true
  }
  interface FastifyInstance {
    /**
     * What the `onRoute` guard below saw, kept rather than discarded: every route and the
     * scope it requires, or nothing for a public one. Who may call what is a security surface,
     * and one worth being able to enumerate rather than infer from a grep.
     */
    routeAuthorizations: RouteAuthorization[]
  }
}

export interface RouteAuthorization {
  method: string
  url: string
  /** Absent on a route declared `public: true`. */
  scope?: Scope | undefined
}

const BEARER = /^Bearer (.+)$/

/** Swagger UI registers its own routes and cannot carry our config. */
export function isDocsRoute(url: string): boolean {
  return url === '/docs' || url.startsWith('/docs/')
}

export function registerAuth(app: FastifyInstance, service: TenantService): void {
  // Declared without a value: a shared default array would be one object handed to every
  // request, and Fastify refuses a reference default for exactly that reason.
  app.decorateRequest('tenantId', '')
  app.decorateRequest('apiKeyId', '')
  app.decorateRequest('scopes')

  const authorizations: RouteAuthorization[] = []
  app.decorate('routeAuthorizations', authorizations)

  /**
   * Default deny, enforced at startup rather than at request time. The alternative — a list of
   * protected prefixes — fails open: a route added later is unprotected until somebody
   * remembers to list it. This fails closed, and it fails before the process serves anything.
   */
  app.addHook('onRoute', (route) => {
    // Swagger UI registers its own routes and cannot carry our config, so they are neither
    // guarded nor recorded.
    if (isDocsRoute(route.url)) return

    if (route.config?.public !== true && route.config?.scope === undefined) {
      throw new Error(
        `Route ${String(route.method)} ${route.url} declares neither a scope nor public: true. ` +
          'Every route must say who may call it.',
      )
    }

    // Fastify pairs a HEAD route with every GET, which arrives here as its own registration.
    for (const method of [route.method].flat()) {
      authorizations.push({ method, url: route.url, scope: route.config?.scope })
    }
  })

  /**
   * Failed authentications, counted per address. Authentication runs before the per-key limiter,
   * so without this a caller holding no credential could make the engine look a key up once per
   * request, without limit. Only failures count, so a consumer's valid traffic never spends this
   * budget; every kind of failure counts alike, as every kind answers alike. Given options,
   * `createRateLimit` keeps the count in a child of the limiter's store — its own map in memory,
   * its own namespace in Redis — so nothing the per-key limiter counts can reach it.
   */
  const failures = app.createRateLimit({
    max: app.config.authFailuresPerMinute,
    keyGenerator: failureKey,
  })

  async function failed(request: FastifyRequest): Promise<UnauthorizedError> {
    await failures(request)
    // One message for every failure, so a caller cannot tell "no such key" from "wrong secret"
    // and turn prefix enumeration into a probe.
    return new UnauthorizedError('A valid API key is required')
  }

  /**
   * `onRequest`, not `preHandler`. Fastify validates the body and the query string between the
   * two, so a `preHandler` hook answers 400 to a caller holding no key at all — the wrong
   * status, and a disclosure: the shape a route demands is readable without authenticating.
   * `onRequest` is the first hook in the lifecycle, and it needs no body.
   */
  app.addHook('onRequest', async (request, reply) => {
    const config = request.routeOptions.config as { scope?: Scope; public?: true } | undefined
    if (config?.public === true) return
    if (isDocsRoute(request.url)) return

    // Read before anything else, so a refused address costs no lookup. `remaining`, not the
    // plugin's `isExceeded`: a read never takes the count past `max`, so `isExceeded` would let
    // one more failure through to the database.
    const seen = await failures(request, { increment: false })
    if (!seen.isAllowed && seen.remaining === 0) {
      void reply.header('retry-after', String(seen.ttlInSeconds))
      throw new RateLimitedError('Too many failed authentications from this address')
    }

    const header = request.headers.authorization
    const match = header === undefined ? null : BEARER.exec(header)
    if (match === null) throw await failed(request)

    const resolved = await service.authenticate(match[1]!)
    if (resolved === undefined) throw await failed(request)

    /**
     * No route matched, so there is no scope to demand. The key was still required, which is
     * what stops an anonymous caller from mapping the surface by status code; from here the
     * not-found handler gives an authenticated caller the ordinary uniform 404.
     */
    if (request.routeOptions.url === undefined) return

    const required = config?.scope
    if (required === undefined) {
      // Unreachable while onRoute stands. Kept so that removing that guard fails closed.
      throw new ForbiddenScopeError('This route declares no scope')
    }
    if (!resolved.scopes.includes(required)) {
      // Naming the scope leaks nothing — the caller knows which route it called — and turns a
      // misconfigured key from a guessing game into a one-line fix.
      throw new ForbiddenScopeError(`This key does not hold ${required}`, { required })
    }

    request.tenantId = resolved.tenantId
    request.apiKeyId = resolved.keyId
    request.scopes = resolved.scopes
  })
}
