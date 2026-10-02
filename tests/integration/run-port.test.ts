import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { GenericContainer, Wait } from 'testcontainers'
import { describe, expect, it } from 'vitest'
import { runPortCases, type Holder } from '../fixtures/datasets/run-port.js'

const RUN = fileURLToPath(new URL('../../run', import.meta.url))
const REPO = fileURLToPath(new URL('../..', import.meta.url))
const NOT_THE_ENGINE =
  "require('http').createServer((q, s) => s.end('not the engine')).listen(3000)"

interface Held {
  port: number
  container: string
  release(): Promise<void>
}

/** Any interface, so `localhost` reaches it whether it resolves to `::1` or `127.0.0.1`. */
async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, resolve))
  return (server.address() as AddressInfo).port
}

async function hold(holder: Holder): Promise<Held> {
  if (holder === 'host server') {
    const server = createServer((_request, response) => response.end('not the engine'))
    const port = await listen(server)
    return {
      port,
      container: '',
      release: () => new Promise((done) => server.close(() => done())),
    }
  }
  if (holder === 'nothing') {
    // A port that was free a moment ago and is free again.
    const server = createServer()
    const port = await listen(server)
    await new Promise<void>((done) => server.close(() => done()))
    return { port, container: '', release: async () => {} }
  }
  const started = await new GenericContainer('node:24.18-alpine')
    .withCommand(['node', '-e', NOT_THE_ENGINE])
    .withExposedPorts(3000)
    .withWaitStrategy(Wait.forListeningPorts())
    .start()
  return {
    port: started.getMappedPort(3000),
    container: started.getName().replace(/^\//, ''),
    release: async () => {
      await started.stop()
    },
  }
}

/**
 * Spawned, never run synchronously: the host server lives in this process, and a blocked event
 * loop would leave it unable to answer `./run`'s `curl`.
 */
function runScenario(
  scenario: string,
  port: number,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(RUN, [scenario], {
      cwd: REPO,
      env: { ...process.env, PORT: String(port) },
    })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.on('close', (code) => resolve({ code, output }))
  })
}

describe('./run against a port the engine does not hold', () => {
  it.each(runPortCases)(
    '$name',
    async ({ scenario, holder, says, never }) => {
      const held = await hold(holder)
      try {
        const { code, output } = await runScenario(scenario, held.port)
        const fill = (text: string) =>
          text.replaceAll('{port}', String(held.port)).replaceAll('{container}', held.container)

        expect(code).toBe(1)
        for (const text of says) expect(output).toContain(fill(text))
        for (const text of never) expect(output).not.toContain(fill(text))
      } finally {
        await held.release()
      }
    },
    60_000,
  )
})
