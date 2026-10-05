import { describe, expect, it } from 'vitest'
import { memberSlots } from '../../src/modules/availability/member-slots.js'
import { generateSlots } from '../../src/modules/availability/slot-generator.js'
import { resolveWindows } from '../../src/modules/availability/window-resolver.js'
import { parseSlotDuration } from '../../src/shared/time.js'
import { dayAfter, dayBefore, fallBacks } from '../fixtures/datasets/dst.js'
import {
  dayOffFor,
  memberSlotsCases,
  windowFor,
  type MemberScheduleRow,
} from '../fixtures/datasets/member-slots.js'

describe('memberSlots', () => {
  it.each(memberSlotsCases)('$name', (testCase) => {
    const result = memberSlots({
      memberIds: testCase.memberIds,
      dates: testCase.dates,
      grid: {
        timezone: testCase.timezone,
        slotDuration: parseSlotDuration(testCase.slotDuration),
        anchorTime: testCase.anchorTime,
      },
      scheduleRows: testCase.scheduleRows,
      exceptionRows: testCase.exceptionRows,
    })

    expect(
      Object.fromEntries(
        [...result].map(([id, slots]) => [id, slots.map((slot) => [slot.start, slot.end])]),
      ),
    ).toEqual(testCase.expected)
  })

  /**
   * The property the booking path relies on: a member's slots inside a pool are the slots it
   * would have alone. Checked across a real fall-back night, taken from the tz-derived dataset,
   * so no offset is written down here.
   */
  it.each(fallBacks.filter((transition) => transition.zone === 'Europe/Warsaw'))(
    'gives each member the slots it would have alone, across the $zone fall-back of $date',
    ({ zone, date }) => {
      const wholeWeek = (member: string): MemberScheduleRow[] =>
        [0, 1, 2, 3, 4, 5, 6].map((day) => windowFor(member, day, null, null))
      const dates = [dayBefore(date), date, dayAfter(date)]
      const grid = { timezone: zone, slotDuration: parseSlotDuration('P1D'), anchorTime: '14:00' }
      const scheduleRows = [...wholeWeek('a'), ...wholeWeek('b')]
      const exceptionRows = [dayOffFor('b', date)]

      const result = memberSlots({
        memberIds: ['a', 'b'],
        dates,
        grid,
        scheduleRows,
        exceptionRows,
      })

      for (const id of ['a', 'b']) {
        const alone = generateSlots({
          dates,
          windowsByDate: resolveWindows({
            dates,
            timezone: zone,
            scheduleRows: scheduleRows.filter((row) => row.resource_id === id),
            exceptionRows: exceptionRows.filter((row) => row.resource_id === id),
          }),
          timezone: zone,
          slotDuration: grid.slotDuration,
          anchorTime: grid.anchorTime,
        })
        expect(result.get(id)).toEqual(alone)
      }
      // The day off is visible, so the comparison above is not between two empty lists.
      expect(result.get('a')!.length).toBeGreaterThan(result.get('b')!.length)
    },
  )
})
