import { describe, expect, it } from 'vitest'
import {
  AppError,
  InvalidRangeError,
  NotFoundError,
  ScheduleOverlapError,
  ScheduleShapeMismatchError,
  UnsupportedConcurrencyModeError,
  ValidationError,
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
