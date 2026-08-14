import { describe, expect, it } from 'vitest'
import {
  AppError,
  ConcurrentUpdateError,
  InvalidRangeError,
  NotFoundError,
  ScheduleOverlapError,
  ScheduleShapeMismatchError,
  UnsupportedConcurrencyModeError,
  ValidationError,
  isSerializationFailure,
  rethrowContention,
} from '../../src/shared/errors.js'

interface ErrorCase {
  name: string
  construct: (message: string, details?: Record<string, unknown>) => AppError
  statusCode: number
  code: string
}

const errorCases: ErrorCase[] = [
  {
    name: 'ValidationError',
    construct: (m, d) => new ValidationError(m, d),
    statusCode: 400,
    code: 'validation_error',
  },
  {
    name: 'InvalidRangeError',
    construct: (m, d) => new InvalidRangeError(m, d),
    statusCode: 400,
    code: 'invalid_range',
  },
  {
    name: 'ScheduleOverlapError',
    construct: (m, d) => new ScheduleOverlapError(m, d),
    statusCode: 400,
    code: 'schedule_overlap',
  },
  {
    name: 'ScheduleShapeMismatchError',
    construct: (m, d) => new ScheduleShapeMismatchError(m, d),
    statusCode: 400,
    code: 'schedule_shape_mismatch',
  },
  {
    name: 'UnsupportedConcurrencyModeError',
    construct: (m, d) => new UnsupportedConcurrencyModeError(m, d),
    statusCode: 400,
    code: 'unsupported_concurrency_mode',
  },
  {
    name: 'NotFoundError',
    construct: (m, d) => new NotFoundError(m, d),
    statusCode: 404,
    code: 'not_found',
  },
  {
    name: 'ConcurrentUpdateError',
    construct: (m, d) => new ConcurrentUpdateError(m, d),
    statusCode: 503,
    code: 'concurrent_update',
  },
]

describe('AppError hierarchy', () => {
  it.each(errorCases)('$name maps to $statusCode $code', ({ construct, statusCode, code }) => {
    const error = construct('something went wrong')
    expect(error.statusCode).toBe(statusCode)
    expect(error.code).toBe(code)
  })

  it.each(errorCases)('$name is an AppError and an Error', ({ construct }) => {
    const error = construct('something went wrong')
    expect(error).toBeInstanceOf(AppError)
    expect(error).toBeInstanceOf(Error)
  })

  it.each(errorCases)('$name keeps its message and name', ({ name, construct }) => {
    const error = construct('something went wrong')
    expect(error.message).toBe('something went wrong')
    expect(error.name).toBe(name)
  })

  it.each(errorCases)('$name carries optional details through', ({ construct }) => {
    expect(construct('m', { field: 'timezone' }).details).toEqual({ field: 'timezone' })
    expect(construct('m').details).toBeUndefined()
  })

  it.each(errorCases)('$name produces a usable stack trace', ({ construct }) => {
    expect(construct('m').stack).toContain('errors.test.ts')
  })

  it('gives every error type a distinct code', () => {
    const codes = errorCases.map((testCase) => testCase.code)
    expect(new Set(codes).size).toBe(codes.length)
  })
})

describe('contention translation', () => {
  it.each([
    { name: 'a deadlock', code: '40P01' },
    { name: 'a serialization failure', code: '40001' },
  ])('recognises $name', ({ code }) => {
    expect(isSerializationFailure({ code })).toBe(true)
  })

  it.each([
    { name: 'an exclusion violation', error: { code: '23P01' } },
    { name: 'a foreign key violation', error: { code: '23503' } },
    { name: 'an ordinary error', error: new Error('boom') },
    { name: 'null', error: null },
    { name: 'a string', error: 'nope' },
  ])('does not mistake $name for contention', ({ error }) => {
    expect(isSerializationFailure(error)).toBe(false)
  })

  it('translates a deadlock into a retryable 503', () => {
    try {
      rethrowContention({ code: '40P01' }, 'The booking')
      expect.unreachable('rethrowContention must throw')
    } catch (error) {
      expect(error).toBeInstanceOf(ConcurrentUpdateError)
      // The caller is told to retry rather than to treat this as a conflict over the slot.
      expect((error as ConcurrentUpdateError).headers).toEqual({ 'retry-after': '1' })
      expect((error as ConcurrentUpdateError).message).toContain('retry')
    }
  })

  it('passes anything else through untouched', () => {
    const original = new Error('boom')
    expect(() => rethrowContention(original, 'The booking')).toThrow(original)
  })
})
