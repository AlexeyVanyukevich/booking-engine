import type { FastifyInstance, InjectOptions } from 'fastify'
import type { Kysely } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.js'
import { loadAppConfig } from '../../src/config.js'
import type { Database } from '../../src/db/schema.js'
import { TenantRepository } from '../../src/modules/tenants/tenant.repository.js'
import { TenantService } from '../../src/modules/tenants/tenant.service.js'
import { SHARED_RULES } from '../../src/shared/responses.js'
import { SCOPES, type Scope } from '../../src/shared/scopes.js'
import {
  INVALID_PARAMETER,
  sharedTriggers,
  triggerSkips,
  validParameter,
  type AppUnderTest,
  type RouteUnderTest,
  type SharedTrigger,
} from '../fixtures/datasets/shared-responses.js'
import { buildTestApp, closeTestDb, getTestDb, resetDb, seedTenant } from './helpers.js'

interface Operation {
  parameters?: Array<{
    in: string
    name: string
    example?: string
    schema?: { format?: string }
  }>
  requestBody?: unknown
  responses: Record<
    string,
    {
      headers?: Record<string, unknown>
      content?: {
        'application/json'?: { schema?: { properties?: { error?: { enum?: string[] } } } }
      }
    }
  >
}

type PathParameter = NonNullable<Operation['parameters']>[number]

/**
 * The routes and their scopes come from the live app, not from a list here: what the engine
 * serves is what is tested. No handler runs while routes register, so no database is needed.
 */
async function inventory(): Promise<{
  routes: RouteUnderTest[]
  bodyLimit: number
  paths: Record<string, Record<string, Operation>>
}> {
  const app = await buildApp({
    config: { ...loadAppConfig({}), logLevel: 'silent' },
    db: {} as Kysely<Database>,
  })
  try {
    await app.ready()
    // Read as plain JSON: the generator's own types model every OpenAPI variant, not this one.
    const generated: unknown = app.swagger()
    const document = generated as { paths: Record<string, Record<string, Operation>> }
    const routes = app.routeAuthorizations
      .filter((route) => route.method !== 'HEAD')
      .map((route) => ({
        ...route,
        path: route.url.replace(/:(\w+)/g, '{$1}'),
        method: route.method.toLowerCase(),
      }))
      .filter((route) => document.paths[route.path]?.[route.method] !== undefined)
      .map((route): RouteUnderTest => {
        const operation = document.paths[route.path]![route.method]!
        const pathParameters = (operation.parameters ?? []).filter(
          (parameter) => parameter.in === 'path',
        )
        const fill = (value: (parameter: PathParameter) => string) =>
          pathParameters.reduce(
            (url, parameter) => url.replace(`{${parameter.name}}`, value(parameter)),
            route.path,
          )
        return {
          method: route.method,
          path: route.path,
          // The parameter's own documented example where it has one, else a value for its format.
          url: fill((parameter) => {
            if (parameter.example !== undefined) return parameter.example
            const format = parameter.schema?.format ?? ''
            const make = validParameter[format]
            if (!make)
              throw new Error(`No valid value for path format "${format}" in shared-responses.ts`)
            return make()
          }),
          invalidUrl: fill(() => INVALID_PARAMETER),
          hasPathParams: pathParameters.length > 0,
          hasBody: operation.requestBody !== undefined,
          hasQuery: (operation.parameters ?? []).some(
            (parameter) => parameter.in === 'querystring' || parameter.in === 'query',
          ),
          scope: route.scope,
        }
      })
    return { routes, bodyLimit: app.initialConfig.bodyLimit ?? 1_048_576, paths: document.paths }
  } finally {
    await app.close()
  }
}

const { routes, bodyLimit, paths } = await inventory()

