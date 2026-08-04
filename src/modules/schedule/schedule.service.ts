import {
  ScheduleOverlapError,
  ScheduleShapeMismatchError,
  ValidationError,
} from '../../shared/errors.js'
import { formatTime, parseSlotDuration, type SlotDuration } from '../../shared/time.js'
import type { ResourceService } from '../resources/resource.service.js'
import type { ScheduleRepository, ScheduleRow } from './schedule.repository.js'
import type { ScheduleRuleInput, ScheduleRuleResponse } from './schedule.schemas.js'

function toMinutes(time: string): number {
  const [hours, minutes] = time.split(':')
  return Number(hours) * 60 + Number(minutes)
}

/**
 * Validates the submitted set as a whole. Per-row invariants are also enforced by CHECK
 * constraints in the database; the rules that span rows — overlap and shape consistency —
 * can only live here.
 */
export function validateScheduleSet(rules: ScheduleRuleInput[], duration: SlotDuration): void {
  for (const rule of rules) {
    const bothNull = rule.start_time === null && rule.end_time === null
    const bothSet = rule.start_time !== null && rule.end_time !== null

    if (!bothNull && !bothSet) {
      throw new ValidationError('start_time and end_time must both be set or both be null', {
        day_of_week: rule.day_of_week,
      })
    }

    if (duration.kind === 'day' && !bothNull) {
      throw new ScheduleShapeMismatchError(
        'A day-based resource (P<n>D) requires schedule rules with null times',
        { day_of_week: rule.day_of_week },
      )
    }

    if (duration.kind === 'intraday' && !bothSet) {
      throw new ScheduleShapeMismatchError(
        'An intraday resource (PT…) requires schedule rules with both times set',
        { day_of_week: rule.day_of_week },
      )
    }

    if (rule.start_time !== null && rule.end_time !== null) {
      if (toMinutes(rule.start_time) >= toMinutes(rule.end_time)) {
        throw new ValidationError(
          'start_time must be earlier than end_time; windows crossing midnight are not supported',
          { day_of_week: rule.day_of_week },
        )
      }
    }
  }

  const byDay = new Map<number, ScheduleRuleInput[]>()
  for (const rule of rules) {
    const bucket = byDay.get(rule.day_of_week) ?? []
    bucket.push(rule)
    byDay.set(rule.day_of_week, bucket)
  }

  for (const [day, bucket] of byDay) {
    if (duration.kind === 'day' && bucket.length > 1) {
      throw new ScheduleShapeMismatchError(
        'A day-based resource allows at most one schedule rule per weekday',
        { day_of_week: day },
      )
    }

    const sorted = bucket
      .filter(
        (rule): rule is ScheduleRuleInput & { start_time: string; end_time: string } =>
          rule.start_time !== null && rule.end_time !== null,
      )
      .map((rule) => ({ start: toMinutes(rule.start_time), end: toMinutes(rule.end_time) }))
      .sort((a, b) => a.start - b.start)

    for (let i = 1; i < sorted.length; i += 1) {
      // Touching endpoints are fine: 09:00–12:00 and 12:00–17:00 do not overlap.
      if (sorted[i]!.start < sorted[i - 1]!.end) {
        throw new ScheduleOverlapError('Schedule rules on the same weekday must not overlap', {
          day_of_week: day,
        })
      }
    }
  }
}

export function toScheduleResponse(row: ScheduleRow): ScheduleRuleResponse {
  return {
    id: row.id,
    day_of_week: row.day_of_week,
    start_time: row.start_time === null ? null : formatTime(row.start_time),
    end_time: row.end_time === null ? null : formatTime(row.end_time),
  }
}

export class ScheduleService {
  constructor(
    private readonly repository: ScheduleRepository,
    private readonly resources: ResourceService,
  ) {}

  async list(resourceId: string): Promise<ScheduleRuleResponse[]> {
    await this.resources.loadOrFail(resourceId)
    const rows = await this.repository.listByResource(resourceId)
    return rows.map(toScheduleResponse)
  }

  async replace(resourceId: string, rules: ScheduleRuleInput[]): Promise<ScheduleRuleResponse[]> {
    const resource = await this.resources.loadOrFail(resourceId)
    validateScheduleSet(rules, parseSlotDuration(resource.slot_duration))
    const rows = await this.repository.replaceForResource(resourceId, rules)
    return rows.map(toScheduleResponse)
  }
}
