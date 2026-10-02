# Run port-holder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `./run smoke` and `./run docs` say "Port N is answering, but it is not this engine" when a non-container server holds the port, instead of exiting silently.

**Architecture:** One guard on one assignment in `run`'s `assert_engine_answers`, the same `|| var=""` idiom `resolve_running_port` uses, pinned by an integration test that holds the port with a host server, a container, or nothing.

**Tech Stack:** Bash under `set -euo pipefail`, Vitest, Testcontainers 12.

**Spec:** `docs/superpowers/specs/2026-10-02-run-port-holder-design.md`

## Global Constraints

- Test data lives in datasets under `tests/fixtures/datasets/`.
- Commits: Conventional Commits, subject line only, no body, no trailer. `./run check` passes before every commit.
- Check `git branch --show-current` is `fix/run-port-holder` before every commit.

## Review Focus

- The test's host server lives in the test's own process, so `./run` must be spawned asynchronously; a synchronous spawn blocks the event loop, the server never answers `curl`, and the case would pass for the wrong reason as "nothing listening". The runner uses `spawn`.
- `localhost` may resolve to `::1` before `127.0.0.1`. The host server listens on all interfaces (`listen(0)` with no host) so both `curl` and `nc -z localhost` reach it.
- Docker not running at all takes the same fixed path (the guarded substitution), but no row stops Docker to prove it; the guard is the same line either way.

---

### Task 1: Guard the container lookup

**Files:**

- Create: `tests/fixtures/datasets/run-port.ts`
- Create: `tests/integration/run-port.test.ts`
- Modify: `run`, `assert_engine_answers()`
- Modify: `docs/backlog.md` — delete the entry this fixes

- [ ] **Step 1: Write the dataset**

`tests/fixtures/datasets/run-port.ts`:

```ts
/** What holds the port when `./run` looks at it. */
export type Holder = 'host server' | 'container server' | 'nothing'

export interface RunPortCase {
  name: string
  scenario: 'smoke' | 'docs'
  holder: Holder
  /** Each must appear in the output. `{port}` and `{container}` are filled in by the runner. */
  says: string[]
  /** None may appear. */
  never: string[]
}

export const runPortCases: RunPortCase[] = [
  {
    name: 'smoke, with a non-engine server on the host',
    scenario: 'smoke',
    holder: 'host server',
    says: ['Port {port} is answering, but it is not this engine.'],
    never: [' — it is '],
  },
  {
    name: 'docs, with a non-engine server on the host',
    scenario: 'docs',
    holder: 'host server',
    says: ['Port {port} is answering, but it is not this engine.'],
    never: [' — it is '],
  },
  {
    name: 'smoke, with a non-engine server in a container',
    scenario: 'smoke',
    holder: 'container server',
    says: ['Port {port} is answering, but it is not this engine — it is {container}.'],
    never: [],
  },
  {
    name: 'smoke, with nothing listening',
    scenario: 'smoke',
    holder: 'nothing',
    says: ['Nothing is answering on http://localhost:{port}.'],
    never: [],
  },
]
```

- [ ] **Step 2: Write the runner**

`tests/integration/run-port.test.ts`:

```ts
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
    return { port, container: '', release: () => new Promise((done) => server.close(() => done())) }
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
    const child = spawn(RUN, [scenario], { cwd: REPO, env: { ...process.env, PORT: String(port) } })
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
```

- [ ] **Step 3: Run it and see it fail**

Run: `npx vitest run tests/integration/run-port.test.ts`
Expected: the two host-server rows FAIL — exit `1` but the output lacks "is answering, but it is not this engine". The container and nothing-listening rows PASS.

- [ ] **Step 4: Guard the assignment**

In `run`, `assert_engine_answers`, replace

```bash
    holder=$(docker ps --format '{{.Names}}\t{{.Ports}}' 2>/dev/null | grep ":${APP_PORT}->" | cut -f1 | head -1)
```

with

```bash
    # `|| holder=""`, as in resolve_running_port: when no container publishes the port, or
    # Docker is not running, the pipeline is non-zero, and `set -e` would end the scenario
    # here, before the message below. No container is an ordinary answer.
    holder=$(docker ps --format '{{.Names}}\t{{.Ports}}' 2>/dev/null | grep ":${APP_PORT}->" | cut -f1 | head -1) || holder=""
```

- [ ] **Step 5: Run it and see it pass**

Run: `npx vitest run tests/integration/run-port.test.ts`
Expected: PASS, 4 cases.

- [ ] **Step 6: Delete the backlog entry, check, commit**

Delete _`./run smoke` and `./run docs` exit silently when another server holds the port_ from `docs/backlog.md`.

Run: `./run check`. Expected: passes.

```bash
git add run tests/fixtures/datasets/run-port.ts tests/integration/run-port.test.ts docs/backlog.md
git commit -m "fix: explain a port held by something other than the engine"
```

---

### Task 2: Close the slice

`docs/architecture.md`, `docs/conventions.md` and `README.md` describe no part of this; nothing in them changes.

- [ ] **Step 1:** Set the spec's status line to `**Status:** implemented · **Date:** 2026-10-02`, with an _As built_ note for any ruling that changed what it says.
- [ ] **Step 2:** `git mv docs/superpowers/plans/2026-10-02-run-port-holder.md docs/superpowers/plans/archive/`, then `./run check`.
- [ ] **Step 3:**

```bash
git add -A docs/superpowers
git commit -m "docs: mark the run port-holder fix implemented and archive its plan"
```
