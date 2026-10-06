import type { FastifyError, FastifyInstance } from 'fastify'

/** What the OpenAPI document shows for a code. Illustration: never compared with real throws. */
export interface ErrorExample {
  message: string
  details?: Record<string, unknown>
}

/** A code as the documentation describes it — the error table and the OpenAPI document both read this. */
export interface ErrorDescription {
  code: string
  meaning: string
  example: ErrorExample
}

export abstract class AppError extends Error {
  abstract readonly statusCode: number
  abstract readonly code: string
  /** One line, Markdown allowed. The error table in `docs/conventions.md` is asserted equal to it. */
  abstract readonly meaning: string
  abstract readonly example: ErrorExample
  readonly details?: Record<string, unknown> | undefined
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
  readonly meaning = 'Body, query or path failed validation'
  readonly example: ErrorExample = {
    message: 'Unknown IANA timezone "Mars/Olympus"',
    details: { field: 'timezone' },
  }
}

export class InvalidRangeError extends AppError {
  readonly statusCode = 400
  readonly code = 'invalid_range'
  readonly meaning = '`to <= from`, or wider than `MAX_RANGE_DAYS`'
  readonly example: ErrorExample = {
    message: 'to must be after from',
    details: { from: '2026-07-20', to: '2026-07-13' },
  }
}

export class ScheduleOverlapError extends AppError {
  readonly statusCode = 400
  readonly code = 'schedule_overlap'
  readonly meaning = 'Two rules on one weekday overlap'
  readonly example: ErrorExample = {
    message: 'Schedule rules on the same weekday must not overlap',
    details: { day_of_week: 0 },
  }
}

export class ScheduleShapeMismatchError extends AppError {
  readonly statusCode = 400
  readonly code = 'schedule_shape_mismatch'
  readonly meaning = 'Rule shape does not match the slot duration'
  readonly example: ErrorExample = {
    message: 'A day-based resource (P<n>D) requires schedule rules with null times',
    details: { day_of_week: 0 },
  }
}

export class UnsupportedConcurrencyModeError extends AppError {
  readonly statusCode = 400
  readonly code = 'unsupported_concurrency_mode'
  readonly meaning =
    'A booking reached the write path carrying `pool`; selection should have chosen a member'
  readonly example: ErrorExample = {
    message: 'A booking row reached the write path carrying concurrency_mode "pool"',
    details: { concurrency_mode: 'pool' },
  }
}

export class NotFoundError extends AppError {
  readonly statusCode = 404
  readonly code = 'not_found'
  readonly meaning = 'No such resource or booking, or no such route'
  readonly example: ErrorExample = {
    message: 'Resource 6f1c2b9e-4a63-4e0b-9a51-2d3c4b5a6e7f not found',
  }
}

/**
 * Every authentication failure answers this, whatever went wrong: no header, a malformed key,
 * an unknown prefix, a wrong secret, a revoked key, an inactive tenant. A caller learns that
 * the key did not work and never which step rejected it — distinguishing "no such key" from
 * "wrong secret" would turn prefix enumeration into a usable probe.
 */
export class UnauthorizedError extends AppError {
  readonly statusCode = 401
  readonly code = 'unauthorized'
  readonly meaning = 'Missing, malformed, unknown or revoked key; inactive tenant'
  readonly example: ErrorExample = { message: 'A valid API key is required' }
  readonly headers = { 'www-authenticate': 'Bearer' }
}

/** A valid key that does not hold the scope the route requires. `details` names it. */
export class ForbiddenScopeError extends AppError {
  readonly statusCode = 403
  readonly code = 'forbidden_scope'
  readonly meaning = 'Valid key, but it does not hold the scope the route requires'
  readonly example: ErrorExample = {
    message: 'This key does not hold bookings.read',
    details: { required: 'bookings.read' },
  }
}

/** A console write whose `Origin` is not the console itself. */
export class ForbiddenOriginError extends AppError {
  readonly statusCode = 403
  readonly code = 'forbidden_origin'
  readonly meaning = 'A console write whose `Origin` is not the console itself'
  readonly example: ErrorExample = { message: 'This request did not come from the console' }
}

