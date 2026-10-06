import { afterAll, afterEach, expect } from 'vitest'
import { takeContractMismatches } from './contract.js'

/**
 * Each test file runs in its own module context, so the list is per file and nothing crosses a
 * worker boundary. `afterEach` names the test that drew the reply; `afterAll` catches requests
 * sent from `afterAll` hooks, and a `beforeAll` request is reported against the first test.
 */
const check = () =>
  expect(
    takeContractMismatches(),
    'replies the route does not declare — see tests/integration/contract.ts',
  ).toEqual([])

afterEach(check)
afterAll(check)
