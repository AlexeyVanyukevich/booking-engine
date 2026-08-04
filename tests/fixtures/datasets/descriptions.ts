import type { DescriptionBlock } from '../../../src/shared/docs.js'

export interface DescriptionCase {
  name: string
  blocks: DescriptionBlock[]
  expected: string
}

export const descriptionCases: DescriptionCase[] = [
  {
    name: 'a single paragraph is untouched',
    blocks: ['One sentence.'],
    expected: 'One sentence.',
  },
  {
    name: 'paragraphs are separated by a blank line',
    blocks: ['First.', 'Second.'],
    expected: 'First.\n\nSecond.',
  },
  {
    name: 'an array becomes a tight bullet list',
    blocks: [['one', 'two']],
    expected: '- one\n- two',
  },
  {
    name: 'a list keeps its own markers when items already have them',
    blocks: [['1. first', '2. second']],
    expected: '1. first\n2. second',
  },
  {
    name: 'existing dashes are not doubled',
    blocks: [['- already marked', 'not marked']],
    expected: '- already marked\n- not marked',
  },
  {
    name: 'a list sits between paragraphs with blank lines around it',
    blocks: ['Intro:', ['one', 'two'], 'Outro.'],
    expected: 'Intro:\n\n- one\n- two\n\nOutro.',
  },
  {
    name: 'stray whitespace around a paragraph is trimmed',
    blocks: ['  padded  '],
    expected: 'padded',
  },
  {
    name: 'an empty list produces an empty block rather than a stray marker',
    blocks: [[]],
    expected: '',
  },
]
