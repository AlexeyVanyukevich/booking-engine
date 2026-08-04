import { describe, expect, it } from 'vitest'
import { md } from '../../src/shared/docs.js'
import { descriptionCases } from '../fixtures/datasets/descriptions.js'

describe('md', () => {
  it.each(descriptionCases)('$name', ({ blocks, expected }) => {
    expect(md(...blocks)).toBe(expected)
  })

  /**
   * The two rules that make a Swagger description readable, asserted directly rather than
   * only through the rendered document.
   */
  it('never joins two paragraphs with a bare newline', () => {
    const result = md('First.', 'Second.', 'Third.')
    const proseBlocks = result.split('\n\n')
    expect(proseBlocks).toHaveLength(3)
    for (const block of proseBlocks) {
      expect(block).not.toContain('\n')
    }
  })

  it('keeps list items on adjacent lines so the list stays tight', () => {
    const result = md(['one', 'two', 'three'])
    expect(result).not.toContain('\n\n')
    expect(result.split('\n')).toHaveLength(3)
  })

  it('is stable when applied to its own output', () => {
    const once = md('Intro:', ['one', 'two'])
    expect(md(once)).toBe(once)
  })
})
