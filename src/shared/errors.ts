import type { FastifyError, FastifyInstance } from 'fastify'

export abstract class AppError extends Error {
  abstract readonly statusCode: number
  abstract readonly code: string
  readonly details?: Record<string, unknown>

  constructor(message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = new.target.name
    this.details = details
  }
}

export class ValidationError extends AppError {
  readonly statusCode = 400
  readonly code = 'validation_error'
}

export class InvalidRangeError extends AppError {
  readonly statusCode = 400
  readonly code = 'invalid_range'
}

export class ScheduleOverlapError extends AppError {
  readonly statusCode = 400
  readonly code = 'schedule_overlap'
}

export class ScheduleShapeMismatchError extends AppError {
  readonly statusCode = 400
  readonly code = 'schedule_shape_mismatch'
}

export class UnsupportedConcurrencyModeError extends AppError {
  readonly statusCode = 400
  readonly code = 'unsupported_concurrency_mode'
}

export class NotFoundError extends AppError {
  readonly statusCode = 404
  readonly code = 'not_found'
}

const CLIENT_ERROR_CODES: Record<number, string> = {
  400: 'validation_error',
  404: 'not_found',
  405: 'method_not_allowed',
  406: 'not_acceptable',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
}

function clientErrorCode(statusCode: number): string {
  return CLIENT_ERROR_CODES[statusCode] ?? 'bad_request'
}

export function registerErrorHandler(app: FastifyInstance): void {
  // The parameter is annotated because the type provider widens it to `unknown`.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof AppError) {
      void reply.status(error.statusCode).send({
        error: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      })
      return
    }

    // Fastify's own schema validation failures, translated into our shape.
    if (error.validation) {
      void reply.status(400).send({
        error: 'validation_error',
        message: error.message,
        details: { issues: error.validation },
      })
      return
    }

    // Fastify raises its own 4xx for things the route never sees — an unsupported
    // content type, an unparseable JSON body, an oversized payload. Those are the
    // caller's mistakes and must not be reported as server failures.
    if (typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
      void reply
        .status(error.statusCode)
        .send({ error: clientErrorCode(error.statusCode), message: error.message })
      return
    }

    // Anything unexpected: log with the stack, reveal nothing. Database structure must
    // never reach the client through error text.
    request.log.error({ err: error }, 'unhandled error')
    void reply.status(500).send({ error: 'internal_error', message: 'Internal server error' })
  })

  app.setNotFoundHandler((_request, reply) => {
    void reply.status(404).send({ error: 'not_found', message: 'Route not found' })
  })
}