export class InvalidIntervalError extends AppError {
  readonly statusCode = 400
  readonly code = 'invalid_interval'
  readonly meaning = '`end_time <= start_time`'
  readonly example: ErrorExample = {
    message: 'end_time must be after start_time',
    details: { start_time: '2026-07-20T10:00:00+02:00', end_time: '2026-07-20T09:00:00+02:00' },
  }
}

export class InvalidSlotBoundaryError extends AppError {
  readonly statusCode = 400
  readonly code = 'invalid_slot_boundary'
  readonly meaning = 'Start or end does not fall on a slot boundary'
  readonly example: ErrorExample = {
    message: 'start_time and end_time must fall on slot boundaries offered by this resource',
    details: { start_time: '2026-07-20T09:15:00+02:00', end_time: '2026-07-20T10:00:00+02:00' },
  }
}

export class OutsideScheduleError extends AppError {
  readonly statusCode = 400
  readonly code = 'outside_schedule'
  readonly meaning = 'A slot in the requested run is not offered'
  readonly example: ErrorExample = {
    message: 'The requested interval is not a contiguous run of slots this resource offers',
    details: { start_time: '2026-07-20T16:00:00+02:00', end_time: '2026-07-20T18:00:00+02:00' },
  }
}

/** The slots exist and are offered, but capacity for them is already taken. */
export class SlotUnavailableError extends AppError {
  readonly statusCode = 409
  readonly code = 'slot_unavailable'
  readonly meaning = 'The slots exist and are offered, but capacity is taken'
  readonly example: ErrorExample = {
    message: 'Those slots are offered, but they are already taken',
    details: { start_time: '2026-07-20T09:00:00+02:00', end_time: '2026-07-20T10:00:00+02:00' },
  }
}

export class ResourceInactiveError extends AppError {
  readonly statusCode = 409
  readonly code = 'resource_inactive'
  readonly meaning = 'The resource exists but `is_active` is false'
  readonly example: ErrorExample = {
    message: 'Resource 6f1c2b9e-4a63-4e0b-9a51-2d3c4b5a6e7f is not active and cannot be booked',
    details: { resource_id: '6f1c2b9e-4a63-4e0b-9a51-2d3c4b5a6e7f' },
  }
}

export class InvalidStateTransitionError extends AppError {
  readonly statusCode = 409
  readonly code = 'invalid_state_transition'
  readonly meaning = 'The requested transition is not legal from the current status'
  readonly example: ErrorExample = {
    message: 'A booking in status "cancelled" cannot become "confirmed"',
    details: { status: 'cancelled', requested: 'confirmed' },
  }
}

export class ResourceHasBookingsError extends AppError {
  readonly statusCode = 409
  readonly code = 'resource_has_bookings'
  readonly meaning = '`DELETE /resources/:id` with bookings on record'
  readonly example: ErrorExample = {
    message:
      'Resource 6f1c2b9e-4a63-4e0b-9a51-2d3c4b5a6e7f has bookings on record and cannot be deleted; set is_active to false to retire it instead',
    details: { resource_id: '6f1c2b9e-4a63-4e0b-9a51-2d3c4b5a6e7f' },
  }
}

/** A `pool_id` write that breaks one of the four membership rules. `details.rule` names which. */
export class InvalidPoolMembershipError extends AppError {
  readonly statusCode = 400
  readonly code = 'invalid_pool_membership'
  readonly meaning = '`pool_id` names a non-pool, a pool, or a resource on a different grid'
  readonly example: ErrorExample = {
    message: 'No pool 6f1c2b9e-4a63-4e0b-9a51-2d3c4b5a6e7f in this tenant',
    details: { rule: 'tenant', pool_id: '6f1c2b9e-4a63-4e0b-9a51-2d3c4b5a6e7f' },
  }
}

