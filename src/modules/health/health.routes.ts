import { Type } from 'typebox'
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'

/**
 * A plugin rather than a bare `app.get` on the root instance: routes added directly are
 * registered before deferred plugins load, so the OpenAPI generator's onRoute hook would
 * never see them and `/health` would be missing from the documentation.
 */
export const healthRoutes: FastifyPluginAsyncTypebox = async (app) => {
  // The root serves no resource, so it used to answer with the uniform 404 — technically
  // correct and useless to a person who has just started the engine and opened it in a
  // browser. Send them to the API reference instead. Hidden from the documentation: it is
  // navigation, not part of the contract.
  app.get('/', { config: { public: true }, schema: { hide: true } }, async (_request, reply) =>
    reply.redirect('/docs'),
  )

  app.get(
    '/health',
    {
      config: { public: true },
      schema: {
        tags: ['Health'],
        summary: 'Liveness probe',
        description:
          'Reports that the process is alive. It does **not** check the database — an engine that cannot reach Postgres still answers 200 here, so do not use this as a readiness probe.',
        response: {
          200: Type.Object({ status: Type.String() }, { examples: [{ status: 'ok' }] }),
        },
      },
    },
    async () => ({ status: 'ok' }),
  )
}
