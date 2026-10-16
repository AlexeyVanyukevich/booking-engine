import type { FastifyInstance } from 'fastify'
import { Type, type TSchema } from 'typebox'
import { isDocsRoute } from './auth.js'
import { md } from './docs.js'
import * as errors from './errors.js'
import type { AppError, ErrorExample } from './errors.js'

/**
 * Every error response in the OpenAPI document is built here, from the codes themselves: the
 * class states its status, meaning, example and headers once, and this turns them into the
 * schema the route serializes with and the document shows. Pure — nothing here reaches a
 * database — so the rules are tested without one.
 */

type ErrorClass = new (message: string) => AppError

export interface ErrorEntry {
  status: number
  code: string
  meaning: string
  example: ErrorExample
  /** Headers this code's replies always carry on their own, apart from the limiter's three. */
  headers: readonly string[]
}

const ERROR_FIELD = {
  description: 'Stable machine-readable code — branch on this, not on the message.',
}
const MESSAGE_FIELD = { description: 'Human-readable explanation. May change.' }
const DETAILS_FIELD = { description: 'Context, when there is any.' }

/** The shape every error shares, without the narrowing a declared response adds. */
export const ErrorBody = Type.Object({
  error: Type.String(ERROR_FIELD),
  message: Type.String(MESSAGE_FIELD),
  details: Type.Optional(Type.Unknown(DETAILS_FIELD)),
})

/**
 * Headers a code carries that its class does not set: the rate-limit plugin writes `retry-after`
 * on the reply before it throws, and Fastify's error path keeps it. The limiter's other three
 * are not here: they are on every reply it counted, not on one code — see `LIMITER_REACH`.
 */
const PLUGIN_HEADERS: Record<string, readonly string[]> = {
  rate_limited: ['retry-after'],
}

interface HeaderDoc {
  type: 'integer' | 'string'
  description: string
}

/** Every header the document describes. The recorder fails a reply carrying one undeclared. */
export const HEADER_DOCS: Record<string, HeaderDoc> = {
  'www-authenticate': {
    type: 'string',
    description: 'Always `Bearer`, the scheme the key is sent in',
  },
  'retry-after': {
    type: 'integer',
    description: 'Seconds to wait before sending the same request again',
  },
  'x-ratelimit-limit': { type: 'integer', description: 'Requests this key may send per minute' },
  'x-ratelimit-remaining': { type: 'integer', description: 'Requests left in the current minute' },
  'x-ratelimit-reset': {
    type: 'integer',
    description: "Seconds until the current minute's count resets",
  },
}

/** The three headers `@fastify/rate-limit` writes on every request it counts. */
const LIMITER_HEADERS = ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset']

/**
 * Where a code is answered relative to the limiter. Authentication is an application-level
 * `onRequest` hook and the limiter a route-level one, which Fastify runs after it, so what
 * authentication throws is answered before the request is counted. `internal_error` comes from
 * either side: a failing key lookup, or a failing handler. `rate_limited` too: the limiter's own
 * refusal is counted, and authentication's refusal of an address that keeps failing is not.
 * Every other code, and every success, is answered after.
 */
const LIMITER_REACH: Record<string, 'before' | 'either'> = {
  unauthorized: 'before',
  forbidden_scope: 'before',
  internal_error: 'either',
  rate_limited: 'either',
}

type Presence = 'always' | 'sometimes'

function limiterPresence(reach: 'after' | 'before' | 'either'): Array<[string, Presence]> {
  if (reach === 'before') return []
  const presence: Presence = reach === 'after' ? 'always' : 'sometimes'
  return LIMITER_HEADERS.map((name) => [name, presence])
}

/** The headers one code's replies carry, and whether always or only sometimes. */
function presenceOf(entry: ErrorEntry): ReadonlyMap<string, Presence> {
  return new Map([
    ...entry.headers.map((name): [string, Presence] => [name, 'always']),
    ...limiterPresence(LIMITER_REACH[entry.code] ?? 'after'),
  ])
}

const SUCCESS_PRESENCE: ReadonlyMap<string, Presence> = new Map(limiterPresence('after'))

/**
 * A status's headers: every header any of its codes carries, `required` only where every code
 * always carries it. A header some code carries only sometimes is declared without `required`,
 * which OpenAPI reads as "may be present".
 */
