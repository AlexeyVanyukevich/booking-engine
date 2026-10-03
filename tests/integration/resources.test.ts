import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Api } from '../fixtures/api.js'
import { withAuthorization, injectTransport } from '../fixtures/transport.js'
import { MALFORMED_UUIDS, unknownUuid } from '../fixtures/ids.js'
import { aResource, aSharedResource, aDayBasedResource } from '../fixtures/resources.js'
import {
  acceptedPatches,
  acceptedResources,
  rejectedPatches,
  rejectedResources,
} from '../fixtures/datasets/resource-validation.js'
import { WEEKDAYS, aWindow } from '../fixtures/schedules.js'
import { buildTestApp, closeTestDb, resetDbWithTenant, testAuthorization } from './helpers.js'
import type { ErrorResponse, ResourceListResponse, ResourceResponse } from '../fixtures/bodies.js'

let api: Api
let close: () => Promise<void>

beforeAll(async () => {
  const app = await buildTestApp()
  api = new Api(withAuthorization(injectTransport(app), testAuthorization))
  close = async () => {
    await app.close()
  }
})

beforeEach(resetDbWithTenant)

afterAll(async () => {
  await close()
  await closeTestDb()
})

describe('POST /resources', () => {
  it.each(acceptedResources)('creates $name', async ({ overrides, expected }) => {
    const response = await api.createResource(aResource(overrides))
    expect(response.statusCode).toBe(201)
    expect(response.json<ResourceResponse>()).toMatchObject(expected)
  })

  it.each(rejectedResources)('rejects $name', async ({ overrides, expectedError }) => {
    const response = await api.createResource({ ...aResource(), ...overrides })
    expect(response.statusCode).toBe(400)
    expect(response.json<ErrorResponse>().error).toBe(expectedError)
  })

  it('assigns a distinct id to each resource', async () => {
    const first = await api.givenResource(aResource())
    const second = await api.givenResource(aResource())
    expect(first).not.toBe(second)
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it.each(['timezone', 'slot_duration', 'concurrency_mode'])(
    'rejects a body missing %s',
    async (field) => {
      const payload: Record<string, unknown> = { ...aResource() }
      delete payload[field]
      const response = await api.createResource(payload)
      expect(response.statusCode).toBe(400)
      expect(response.json<ErrorResponse>().error).toBe('validation_error')
    },
  )

  it('reports pool_id as null on a resource that has no pool', async () => {
    const response = await api.createResource(aResource())
    expect(response.json<ResourceResponse>()).toHaveProperty('pool_id', null)
  })

  it('never leaks internal columns', async () => {
    const response = await api.createResource(aResource())
    expect(Object.keys(response.json<ResourceResponse>()).sort()).toEqual([
      'capacity',
      'concurrency_mode',
      'id',
      'is_active',
      'pool_id',
      'slot_anchor_time',
      'slot_duration',
      'timezone',
    ])
  })
})

describe('GET /resources/:id', () => {
  it('returns a resource unchanged after creation', async () => {
    const created = (await api.createResource(aDayBasedResource())).json<ResourceResponse>()
    const fetched = await api.getResource(created.id)
    expect(fetched.statusCode).toBe(200)
    expect(fetched.json<ResourceResponse>()).toEqual(created)
  })

  it('returns 404 for an unknown id', async () => {
    const response = await api.getResource(unknownUuid())
    expect(response.statusCode).toBe(404)
    expect(response.json<ErrorResponse>().error).toBe('not_found')
  })

  it.each(MALFORMED_UUIDS)('returns 400 for the malformed id %s', async (id) => {
    const response = await api.getResource(id)
    expect(response.statusCode).toBe(400)
    expect(response.json<ErrorResponse>().error).toBe('validation_error')
  })
})

describe('PATCH /resources/:id', () => {
  it.each(acceptedPatches)('$name', async ({ create, patch, expected }) => {
    const id = await api.givenResource(aResource(create))
    const response = await api.patchResource(id, patch)
    expect(response.statusCode).toBe(200)
    expect(response.json<ResourceResponse>()).toMatchObject(expected)
  })

  it.each(rejectedPatches)('rejects $name', async ({ create, patch, expectedError }) => {
    const id = await api.givenResource(aResource(create))
    const response = await api.patchResource(id, patch)
    expect(response.statusCode).toBe(400)
    expect(response.json<ErrorResponse>().error).toBe(expectedError)
  })

  it.each(rejectedPatches)(
    'leaves the resource untouched after rejecting $name',
    async ({ create, patch }) => {
      const id = await api.givenResource(aResource(create))
      const before = (await api.getResource(id)).json<ResourceResponse>()
      await api.patchResource(id, patch)
      expect((await api.getResource(id)).json<ResourceResponse>()).toEqual(before)
    },
  )

  it('persists the change', async () => {
    const id = await api.givenResource(aResource())
    await api.patchResource(id, { slot_duration: 'PT15M' })
    expect((await api.getResource(id)).json<ResourceResponse>().slot_duration).toBe('PT15M')
  })

  it('returns 404 for an unknown id', async () => {
    const response = await api.patchResource(unknownUuid(), { is_active: false })
    expect(response.statusCode).toBe(404)
  })
})

describe('DELETE /resources/:id', () => {
  it('deletes a resource', async () => {
    const id = await api.givenResource(aResource())
    expect((await api.deleteResource(id)).statusCode).toBe(204)
    expect((await api.getResource(id)).statusCode).toBe(404)
  })

  it('cascades to the schedule and the exceptions', async () => {
    const id = await api.givenResource(aResource())
    await api.givenSchedule(id, [aWindow(0, '09:00', '17:00')])
    await api.putException(id, { date: '2026-07-20', start_time: null, end_time: null })

    await api.deleteResource(id)

    expect((await api.getSchedule(id)).statusCode).toBe(404)
    expect((await api.listExceptions(id, '2026-07-01', '2026-08-01')).statusCode).toBe(404)
  })

  it('leaves other resources alone', async () => {
    const doomed = await api.givenResource(aResource())
    const survivor = await api.givenResource(aSharedResource())
    await api.deleteResource(doomed)
    expect((await api.getResource(survivor)).statusCode).toBe(200)
  })

  it('returns 404 for an unknown id', async () => {
    expect((await api.deleteResource(unknownUuid())).statusCode).toBe(404)
  })

  it('returns 404 on a second delete', async () => {
    const id = await api.givenResource(aResource())
    expect((await api.deleteResource(id)).statusCode).toBe(204)
    expect((await api.deleteResource(id)).statusCode).toBe(404)
  })
})

describe('DELETE /resources/:id with bookings', () => {
  it('refuses to delete a resource that has any booking', async () => {
    const id = await api.givenResource(aResource())
    await api.givenSchedule(id, [aWindow(WEEKDAYS.monday, '09:00', '12:00')])
    await api.givenBooking(id, {
      customer_id: 'c-1',
      start_time: '2026-07-20T09:00:00+02:00',
      end_time: '2026-07-20T10:00:00+02:00',
    })

    const response = await api.deleteResource(id)
    expect(response.statusCode).toBe(409)
    expect(response.json<ErrorResponse>().error).toBe('resource_has_bookings')
    expect((await api.getResource(id)).statusCode).toBe(200)
  })

  it('refuses even when every booking is terminal', async () => {
    const id = await api.givenResource(aResource())
    await api.givenSchedule(id, [aWindow(WEEKDAYS.monday, '09:00', '12:00')])
    const booking = await api.givenBooking(id, {
      customer_id: 'c-1',
      start_time: '2026-07-20T09:00:00+02:00',
      end_time: '2026-07-20T10:00:00+02:00',
    })
    await api.bookingAction(booking, 'cancel')

    // History is not discarded as a side effect of a delete; `is_active: false` is the
    // tool for retiring a resource.
    expect((await api.deleteResource(id)).statusCode).toBe(409)
  })

  it('still deletes a resource that has none', async () => {
    const id = await api.givenResource(aResource())
    expect((await api.deleteResource(id)).statusCode).toBe(204)
  })
})

describe('GET /resources', () => {
  it('answers an empty array when the tenant owns nothing', async () => {
    const response = await api.listResources()
    expect(response.statusCode).toBe(200)
    expect(response.json<ResourceListResponse>()).toEqual([])
  })

  it('lists the tenant resources oldest first', async () => {
    const first = await api.givenResource(aResource())
    const second = await api.givenResource(aResource())

    const response = await api.listResources()
    expect(response.json<ResourceListResponse>().map((row: { id: string }) => row.id)).toEqual([
      first,
      second,
    ])
  })

  it('returns the same shape as reading one', async () => {
    const id = await api.givenResource(aResource())
    const [listed] = (await api.listResources()).json<ResourceListResponse>()
    expect(listed).toEqual((await api.getResource(id)).json<ResourceResponse>())
  })

  it.each([
    ['is_active=false', false],
    ['is_active=true', true],
  ])('filters by %s', async (query, expectRetired) => {
    const retired = await api.givenResource(aResource())
    await api.patchResource(retired, { is_active: false })
    const live = await api.givenResource(aResource())

    const ids = (await api.listResources(query))
      .json<ResourceListResponse>()
      .map((row: { id: string }) => row.id)
    expect(ids).toEqual([expectRetired ? live : retired])
  })

  it('rejects an unknown query parameter rather than ignoring it', async () => {
    const response = await api.listResources('tenant_id=someone-else')
    expect(response.statusCode).toBe(400)
  })
})
