import { ScheduleShapeMismatchError, ValidationError } from '../../shared/errors.js'
import { assertValidRange } from '../../shared/range.js'
import { formatTime, parseSlotDuration } from '../../shared/time.js'
import type { ResourceService } from '../resources/resource.service.js'
import type { ExceptionRepository, ExceptionRow } from './exception.repository.js'
import type { ExceptionResponse, PutExceptionBody } from './exception.schemas.js'

function toMinutes(time: string): number {
  const [hours, minutes] = time.split(':')
  return Number(hours) * 60 + Number(minutes)
}

function toResponse(row: ExceptionRow): ExceptionResponse {
  return {
    id: row.id,
    date: row.date,
    start_time: row.start_time === null ? null : formatTime(row.start_time),
    end_time: row.end_time === null ? null : formatTime(row.end_time),
  }
}

export class ExceptionService {
  constructor(
    private readonly repository: ExceptionRepository,
    private readonly resources: ResourceService,
    private readonly maxRangeDays: number,
  ) {}

  async list(resourceId: string, from: string, to: string): Promise<ExceptionResponse[]> {
    await this.resources.loadOrFail(resourceId)
    assertValidRange(from, to, this.maxRangeDays)
    const rows = await this.repository.listInRange(resourceId, from, to)
    return rows.map(toResponse)
  }

  async put(resourceId: string, date: string, body: PutExceptionBody): Promise<ExceptionResponse> {
    const resource = await this.resources.loadOrFail(resourceId)
    const duration = parseSlotDuration(resource.slot_duration)

    const bothNull = body.start_time === null && body.end_time === null
    const bothSet = body.start_time !== null && body.end_time !== null

    if (!bothNull && !bothSet) {
      throw new ValidationError(
        'start_time and end_time must both be set (altered hours) or both be null (day off)',
      )
    }

    // A day off is expressible for any resource; altered hours must match its shape.
    if (bothSet && duration.kind === 'day') {
      throw new ScheduleShapeMismatchError(
        'A day-based resource (P<n>D) only accepts exceptions with null times, meaning a day off',
      )
    }

    if (body.start_time !== null && body.end_time !== null) {
      if (toMinutes(body.start_time) >= toMinutes(body.end_time)) {
        throw new ValidationError(
          'start_time must be earlier than end_time; windows crossing midnight are not supported',
        )
      }
    }

    const row = await this.repository.upsert(resourceId, date, body.start_time, body.end_time)
    return toResponse(row)
  }

  /** Idempotent: deleting an exception that does not exist is not an error. */
  async delete(resourceId: string, date: string): Promise<void> {
    await this.resources.loadOrFail(resourceId)
    await this.repository.delete(resourceId, date)
  }
}
