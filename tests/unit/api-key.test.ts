import { describe, expect, it } from 'vitest'
import {
  generateKey,
  hashSecret,
  parseKey,
  verifySecret,
} from '../../src/modules/tenants/api-key.js'

describe('api keys', () => {
  it('generates a key with an 8-character prefix and a 43-character secret', () => {
    const { key, prefix, hash } = generateKey()
    expect(key.startsWith('bk_live_')).toBe(true)
    expect(prefix).toHaveLength(8)
    expect(key).toHaveLength('bk_live_'.length + 8 + 43)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('never generates the same key twice', () => {
    const keys = new Set(Array.from({ length: 200 }, () => generateKey().key))
    expect(keys.size).toBe(200)
  })

  it('round-trips through parse', () => {
    const { key, prefix, hash } = generateKey()
    const parsed = parseKey(key)
    expect(parsed?.prefix).toBe(prefix)
    expect(verifySecret(parsed!.secret, hash)).toBe(true)
  })

  it('rejects a secret differing in one character', () => {
    const { key, hash } = generateKey()
    const parsed = parseKey(key)!
    const tampered = parsed.secret.slice(0, -1) + (parsed.secret.endsWith('a') ? 'b' : 'a')
    expect(verifySecret(tampered, hash)).toBe(false)
  })

  it('rejects a hash of the wrong length without throwing', () => {
    // timingSafeEqual throws on a length mismatch; verifySecret must not propagate that.
    expect(verifySecret('anything', 'deadbeef')).toBe(false)
  })

  it('rejects a hash that is not hex without throwing', () => {
    expect(verifySecret('anything', 'zzzz')).toBe(false)
  })

  it.each([
    ['', 'empty'],
    ['bk_live_', 'marker only'],
    [`bk_test_abcdefgh${'A'.repeat(43)}`, 'wrong marker'],
    [`abcdefgh${'A'.repeat(43)}`, 'no marker'],
    ['bk_live_short', 'too short'],
    [`bk_live_${'A'.repeat(60)}`, 'too long'],
    [`bk_live_abcdefg!${'A'.repeat(42)}`, 'non-alphanumeric'],
    [`bk_live_abcdefgh${'A'.repeat(43)}\n`, 'trailing newline'],
  ])('refuses to parse %s (%s)', (raw) => {
    expect(parseKey(raw)).toBeUndefined()
  })

  it('hashes deterministically', () => {
    expect(hashSecret('abc')).toBe(hashSecret('abc'))
    expect(hashSecret('abc')).not.toBe(hashSecret('abd'))
  })

  // A modulo over 256 would bias a 62-character alphabet towards its first 8 letters.
  it('draws from the whole alphabet', () => {
    const seen = new Set([...Array.from({ length: 400 }, () => generateKey().key).join('')])
    expect(seen.size).toBeGreaterThan(55)
  })
})
