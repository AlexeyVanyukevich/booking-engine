import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, closeTestDb } from './helpers.js'

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
  ['get', '/resources/{id}'],
  ['patch', '/resources/{id}'],
  ['delete', '/resources/{id}'],
  ['get', '/resources/{id}/schedule'],
  ['put', '/resources/{id}/schedule'],
  ['get', '/resources/{id}/exceptions'],
  ['put', '/resources/{id}/exceptions/{date}'],
  ['delete', '/resources/{id}/exceptions/{date}'],
  ['get', '/resources/{id}/availability'],
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

    const response = await app.inject({ method: 'POST', url: '/resources', payload: prefilled })
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
