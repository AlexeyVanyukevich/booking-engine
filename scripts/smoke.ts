/**
 * Replays the test-case suites against a live engine over real HTTP.
 *
 * This file contains no test case and no knowledge of any endpoint. Cases come from
 * `tests/fixtures/datasets/`, the same source the automated suite reads; the way to execute
 * them comes from `tests/fixtures/suites/`. Adding an area of behaviour means adding a suite
 * and registering it — this runner does not change.
 *
 *   ./run smoke                  every suite
 *   ./run smoke availability     only suites whose name matches, case-insensitively
 *   BASE_URL=http://host:port tsx scripts/smoke.ts
 */
import { Api } from '../tests/fixtures/api.js'
import type { ResourcePayload } from '../tests/fixtures/resources.js'
import {
  isSkipped,
  suites,
  type CaseResult,
  type SuiteContext,
} from '../tests/fixtures/suites/index.js'
import { httpTransport } from '../tests/fixtures/transport.js'

const BASE_URL = process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`
const filter = process.argv[2]?.toLowerCase()

const tty = process.stdout.isTTY
const BOLD = tty ? '[1m' : ''
const DIM = tty ? '[2m' : ''
const RED = tty ? '[31m' : ''
const GREEN = tty ? '[32m' : ''
const YELLOW = tty ? '[33m' : ''
const OFF = tty ? '[0m' : ''

const out = (line: string) => process.stdout.write(`${line}\n`)

interface Failure {
  suite: string
  case: string
  detail: string
}

const failures: Failure[] = []
let passed = 0
/** Cases a suite reported it could not execute. Never counted as passes. */
let skipped = 0

/** Resources created along the way, removed at the end so a development database stays usable. */
const created: string[] = []

const transport = httpTransport(BASE_URL)
const api = new Api(transport)

const context: SuiteContext = {
  api,
  send: transport,
  track: (id) => created.push(id),
  newResource: async (payload: ResourcePayload) => {
    const id = await api.givenResource(payload)
    created.push(id)
    return id
  },
}

async function main(): Promise<void> {
  out(`${BOLD}Smoke run against ${BASE_URL}${OFF}`)

  const health = await api.health().catch(() => null)
  if (!health || health.statusCode !== 200) {
    out(`${RED}✗ Nothing healthy at ${BASE_URL}${OFF}`)
    process.exit(1)
  }

  const selected = filter
    ? suites.filter((suite) => suite.name.toLowerCase().includes(filter))
    : suites

  if (selected.length === 0) {
    out(`${RED}✗ No suite matches "${filter}".${OFF}`)
    out(`${DIM}  Available: ${suites.map((suite) => suite.name).join(', ')}${OFF}`)
    process.exit(1)
  }
  if (filter) {
    out(`${DIM}Filtered to ${selected.length} of ${suites.length} suites by "${filter}"${OFF}`)
  }

  for (const suite of selected) {
    out(`\n${BOLD}${suite.name}${OFF} ${DIM}(${suite.cases.length})${OFF}`)

    if (suite.cases.length === 0) {
      out(`  ${YELLOW}! empty suite — the dataset behind it has no cases${OFF}`)
      continue
    }

    for (const testCase of suite.cases) {
      const name = suite.describe(testCase)
      let detail: CaseResult
      try {
        detail = await suite.run(context, testCase)
      } catch (error) {
        detail = error instanceof Error ? error.message : String(error)
      }

      if (isSkipped(detail)) {
        skipped += 1
        out(`  ${YELLOW}–${OFF} ${DIM}${name} — ${detail.skipped}${OFF}`)
      } else if (detail === null) {
        passed += 1
        out(`  ${GREEN}✓${OFF} ${DIM}${name}${OFF}`)
      } else {
        failures.push({ suite: suite.name, case: name, detail })
        out(`  ${RED}✗ ${name}${OFF}\n    ${detail}`)
      }
    }
  }

  await cleanup()
  report()
}

async function cleanup(): Promise<void> {
  if (created.length === 0) return
  out(`\n${DIM}Removing ${created.length} resources created by this run${OFF}`)
  for (const id of created) {
    await api.deleteResource(id).catch(() => undefined)
  }
}

function report(): void {
  const total = passed + failures.length
  // Skips are reported beside the count, never inside it: a check that did not run is not a
  // check that passed.
  const note = skipped > 0 ? `${DIM} (${skipped} skipped)${OFF}` : ''

  if (failures.length === 0) {
    out(`\n${GREEN}${BOLD}✓ ${passed}/${total} checks passed${OFF}${note}`)
    process.exit(0)
  }

  out(`\n${RED}${BOLD}✗ ${failures.length} of ${total} checks failed${OFF}${note}`)
  for (const failure of failures) {
    out(`  ${RED}${failure.suite} — ${failure.case}${OFF}\n    ${failure.detail}`)
  }
  process.exit(1)
}

await main()
