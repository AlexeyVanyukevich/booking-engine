import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * `./run` takes its helpers from dev-kit, so before the first `npm install` it has nothing to
 * source — and no `die` to explain itself with. A host with Docker and no Node, which the
 * README's Docker-only path describes, must get an instruction rather than a shell error.
 */
describe('./run before dependencies are installed', () => {
  it('without npm on the PATH, says what to install and how to run on Docker alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'run-bootstrap-'))
    try {
      const bin = join(dir, 'bin')
      mkdirSync(bin)
      // `dirname` is the one external command the script runs before the bootstrap.
      symlinkSync(
        execFileSync('which', ['dirname'], { encoding: 'utf8' }).trim(),
        join(bin, 'dirname'),
      )
      copyFileSync(fileURLToPath(new URL('../../run', import.meta.url)), join(dir, 'run'))

      const bash = execFileSync('which', ['bash'], { encoding: 'utf8' }).trim()
      const result = spawnSync(bash, [join(dir, 'run'), 'help'], {
        env: { PATH: bin },
        encoding: 'utf8',
      })

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('Node.js 24')
      expect(result.stderr).toContain('docker compose up -d --build')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
