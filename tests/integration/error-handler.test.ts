import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Api } from '../fixtures/api.js'
import { withAuthorization, injectTransport } from '../fixtures/transport.js'
import { unknownUuid } from '../fixtures/ids.js'
import { aResource } from '../fixtures/resources.js'
import { buildTestApp, closeTestDb, resetDbWithTenant, testAuthorization } from './helpers.js'

let app: FastifyInstance
let api: Api

beforeAll(async () => {
  app = await buildTestApp()
  api = new Api(withAuthorization(injectTransport(app), testAuthorization))
})

beforeEach(resetDbWithTenant)

afterAll(async () => {
  await app.close()
  await closeTestDb()
})

const unmatched = [
  { name: 'an unknown path', method: 'GET' as const, url: '/nope' },
  { name: 'an unknown nested path', method: 'GET' as const, url: '/resources/x/y/z' },
  { name: 'a method the route does not serve', method: 'DELETE' as const, url: '/health' },
]

describe('error responses', () => {
  it.each(unmatched)('answers $name with the uniform 404 shape', async ({ method, url }) => {
    const response = await api.request({ method, url })
    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({ error: 'not_found', message: 'Route not found' })
  })

  /**
   * Authentication runs in `onRequest`, before Fastify has decided there is no route, so an
   * unknown path answers 401 rather than 404 to a caller with no key. That is the better
   * answer: without it, anyone could map which paths exist by reading status codes. With a
   * valid key the uniform 404 above is what comes back, so nothing is hidden from a caller
   * entitled to know.
   */
  it.each(unmatched)('answers $name with 401 when no key is presented', async ({ method, url }) => {
    const response = await app.inject({ method, url })
    expect(response.statusCode).toBe(401)
    expect(response.json().error).toBe('unauthorized')
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
