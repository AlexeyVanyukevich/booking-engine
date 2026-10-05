import type { SlotDuration } from '../../shared/time.js'
import type { ExceptionRow } from '../exceptions/exception.repository.js'
import type { ScheduleRow } from '../schedule/schedule.repository.js'
import { generateSlots, type Slot } from './slot-generator.js'
import { resolveWindows } from './window-resolver.js'

/** The one grid every member of a pool shares (membership rule 4). */
export interface PoolGrid {
  timezone: string
  slotDuration: SlotDuration
  /** 'HH:MM' */
  anchorTime: string
}

export interface MemberSlotsInput {
  memberIds: string[]
  /** 'YYYY-MM-DD' dates, in the pool's timezone */
  dates: string[]
  grid: PoolGrid
  scheduleRows: Array<ScheduleRow & { resource_id: string }>
  exceptionRows: Array<ExceptionRow & { resource_id: string }>
}

/**
 * Each member's slots over `dates`, on the pool's one grid. Pure, and the one place a pool's
 * members become slots: availability unions the result, booking checks a run against each
 * member's list. The rows arrive batched for every member and are split here.
 */
export function memberSlots(input: MemberSlotsInput): Map<string, Slot[]> {
  const { memberIds, dates, grid } = input
  return new Map(
    memberIds.map((id) => [
      id,
      generateSlots({
        dates,
        windowsByDate: resolveWindows({
          dates,
          timezone: grid.timezone,
          scheduleRows: input.scheduleRows.filter((row) => row.resource_id === id),
          exceptionRows: input.exceptionRows.filter((row) => row.resource_id === id),
        }),
        timezone: grid.timezone,
        slotDuration: grid.slotDuration,
        anchorTime: grid.anchorTime,
      }),
    ]),
  )
}
