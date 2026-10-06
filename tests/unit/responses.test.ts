import { describe, expect, it } from 'vitest'
import { Type, type TSchema } from 'typebox'
import * as errors from '../../src/shared/errors.js'
import {
  catalogue,
  declaredCodes,
  errorResponses,
  SHARED_RULES,
  withSharedResponses,
} from '../../src/shared/responses.js'
import { groupingCases, mergeCases, ruleCases } from '../fixtures/datasets/response-rules.js'

type ErrorClass = new (message: string) => errors.AppError

function classNamed(name: string): ErrorClass {
  const exported = (errors as Record<string, unknown>)[name]
  if (typeof exported !== 'function') throw new Error(`errors.ts exports no ${name}`)
  return exported as ErrorClass
}

interface Built {
  description?: string
  headers?: Record<string, unknown>
  'x-examples'?: Record<string, { value: { error: string } }>
  properties: { error: { enum: string[] } }
}

const built = (schema: unknown) => schema as Built

function shapeOf(response: Record<string, unknown>) {
  const codes: Record<number, string[]> = {}
  const headers: Record<number, string[]> = {}
  for (const [status, schema] of Object.entries(response)) {
    codes[Number(status)] = built(schema).properties.error.enum
    const names = Object.keys(built(schema).headers ?? {})
    if (names.length > 0) headers[Number(status)] = names
  }
  return { codes, headers }
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
      const { properties, 'x-examples': examples } = built(schema)
      expect(Object.keys(examples ?? {})).toEqual(properties.error.enum)
      for (const [code, example] of Object.entries(examples ?? {})) {
        expect(example.value.error).toBe(code)
      }
    }
  })

  it.each(groupingCases)('describes every code with its meaning: $name', ({ classes }) => {
    for (const schema of Object.values(errorResponses(...classes.map(classNamed)))) {
      for (const code of built(schema).properties.error.enum) {
        expect(built(schema).description).toContain(
          `\`${code}\` — ${catalogue().get(code)!.meaning}`,
        )
      }
    }
  })
})

describe('withSharedResponses', () => {
  it.each(mergeCases)('$name', ({ route, declared, expected, headers }) => {
    const merged = withSharedResponses(errorResponses(...declared.map(classNamed)), route, 'probe')
    expect(shapeOf(merged)).toEqual({ codes: expected, headers })
  })

  it.each(mergeCases)('gives the same answer applied twice: $name', ({ route, declared }) => {
    const once = withSharedResponses(errorResponses(...declared.map(classNamed)), route, 'probe')
    expect(withSharedResponses(once, route, 'probe')).toEqual(once)
  })

  it('leaves success responses as they are', () => {
    const ok: TSchema = Type.Object({ status: Type.String() })
    const merged = withSharedResponses({ 200: ok }, ruleCases[0]!.route, 'probe')
    expect(merged['200']).toBe(ok)
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