function declaredHeaders(
  presences: ReadonlyArray<ReadonlyMap<string, Presence>>,
): Record<string, HeaderDoc & { required?: true }> {
  const names = [...new Set(presences.flatMap((presence) => [...presence.keys()]))]
  return Object.fromEntries(
    names.map((name) => {
      const required = presences.every((presence) => presence.get(name) === 'always')
      return [name, { ...headerSchema(name), ...(required ? { required: true as const } : {}) }]
    }),
  )
}

const isSuccess = (status: string) => Number(status) >= 200 && Number(status) < 300

function entryOfClass(ErrorType: ErrorClass): ErrorEntry {
  const probe = new ErrorType('probe')
  return {
    status: probe.statusCode,
    code: probe.code,
    meaning: probe.meaning,
    example: probe.example,
    headers: [...Object.keys(probe.headers ?? {}), ...(PLUGIN_HEADERS[probe.code] ?? [])],
  }
}

function isErrorClass(value: unknown): value is ErrorClass {
  return typeof value === 'function' && value.prototype instanceof errors.AppError
}

let built: ReadonlyMap<string, ErrorEntry> | undefined

/** Every code the engine can emit, by code. Built on first use, once. */
export function catalogue(): ReadonlyMap<string, ErrorEntry> {
  if (built) return built
  const entries: ErrorEntry[] = Object.values(errors).flatMap((value: unknown) =>
    isErrorClass(value) ? [entryOfClass(value)] : [],
  )
  for (const [status, description] of Object.entries(errors.CLIENT_ERRORS)) {
    entries.push({ status: Number(status), headers: [], ...description })
  }
  entries.push({ status: 500, headers: [], ...errors.INTERNAL_ERROR })
  built = new Map(entries.map((entry) => [entry.code, entry]))
  return built
}

function lookup(code: string): ErrorEntry {
  const entry = catalogue().get(code)
  if (!entry) throw new Error(`No error code ${code} in src/shared/errors.ts`)
  return entry
}

function headerSchema(name: string): HeaderDoc {
  const doc = HEADER_DOCS[name]
  if (!doc) throw new Error(`Header ${name} has no entry in HEADER_DOCS`)
  return doc
}

function describeCodes(entries: readonly ErrorEntry[]): string {
  const lines = entries.map((entry) => `\`${entry.code}\` — ${entry.meaning}`)
  return entries.length === 1 ? lines[0]! : md('One of:', lines)
}

/**
 * One status's response: `error` narrowed to exactly these codes with `enum` — never a union of
 * literals, which the serializer validates and would turn an unlisted code into a 500 — a
 * description naming each, one example per code keyed by it, and the headers they carry, each
 * `required` only where every code always carries it.
 */
export function errorResponse(entries: readonly ErrorEntry[]): TSchema {
  const headers = declaredHeaders(entries.map(presenceOf))
  return Type.Object(
    {
      error: Type.String({ ...ERROR_FIELD, enum: entries.map((entry) => entry.code) }),
      message: Type.String(MESSAGE_FIELD),
      details: Type.Optional(Type.Unknown(DETAILS_FIELD)),
    },
    {
      description: describeCodes(entries),
      'x-examples': Object.fromEntries(
        entries.map((entry) => [entry.code, { value: { error: entry.code, ...entry.example } }]),
      ),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    },
  )
}

/** A route's own error responses, grouped by the status each class states. */
export function errorResponses(...classes: ErrorClass[]): Record<number, TSchema> {
  const byStatus = new Map<number, ErrorEntry[]>()
  for (const entry of classes.map(entryOfClass)) {
    byStatus.set(entry.status, [...(byStatus.get(entry.status) ?? []), entry])
  }
  return Object.fromEntries(
    [...byStatus].map(([status, entries]) => [status, errorResponse(entries)]),
  )
}

export interface RouteShape {
  methods: readonly string[]
  isPublic: boolean
  /** The route has a params, querystring or body schema. */
  validates: boolean
}

export interface SharedRule {
  status: number
  code: string
  appliesTo: (route: RouteShape) => boolean
}

/**
 * The methods Fastify 5.10 parses a body for, from its `bodywith` set, less `OPTIONS`, which no
 * route here serves. A body arriving on any of them can be too large or of a type no parser
 * accepts, whatever the route declares. The trigger dataset proves this list in both
 * directions, so it does not have to be taken on trust.
 */
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const takesBody = (route: RouteShape) => route.methods.some((method) => BODY_METHODS.has(method))

