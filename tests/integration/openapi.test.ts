import { readFile } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { generateOpenApiDocument, serializeOpenApiDocument } from '../../src/shared/openapi.js'
import { buildTestApp, closeTestDb, resetDbWithTenant, testAuthorization } from './helpers.js'

let app: FastifyInstance
let document: {
  openapi: string
  info: { title: string; version: string; description: string }
  tags: Array<{ name: string }>
  paths: Record<string, Record<string, Record<string, unknown>>>
}

beforeAll(async () => {
  app = await buildTestApp()
  document = (await app.inject({ method: 'GET', url: '/docs/json' })).json()
})

afterAll(async () => {
  await app.close()
  await closeTestDb()
})

/** Every route the engine serves, other than the documentation itself. */
const ROUTES: Array<[method: string, path: string]> = [
  ['get', '/health'],
  ['post', '/resources'],
  ['get', '/resources'],
  ['get', '/resources/{id}'],
  ['patch', '/resources/{id}'],
  ['delete', '/resources/{id}'],
  ['get', '/resources/{id}/schedule'],
  ['put', '/resources/{id}/schedule'],
  ['get', '/resources/{id}/exceptions'],
  ['put', '/resources/{id}/exceptions/{date}'],
  ['delete', '/resources/{id}/exceptions/{date}'],
  ['get', '/resources/{id}/availability'],
  ['post', '/resources/{id}/bookings'],
  ['get', '/bookings/{id}'],
  ['post', '/bookings/{id}/confirm'],
  ['post', '/bookings/{id}/cancel'],
  ['post', '/bookings/{id}/complete'],
  ['post', '/bookings/{id}/no-show'],
  ['post', '/bookings/{id}/reschedule'],
  ['get', '/resources/{id}/bookings'],
  ['get', '/bookings'],
]

describe('OpenAPI document', () => {
  it('is served as JSON', () => {
    expect(document.openapi).toMatch(/^3\./)
    expect(document.info.title).toBe('Booking Engine')
  })

  it('states the conventions a caller cannot guess', () => {
    for (const rule of ['half-open', 'PT24H', 'Monday = 0', 'named IANA']) {
      expect(document.info.description).toContain(rule)
    }
  })

  it.each(ROUTES)('documents %s %s', (method, path) => {
    expect(document.paths[path]?.[method]).toBeDefined()
  })

  it('documents no route that does not exist', () => {
    const documented = Object.entries(document.paths).flatMap(([path, methods]) =>
      Object.keys(methods).map((method) => `${method} ${path}`),
    )
    const known = ROUTES.map(([method, path]) => `${method} ${path}`)
    expect(documented.sort()).toEqual(known.sort())
  })

  interface DocumentedError {
    description: string
    headers?: Record<string, unknown>
    content: {
      'application/json': {
        schema: { properties: { error: { enum?: string[] } } }
        examples?: Record<string, { value: { error: string } }>
      }
    }
  }

  const errorResponsesOf = (method: string, path: string) =>
    Object.entries(
      document.paths[path]![method]!.responses as Record<string, DocumentedError>,
    ).filter(([status]) => Number(status) >= 400)

  it.each(ROUTES)('narrows every error code of %s %s and gives each an example', (method, path) => {
    for (const [status, response] of errorResponsesOf(method, path)) {
      const media = response.content['application/json']
      const codes = media.schema.properties.error.enum
      expect(codes, `${status} has no enum`).toBeDefined()
      expect(Object.keys(media.examples ?? {}), `${status} examples`).toEqual(codes)
      expect(response.description, `${status} description`).not.toBe('Default Response')
    }
  })

  it.each(ROUTES)('declares 429 and 500 on %s %s', (method, path) => {
    const statuses = errorResponsesOf(method, path).map(([status]) => status)
    expect(statuses).toEqual(expect.arrayContaining(['429', '500']))
  })

  it('documents the rate-limit headers on a 429', () => {
    const [, tooMany] = errorResponsesOf('get', '/resources').find(([status]) => status === '429')!
    expect(Object.keys(tooMany.headers ?? {}).sort()).toEqual([
      'retry-after',
      'x-ratelimit-limit',
      'x-ratelimit-remaining',
      'x-ratelimit-reset',
    ])
  })

  it('lists the codes a booking can lose its slot with', () => {
    const [, conflict] = errorResponsesOf('post', '/resources/{id}/bookings').find(
      ([status]) => status === '409',
    )!
    expect(conflict.content['application/json'].schema.properties.error.enum).toEqual([
      'resource_inactive',
      'slot_unavailable',
      'idempotency_key_reused',
    ])
  })

  it.each(ROUTES)('gives %s %s a tag and a summary', (method, path) => {
    const operation = document.paths[path]![method]!
    expect(operation.tags).toBeDefined()
    expect(operation.summary).toBeTypeOf('string')
  })

  it.each(ROUTES)('declares the responses of %s %s', (method, path) => {
    const responses = document.paths[path]![method]!.responses as Record<string, unknown>
    expect(Object.keys(responses).length).toBeGreaterThan(0)
    // A success code must be declared, or the serializer has nothing to enforce.
    expect(Object.keys(responses).some((code) => code.startsWith('2'))).toBe(true)
  })

  /**
   * Swagger UI composes the pre-filled "Try it out" body from the first example of each
   * field. If those examples do not compose into a request the engine accepts, the first
   * thing a newcomer does in the UI fails.
   */
  it('pre-fills the create body with a request that actually works', async () => {
    const properties = document.paths['/resources']!.post!.requestBody as {
      content: Record<string, { schema: { properties: Record<string, { example?: unknown }> } }>
    }
    const prefilled = Object.fromEntries(
      Object.entries(properties.content['application/json']!.schema.properties)
        .filter(([, field]) => field.example !== undefined)
        .map(([name, field]) => [name, field.example]),
    )

    // The documented body has to work against the real route, which now needs a key.
    await resetDbWithTenant()
    const response = await app.inject({
      method: 'POST',
      url: '/resources',
      headers: { authorization: testAuthorization()! },
      payload: prefilled,
    })
    expect(response.statusCode).toBe(201)
  })

  /**
   * Markdown treats a single newline as a space, so hand-wrapped lines joined with '\n'
   * collapse into one very long line in the Swagger UI. Paragraphs must be separated by a
   * blank line — `md()` in `src/shared/docs.ts` is what does it.
   */
  it('separates description paragraphs with a blank line', () => {
    const descriptions = [
      ['info', document.info.description] as const,
      ...ROUTES.map(
        ([method, path]) =>
          [`${method} ${path}`, document.paths[path]![method]!.description as string] as const,
      ),
    ].filter(([, text]) => typeof text === 'string' && text.includes('\n'))

    // A bare newline is correct inside a list — Markdown reads consecutive item lines as a
    // tight list. It is only harmful between lines of prose, where it collapses them.
    const isListBlock = (block: string) =>
      block.split('\n').every((line) => /^\s*([-*]|\d+\.)\s/.test(line))

    for (const [where, text] of descriptions) {
      const collapsed = text
        .split('\n\n')
        .filter((block) => block.includes('\n') && !isListBlock(block))
      expect(collapsed, `${where} wraps prose with a bare newline`).toEqual([])
    }
  })

  it('never shows an ellipsis that reads as truncated output', () => {
    const texts = [
      document.info.description,
      ...ROUTES.map(([method, path]) => document.paths[path]![method]!.description as string),
    ]
    for (const text of texts) {
      expect(text ?? '').not.toMatch(/…/)
    }
  })

  it('declares every tag it uses', () => {
    const declared = new Set(document.tags.map((tag) => tag.name))
    for (const [method, path] of ROUTES) {
      for (const tag of document.paths[path]![method]!.tags as string[]) {
        expect(declared).toContain(tag)
      }
    }
  })
})

