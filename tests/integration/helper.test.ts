import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { GenericContainer } from 'testcontainers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CONTAINER_LABEL, startEngine, type StartedEngine } from '../../testing/src/index.js'
import { aResource } from '../fixtures/resources.js'

/** Built from this checkout, so the helper is tested against the code beside it. */
const IMAGE = 'booking-engine:helper-test'
const REPO = fileURLToPath(new URL('../..', import.meta.url))

function stillRunning(): string[] {
  return execFileSync('docker', ['ps', '-q', '--filter', `label=${CONTAINER_LABEL}`], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter((line) => line.length > 0)
}

beforeAll(async () => {
  // Kept after the run, so later runs reuse the layer cache instead of rebuilding.
  await GenericContainer.fromDockerfile(REPO).build(IMAGE, { deleteOnExit: false })
}, 600_000)

describe('startEngine', () => {
  let engine: StartedEngine | undefined

  beforeAll(async () => {
    engine = await startEngine({
      image: IMAGE,
      keys: ['back_office', 'site_backend', 'reporting'],
      rateLimitPerMinute: 2,
    })
  }, 180_000)

  afterAll(async () => {
    await engine?.stop()
  })

  const call = (key: string | undefined, method: string, path: string, body?: unknown) =>
    fetch(`${engine!.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${key ?? ''}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })

  it('issues a back_office key that can create a resource', async () => {
    const response = await call(engine!.keys.back_office, 'POST', '/resources', aResource())
    expect(response.status).toBe(201)
  })

  it('issues a site_backend key that holds only its own scopes', async () => {
    const response = await call(engine!.keys.site_backend, 'POST', '/resources', aResource())
    expect(response.status).toBe(403)
    expect(((await response.json()) as { error: string }).error).toBe('forbidden_scope')
  })

  it('passes the rate limit through to the engine', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 3; i++) {
      statuses.push((await call(engine!.keys.reporting, 'GET', '/resources')).status)
    }
    expect(statuses).toEqual([200, 200, 429])
  })

  it('names the tenant every key belongs to', () => {
    expect(engine!.tenantId).toMatch(/^[0-9a-f-]{36}$/)
    expect(Object.keys(engine!.keys).sort()).toEqual(['back_office', 'reporting', 'site_backend'])
  })

  it('leaves nothing running after stop', async () => {
    await engine!.stop()
    engine = undefined
    expect(stillRunning()).toEqual([])
  }, 60_000)
})

describe('startEngine when a step fails', () => {
  it('rejects with the step output and leaves nothing running', async () => {
    await expect(startEngine({ image: IMAGE, tenant: '   ' })).rejects.toThrow(
      /issue-keys[\s\S]*blank/,
    )
    expect(stillRunning()).toEqual([])
  }, 180_000)
})