/** `DELETE /resources/:id` on a pool whose members have not left it. */
export class PoolHasMembersError extends AppError {
  readonly statusCode = 409
  readonly code = 'pool_has_members'
  readonly meaning = '`DELETE /resources/:id` on a pool whose members have not left'
  readonly example: ErrorExample = {
    message:
      'Pool 6f1c2b9e-4a63-4e0b-9a51-2d3c4b5a6e7f still has members; move them out with PATCH pool_id: null before deleting it',
    details: { pool_id: '6f1c2b9e-4a63-4e0b-9a51-2d3c4b5a6e7f' },
  }
}

export class IdempotencyKeyReusedError extends AppError {
  readonly statusCode = 409
  readonly code = 'idempotency_key_reused'
  readonly meaning = 'Same key, different request body'
  readonly example: ErrorExample = {
    message:
      'That idempotency key was used for a different booking; this is a caller error, not a retry',
  }
}

export class HoldExpiredError extends AppError {
  readonly statusCode = 410
  readonly code = 'hold_expired'
  readonly meaning = '`confirm` on a hold whose `held_until` has passed'
  readonly example: ErrorExample = {
    message: 'That hold expired before it was confirmed',
    details: { status: 'expired' },
  }
}

/**
 * The per-key limit for this minute is used up. The rate-limit plugin in `src/app.ts` throws
 * whatever its `errorResponseBuilder` returns, and returns this, so the refusal is sent like any
 * other engine error. The plugin has already set `retry-after` and `x-ratelimit-*` on the reply,
 * and Fastify's error path keeps them.
 */
export class RateLimitedError extends AppError {
  readonly statusCode = 429
  readonly code = 'rate_limited'
  readonly meaning = 'The per-key limit for this minute is used up; carries `Retry-After`'
  readonly example: ErrorExample = { message: 'Too many requests; slow down and retry' }
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
  readonly meaning = 'Contention rolled the transaction back; retry the request'
  readonly example: ErrorExample = {
    message:
      'The booking could not complete because of concurrent activity on the same rows; retry the request',
  }
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

/** Reads a class's description without throwing it; the probe message is never shown. */
export function describeError(ErrorType: new (message: string) => AppError): ErrorDescription {
  const probe = new ErrorType('probe')
  return { code: probe.code, meaning: probe.meaning, example: probe.example }
}

/**
 * What the framework's own 4xx are translated into, so a caller's mistake never surfaces as
 * `internal_error`. Exported because it is half of what the engine can emit: the error table in
 * `docs/conventions.md` and the OpenAPI document both read this and the `AppError` subclasses
 * together. A framework 400 and 404 reuse the engine's own codes, so they reuse their classes.
 */
export const CLIENT_ERRORS: Record<number, ErrorDescription> = {
  400: describeError(ValidationError),
  404: describeError(NotFoundError),
  405: {
    code: 'method_not_allowed',
    meaning: 'The framework matched the path but not the method',
    example: { message: 'Method Not Allowed' },
  },
  406: {
    code: 'not_acceptable',
    meaning: 'The framework could not satisfy the `Accept` header',
    example: { message: 'Not Acceptable' },
  },
  413: {
    code: 'payload_too_large',
    meaning: "Body beyond Fastify's body limit",
    example: { message: 'Request body is too large' },
  },
  415: {
    code: 'unsupported_media_type',
    meaning: 'Body sent with a content type the route cannot parse',
    example: { message: 'Unsupported Media Type: application/xml' },
  },
}

/** Any other framework 4xx. The one code with no fixed status, hence no row of its own. */
export const FALLBACK_CLIENT_ERROR_CODE = 'bad_request'

export const INTERNAL_ERROR: ErrorDescription = {
  code: 'internal_error',
  meaning: 'Anything unexpected',
  example: { message: 'Internal server error' },
}

function clientErrorCode(statusCode: number): string {
  return CLIENT_ERRORS[statusCode]?.code ?? FALLBACK_CLIENT_ERROR_CODE
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
    void reply
      .status(500)
      .send({ error: INTERNAL_ERROR.code, message: INTERNAL_ERROR.example.message })
  })

  app.setNotFoundHandler((_request, reply) => {
    void reply.status(404).send({ error: 'not_found', message: 'Route not found' })
  })
}