/**
 * The document is also committed, so a consumer can generate its types without running the
 * engine, and so a contract change appears in the diff of a pull request here — where the
 * reviewer making it can see that a field disappeared — instead of surfacing later as a
 * consumer's failing build. Both only hold while the file matches what the engine serves.
 */
describe('the committed openapi.json', () => {
  const stale = 'openapi.json no longer matches the engine. Regenerate it: npm run openapi'

  let committed: string
  let generated: Record<string, unknown>

  beforeAll(async () => {
    committed = await readFile(new URL('../../openapi.json', import.meta.url), 'utf8')
    generated = await generateOpenApiDocument()
  })

  it('describes the same API the engine serves', () => {
    expect(JSON.parse(committed), stale).toEqual(generated)
  })

  /**
   * Asserted separately from the contract above: this one fails when only the formatting has
   * drifted, and a diff of two parsed documents would then report no difference at all.
   */
  it('is written exactly as the generator writes it', () => {
    expect(committed, stale).toBe(serializeOpenApiDocument(generated))
  })
})

describe('Swagger UI', () => {
  it.each(['/docs', '/docs/'])('serves the interactive UI at %s', async (url) => {
    const response = await app.inject({ method: 'GET', url })
    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('swagger-ui')
  })

  /**
   * Descriptions here are dense with inline code, which Swagger UI styles as a padded box.
   * Without extra leading those boxes overlap the line above, and without wrapping they push
   * past the right edge of the panel. The stylesheet that fixes it must actually reach the
   * page — a link to a 404 looks fine in the markup and broken on screen.
   */
  it('links a stylesheet and serves it', async () => {
    const page = await app.inject({ method: 'GET', url: '/docs/' })
    const href = /<link[^>]+href="\.?\/?([^"]*theme\.css)"/.exec(page.body)?.[1]
    expect(href, 'the UI does not link a custom stylesheet').toBeDefined()

    const stylesheet = await app.inject({ method: 'GET', url: `/docs/${href}` })
    expect(stylesheet.statusCode).toBe(200)
    expect(stylesheet.body).toContain('line-height')
    expect(stylesheet.body).toContain('overflow-wrap')
  })

  it('leaves example blocks alone while fixing inline code', async () => {
    const page = await app.inject({ method: 'GET', url: '/docs/' })
    const href = /<link[^>]+href="\.?\/?([^"]*theme\.css)"/.exec(page.body)![1]
    const css = (await app.inject({ method: 'GET', url: `/docs/${href}` })).body

    // Collapsing whitespace inside <pre> would destroy request and response samples.
    expect(css).toContain(':not(pre) > code')
    expect(css).not.toMatch(/^\s*\.swagger-ui code\s*\{/m)
  })

  it('serves the document as YAML too', async () => {
    const response = await app.inject({ method: 'GET', url: '/docs/yaml' })
    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('Booking Engine')
  })
})
