import Fastify, { type FastifyInstance } from 'fastify'
import fastifyRateLimit from '@fastify/rate-limit'
import fastifySwagger from '@fastify/swagger'
import fastifySwaggerUi from '@fastify/swagger-ui'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import { md } from './shared/docs.js'
import { swaggerThemeCss } from './shared/swagger-theme.js'
import type { Kysely } from 'kysely'
import type { Config } from './config.js'
import type { Database } from './db/schema.js'
import { availabilityRoutes } from './modules/availability/availability.routes.js'
import { bookingRoutes } from './modules/bookings/booking.routes.js'
import { exceptionRoutes } from './modules/exceptions/exception.routes.js'
import { healthRoutes } from './modules/health/health.routes.js'
import { resourceRoutes } from './modules/resources/resource.routes.js'
import { scheduleRoutes } from './modules/schedule/schedule.routes.js'
import { TenantRepository } from './modules/tenants/tenant.repository.js'
import { TenantService } from './modules/tenants/tenant.service.js'
import { registerAuth } from './shared/auth.js'
import { registerErrorHandler } from './shared/errors.js'

export interface AppDeps {
  config: Config
  db: Kysely<Database>
}

declare module 'fastify' {
  interface FastifyInstance {
    db: Kysely<Database>
    config: Config
  }
}

function openapiDocument(config: Config) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Booking Engine',
      version: '0.1.0',
      description: md(
        'A domain-agnostic booking engine, working on three abstractions — resource, schedule, booking — with no knowledge of what is being booked.',
        '**Conventions that apply everywhere**',
        [
          `Date ranges are half-open: \`from\` inclusive, \`to\` exclusive, at most ${config.maxRangeDays} days.`,
          'Durations use a restricted ISO-8601 grammar. `P1D` and `PT24H` are **not** interchangeable: `P1D` runs anchor to anchor and spans 23, 24 or 25 real hours across a daylight-saving transition, and the written form is what makes a resource day-based.',
          'Timezones must be named IANA zones. A fixed offset such as `+02:00` is rejected, because an offset carries no daylight-saving rules.',
          'Weekdays are Monday = 0, Sunday = 6 — matching neither Postgres nor JavaScript.',
          'Timestamps carry an offset: `2026-07-20T09:00:00+02:00`.',
          'Errors always have the shape `{ error, message, details? }`.',
        ],
        "Every request carries an API key in an `Authorization: Bearer` header. A key belongs to one tenant and sees only that tenant's rows; another tenant's id answers `404`, never `403`.",
        "A key holds a set of scopes, and each route requires exactly one of them. No scope implies another: `bookings.write` does not confer `bookings.read`, which is what lets a partner channel create bookings without being able to list the tenant's calendar. Keys are issued from the console.",
      ),
    },
    servers: [{ url: `http://localhost:${config.port}`, description: 'Local' }],
    tags: [
      { name: 'Resources', description: 'Bookable units and their scheduling parameters' },
      { name: 'Schedule', description: 'Regular weekly availability' },
      { name: 'Exceptions', description: 'Per-date overrides: a day off or altered hours' },
      { name: 'Availability', description: 'Computed slots, read-only' },
      {
        name: 'Bookings',
        description: 'Creating bookings and moving them through their lifecycle',
      },
      { name: 'Health', description: 'Liveness' },
    ],
  }
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: deps.config.logLevel,
      // Without this the first authenticated request writes a live credential to the log,
      // where it outlives the key it belongs to.
      redact: ['req.headers.authorization'],
    },
    // Fastify defaults AJV to removeAdditional: true, which silently strips unknown
    // properties. This engine needs them rejected instead: `additionalProperties: false`
    // on the PATCH body is what makes `timezone` and `concurrency_mode` immutable, and a
    // silently dropped field would look to the caller like a successful change.
    ajv: { customOptions: { removeAdditional: false } },
  }).withTypeProvider<TypeBoxTypeProvider>()

  app.decorate('db', deps.db)
  app.decorate('config', deps.config)

  registerErrorHandler(app)

  // Per key, so one tenant cannot exhaust the engine for the others. The authentication hook
  // has not run when the generator is called, so the raw header stands in for the key id — it
  // identifies the caller just as well and needs no database round trip.
  await app.register(fastifyRateLimit, {
    max: deps.config.rateLimitPerMinute,
    timeWindow: '1 minute',
    keyGenerator: (request) => request.headers.authorization ?? request.ip,
    errorResponseBuilder: () => ({
      error: 'rate_limited',
      message: 'Too many requests; slow down and retry',
    }),
  })

  registerAuth(app, new TenantService(new TenantRepository(deps.db)))

  // Generated from the same TypeBox schemas the routes validate against, so the
  // documentation cannot drift from the behaviour. Registered before the route
  // plugins, because the generator collects routes as they are added.
  void app.register(fastifySwagger, { openapi: openapiDocument(deps.config) })
  void app.register(fastifySwaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true, tryItOutEnabled: true },
    // Without this the inline code spans in the descriptions overlap the lines above.
    theme: { css: [{ filename: 'theme.css', content: swaggerThemeCss }] },
  })

  // Every route is registered through this one place, so a future authentication
  // preHandler attaches here without touching any handler. All of them are plugins,
  // including health: a route added directly to the root instance would load before
  // the OpenAPI generator and be missing from the documentation.
  void app.register(healthRoutes)
  void app.register(resourceRoutes)
  void app.register(scheduleRoutes)
  void app.register(exceptionRoutes)
  void app.register(availabilityRoutes)
  void app.register(bookingRoutes)

  return app
}
