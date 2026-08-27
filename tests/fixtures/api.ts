import type { ResourcePayload } from './resources.js'
import type { ExceptionInput, ScheduleRule } from './schedules.js'
import type { Transport } from './transport.js'

/**
 * A thin client over a transport, so callers describe intent rather than repeating URLs and
 * method names. Every method returns the raw response: assertions about status codes and
 * error shapes belong in the caller, not here.
 *
 * The transport is injected so the same client — and therefore the same datasets — drives
 * both the in-process integration tests and the smoke run against a live engine.
 */
export class Api {
  constructor(private readonly send: Transport) {}

  /**
   * An escape hatch for cases that are about the transport rather than about an endpoint —
   * an unmatched path, a method a route does not serve. It still goes through the transport,
   * so it carries the same credentials as every other call.
   */
  request(request: Parameters<Transport>[0]) {
    return this.send(request)
  }

  createResource(payload: ResourcePayload | Record<string, unknown>) {
    return this.send({ method: 'POST', url: '/resources', payload })
  }

  getResource(id: string) {
    return this.send({ method: 'GET', url: `/resources/${id}` })
  }

  listResources(query = '') {
    return this.send({ method: 'GET', url: `/resources${query === '' ? '' : `?${query}`}` })
  }

  patchResource(id: string, payload: Record<string, unknown>) {
    return this.send({ method: 'PATCH', url: `/resources/${id}`, payload })
  }

  deleteResource(id: string) {
    return this.send({ method: 'DELETE', url: `/resources/${id}` })
  }

  getSchedule(id: string) {
    return this.send({ method: 'GET', url: `/resources/${id}/schedule` })
  }

  putSchedule(id: string, rules: ScheduleRule[] | unknown[]) {
    return this.send({ method: 'PUT', url: `/resources/${id}/schedule`, payload: rules })
  }

  /**
   * Sends an arbitrary body as JSON. A raw string payload would otherwise be treated as a
   * non-JSON body, exercising content-type handling rather than schema validation.
   */
  putScheduleJson(id: string, body: unknown) {
    return this.send({
      method: 'PUT',
      url: `/resources/${id}/schedule`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    })
  }

  listExceptions(id: string, from: string, to: string) {
    return this.listExceptionsWithQuery(id, `?from=${from}&to=${to}`)
  }

  /** Escape hatch for cases that must send an incomplete or malformed query string. */
  listExceptionsWithQuery(id: string, query: string) {
    return this.send({ method: 'GET', url: `/resources/${id}/exceptions${query}` })
  }

  putException(
    id: string,
    exception: ExceptionInput | ({ date: string } & Record<string, unknown>),
  ): ReturnType<Transport>
  putException(
    id: string,
    date: string,
    body: { start_time: string | null; end_time: string | null },
  ): ReturnType<Transport>
  putException(
    id: string,
    dateOrException: string | (ExceptionInput | ({ date: string } & Record<string, unknown>)),
    body?: { start_time: string | null; end_time: string | null },
  ) {
    if (typeof dateOrException === 'string') {
      return this.send({
        method: 'PUT',
        url: `/resources/${id}/exceptions/${dateOrException}`,
        payload: body,
      })
    }
    const { date, ...rest } = dateOrException
    return this.send({ method: 'PUT', url: `/resources/${id}/exceptions/${date}`, payload: rest })
  }

  deleteException(id: string, date: string) {
    return this.send({ method: 'DELETE', url: `/resources/${id}/exceptions/${date}` })
  }

  getAvailability(id: string, from: string, to: string) {
    return this.send({
      method: 'GET',
      url: `/resources/${id}/availability?from=${from}&to=${to}`,
    })
  }

  health() {
    return this.send({ method: 'GET', url: '/health' })
  }

  createBooking(resourceId: string, payload: Record<string, unknown>) {
    return this.send({ method: 'POST', url: `/resources/${resourceId}/bookings`, payload })
  }

  getBooking(id: string) {
    return this.send({ method: 'GET', url: `/bookings/${id}` })
  }

  bookingAction(id: string, action: 'confirm' | 'cancel' | 'complete' | 'no-show') {
    return this.send({ method: 'POST', url: `/bookings/${id}/${action}` })
  }

  rescheduleBooking(id: string, payload: Record<string, unknown>) {
    return this.send({ method: 'POST', url: `/bookings/${id}/reschedule`, payload })
  }

  listResourceBookings(resourceId: string, query: string) {
    return this.send({ method: 'GET', url: `/resources/${resourceId}/bookings${query}` })
  }

  listCustomerBookings(query: string) {
    return this.send({ method: 'GET', url: `/bookings${query}` })
  }

  /** Creates a resource and returns its id, failing loudly if creation was rejected. */
  async givenResource(payload: ResourcePayload): Promise<string> {
    const response = await this.createResource(payload)
    if (response.statusCode !== 201) {
      throw new Error(
        `Fixture setup failed: expected 201, got ${response.statusCode} ${response.body}`,
      )
    }
    return response.json().id as string
  }

  /** Installs a schedule, failing loudly if it was rejected. */
  async givenSchedule(id: string, rules: ScheduleRule[]): Promise<void> {
    const response = await this.putSchedule(id, rules)
    if (response.statusCode !== 200) {
      throw new Error(
        `Fixture setup failed: expected 200, got ${response.statusCode} ${response.body}`,
      )
    }
  }

  async givenExceptions(id: string, exceptions: ExceptionInput[]): Promise<void> {
    for (const exception of exceptions) {
      const response = await this.putException(id, exception)
      if (response.statusCode !== 200) {
        throw new Error(
          `Fixture setup failed: expected 200, got ${response.statusCode} ${response.body}`,
        )
      }
    }
  }

  /** Creates a booking and returns its id, failing loudly if it was rejected. */
  async givenBooking(resourceId: string, payload: Record<string, unknown>): Promise<string> {
    const response = await this.createBooking(resourceId, payload)
    if (response.statusCode !== 201) {
      throw new Error(
        `Fixture setup failed: expected 201, got ${response.statusCode} ${response.body}`,
      )
    }
    return response.json().id as string
  }
}
