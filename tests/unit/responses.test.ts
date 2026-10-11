import { describe, expect, it } from 'vitest'
import { Type, type TSchema } from 'typebox'
import * as errors from '../../src/shared/errors.js'
import {
  catalogue,
  declaredCodes,
  errorResponses,
  liftRequiredHeaders,
  SHARED_RULES,
  withSharedResponses,
} from '../../src/shared/responses.js'
import { liftCases } from '../fixtures/datasets/required-headers.js'
import {
  groupingCases,
  mergeCases,
  ruleCases,
  type MergeCase,
} from '../fixtures/datasets/response-rules.js'

type ErrorClass = new (message: string) => errors.AppError

function classNamed(name: string): ErrorClass {
  const exported = (errors as Record<string, unknown>)[name]
  if (typeof exported !== 'function') throw new Error(`errors.ts exports no ${name}`)
  return exported as ErrorClass
}

interface Built {
  description?: string
  headers?: Record<string, { required?: boolean }>
  'x-examples'?: Record<string, { value: { error: string } }>
  properties?: { error?: { enum?: string[] } }
}

const built = (schema: unknown) => schema as Built

/** A header a route might declare on its own success, which the limiter's three must not displace. */
const LOCATION = { type: 'string', description: 'Where the created record lives', required: true }

const codesOf = (schema: unknown) => built(schema).properties?.error?.enum ?? []

function shapeOf(response: Record<string, unknown>) {
  const codes: Record<number, string[] | null> = {}
  const headers: Record<number, Record<string, boolean>> = {}
  for (const [status, schema] of Object.entries(response)) {
    codes[Number(status)] = built(schema).properties?.error?.enum ?? null
    const declared = Object.entries(built(schema).headers ?? {})
    if (declared.length > 0) {
      headers[Number(status)] = Object.fromEntries(
        declared.map(([name, header]) => [name, header.required === true]),
      )
    }
  }
  return { codes, headers }
}

/** What a route declares before the merge: its successes, then its own error classes. */
function declaredBy({ successes, declared }: MergeCase): Record<string, unknown> {
  return {
    ...Object.fromEntries(
      Object.entries(successes).map(([status, body]) => [
        status,
        body === 'none' ? Type.Null() : Type.Object({ status: Type.String() }),
      ]),
    ),
    ...errorResponses(...declared.map(classNamed)),
  }
}

describe('the shared rules', () => {
  it.each(ruleCases)('$name', ({ route, statuses }) => {
    const applied = SHARED_RULES.filter((rule) => rule.appliesTo(route)).map((rule) => rule.status)
    expect(applied.sort((a, b) => a - b)).toEqual(statuses)
  })

  it.each(SHARED_RULES)('names a code the engine emits at $status', ({ status, code }) => {
    expect(catalogue().get(code)?.status).toBe(status)
  })
})

describe('errorResponses', () => {
  it.each(groupingCases)('$name', ({ classes, expected, headers }) => {
    const shape = shapeOf(errorResponses(...classes.map(classNamed)))
    expect(shape.codes).toEqual(expected)
    expect(shape.headers).toEqual(headers)
  })

  it.each(groupingCases)('keys one example per code, carrying that code: $name', ({ classes }) => {
    for (const schema of Object.values(errorResponses(...classes.map(classNamed)))) {
      const { 'x-examples': examples } = built(schema)
      expect(Object.keys(examples ?? {})).toEqual(codesOf(schema))
      for (const [code, example] of Object.entries(examples ?? {})) {
        expect(example.value.error).toBe(code)
      }
    }
  })

  it.each(groupingCases)('describes every code with its meaning: $name', ({ classes }) => {
    for (const schema of Object.values(errorResponses(...classes.map(classNamed)))) {
      for (const code of codesOf(schema)) {
        expect(built(schema).description).toContain(
          `\`${code}\` — ${catalogue().get(code)!.meaning}`,
        )
      }
    }
  })
})

describe('withSharedResponses', () => {
  it.each(mergeCases)('$name', (testCase) => {
    const merged = withSharedResponses(declaredBy(testCase), testCase.route, 'probe')
    expect(shapeOf(merged)).toEqual({ codes: testCase.expected, headers: testCase.headers })
  })

  it.each(mergeCases)('gives the same answer applied twice: $name', (testCase) => {
    const once = withSharedResponses(declaredBy(testCase), testCase.route, 'probe')
    expect(withSharedResponses(once, testCase.route, 'probe')).toEqual(once)
  })

  it('adds the headers to a copy, leaving the success schema it was given unchanged', () => {
    const ok: TSchema = Type.Object({ status: Type.String() })
    const merged = withSharedResponses({ 200: ok }, ruleCases[0]!.route, 'probe')
    expect(ok).toEqual(Type.Object({ status: Type.String() }))
    expect(merged['200']).not.toBe(ok)
    expect(merged['200']).toEqual({ ...ok, headers: expect.any(Object) })
  })

  it('keeps a header the success already declares beside the limiter headers', () => {
    const created = { ...Type.Object({ id: Type.String() }), headers: { location: LOCATION } }
    const merged = withSharedResponses({ 201: created }, ruleCases[0]!.route, 'probe')
    expect(built(merged['201']).headers).toMatchObject({ location: LOCATION })
    expect(withSharedResponses(merged, ruleCases[0]!.route, 'probe')).toEqual(merged)
  })

  it('refuses a shared status declared without errorResponses', () => {
    const plain = Type.Object({ error: Type.String(), message: Type.String() })
    expect(() =>
      withSharedResponses(
        { 400: plain },
        { methods: ['GET'], isPublic: false, validates: true },
        'GET /x',
      ),
    ).toThrow(/GET \/x 400 .*errorResponses/)
  })

  it('reads no codes from a schema without an enum', () => {
    expect(() => declaredCodes(Type.Object({}), 'GET /x 400')).toThrow(/errorResponses/)
  })
})

describe('liftRequiredHeaders', () => {
  const documentWith = (headers: Record<string, unknown> | undefined) => ({
    openapi: '3.1.0',
    paths: {
      '/x': {
        get: { responses: { '200': { description: 'ok', ...(headers ? { headers } : {}) } } },
      },
    },
  })

  it.each(liftCases)('$name', ({ headers, expected }) => {
    const lifted = liftRequiredHeaders(documentWith(headers))
    expect(lifted).toEqual(documentWith(expected))
  })

  it('leaves the document it was given unchanged', () => {
    const given = documentWith(liftCases[0]!.headers)
    const before = structuredClone(given)
    liftRequiredHeaders(given)
    expect(given).toEqual(before)
  })
})