const cases = routes.flatMap((route) =>
  sharedTriggers.map((trigger) => ({
    route,
    trigger,
    skip: triggerSkips.find(
      (skip) =>
        skip.status === trigger.status && skip.method === route.method && skip.path === route.path,
    ),
    applies: SHARED_RULES.find((rule) => rule.status === trigger.status)!.appliesTo({
      methods: [route.method.toUpperCase()],
      isPublic: route.scope === undefined,
      validates: route.hasPathParams || route.hasBody || route.hasQuery,
    }),
    name: `${route.method.toUpperCase()} ${route.path} — ${trigger.status} ${trigger.code}`,
  })),
)

let apps: Record<Exclude<AppUnderTest, 'a limit of one'>, FastifyInstance>
let holding: string
const lacking = new Map<Scope, string>()

beforeAll(async () => {
  await resetDb()
  const { tenantId, authHeader } = await seedTenant()
  holding = authHeader.authorization!
  const service = new TenantService(new TenantRepository(getTestDb()))
  for (const scope of SCOPES) {
    const { secret } = await service.issueKey(
      tenantId,
      `lacking ${scope}`,
      SCOPES.filter((other) => other !== scope),
    )
    lacking.set(scope, `Bearer ${secret}`)
  }
  apps = {
    default: await buildTestApp(),
    'a database that fails every query': await buildTestApp({}, {} as Kysely<Database>),
  }
})

afterAll(async () => {
  await apps.default.close()
  await apps['a database that fails every query'].close()
  await closeTestDb()
})

function credentialFor(trigger: SharedTrigger, route: RouteUnderTest): Record<string, string> {
  if (trigger.credential === 'none') return {}
  if (trigger.credential === 'holding the scope') return { authorization: holding }
  // A public route has no scope to lack; any key will do, and the route ignores it.
  return { authorization: route.scope === undefined ? holding : lacking.get(route.scope as Scope)! }
}

async function send(trigger: SharedTrigger, route: RouteUnderTest) {
  const request = trigger.request(route, bodyLimit)
  const options: InjectOptions = {
    ...request,
    method: route.method.toUpperCase() as NonNullable<InjectOptions['method']>,
    headers: { ...request.headers, ...credentialFor(trigger, route) },
  }
  if (trigger.app !== 'a limit of one') return apps[trigger.app].inject(options)

  // The limiter counts in memory, so each route gets an app of its own.
  const limited = await buildTestApp({ rateLimitPerMinute: 1 })
  try {
    if (trigger.sendTwice) await limited.inject(options)
    return await limited.inject(options)
  } finally {
    await limited.close()
  }
}

describe('statuses every route shares', () => {
  it.each(cases.filter((c) => c.applies && !c.skip))(
    '$name: answered and declared',
    async ({ route, trigger }) => {
      const response = await send(trigger, route)
      expect(response.statusCode).toBe(trigger.status)
      expect(response.json<{ error: string }>().error).toBe(trigger.code)

      const declared = paths[route.path]![route.method]!.responses[String(trigger.status)]
      expect(declared?.content?.['application/json']?.schema?.properties?.error?.enum).toContain(
        trigger.code,
      )
      for (const header of Object.keys(declared?.headers ?? {})) {
        expect(response.headers[header], header).toBeDefined()
      }
    },
  )

  it.each(cases.filter((c) => !c.applies))(
    '$name: neither answered nor declared',
    async ({ route, trigger }) => {
      const declared = paths[route.path]![route.method]!.responses[String(trigger.status)]
      expect(
        declared?.content?.['application/json']?.schema?.properties?.error?.enum ?? [],
      ).not.toContain(trigger.code)
      const response = await send(trigger, route)
      expect(response.statusCode).not.toBe(trigger.status)
    },
  )

  it.each(cases.filter((c) => c.skip))(
    '$name: declared, not triggered — $skip.reason',
    ({ route, trigger }) => {
      const declared = paths[route.path]![route.method]!.responses[String(trigger.status)]
      expect(declared).toBeDefined()
    },
  )
})
