import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, closeTestDb } from './helpers.js'

let app: FastifyInstance

beforeAll(async () => {
  app = await buildTestApp()
})

afterAll(async () => {
  await app.close()
  await closeTestDb()
})

describe('GET /health', () => {
  it('reports health', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'ok' })
  })

  it('answers repeatedly without state', async () => {
    for (let i = 0; i < 3; i += 1) {
      expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200)
    }
  })

  it('responds as JSON', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' })
    expect(response.headers['content-type']).toContain('application/json')
  })
})

describe('GET /', () => {
  it('sends a browser to the API reference rather than a bare 404', async () => {
    const response = await app.inject({ method: 'GET', url: '/' })
    expect(response.statusCode).toBeGreaterThanOrEqual(300)
    expect(response.statusCode).toBeLessThan(400)
    expect(response.headers.location).toBe('/docs')
  })

  it('stays out of the API documentation', async () => {
    const document = (await app.inject({ method: 'GET', url: '/docs/json' })).json()
    expect(document.paths['/']).toBeUndefined()
  })
})
