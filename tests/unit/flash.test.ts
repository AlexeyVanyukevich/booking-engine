import { describe, expect, it, vi } from 'vitest'
import { SecretFlash } from '../../src/modules/console/flash.js'

describe('SecretFlash', () => {
  it('returns the secret once', () => {
    const flash = new SecretFlash()
    const id = flash.put('bk_live_secret')
    expect(flash.take(id)).toBe('bk_live_secret')
  })

  // The whole mechanism: a reload finds nothing, so "shown once" is behaviour rather than a
  // rule bolted on top of a page that could have rendered it again.
  it('returns nothing the second time', () => {
    const flash = new SecretFlash()
    const id = flash.put('bk_live_secret')
    flash.take(id)
    expect(flash.take(id)).toBeUndefined()
  })

  it('returns nothing for an unknown id', () => {
    expect(new SecretFlash().take('nope')).toBeUndefined()
  })

  it('expires an entry after its ttl', () => {
    vi.useFakeTimers()
    try {
      const flash = new SecretFlash(60_000)
      const id = flash.put('bk_live_secret')
      vi.advanceTimersByTime(60_001)
      expect(flash.take(id)).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps an entry that has not expired yet', () => {
    vi.useFakeTimers()
    try {
      const flash = new SecretFlash(60_000)
      const id = flash.put('bk_live_secret')
      vi.advanceTimersByTime(59_000)
      expect(flash.take(id)).toBe('bk_live_secret')
    } finally {
      vi.useRealTimers()
    }
  })

  it('issues an unguessable, distinct id every time', () => {
    const flash = new SecretFlash()
    const ids = [flash.put('a'), flash.put('b'), flash.put('c')]
    expect(new Set(ids).size).toBe(3)
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{32}$/)
  })

  it('keeps entries apart', () => {
    const flash = new SecretFlash()
    const first = flash.put('one')
    const second = flash.put('two')
    expect(flash.take(second)).toBe('two')
    expect(flash.take(first)).toBe('one')
  })
})
