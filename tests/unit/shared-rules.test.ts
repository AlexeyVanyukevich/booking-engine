import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { kitFreeFiles } from '../fixtures/datasets/shared-rules.js'

/**
 * `CLAUDE.md` imports the shared rules by filesystem path. An import whose file is gone loads
 * nothing and fails nothing: the session simply works without the rule, and no one notices.
 */

const ROOT = new URL('../../', import.meta.url)

describe('the shared rules', () => {
  it('every import in CLAUDE.md names a file that exists', () => {
    const imports = readFileSync(new URL('CLAUDE.md', ROOT), 'utf8')
      .split('\n')
      .map((line) => /^@(\S+)$/.exec(line)?.[1])
      .filter((path) => path !== undefined)

    expect(imports.length).toBeGreaterThan(0)
    for (const path of imports) {
      expect(existsSync(new URL(path, ROOT)), path).toBe(true)
    }
  })

  it.each(kitFreeFiles)('%s does not name the old kit', (file) => {
    expect(readFileSync(new URL(file, ROOT), 'utf8')).not.toContain('dev-kit')
  })
})
