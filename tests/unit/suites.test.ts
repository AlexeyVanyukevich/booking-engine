import { describe, expect, it } from 'vitest'
import { seal, skip, type Suite, type SuiteContext } from '../fixtures/suites/index.js'

/**
 * The smoke runner iterates sealed suites: each case already bound to its own `describe` and
 * `run`, so suites over different case types share one list without `any`.
 */
describe('sealing a suite', () => {
  const context = {} as SuiteContext
  const doubling: Suite<{ input: number; expected: number }> = {
    name: 'doubling',
    cases: [
      { input: 1, expected: 2 },
      { input: 2, expected: 5 },
      { input: 0, expected: 0 },
    ],
    describe: ({ input }) => `doubles ${input}`,
    run: async (_, { input, expected }) =>
      input === 0 ? skip('zero proves nothing') : input * 2 === expected ? null : 'wrong',
  }

  it('keeps the name, and one check per case in dataset order', () => {
    const sealed = seal(doubling)
    expect(sealed.name).toBe('doubling')
    expect(sealed.checks.map((check) => check.describe)).toEqual([
      'doubles 1',
      'doubles 2',
      'doubles 0',
    ])
  })

  it('runs each check against its own case', async () => {
    const results = await Promise.all(seal(doubling).checks.map((check) => check.run(context)))
    expect(results).toEqual([null, 'wrong', { skipped: 'zero proves nothing' }])
  })
})
