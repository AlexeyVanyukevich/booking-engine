import { describe, expect, it } from 'vitest'
import { assertValidRange } from '../../src/shared/range.js'
import { InvalidRangeError } from '../../src/shared/errors.js'
import { rangeCases } from '../fixtures/datasets/calendar.js'

const accepted = rangeCases.filter((testCase) => testCase.expectedMessage === undefined)
const rejected = rangeCases.filter((testCase) => testCase.expectedMessage !== undefined)

describe('assertValidRange', () => {
  it.each(accepted)('accepts $name', ({ from, to, maxDays }) => {
    expect(() => assertValidRange(from, to, maxDays)).not.toThrow()
  })

  it.each(rejected)('rejects $name', ({ from, to, maxDays, expectedMessage }) => {
    expect(() => assertValidRange(from, to, maxDays)).toThrow(expectedMessage)
  })

  it.each(rejected)('reports $name as invalid_range', ({ from, to, maxDays }) => {
    try {
      assertValidRange(from, to, maxDays)
      expect.unreachable('expected assertValidRange to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidRangeError)
      expect((error as InvalidRangeError).code).toBe('invalid_range')
      expect((error as InvalidRangeError).statusCode).toBe(400)
    }
  })

  it('carries the offending bounds in the error details', () => {
    try {
      assertValidRange('2026-07-27', '2026-07-20', 366)
      expect.unreachable('expected assertValidRange to throw')
    } catch (error) {
      expect((error as InvalidRangeError).details).toMatchObject({
        from: '2026-07-27',
        to: '2026-07-20',
      })
    }
  })
})
