import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { md } from '../../shared/docs.js'
import { PoolRepository } from '../resources/pool.repository.js'
import { PoolService } from '../resources/pool.service.js'
import { ResourceRepository } from '../resources/resource.repository.js'
import { ErrorResponse, ResourceParams } from '../resources/resource.schemas.js'
import { ResourceService } from '../resources/resource.service.js'
import { ScheduleRepository } from './schedule.repository.js'
import { ReplaceScheduleBody, ScheduleResponse } from './schedule.schemas.js'
import { ScheduleService } from './schedule.service.js'

export const scheduleRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const resourceRepository = new ResourceRepository(app.db)
  const service = new ScheduleService(
    new ScheduleRepository(app.db),
    new ResourceService(
      resourceRepository,
      new PoolService(resourceRepository, new PoolRepository(app.db)),
    ),
  )

  app.get(
    '/resources/:id/schedule',
    {
      config: { scope: 'schedule.read' },
      schema: {
        tags: ['Schedule'],
        summary: 'Read the weekly schedule',
        description: 'Rules ordered by weekday, then by start time.',
        params: ResourceParams,
        response: { 200: ScheduleResponse, 404: ErrorResponse },
      },
    },
    async (request) => service.list(request.tenantId, request.params.id),
  )

  app.put(
    '/resources/:id/schedule',
    {
      config: { scope: 'schedule.write' },
      schema: {
        tags: ['Schedule'],
        summary: 'Replace the weekly schedule',
        description: md(
          'Replaces the whole schedule in one transaction. An empty array is valid and means "never available". A rejected submission writes nothing, so the previous schedule survives intact.',
          'Weekdays are **Monday = 0, Sunday = 6**.',
          'Three rules are checked across the whole set:',
          [
            '**Shape matches the duration** — a day-based resource takes null times, at most one rule per weekday; an intraday resource requires both times.',
            '**No overlap on a weekday** — touching endpoints are fine, so 09:00–12:00 and 12:00–17:00 are two windows rather than a clash.',
            '**`start_time` precedes `end_time`** — a window crossing midnight is refused; express 22:00–02:00 as two rules on adjacent days.',
          ],
        ),
        params: ResourceParams,
        body: ReplaceScheduleBody,
        response: { 200: ScheduleResponse, 400: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (request) => service.replace(request.tenantId, request.params.id, request.body),
  )
}
