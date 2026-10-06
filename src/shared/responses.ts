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
 * Headers a code carries that its class does not set: the rate-limit plugin writes these on the
 * reply before it throws, and Fastify's error path keeps them.
 */
const PLUGIN_HEADERS: Record<string, readonly string[]> = {
  rate_limited: ['retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset'],
}

const HEADER_DOCS: Record<string, { type: 'integer' | 'string'; description: string }> = {
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

function headerSchema(name: string) {
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
 * description naming each, one example per code keyed by it, and the headers they carry.
 */
export function errorResponse(entries: readonly ErrorEntry[]): TSchema {
  const headers = [...new Set(entries.flatMap((entry) => entry.headers))]
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
      ...(headers.length > 0
        ? { headers: Object.fromEntries(headers.map((name) => [name, headerSchema(name)])) }
        : {}),
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
 * A route's response map with every shared rule that applies merged in. Where the route already
 * declares that status its codes come first and the shared one last; merging twice changes
 * nothing, which matters because Fastify hands the `HEAD` twin of a `GET` the same schema.
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
