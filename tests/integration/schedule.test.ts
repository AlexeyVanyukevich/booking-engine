import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Api } from '../fixtures/api.js'
import { withAuthorization, injectTransport } from '../fixtures/transport.js'
import { unknownUuid } from '../fixtures/ids.js'
import { aDayBasedResource, aResource } from '../fixtures/resources.js'
import { WEEKDAYS, aWindow, everyDay, windowsOn } from '../fixtures/schedules.js'
import {
  acceptedSchedules,
  malformedSchedules,
  nonArrayScheduleBodies,
  rejectedSchedules,
} from '../fixtures/datasets/schedule-validation.js'
import { buildTestApp, closeTestDb, resetDbWithTenant, testAuthorization } from './helpers.js'
import type { ErrorResponse, ScheduleResponse } from '../fixtures/bodies.js'

let app: FastifyInstance
let api: Api
let close: () => Promise<void>

beforeAll(async () => {
  app = await buildTestApp()
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

describe('PUT /resources/:id/schedule', () => {
  it.each(acceptedSchedules)('accepts $name', async ({ kind, rules }) => {
    const id = await api.givenResource(resourceFor(kind))
    const response = await api.putSchedule(id, rules)
    expect(response.statusCode).toBe(200)
    expect(response.json<ScheduleResponse>()).toHaveLength(rules.length)
  })

  it.each(acceptedSchedules)('persists $name', async ({ kind, rules }) => {
    const id = await api.givenResource(resourceFor(kind))
    await api.putSchedule(id, rules)
    const listed = await api.getSchedule(id)
    expect(listed.json<ScheduleResponse>()).toHaveLength(rules.length)
  })

  it.each(rejectedSchedules)(
    'rejects $name with $expectedError',
    async ({ kind, rules, expectedError }) => {
      const id = await api.givenResource(resourceFor(kind))
      const response = await api.putSchedule(id, rules)
      expect(response.statusCode).toBe(400)
      expect(response.json<ErrorResponse>().error).toBe(expectedError)
    },
  )

  it.each(rejectedSchedules)(
    'leaves the previous schedule intact after rejecting $name',
    async ({ kind, rules }) => {
      const id = await api.givenResource(resourceFor(kind))
      const original =
        kind === 'day' ? everyDay().slice(0, 1) : [aWindow(WEEKDAYS.monday, '09:00', '17:00')]
      await api.givenSchedule(id, original)

      await api.putSchedule(id, rules)

      const listed = await api.getSchedule(id)
      expect(listed.json<ScheduleResponse>()).toHaveLength(1)
      expect(listed.json<ScheduleResponse>()[0]).toMatchObject({ day_of_week: WEEKDAYS.monday })
    },
  )

  it.each(malformedSchedules)('rejects $name before any business rule runs', async ({ rules }) => {
    const id = await api.givenResource(aResource())
    const response = await api.putSchedule(id, rules)
    expect(response.statusCode).toBe(400)
    expect(response.json<ErrorResponse>().error).toBe('validation_error')
  })

  it.each(nonArrayScheduleBodies)('rejects a JSON body that is $name', async ({ body }) => {
    const id = await api.givenResource(aResource())
    const response = await api.putScheduleJson(id, body)
    expect(response.statusCode).toBe(400)
    expect(response.json<ErrorResponse>().error).toBe('validation_error')
  })

  it('answers a body sent with the wrong content type as a client error, not a server one', async () => {
    const id = await api.givenResource(aResource())
    const response = await app.inject({
      method: 'PUT',
      url: `/resources/${id}/schedule`,
      headers: { 'content-type': 'text/plain' },
      payload: 'monday 09:00-17:00',
    })

    // Fastify raises this before the handler runs. The status it picks is its own business;
    // what matters is that a caller's mistake never surfaces as internal_error.
    expect(response.statusCode).toBeGreaterThanOrEqual(400)
    expect(response.statusCode).toBeLessThan(500)
    expect(response.json().error).not.toBe('internal_error')
    expect(
      Object.keys(response.json()).every((key) => ['error', 'message', 'details'].includes(key)),
    ).toBe(true)
  })

  it('replaces the previous schedule rather than adding to it', async () => {
    const id = await api.givenResource(aResource())
    await api.givenSchedule(id, [aWindow(WEEKDAYS.monday, '09:00', '17:00')])
    await api.givenSchedule(id, [aWindow(WEEKDAYS.thursday, '10:00', '14:00')])

    const listed = await api.getSchedule(id)
    expect(listed.json<ScheduleResponse>()).toHaveLength(1)
    expect(listed.json<ScheduleResponse>()[0]).toMatchObject({ day_of_week: WEEKDAYS.thursday })
  })

  it('clears the schedule when given an empty array', async () => {
    const id = await api.givenResource(aResource())
    await api.givenSchedule(id, windowsOn([0, 1, 2], '09:00', '17:00'))
    await api.givenSchedule(id, [])
    expect((await api.getSchedule(id)).json<ScheduleResponse>()).toEqual([])
  })

  it('assigns a fresh id to every rule on replacement', async () => {
    const id = await api.givenResource(aResource())
    await api.givenSchedule(id, [aWindow(WEEKDAYS.monday, '09:00', '17:00')])
    const first = (await api.getSchedule(id)).json<ScheduleResponse>()[0]?.id
    await api.givenSchedule(id, [aWindow(WEEKDAYS.monday, '09:00', '17:00')])
    const second = (await api.getSchedule(id)).json<ScheduleResponse>()[0]?.id
    expect(second).not.toBe(first)
  })

  it('keeps schedules of different resources separate', async () => {
    const first = await api.givenResource(aResource())
    const second = await api.givenResource(aResource())
    await api.givenSchedule(first, [aWindow(WEEKDAYS.monday, '09:00', '17:00')])

    expect((await api.getSchedule(second)).json<ScheduleResponse>()).toEqual([])
  })

  it('returns 404 for an unknown resource', async () => {
    expect((await api.putSchedule(unknownUuid(), [])).statusCode).toBe(404)
  })
})

describe('GET /resources/:id/schedule', () => {
  it('returns an empty list for a resource without a schedule', async () => {
    const id = await api.givenResource(aResource())
    const response = await api.getSchedule(id)
    expect(response.statusCode).toBe(200)
    expect(response.json<ScheduleResponse>()).toEqual([])
  })

  it('returns rules ordered by weekday and then start time', async () => {
    const id = await api.givenResource(aResource())
    await api.givenSchedule(id, [
      aWindow(WEEKDAYS.wednesday, '14:00', '17:00'),
      aWindow(WEEKDAYS.monday, '14:00', '17:00'),
      aWindow(WEEKDAYS.monday, '09:00', '12:00'),
    ])

    expect(
      (await api.getSchedule(id))
        .json<ScheduleResponse>()
        .map((rule) => [rule.day_of_week, rule.start_time]),
    ).toEqual([
      [WEEKDAYS.monday, '09:00'],
      [WEEKDAYS.monday, '14:00'],
      [WEEKDAYS.wednesday, '14:00'],
    ])
  })

  it('reports times as HH:MM rather than the stored HH:MM:SS', async () => {
    const id = await api.givenResource(aResource())
    await api.givenSchedule(id, [aWindow(WEEKDAYS.monday, '09:00', '17:00')])
    expect((await api.getSchedule(id)).json<ScheduleResponse>()[0]).toMatchObject({
      start_time: '09:00',
      end_time: '17:00',
    })
  })

  it('reports null times for a day-based resource', async () => {
    const id = await api.givenResource(aDayBasedResource())
    await api.givenSchedule(id, everyDay())
    const rules = (await api.getSchedule(id)).json<ScheduleResponse>()
    expect(rules).toHaveLength(7)
    for (const rule of rules) {
      expect(rule.start_time).toBeNull()
      expect(rule.end_time).toBeNull()
    }
  })

  it('returns 404 for an unknown resource', async () => {
    expect((await api.getSchedule(unknownUuid())).statusCode).toBe(404)
  })
})