export const SHARED_RULES: readonly SharedRule[] = [
  // A malformed JSON body answers 400 through the framework translation even on a route that
  // validates nothing, so a body method is enough.
  {
    status: 400,
    code: 'validation_error',
    appliesTo: (route) => route.validates || takesBody(route),
  },
  { status: 401, code: 'unauthorized', appliesTo: (route) => !route.isPublic },
  { status: 403, code: 'forbidden_scope', appliesTo: (route) => !route.isPublic },
  { status: 413, code: 'payload_too_large', appliesTo: takesBody },
  { status: 415, code: 'unsupported_media_type', appliesTo: takesBody },
  // Public routes are limited too, keyed on the address.
  { status: 429, code: 'rate_limited', appliesTo: () => true },
  { status: 500, code: 'internal_error', appliesTo: () => true },
]

/** The codes a declared error response lists — readable only from one `errorResponse` built. */
export function declaredCodes(schema: unknown, where: string): string[] {
  const codes = (schema as { properties?: { error?: { enum?: unknown } } }).properties?.error?.enum
  if (!Array.isArray(codes)) {
    throw new Error(`${where} is declared without errorResponses(), so its codes cannot be merged`)
  }
  return codes as string[]
}

/**
 * A route's response map with every shared rule that applies merged in, and the limiter's headers
 * on every success. Where the route already declares that status its codes come first and the
 * shared one last; merging twice changes nothing, which matters because Fastify hands the `HEAD`
 * twin of a `GET` the same schema.
 */
export function withSharedResponses(
  response: Record<string, unknown> | undefined,
  route: RouteShape,
  where: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...response }
  for (const rule of SHARED_RULES) {
    if (!rule.appliesTo(route)) continue
    const existing = result[rule.status]
    const codes = existing === undefined ? [] : declaredCodes(existing, `${where} ${rule.status}`)
    result[rule.status] = errorResponse([...new Set([...codes, rule.code])].map(lookup))
  }
  // Every success has been counted by the limiter. A copy, never the route's own object: one
  // success schema is often shared by many routes. Headers the route declares itself are kept.
  for (const [status, schema] of Object.entries(result)) {
    if (isSuccess(status)) {
      const own = (schema as { headers?: Record<string, unknown> }).headers
      result[status] = {
        ...(schema as object),
        headers: { ...own, ...declaredHeaders([SUCCESS_PRESENCE]) },
      }
    }
  }
  return result
}

/**
 * Merges the shared rules into every documented route's real response schema, so a reply is
 * serialized against what the document shows. Registered before `@fastify/swagger`, whose own
 * `onRoute` hook reads the schema as it stands then.
 */
export function registerResponseRules(app: FastifyInstance): void {
  app.addHook('onRoute', (route) => {
    const schema = route.schema
    if (isDocsRoute(route.url) || schema === undefined || schema.hide === true) return
    const methods = [route.method].flat()
    schema.response = withSharedResponses(
      schema.response as Record<string, unknown> | undefined,
      {
        methods,
        isPublic: route.config?.public === true,
        validates: [schema.params, schema.querystring, schema.body].some(
          (part) => part !== undefined,
        ),
      },
      `${methods.join(',')} ${route.url}`,
    )
  })
}

interface DocumentHeaders {
  paths?: Record<
    string,
    Record<
      string,
      {
        responses?: Record<
          string,
          { headers?: Record<string, { schema?: { required?: unknown }; required?: boolean }> }
        >
      }
    >
  >
}

/**
 * `@fastify/swagger` 9.8.1 copies everything a header declares except its description into the
 * header's `schema`, so `required: true` would land inside the JSON Schema, where `required` must
 * be an array of property names. This moves it onto the header object, where the OpenAPI Header
 * Object defines it. Passed to the generator as `transformObject`, so the served document and
 * the committed one both go through it. Returns a copy.
 */
export function liftRequiredHeaders<T extends object>(document: T): T {
  const copy = structuredClone(document)
  for (const operations of Object.values((copy as DocumentHeaders).paths ?? {})) {
    for (const operation of Object.values(operations)) {
      for (const response of Object.values(operation.responses ?? {})) {
        for (const header of Object.values(response.headers ?? {})) {
          if (header.schema?.required !== true) continue
          delete header.schema.required
          header.required = true
        }
      }
    }
  }
  return copy
}
