import { describe, expect, it } from 'vitest'
import {
  PRESETS,
  SCOPES,
  SCOPE_DESCRIPTIONS,
  expandPreset,
  isScope,
} from '../../src/shared/scopes.js'

describe('scopes', () => {
  it('has exactly the eight the spec names', () => {
    expect([...SCOPES].sort()).toEqual([
      'availability.read',
      'bookings.list',
      'bookings.read',
      'bookings.write',
      'resources.read',
      'resources.write',
      'schedule.read',
      'schedule.write',
    ])
  })

  it('describes every scope', () => {
    for (const scope of SCOPES) expect(SCOPE_DESCRIPTIONS[scope]).toBeTruthy()
  })

  it('accepts a known scope and rejects anything else', () => {
    expect(isScope('bookings.write')).toBe(true)
    expect(isScope('bookings.destroy')).toBe(false)
    expect(isScope('')).toBe(false)
  })

  it.each(Object.keys(PRESETS) as (keyof typeof PRESETS)[])(
    'expands preset %s to known scopes only',
    (name) => {
      const expanded = expandPreset(name)
      expect(expanded.length).toBeGreaterThan(0)
      for (const scope of expanded) expect(SCOPES).toContain(scope)
    },
  )

  // The difference the whole model exists for: a partner may book and may not read the calendar.
  it('gives partner_channel bookings.write without bookings.list', () => {
    expect(expandPreset('partner_channel')).toContain('bookings.write')
    expect(expandPreset('partner_channel')).not.toContain('bookings.list')
  })

  it('gives site_backend bookings.list', () => {
    expect(expandPreset('site_backend')).toContain('bookings.list')
  })

  // A scope no preset can issue is a scope nobody can use without hand-editing SQL.
  it('reaches every scope through at least one preset', () => {
    const reachable = new Set(
      Object.keys(PRESETS).flatMap((n) => expandPreset(n as keyof typeof PRESETS)),
    )
    expect([...reachable].sort()).toEqual([...SCOPES].sort())
  })
})
