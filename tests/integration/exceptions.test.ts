import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Api } from '../fixtures/api.js'
import { withAuthorization, injectTransport } from '../fixtures/transport.js'
import { unknownUuid } from '../fixtures/ids.js'
import { aDayBasedResource, aResource } from '../fixtures/resources.js'
import { aDayOff, alteredHours } from '../fixtures/schedules.js'
import {
  acceptedExceptions,
  impossibleExceptionDates,
  malformedExceptionDates,
  rejectedExceptions,
} from '../fixtures/datasets/exception-validation.js'
import { buildTestApp, closeTestDb, resetDbWithTenant, testAuthorization } from './helpers.js'

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

const resourceFor = (kind: 'intraday' | 'day') =>
  kind === 'day' ? aDayBasedResource() : aResource()

const DATE = '2026-07-20'

describe('PUT /resources/:id/exceptions/:date', () => {
  it.each(acceptedExceptions)('accepts $name', async ({ kind, body }) => {
    const id = await api.givenResource(resourceFor(kind))
    const response = await api.putException(id, { date: DATE, ...body })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ date: DATE, ...body })
  })

  it.each(rejectedExceptions)(
    'rejects $name with $expectedError',
    async ({ kind, body, expectedError }) => {
      const id = await api.givenResource(resourceFor(kind))
      const response = await api.putException(id, { date: DATE, ...body })
      expect(response.statusCode).toBe(400)
      expect(response.json().error).toBe(expectedError)
    },
  )

  it.each(rejectedExceptions)('stores nothing after rejecting $name', async ({ kind, body }) => {
    const id = await api.givenResource(resourceFor(kind))
    await api.putException(id, { date: DATE, ...body })
    expect((await api.listExceptions(id, '2026-07-01', '2026-08-01')).json()).toEqual([])
  })

  it.each(malformedExceptionDates)('rejects the malformed date %s', async (date) => {
    const id = await api.givenResource(aResource())
    const response = await api.putException(id, aDayOff(date))
    expect(response.statusCode).toBe(400)
  })

  it.each(impossibleExceptionDates)('rejects the impossible date %s', async (date) => {
    const id = await api.givenResource(aResource())
    const response = await api.putException(id, aDayOff(date))
    expect(response.statusCode).toBeGreaterThanOrEqual(400)
  })

  it('overwrites on repeat rather than accumulating', async () => {
    const id = await api.givenResource(aResource())
    await api.putException(id, alteredHours(DATE, '10:00', '14:00'))
    const second = await api.putException(id, alteredHours(DATE, '11:00', '15:00'))

    expect(second.statusCode).toBe(200)
    expect(second.json()).toMatchObject({ start_time: '11:00', end_time: '15:00' })
    expect((await api.listExceptions(id, '2026-07-01', '2026-08-01')).json()).toHaveLength(1)
  })

  it('can turn altered hours into a day off and back', async () => {
    const id = await api.givenResource(aResource())
    await api.putException(id, alteredHours(DATE, '10:00', '14:00'))
    await api.putException(id, aDayOff(DATE))
    expect((await api.listExceptions(id, '2026-07-01', '2026-08-01')).json()[0]).toMatchObject({
      start_time: null,
      end_time: null,
    })

    await api.putException(id, alteredHours(DATE, '12:00', '13:00'))
    expect((await api.listExceptions(id, '2026-07-01', '2026-08-01')).json()[0]).toMatchObject({
      start_time: '12:00',
      end_time: '13:00',
    })
  })

  it('keeps exceptions of different resources separate', async () => {
    const first = await api.givenResource(aResource())
    const second = await api.givenResource(aResource())
    await api.putException(first, aDayOff(DATE))

    expect((await api.listExceptions(second, '2026-07-01', '2026-08-01')).json()).toEqual([])
  })

  it('stores the date exactly as given, without timezone drift', async () => {
    // A resource far from UTC is the case where a Date-based parser would shift the day.
    const id = await api.givenResource(aResource({ timezone: 'Pacific/Auckland' }))
    const response = await api.putException(id, aDayOff('2026-01-01'))
    expect(response.json().date).toBe('2026-01-01')
  })

  it('returns 404 for an unknown resource', async () => {
    expect((await api.putException(unknownUuid(), aDayOff(DATE))).statusCode).toBe(404)
  })
})

