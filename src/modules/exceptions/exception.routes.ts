import { Type } from 'typebox'
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { md } from '../../shared/docs.js'
import { PoolService } from '../resources/pool.service.js'
import { ResourceRepository } from '../resources/resource.repository.js'
import { ErrorResponse, ResourceParams } from '../resources/resource.schemas.js'
import { ResourceService } from '../resources/resource.service.js'
import { ExceptionRepository } from './exception.repository.js'
import {
  ExceptionListResponse,
  ExceptionParams,
  ExceptionRangeQuery,
  ExceptionResponse,
  PutExceptionBody,
} from './exception.schemas.js'
import { ExceptionService } from './exception.service.js'

export const exceptionRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const resourceRepository = new ResourceRepository(app.db)
  const service = new ExceptionService(
    new ExceptionRepository(app.db),
    new ResourceService(resourceRepository, new PoolService(resourceRepository)),
    app.config.maxRangeDays,
  )

  app.get(
    '/resources/:id/exceptions',
    {
      config: { scope: 'schedule.read' },
      schema: {
        tags: ['Exceptions'],
        summary: 'List exceptions in a date range',
        description:
          'The range is half-open: `from` inclusive, `to` exclusive. Both are required, and the span is capped at `MAX_RANGE_DAYS`.',
        params: ResourceParams,
        querystring: ExceptionRangeQuery,
        response: { 200: ExceptionListResponse, 400: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (request) =>
      service.list(request.tenantId, request.params.id, request.query.from, request.query.to),
  )

  app.put(
    '/resources/:id/exceptions/:date',
    {
      config: { scope: 'schedule.write' },
      schema: {
        tags: ['Exceptions'],
        summary: 'Create or overwrite the exception for a date',
        description: md(
          'Idempotent — the date is the key, so repeating the call overwrites rather than accumulating.',
          'An exception **replaces** the weekly schedule for its date entirely; it never merges with it.',
          'Both times `null` means a day off, valid for any resource. Altered hours only make sense on an intraday resource — a day-based one has no hours to alter, and the attempt is rejected.',
        ),
        params: ExceptionParams,
        body: PutExceptionBody,
        response: { 200: ExceptionResponse, 400: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (request) =>
      service.put(request.tenantId, request.params.id, request.params.date, request.body),
  )

  app.delete(
    '/resources/:id/exceptions/:date',
    {
      config: { scope: 'schedule.write' },
      schema: {
        tags: ['Exceptions'],
        summary: 'Remove the exception for a date',
        description:
          'Idempotent: a date with no exception also returns 204, matching the idempotent PUT.',
        params: ExceptionParams,
        response: { 204: Type.Null(), 404: ErrorResponse },
      },
    },
    async (request, reply) => {
      await service.delete(request.tenantId, request.params.id, request.params.date)
      return reply.status(204).send(null)
    },
  )
}
