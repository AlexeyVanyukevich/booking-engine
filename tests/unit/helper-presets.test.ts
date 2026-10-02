import { expect, it } from 'vitest'
import { PRESETS } from '../../src/shared/scopes.js'
import { PRESET_NAMES } from '../../testing/src/index.js'

/**
 * The helper ships without the engine's source, so it restates the preset names instead of
 * importing them. This is what keeps the restatement exact.
 */
it('names exactly the presets the engine has', () => {
  expect([...PRESET_NAMES].sort()).toEqual(Object.keys(PRESETS).sort())
})
