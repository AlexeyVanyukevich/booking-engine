import type { FastifyError, FastifyInstance } from 'fastify'

export abstract class AppError extends Error {
  abstract readonly statusCode: number
  abstract readonly code: string
  readonly details?: Record<string, unknown>
  /** Response headers the status code alone cannot express, such as `Retry-After`. */
  readonly headers?: Record<string, string>

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

export class InvalidIntervalError extends AppError {
  readonly statusCode = 400
  readonly code = 'invalid_interval'
}

export class InvalidSlotBoundaryError extends AppError {
  readonly statusCode = 400
  readonly code = 'invalid_slot_boundary'
}

export class OutsideScheduleError extends AppError {
  readonly statusCode = 400
  readonly code = 'outside_schedule'
}

/** The slots exist and are offered, but capacity for them is already taken. */
export class SlotUnavailableError extends AppError {
  readonly statusCode = 409
  readonly code = 'slot_unavailable'
}

export class ResourceInactiveError extends AppError {
  readonly statusCode = 409
  readonly code = 'resource_inactive'
}

export class InvalidStateTransitionError extends AppError {
  readonly statusCode = 409
  readonly code = 'invalid_state_transition'
}

export class ResourceHasBookingsError extends AppError {
  readonly statusCode = 409
  readonly code = 'resource_has_bookings'
}

export class IdempotencyKeyReusedError extends AppError {
  readonly statusCode = 409
  readonly code = 'idempotency_key_reused'
}

export class HoldExpiredError extends AppError {
  readonly statusCode = 410
  readonly code = 'hold_expired'
}

/**
 * The transaction was rolled back by Postgres because of contention, not because anything
 * about the request was wrong. `503` with `Retry-After` is the honest answer: the same request
 * sent again is expected to succeed. `409` would be a lie — it would tell the caller the slots
 * are contested, when in fact the engine never got as far as deciding.
 *
 * There is deliberately no retry loop behind this. The spec rejected retry machinery; this is
 * translation only, so the decision to retry stays with the caller.
 */
export class ConcurrentUpdateError extends AppError {
  readonly statusCode = 503
  readonly code = 'concurrent_update'
  readonly headers = { 'retry-after': '1' }
}

/**
 * Postgres reports a deadlock as SQLSTATE `40P01` and a serialization failure as `40001`.
 * Neither can be prevented outright — lock ordering makes them rare, not impossible — so both
 * are matched by code and translated rather than left to surface as `internal_error`.
 */
export function isSerializationFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = (error as { code?: unknown }).code
  return code === '40P01' || code === '40001'
}

/** Rethrows a contention failure as `ConcurrentUpdateError`, and anything else unchanged. */
export function rethrowContention(error: unknown, what: string): never {
  if (isSerializationFailure(error)) {
    throw new ConcurrentUpdateError(
      `${what} could not complete because of concurrent activity on the same rows; retry the request`,
    )
  }
  throw error
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
      if (error.headers) void reply.headers(error.headers)
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