describe('GET /resources/:id/exceptions', () => {
  const dates = ['2026-07-18', '2026-07-19', '2026-07-20', '2026-07-21']

  it('is half-open on the upper bound', async () => {
    const id = await api.givenResource(aResource())
    await api.givenExceptions(id, dates.map(aDayOff))

    const listed = await api.listExceptions(id, '2026-07-19', '2026-07-21')
    expect(listed.json().map((row: { date: string }) => row.date)).toEqual([
      '2026-07-19',
      '2026-07-20',
    ])
  })

  it('returns exceptions in date order', async () => {
    const id = await api.givenResource(aResource())
    await api.givenExceptions(id, [...dates].reverse().map(aDayOff))

    const listed = await api.listExceptions(id, '2026-07-01', '2026-08-01')
    expect(listed.json().map((row: { date: string }) => row.date)).toEqual(dates)
  })

  it('returns an empty list when nothing falls in the range', async () => {
    const id = await api.givenResource(aResource())
    await api.givenExceptions(id, dates.map(aDayOff))
    expect((await api.listExceptions(id, '2026-09-01', '2026-09-30')).json()).toEqual([])
  })

  it.each([
    { name: 'an inverted range', from: '2026-07-21', to: '2026-07-19' },
    { name: 'a range with equal bounds', from: '2026-07-20', to: '2026-07-20' },
    { name: 'an over-wide range', from: '2026-01-01', to: '2028-01-01' },
  ])('rejects $name', async ({ from, to }) => {
    const id = await api.givenResource(aResource())
    const response = await api.listExceptions(id, from, to)
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('invalid_range')
  })

  it.each([
    { name: 'both bounds', query: '' },
    { name: 'the upper bound', query: '?from=2026-07-01' },
    { name: 'the lower bound', query: '?to=2026-08-01' },
  ])('rejects a request missing $name', async ({ query }) => {
    const id = await api.givenResource(aResource())
    const response = await api.listExceptionsWithQuery(id, query)
    expect(response.statusCode).toBe(400)
  })

  it('returns 404 for an unknown resource', async () => {
    expect((await api.listExceptions(unknownUuid(), '2026-07-01', '2026-08-01')).statusCode).toBe(
      404,
    )
  })
})

describe('DELETE /resources/:id/exceptions/:date', () => {
  it('deletes an existing exception', async () => {
    const id = await api.givenResource(aResource())
    await api.putException(id, aDayOff(DATE))

    expect((await api.deleteException(id, DATE)).statusCode).toBe(204)
    expect((await api.listExceptions(id, '2026-07-01', '2026-08-01')).json()).toEqual([])
  })

  it('is idempotent: deleting a date with no exception still returns 204', async () => {
    const id = await api.givenResource(aResource())
    expect((await api.deleteException(id, DATE)).statusCode).toBe(204)
    expect((await api.deleteException(id, DATE)).statusCode).toBe(204)
  })

  it('deletes only the named date', async () => {
    const id = await api.givenResource(aResource())
    await api.givenExceptions(id, ['2026-07-19', '2026-07-20'].map(aDayOff))
    await api.deleteException(id, '2026-07-20')

    expect(
      (await api.listExceptions(id, '2026-07-01', '2026-08-01'))
        .json()
        .map((row: { date: string }) => row.date),
    ).toEqual(['2026-07-19'])
  })

  it('returns 404 for an unknown resource', async () => {
    expect((await api.deleteException(unknownUuid(), DATE)).statusCode).toBe(404)
  })
})
