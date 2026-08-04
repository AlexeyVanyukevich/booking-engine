import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Api } from '../fixtures/api.js'
import { injectTransport } from '../fixtures/transport.js'
import { unknownUuid } from '../fixtures/ids.js'
import { aResource } from '../fixtures/resources.js'
import { buildTestApp, closeTestDb, resetDb } from './helpers.js'

let app: FastifyInstance
let api: Api

beforeAll(async () => {
  app = await buildTestApp()
  api = new Api(injectTransport(app))
})

beforeEach(resetDb)

afterAll(async () => {
  await app.close()
  await closeTestDb()
})

describe('error responses', () => {
  it.each([
    { name: 'an unknown path', method: 'GET' as const, url: '/nope' },
    { name: 'an unknown nested path', method: 'GET' as const, url: '/resources/x/y/z' },
    { name: 'a method the route does not serve', method: 'DELETE' as const, url: '/health' },
  ])('answers $name with the uniform 404 shape', async ({ method, url }) => {
    const response = await app.inject({ method, url })
    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({ error: 'not_found', message: 'Route not found' })
  })

  it.each([
    {
      name: 'a missing resource',
      request: () => api.getResource(unknownUuid()),
      status: 404,
      error: 'not_found',
    },
    {
      name: 'a malformed body',
      request: () => api.createResource({ timezone: 'Europe/Warsaw' }),
      status: 400,
      error: 'validation_error',
    },
    {
      name: 'a rejected business rule',
      request: () => api.createResource(aResource({ concurrency_mode: 'pool' })),
      status: 400,
      error: 'unsupported_concurrency_mode',
    },
  ])('answers $name with $status $error', async ({ request, status, error }) => {
    const response = await request()
    expect(response.statusCode).toBe(status)

    const body = response.json()
    expect(body.error).toBe(error)
    expect(typeof body.message).toBe('string')
    expect(body.message.length).toBeGreaterThan(0)
    expect(Object.keys(body).every((key) => ['error', 'message', 'details'].includes(key))).toBe(
      true,
    )
  })

  it('never exposes database structure in an error message', async () => {
    const response = await api.createResource({ ...aResource(), slot_duration: 'P1M' })
    const serialized = JSON.stringify(response.json())

    for (const leak of ['resources', 'kysely', 'postgres', 'pg_', 'select ', 'insert into']) {
      expect(serialized.toLowerCase()).not.toContain(leak)
    }
  })

  it('sends JSON even for malformed JSON input', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/resources',
      headers: { 'content-type': 'application/json' },
      payload: '{ this is not json',
    })
    expect(response.statusCode).toBeGreaterThanOrEqual(400)
    expect(response.headers['content-type']).toContain('application/json')
  })
})
