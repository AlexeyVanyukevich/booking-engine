import { describe, expect, it } from 'vitest'
import { capacityIsCounted } from '../../src/modules/bookings/booking.service.js'
import { UnsupportedConcurrencyModeError } from '../../src/shared/errors.js'

describe('the mode branch before a booking row is written', () => {
  it.each([
    ['exclusive', false],
    ['shared', true],
  ] as const)('decides %s without throwing', (mode, counted) => {
    expect(capacityIsCounted(mode)).toBe(counted)
  })

  /**
   * Deliberately permanent. A booking always points at a member, whose own mode is
   * `exclusive`, so no row should ever reach here carrying `pool`. If one does, member
   * selection is broken and the row would be governed by nothing at all.
   */
  it('refuses to write a booking row carrying pool', () => {
    expect(() => capacityIsCounted('pool')).toThrow(UnsupportedConcurrencyModeError)
  })
})
