import { Type } from 'typebox'
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { md } from '../../shared/docs.js'
import { PoolRepository } from './pool.repository.js'
import { PoolService } from './pool.service.js'
import { ResourceRepository } from './resource.repository.js'
import {
  CreateResourceBody,
  ErrorResponse,
  ResourceListQuery,
  ResourceListResponse,
  ResourceParams,
  ResourceResponse,
  UpdateResourceBody,
} from './resource.schemas.js'
import { ResourceService } from './resource.service.js'

export const resourceRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const repository = new ResourceRepository(app.db)
  const service = new ResourceService(
    repository,
    new PoolService(repository, new PoolRepository(app.db)),
  )

  app.post(
    '/resources',
    {
      config: { scope: 'resources.write' },
      schema: {
        tags: ['Resources'],
        summary: 'Create a resource',
        description: md(
          'Creates a bookable unit. The engine stores only scheduling parameters; anything describing *what* is booked belongs to the domain layer above.',
          '**`slot_duration` decides the kind.** `P1D` or `P7D` make the resource day-based: schedule rules carry null times and each slot runs anchor to anchor. `PT30M` or `PT1H30M` make it intraday: rules carry both times.',
          '**`slot_anchor_time`** is where a day-based day begins — `14:00` for a hotel. On an intraday resource it must stay `00:00`; a different value is rejected rather than ignored.',
          '`concurrency_mode: "pool"` is not implemented yet and is rejected.',
        ),
        body: CreateResourceBody,
        response: { 201: ResourceResponse, 400: ErrorResponse },
      },
    },
    async (request, reply) =>
      reply.status(201).send(await service.create(request.tenantId, request.body)),
  )

  app.get(
    '/resources',
    {
      config: { scope: 'resources.read' },
      schema: {
        tags: ['Resources'],
        summary: 'List resources',
        description: md(
          "Every resource this key's tenant owns, oldest first.",
          'A caller that keeps its own records already knows its ids, so this is not how it finds them. It exists for the console and for reconciling the two sets when they disagree.',
        ),
        querystring: ResourceListQuery,
        response: { 200: ResourceListResponse, 400: ErrorResponse },
      },
    },
    async (request) => service.list(request.tenantId, request.query),
  )

  app.get(
    '/resources/:id',
    {
      config: { scope: 'resources.read' },
      schema: {
        tags: ['Resources'],
        summary: 'Read a resource',
        params: ResourceParams,
        response: { 200: ResourceResponse, 404: ErrorResponse },
      },
    },
    async (request) => service.getById(request.tenantId, request.params.id),
  )

  app.patch(
    '/resources/:id',
    {
      config: { scope: 'resources.write' },
      schema: {
        tags: ['Resources'],
        summary: 'Update the mutable fields of a resource',
        description: md(
          '`timezone` and `concurrency_mode` are absent on purpose — both are immutable. Changing a timezone moves no row, but it reinterprets the schedule: `09:00–17:00` would denote different moments and existing bookings could fall outside working hours.',
          'Unknown fields are rejected rather than ignored, so an attempt to change one of them fails loudly instead of appearing to succeed.',
          'The **resulting state** is validated, not the patch — changing only the duration can invalidate an anchor that was legal before.',
        ),
        params: ResourceParams,
        body: UpdateResourceBody,
        response: { 200: ResourceResponse, 400: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (request) => service.update(request.tenantId, request.params.id, request.body),
  )

  app.delete(
    '/resources/:id',
    {
      config: { scope: 'resources.write' },
      schema: {
        tags: ['Resources'],
        summary: 'Delete a resource',
        description: md(
          'A hard delete that cascades to the schedule and the exceptions.',
          'It is refused with `409 resource_has_bookings` when the resource has bookings in **any** status, terminal ones included: a delete must not discard booking history as a side effect. `is_active: false` is how a resource is retired.',
        ),
        params: ResourceParams,
        response: {
          204: Type.Null(),
          404: ErrorResponse,
          409: ErrorResponse,
          503: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      await service.delete(request.tenantId, request.params.id)
      return reply.status(204).send(null)
    },
  )
}
