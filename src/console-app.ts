import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import fastifyFormbody from '@fastify/formbody'
import type { Kysely } from 'kysely'
import type { Config } from './config.js'
import type { Database } from './db/schema.js'
import { errorPage } from './modules/console/console.pages.js'
import { consoleRoutes } from './modules/console/console.routes.js'
import { AppError } from './shared/errors.js'

export interface ConsoleDeps {
  config: Config
  db: Kysely<Database>
}

const HTML = 'text/html; charset=utf-8'

/**
 * The control plane: a separate Fastify instance from `buildApp`, serving a browser rather
 * than a program. They share the database, the configuration loader and the repositories, and
 * nothing else — in particular this one has no API-key authentication, which is only safe
 * because `src/console.ts` binds it to loopback.
 */
export async function buildConsoleApp(deps: ConsoleDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: deps.config.logLevel } })

  app.decorate('db', deps.db)
  app.decorate('config', deps.config)

  await app.register(fastifyFormbody)

  // HTML rather than JSON: a browser is the only client here, and a raw JSON body in the
  // viewport is a worse answer than a page. The data plane's handler is untouched.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof AppError) {
      void reply
        .status(error.statusCode)
        .type(HTML)
        .send(errorPage(error.statusCode, error.message))
      return
    }
    if (typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
      void reply
        .status(error.statusCode)
        .type(HTML)
        .send(errorPage(error.statusCode, error.message))
      return
    }
    request.log.error({ err: error }, 'console error')
    void reply
      .status(500)
      .type(HTML)
      .send(errorPage(500, 'Something went wrong. Check the console log for details.'))
  })

  app.setNotFoundHandler((_request, reply) => {
    void reply.status(404).type(HTML).send(errorPage(404, 'No such page.'))
  })

  await app.register(consoleRoutes)
  return app
}
