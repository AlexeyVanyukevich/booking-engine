import { describe, expect, it } from 'vitest'
import { failureKey, limiterKey } from '../../src/shared/rate-limit.js'
import { storeKeyCases, type StoreKeyCase } from '../fixtures/datasets/store-keys.js'

const keyFor = ({ count, request }: StoreKeyCase): string =>
  count === 'limiter' ? limiterKey(request) : failureKey(request)

describe('rate-limit store keys', () => {
  it.each(storeKeyCases)('$name', (row) => {
    expect(keyFor(row)).toBe(row.expected)
  })

  // The rows that spell another count's key in a header are what make this more than a
  // restatement: without the prefixes, two of them would collide. Rows the dataset means to
  // share a key, such as two addresses in one /64, say so by expecting the same one.
  it('gives two rows the same key only where the dataset expects it', () => {
    expect(new Set(storeKeyCases.map(keyFor)).size).toBe(
      new Set(storeKeyCases.map((row) => row.expected)).size,
    )
  })
})
