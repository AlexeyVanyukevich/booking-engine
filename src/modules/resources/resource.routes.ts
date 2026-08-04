import { Type } from 'typebox'
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { md } from '../../shared/docs.js'
import { ResourceRepository } from './resource.repository.js'
import {
  CreateResourceBody,
  ErrorResponse,
  ResourceParams,
  ResourceResponse,
  UpdateResourceBody,
} from './resource.schemas.js'
import { ResourceService } from './resource.service.js'

export const resourceRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const service = new ResourceService(new ResourceRepository(app.db))

  app.post(
    '/resources',
    {
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
    async (request, reply) => reply.status(201).send(await service.create(request.body)),
  )

  app.get(
    '/resources/:id',
    {
      schema: {
        tags: ['Resources'],
        summary: 'Read a resource',
        params: ResourceParams,
        response: { 200: ResourceResponse, 404: ErrorResponse },
      },
    },
    async (request) => service.getById(request.params.id),
  )

  app.patch(
    '/resources/:id',
    {
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
    async (request) => service.update(request.params.id, request.body),
  )

  app.delete(
    '/resources/:id',
    {
      schema: {
        tags: ['Resources'],
        summary: 'Delete a resource',
        description:
          'A hard delete that cascades to the schedule and the exceptions. `is_active: false` already covers soft-disable, so this means what it says.',
        params: ResourceParams,
        response: { 204: Type.Null(), 404: ErrorResponse },
      },
    },
    async (request, reply) => {
      await service.delete(request.params.id)
      return reply.status(204).send(null)
    },
  )
}
