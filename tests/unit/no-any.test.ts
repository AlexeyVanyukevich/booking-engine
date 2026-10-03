import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { anyAllowances } from '../fixtures/datasets/any-allowances.js'

/**
 * The shared TypeScript rule allows `any` in one place: a migration's `Kysely<any>`. Nothing
 * else enforced it, so this does. It is a line scan, not a parse — TypeScript 7 ships no
 * JavaScript API to walk a tree with — and the spec for it says what that can and cannot see.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SCANNED = ['src', 'tests', 'scripts', 'testing/src']

// Assembled from parts, so this file does not report itself.
const ANY = 'any'
const TYPE_POSITION = new RegExp(
  String.raw`(:\s*${ANY}\b|\bas ${ANY}\b|=>\s*${ANY}\b|<${ANY}>|\b${ANY}\[\])`,
)
const SUPPRESSION = ['no', 'explicit', ANY].join('-')

interface Finding {
  file: string
  line: number
  text: string
}

function sourceFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => relative(ROOT, join(entry.parentPath, entry.name)))
}

/** The code on a line, without its comment, so prose such as "any number of" is not a finding. */
function code(line: string): string {
  const trimmed = line.trimStart()
  if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) return ''
  const comment = line.indexOf('//')
  return comment === -1 ? line : line.slice(0, comment)
}

function findings(): Finding[] {
  return SCANNED.flatMap(sourceFiles).flatMap((file) =>
    readFileSync(join(ROOT, file), 'utf8')
      .split('\n')
      .map((text, index) => ({ file, line: index + 1, text }))
      // A suppression is itself a comment, so it is looked for on the raw line.
      .filter(({ text }) => TYPE_POSITION.test(code(text)) || text.includes(SUPPRESSION)),
  )
}

const allowed = (finding: Finding) =>
  anyAllowances.some(({ file, line }) => file.test(finding.file) && line.test(finding.text))

it('writes any nowhere the shared rule does not allow it', () => {
  const unallowed = findings()
    .filter((finding) => !allowed(finding))
    .map(({ file, line, text }) => `${file}:${line}: ${text.trim()}`)
  expect(unallowed).toEqual([])
})

/** An allowance nothing uses any more is a stale row, and the list must stay exact. */
it.each(anyAllowances)('still needs the allowance for $name', ({ file, line }) => {
  expect(findings().some((finding) => file.test(finding.file) && line.test(finding.text))).toBe(
    true,
  )
})
