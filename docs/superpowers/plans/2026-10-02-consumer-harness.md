# Consumer test harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A consumer starts a pinned engine holding keys of the presets it names with one call to an installed helper, and an operator gets a key under `./run up` without the console.

**Architecture:** A one-shot `issue-keys` entry point creates a tenant and issues keys by preset, printing one JSON line. A small package in `testing/` starts Postgres, `migrate`, `issue-keys` and the API from the engine's image with Testcontainers. A tag-triggered workflow pushes the image to GHCR and the helper to GitHub Packages under the same version.

**Tech Stack:** Node 24, TypeScript (NodeNext), Kysely, Testcontainers 12, Vitest, GitHub Actions, Docker Buildx.

**Spec:** `docs/superpowers/specs/2026-10-02-consumer-harness-design.md`

## Global Constraints

- Image: `ghcr.io/alexeyvanyukevich/booking-engine:X.Y.Z`, built for `linux/amd64` and `linux/arm64`.
- Helper package: `@alexeyvanyukevich/booking-engine-testing`, published to `https://npm.pkg.github.com`.
- The tag is the single source of the version; the workflow fails if the tag without `v` differs from the root `package.json` version.
- `issue-keys` writes exactly one line to stdout on success and nothing on stdout on failure.
- The helper imports nothing from `src/`.
- A NodeNext workspace carries a `.js` extension on every relative import.
- No `any` in hand-written code.
- Test data lives in datasets under `tests/fixtures/datasets/`.
- Commits: Conventional Commits, subject line only, no body, no trailer. `./run check` passes before every commit.
- **No tag is pushed by this plan.** Pushing the first tag publishes to two registries and is a separate step the user takes.

## Review Focus

- `issue-keys` run as a real process must print nothing to stdout but the result line; a stray log line would break the helper's parse. Pinned by the helper test, which parses a real container's output.
- A refused invocation must create no tenant, including when one of several presets is unknown. Pinned by a dataset row in Task 1.
- `./run smoke` creates its key through the console, which is unreachable under `./run up` for the same reason as the first run. The README must not tell a `./run up` user to run it. Handled in Task 2's README edit; recorded in the backlog in Task 5.
- A failing step in `startEngine` must reject with that step's output and leave no container running. Pinned in Task 3.
- The release workflow cannot be run locally. Its YAML is checked for syntax only; the first tag push is its first real run. Stated as unproven in Task 4.

---

### Task 1: `issue-keys`

**Files:**

- Create: `src/issue-keys.ts`
- Create: `tests/fixtures/datasets/issue-keys.ts`
- Create: `tests/integration/issue-keys.test.ts`

**Interfaces:**

- Produces: `issueKeys(argv: string[], deps: IssueKeysDeps): Promise<number>`, returning the exit code. `IssueKeysDeps = { service: TenantService; out: (text: string) => void; err: (text: string) => void }`.
- Produces: `node dist/src/issue-keys.js --tenant <name> --preset <preset>...` in the image, printing `{"tenantId":"…","keys":{"<preset>":"bk_live_…"}}\n`.

- [ ] **Step 1: Write the dataset**

`tests/fixtures/datasets/issue-keys.ts`:

```ts
import type { PresetName } from '../../../src/shared/scopes.js'

export interface IssuedCase {
  name: string
  argv: string[]
  /** The presets the result names a key for, in any order. */
  issued: PresetName[]
}

export interface RefusedCase {
  name: string
  argv: string[]
  /** Matched against everything written to stderr. */
  refused: RegExp
}

const tenant = ['--tenant', 'acme']

export const issuedCases: IssuedCase[] = [
  { name: 'one preset', argv: [...tenant, '--preset', 'widget'], issued: ['widget'] },
  {
    name: 'several presets',
    argv: [...tenant, '--preset', 'site_backend', '--preset', 'back_office'],
    issued: ['site_backend', 'back_office'],
  },
  {
    name: 'every preset',
    argv: [
      ...tenant,
      ...['widget', 'site_backend', 'partner_channel', 'reporting', 'back_office'].flatMap(
        (preset) => ['--preset', preset],
      ),
    ],
    issued: ['widget', 'site_backend', 'partner_channel', 'reporting', 'back_office'],
  },
  {
    name: 'a preset named twice issues one key',
    argv: [...tenant, '--preset', 'site_backend', '--preset', 'site_backend'],
    issued: ['site_backend'],
  },
]

export const refusedCases: RefusedCase[] = [
  { name: 'an unknown preset', argv: [...tenant, '--preset', 'nope'], refused: /nope/ },
  {
    name: 'an unknown preset beside a known one',
    argv: [...tenant, '--preset', 'widget', '--preset', 'nope'],
    refused: /nope/,
  },
  { name: 'no preset', argv: [...tenant], refused: /--preset/ },
  { name: 'no tenant', argv: ['--preset', 'widget'], refused: /--tenant/ },
  { name: 'a blank tenant', argv: ['--tenant', '   ', '--preset', 'widget'], refused: /blank/ },
  {
    name: 'a tenant name over the limit',
    argv: ['--tenant', 'x'.repeat(101), '--preset', 'widget'],
    refused: /Tenant name/,
  },
  {
    name: 'an option the command does not take',
    argv: [...tenant, '--preset', 'widget', '--scope', 'resources.read'],
    refused: /--scope/,
  },
]
```

- [ ] **Step 2: Write the runner**

`tests/integration/issue-keys.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { issueKeys } from '../../src/issue-keys.js'
import { TenantRepository } from '../../src/modules/tenants/tenant.repository.js'
import { TenantService } from '../../src/modules/tenants/tenant.service.js'
import { expandPreset } from '../../src/shared/scopes.js'
import { issuedCases, refusedCases } from '../fixtures/datasets/issue-keys.js'
import { closeTestDb, getTestDb, resetDb } from './helpers.js'

beforeEach(resetDb)
afterAll(closeTestDb)

const service = () => new TenantService(new TenantRepository(getTestDb()))

async function run(argv: string[]) {
  const out: string[] = []
  const err: string[] = []
  const code = await issueKeys(argv, {
    service: service(),
    out: (text) => out.push(text),
    err: (text) => err.push(text),
  })
  return { code, out, err: err.join('') }
}

describe('issue-keys', () => {
  it.each(issuedCases)('issues keys for $name', async ({ argv, issued }) => {
    const { code, out, err } = await run(argv)
    expect(err).toBe('')
    expect(code).toBe(0)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatch(/^\{.*\}\n$/)

    const result = JSON.parse(out[0]!) as { tenantId: string; keys: Record<string, string> }
    expect(Object.keys(result.keys).sort()).toEqual([...issued].sort())
    expect(await service().listKeys(result.tenantId)).toHaveLength(issued.length)

    for (const preset of issued) {
      const resolved = await service().authenticate(result.keys[preset]!)
      expect(resolved?.tenantId).toBe(result.tenantId)
      expect([...(resolved?.scopes ?? [])].sort()).toEqual(expandPreset(preset).sort())
    }
  })

  it.each(refusedCases)('refuses $name and creates nothing', async ({ argv, refused }) => {
    const { code, out, err } = await run(argv)
    expect(code).not.toBe(0)
    expect(out).toEqual([])
    expect(err).toMatch(refused)
    expect(await getTestDb().selectFrom('tenants').select('id').execute()).toEqual([])
  })
})
```

- [ ] **Step 3: Run it and see it fail**

Run: `npx vitest run tests/integration/issue-keys.test.ts`
Expected: FAIL — `Cannot find module '../../src/issue-keys.js'` (or the equivalent resolution error).

- [ ] **Step 4: Write the command**

`src/issue-keys.ts`:

```ts
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { loadConfig } from './config.js'
import { createDb } from './db/client.js'
import { TenantRepository } from './modules/tenants/tenant.repository.js'
import { TenantService } from './modules/tenants/tenant.service.js'
import { AppError } from './shared/errors.js'
import { PRESETS, expandPreset, isPresetName, type PresetName } from './shared/scopes.js'

const USAGE = 'Usage: issue-keys --tenant <name> --preset <preset> [--preset <preset>]...'

export interface IssueKeysDeps {
  service: TenantService
  /** Receives the result line, newline included. Nothing else is ever written here. */
  out: (text: string) => void
  err: (text: string) => void
}

/**
 * Creates one tenant and issues one key per preset, for a caller that cannot reach the
 * console: a consumer's test harness, or an operator under `docker compose`. It runs with
 * `DATABASE_URL`, the trust `migrate.js` already has, and opens no port.
 *
 * Returns the exit code. Every refusal is decided before the first write, so a refused
 * invocation leaves no tenant behind.
 */
export async function issueKeys(
  argv: string[],
  { service, out, err }: IssueKeysDeps,
): Promise<number> {
  let tenant: string | undefined
  let presets: string[]
  try {
    const { values } = parseArgs({
      args: argv,
      options: { tenant: { type: 'string' }, preset: { type: 'string', multiple: true } },
      strict: true,
      allowPositionals: false,
    })
    tenant = values.tenant
    presets = values.preset ?? []
  } catch (error) {
    err(`${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`)
    return 2
  }

  if (tenant === undefined) {
    err(`--tenant is required\n${USAGE}\n`)
    return 2
  }
  if (presets.length === 0) {
    err(`At least one --preset is required\n${USAGE}\n`)
    return 2
  }
  const unknown = presets.filter((preset) => !isPresetName(preset))
  if (unknown.length > 0) {
    err(`Unknown preset: ${unknown.join(', ')}. Known: ${Object.keys(PRESETS).join(', ')}\n`)
    return 2
  }
  const wanted: PresetName[] = [...new Set(presets.filter(isPresetName))]

  try {
    const created = await service.createTenant(tenant)
    const keys: Partial<Record<PresetName, string>> = {}
    for (const preset of wanted) {
      const { secret } = await service.issueKey(created.id, preset, expandPreset(preset))
      keys[preset] = secret
    }
    out(`${JSON.stringify({ tenantId: created.id, keys })}\n`)
    return 0
  } catch (error) {
    err(
      `${error instanceof AppError ? error.message : error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    )
    return 1
  }
}

// Executed only when run directly: `node dist/src/issue-keys.js --tenant … --preset …`
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadConfig(process.env)
  const db = createDb(config.databaseUrl)
  try {
    process.exitCode = await issueKeys(process.argv.slice(2), {
      service: new TenantService(new TenantRepository(db)),
      out: (text) => process.stdout.write(text),
      err: (text) => process.stderr.write(text),
    })
  } finally {
    await db.destroy()
  }
}
```

A blank tenant passes the `undefined` check and is refused by `TenantService.createTenant`, whose `cleanName` throws `ValidationError('Tenant name must not be blank')` before any insert; the over-limit name is refused the same way. Both exit `1`.

- [ ] **Step 5: Run it and see it pass**

Run: `npx vitest run tests/integration/issue-keys.test.ts`
Expected: PASS, 11 cases.

- [ ] **Step 6: Check and commit**

Run: `./run check`. Expected: no type errors, formatting clean, full suite passes.

```bash
git add src/issue-keys.ts tests/fixtures/datasets/issue-keys.ts tests/integration/issue-keys.test.ts
git commit -m "feat: issue keys from a one-shot command"
```

---

### Task 2: `./run key` and a first run that works

**Files:**

- Modify: `run` — add `cmd_key`, its dispatch line, and its help line
- Modify: `README.md` — the _First run_ section and the command table under the sweep section

**Interfaces:**

- Consumes: `node dist/src/issue-keys.js` from Task 1.
- Produces: `./run key <tenant> <preset>...`.

- [ ] **Step 1: Add the scenario**

In `run`, after `cmd_psql`:

```bash
# Issues keys against the compose stack, for an operator who cannot reach the console: under
# `./run up` it binds 127.0.0.1 inside its own container, so no published port reaches it.
cmd_key() {
  need_docker
  [ $# -ge 2 ] ||
    die "Usage: ./run key <tenant> <preset>..." \
      "Presets: widget, site_backend, partner_channel, reporting, back_office"
  local tenant="$1"
  shift
  local args=(--tenant "$tenant")
  local preset
  for preset in "$@"; do args+=(--preset "$preset"); done
  docker compose run --rm --build app node dist/src/issue-keys.js "${args[@]}"
}
```

Dispatch, after the `psql)` line: `  key)         shift; cmd_key "$@" ;;`

Help, in the _Run_ group after `logs [svc]`: `  key <tenant> <preset>...  Issue API keys against the stack (prints them once)`

- [ ] **Step 2: Verify by hand**

Run: `./run up`, then `./run key "first run" back_office`, then
`curl -s -H "authorization: Bearer <the printed key>" http://localhost:3000/resources`.
Expected: one JSON line with a `back_office` key, then `[]` from the curl. Then `./run key`
with no arguments prints the usage and exits non-zero. If ports 3000 or 5433 are taken, record
the scenario as unverified in the ledger rather than freeing them.

- [ ] **Step 3: Rewrite the first run**

In `README.md`, replace from "Every request needs an API key, so make one." through "console running but not `BOOKING_KEY`." with:

````markdown
Every request needs an API key. Issue one against the stack you just started:

```bash
./run key "my tenant" back_office
```

It prints `{"tenantId":"…","keys":{"back_office":"bk_live_…"}}`. The key is shown once:

```bash
export BOOKING_KEY=bk_live_...
curl -H "authorization: Bearer $BOOKING_KEY" http://localhost:3000/resources
```

The console is not reachable under `./run up`: it binds `127.0.0.1` inside its own container,
so no published port reaches it. It is for `./run dev`, below, and so is `./run smoke`, which
issues its own key through the console.
````

Add a row to the command table under the sweep section, after the `worker.js --once` row:

```markdown
| `node dist/src/issue-keys.js` | Create a tenant and issue keys by preset, then exit | A test harness, an operator without the console |
```

and widen the table so Prettier keeps it aligned.

- [ ] **Step 4: Check and commit**

Run: `./run check`. Expected: passes, including `tests/unit/run-bootstrap.test.ts`, which runs `./run help`.

```bash
git add run README.md
git commit -m "feat: issue keys against the compose stack with ./run key"
```

---

### Task 3: The test helper

**Files:**

- Create: `testing/package.json`
- Create: `testing/tsconfig.json`
- Create: `testing/src/index.ts`
- Create: `tests/unit/helper-presets.test.ts`
- Create: `tests/integration/helper.test.ts`
- Modify: `tsconfig.json` — include `testing/src/**/*.ts`
- Modify: `package.json`, `package-lock.json` — `testcontainers` as an explicit dev dependency

**Interfaces:**

- Consumes: the image's `node dist/src/db/migrate.js`, `node dist/src/issue-keys.js` (Task 1), `node dist/src/server.js`.
- Produces: `startEngine(options?: EngineOptions): Promise<StartedEngine>`, `PRESET_NAMES`, `PresetName`, `CONTAINER_LABEL` from `testing/src/index.ts`.

- [ ] **Step 1: Make `testcontainers` a direct dependency**

The helper imports it, and today it is present only as a dependency of `@testcontainers/postgresql`.

Run: `npm install --save-dev testcontainers@^12.0.4`
Expected: `package.json` lists it under `devDependencies`; the lock file changes only in that entry's placement.

- [ ] **Step 2: Write the preset test**

`tests/unit/helper-presets.test.ts`:

```ts
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
```

- [ ] **Step 3: Write the helper's integration test**

`tests/integration/helper.test.ts`:

```ts
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { GenericContainer } from 'testcontainers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CONTAINER_LABEL, startEngine, type StartedEngine } from '../../testing/src/index.js'
import { aResource } from '../fixtures/resources.js'

/** Built from this checkout, so the helper is tested against the code beside it. */
const IMAGE = 'booking-engine:helper-test'
const REPO = fileURLToPath(new URL('../..', import.meta.url))

function stillRunning(): string[] {
  return execFileSync('docker', ['ps', '-q', '--filter', `label=${CONTAINER_LABEL}`], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter((line) => line.length > 0)
}

beforeAll(async () => {
  // Kept after the run, so later runs reuse the layer cache instead of rebuilding.
  await GenericContainer.fromDockerfile(REPO).build(IMAGE, { deleteOnExit: false })
}, 600_000)

describe('startEngine', () => {
  let engine: StartedEngine | undefined

  beforeAll(async () => {
    engine = await startEngine({
      image: IMAGE,
      keys: ['back_office', 'site_backend', 'reporting'],
      rateLimitPerMinute: 2,
    })
  }, 180_000)

  afterAll(async () => {
    await engine?.stop()
  })

  const call = (key: string | undefined, method: string, path: string, body?: unknown) =>
    fetch(`${engine!.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${key ?? ''}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })

  it('issues a back_office key that can create a resource', async () => {
    const response = await call(engine!.keys.back_office, 'POST', '/resources', aResource())
    expect(response.status).toBe(201)
  })

  it('issues a site_backend key that holds only its own scopes', async () => {
    const response = await call(engine!.keys.site_backend, 'POST', '/resources', aResource())
    expect(response.status).toBe(403)
    expect(((await response.json()) as { error: string }).error).toBe('forbidden_scope')
  })

  it('passes the rate limit through to the engine', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 3; i++) {
      statuses.push((await call(engine!.keys.reporting, 'GET', '/resources')).status)
    }
    expect(statuses).toEqual([200, 200, 429])
  })

  it('names the tenant every key belongs to', () => {
    expect(engine!.tenantId).toMatch(/^[0-9a-f-]{36}$/)
    expect(Object.keys(engine!.keys).sort()).toEqual(['back_office', 'reporting', 'site_backend'])
  })

  it('leaves nothing running after stop', async () => {
    await engine!.stop()
    engine = undefined
    expect(stillRunning()).toEqual([])
  }, 60_000)
})

describe('startEngine when a step fails', () => {
  it('rejects with the step output and leaves nothing running', async () => {
    await expect(startEngine({ image: IMAGE, tenant: '   ' })).rejects.toThrow(
      /issue-keys[\s\S]*blank/,
    )
    expect(stillRunning()).toEqual([])
  }, 180_000)
})
```

The failing step is a blank tenant rather than the spec's unknown preset: `keys` is typed
`PresetName[]`, so an unknown preset could only be passed through a cast, and both refusals take
the same path — `issue-keys` exits non-zero and the helper reports its output.

- [ ] **Step 4: Run both and see them fail**

Run: `npx vitest run tests/unit/helper-presets.test.ts tests/integration/helper.test.ts`
Expected: FAIL — `testing/src/index.js` cannot be resolved.

- [ ] **Step 5: Write the package files**

`testing/package.json`:

```json
{
  "name": "@alexeyvanyukevich/booking-engine-testing",
  "version": "0.0.0",
  "description": "Starts a pinned booking engine for a consumer's tests",
  "type": "module",
  "license": "UNLICENSED",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/AlexeyVanyukevich/booking-engine.git",
    "directory": "testing"
  },
  "engines": { "node": ">=24.0.0" },
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./package.json": "./package.json"
  },
  "files": ["dist"],
  "peerDependencies": {
    "@testcontainers/postgresql": "^12.0.0",
    "testcontainers": "^12.0.0"
  },
  "publishConfig": { "registry": "https://npm.pkg.github.com" }
}
```

`0.0.0` is never published: the release workflow stamps the tag's version over it.

`testing/tsconfig.json`:

```json
{
  "extends": "dev-kit/tsconfig/node",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "declaration": true
  },
  "include": ["src/**/*.ts"]
}
```

In the root `tsconfig.json`, add `"testing/src/**/*.ts"` to `include`, so `./run check` type-checks the helper.

- [ ] **Step 6: Write the helper**

`testing/src/index.ts`:

```ts
import { readFileSync } from 'node:fs'
import type { Readable } from 'node:stream'
import { PostgreSqlContainer } from '@testcontainers/postgresql'
import { GenericContainer, Network, Wait, type StartedNetwork } from 'testcontainers'

/**
 * Restated from the engine's `src/shared/scopes.ts`, because this package ships without the
 * engine's source. The engine's own suite asserts the two lists are equal.
 */
export const PRESET_NAMES = [
  'widget',
  'site_backend',
  'partner_channel',
  'reporting',
  'back_office',
] as const

export type PresetName = (typeof PRESET_NAMES)[number]

export interface EngineOptions {
  /** Presets to issue one key each for, on one tenant. Default `['back_office']`. */
  keys?: PresetName[]
  /** The tenant's name. Default `'tests'`. */
  tenant?: string
  /** Passed to the API as `RATE_LIMIT_PER_MINUTE`. Default: the engine's own default. */
  rateLimitPerMinute?: number
  /** Default: this package's own version of the engine's published image. */
  image?: string
}

export interface StartedEngine {
  url: string
  tenantId: string
  keys: Partial<Record<PresetName, string>>
  /** Stops the API, its database and their network. Safe to call twice. */
  stop(): Promise<void>
}

/** On every container the helper starts, so a caller can find any that outlived `stop()`. */
export const CONTAINER_LABEL = 'booking-engine-testing'

const REGISTRY_IMAGE = 'ghcr.io/alexeyvanyukevich/booking-engine'
const DB_ALIAS = 'engine-db'

/** The image tag is this package's version, so a consumer pins one version and gets both. */
function ownVersion(): string {
  const manifest: unknown = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  )
  if (
    typeof manifest === 'object' &&
    manifest !== null &&
    'version' in manifest &&
    typeof manifest.version === 'string'
  ) {
    return manifest.version
  }
  throw new Error('The helper could not read its own version from its package.json')
}

interface Stoppable {
  stop(): Promise<unknown>
}

export async function startEngine(options: EngineOptions = {}): Promise<StartedEngine> {
  const image = options.image ?? `${REGISTRY_IMAGE}:${ownVersion()}`
  const presets = options.keys ?? ['back_office']
  const tenant = options.tenant ?? 'tests'
  const labels = { [CONTAINER_LABEL]: 'true' }

  // Stopped newest first; emptied as it goes, so a second `stop()` does nothing.
  const started: Stoppable[] = []
  const stop = async (): Promise<void> => {
    for (const item of started.splice(0).reverse()) await item.stop()
  }

  try {
    const network = await new Network().start()
    started.push(network)

    const db = await new PostgreSqlContainer('postgres:16-alpine')
      .withNetwork(network)
      .withNetworkAliases(DB_ALIAS)
      .withLabels(labels)
      .start()
    started.push(db)
    const databaseUrl = `postgres://${db.getUsername()}:${db.getPassword()}@${DB_ALIAS}:5432/${db.getDatabase()}`
    const step = { image, network, labels, environment: { DATABASE_URL: databaseUrl } }

    await runOnce({ ...step, name: 'migrate', command: ['node', 'dist/src/db/migrate.js'] })
    const output = await runOnce({
      ...step,
      name: 'issue-keys',
      command: [
        'node',
        'dist/src/issue-keys.js',
        '--tenant',
        tenant,
        ...presets.flatMap((preset) => ['--preset', preset]),
      ],
    })
    const { tenantId, keys } = parseIssued(output)

    const environment: Record<string, string> = {
      DATABASE_URL: databaseUrl,
      LOG_LEVEL: 'warn',
      PORT: '3000',
    }
    if (options.rateLimitPerMinute !== undefined) {
      environment['RATE_LIMIT_PER_MINUTE'] = String(options.rateLimitPerMinute)
    }
    const api = await new GenericContainer(image)
      .withNetwork(network)
      .withEnvironment(environment)
      .withLabels(labels)
      .withExposedPorts(3000)
      .withWaitStrategy(Wait.forHttp('/health', 3000))
      .start()
    started.push(api)

    return { url: `http://${api.getHost()}:${api.getMappedPort(3000)}`, tenantId, keys, stop }
  } catch (error) {
    await stop()
    throw error
  }
}

interface OneShot {
  name: string
  image: string
  network: StartedNetwork
  labels: Record<string, string>
  environment: Record<string, string>
  command: string[]
}

/**
 * Runs the image once to completion and returns what it printed. Testcontainers removes a
 * container whose one-shot wait fails, so the output is collected while it runs, through the
 * log consumer, and is still there to explain the failure.
 */
async function runOnce(step: OneShot): Promise<string> {
  let output = ''
  let ended: Promise<void> = Promise.resolve()
  const container = new GenericContainer(step.image)
    .withNetwork(step.network)
    .withLabels(step.labels)
    .withEnvironment(step.environment)
    .withCommand(step.command)
    .withWaitStrategy(Wait.forOneShotStartup())
    .withLogConsumer((stream: Readable) => {
      ended = new Promise((resolve) => {
        stream.on('data', (chunk: Buffer | string) => {
          output += chunk.toString()
        })
        stream.on('end', () => resolve())
        stream.on('error', () => resolve())
      })
    })

  try {
    const finished = await container.start()
    await drained(ended)
    await finished.stop()
    return output
  } catch (error) {
    await drained(ended)
    throw new Error(`The engine's ${step.name} step failed:\n${output}`, { cause: error })
  }
}

/** The log stream ends when the container exits; a bound keeps a stuck stream from hanging. */
async function drained(ended: Promise<void>): Promise<void> {
  await Promise.race([ended, new Promise((resolve) => setTimeout(resolve, 5_000))])
}

function parseIssued(output: string): {
  tenantId: string
  keys: Partial<Record<PresetName, string>>
} {
  const line = output.split('\n').find((candidate) => candidate.startsWith('{"tenantId"'))
  if (line === undefined) throw new Error(`issue-keys printed no result:\n${output}`)
  return JSON.parse(line) as { tenantId: string; keys: Partial<Record<PresetName, string>> }
}
```

- [ ] **Step 7: Run both and see them pass**

Run: `npx vitest run tests/unit/helper-presets.test.ts tests/integration/helper.test.ts`
Expected: PASS, 7 tests. The first run builds the image and takes minutes.

- [ ] **Step 8: Check that the package builds as published**

Run: `npx tsc -p testing && ls testing/dist && rm -rf testing/dist`
Expected: `index.js` and `index.d.ts`, no errors. `testing/dist` is ignored by `.gitignore`'s `dist/` either way.

- [ ] **Step 9: Check and commit**

Run: `./run check`. Expected: passes.

```bash
git add testing tsconfig.json package.json package-lock.json tests/unit/helper-presets.test.ts tests/integration/helper.test.ts
git commit -m "feat: add a test helper that starts a pinned engine"
```

---

### Task 4: The release workflow

**Files:**

- Create: `.github/workflows/release.yml`

**Interfaces:**

- Consumes: `./run check`; `testing/` from Task 3; the `Dockerfile`.
- Produces: on a `vX.Y.Z` tag, `ghcr.io/alexeyvanyukevich/booking-engine:X.Y.Z` and `@alexeyvanyukevich/booking-engine-testing@X.Y.Z`.

- [ ] **Step 1: Write the workflow**

`.github/workflows/release.yml`:

```yaml
# A version tag on main publishes the engine's image and the test helper under the same
# version. Nothing is pushed unless the full check passes first.
name: release

on:
  push:
    tags: ['v*.*.*']

permissions:
  contents: read
  packages: write

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          registry-url: https://npm.pkg.github.com
          scope: '@alexeyvanyukevich'

      - name: The tag matches package.json
        run: |
          version="${GITHUB_REF_NAME#v}"
          declared="$(node -p "require('./package.json').version")"
          [ "$version" = "$declared" ] || {
            echo "Tag $GITHUB_REF_NAME does not match package.json version $declared" >&2
            exit 1
          }
          echo "VERSION=$version" >> "$GITHUB_ENV"

      - run: npm ci

      - run: ./run check

      - uses: docker/setup-qemu-action@v3
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - uses: docker/build-push-action@v6
        with:
          context: .
          platforms: linux/amd64,linux/arm64
          push: true
          tags: ghcr.io/alexeyvanyukevich/booking-engine:${{ env.VERSION }}

      - name: Publish the test helper
        working-directory: testing
        env:
          NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          npx tsc -p tsconfig.json
          npm version "$VERSION" --no-git-tag-version
          npm publish
```

- [ ] **Step 2: Check its syntax**

Run: `npx prettier --check .github/workflows/release.yml`
Expected: `All matched files use Prettier code style!` — Prettier parses YAML, so a syntax error fails here. This proves syntax only; the workflow's first real run is the first tag push, which is not part of this plan.

- [ ] **Step 3: Check and commit**

Run: `./run check` (Prettier formats YAML too). Expected: passes.

```bash
git add .github/workflows/release.yml
git commit -m "ci: publish the image and the test helper on a version tag"
```

---

### Task 5: Documents, and close the slice

**Files:**

- Modify: `README.md` — new section _Testing against the engine_
- Modify: `docs/architecture.md` — _Tenancy_ and the _Tenant_ table
- Modify: `docs/backlog.md` — delete the harness entry; add two entries
- Modify: `docs/superpowers/specs/2026-10-02-consumer-harness-design.md` — status line
- Move: this plan to `docs/superpowers/plans/archive/`

- [ ] **Step 1: README section**

Add before _Running both planes locally_:

````markdown
## Testing against the engine

A consumer's tests can run against a real engine, pinned to a release, with one call. Each
`vX.Y.Z` tag publishes the image `ghcr.io/alexeyvanyukevich/booking-engine:X.Y.Z` and the
helper `@alexeyvanyukevich/booking-engine-testing@X.Y.Z`; the helper starts exactly the image of
its own version.

GitHub Packages needs a token even to install. In the consumer's `.npmrc`:

```
@alexeyvanyukevich:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

with `GITHUB_TOKEN` a token holding `read:packages`, locally and in CI. The same token pulls the
image if it is private: `docker login ghcr.io`.

```ts
import { startEngine } from '@alexeyvanyukevich/booking-engine-testing'

const engine = await startEngine({
  keys: ['site_backend', 'back_office'],
  // The engine's default is 600 a minute per key. A suite that fires more than that from one
  // key is throttled exactly as production would throttle it, so set what the suite needs.
  rateLimitPerMinute: 10_000,
})
// engine.url, engine.tenantId, engine.keys.site_backend, engine.keys.back_office
await engine.stop()
```

It starts the engine's Postgres, runs its migrations, issues one key per preset on one tenant,
and starts the API, all on a private Docker network. `testcontainers` and
`@testcontainers/postgresql` are peer dependencies. Every container it starts carries the label
`booking-engine-testing`.
````

- [ ] **Step 2: Architecture**

In `docs/architecture.md`, _Tenancy_, append after the paragraph ending "hard-coded rather than configurable.":

```markdown
Where the console cannot be reached — a consumer's test harness, or the compose stack, where
the console's loopback bind leaves no published port that reaches it — `issue-keys` does the
same job as a one-shot command: it creates a tenant, issues one key per preset, prints them as
one JSON line and exits. It needs `DATABASE_URL`, the trust the migrator already has, and opens
no port. A version tag publishes the image and a test helper, `testing/`, that starts that
image's Postgres, migrations, `issue-keys` and API for a consumer's suite.
```

In the _Tenant_ section, change "Created only from the console; the engine never creates one." to "Created only from the console or `issue-keys`; the API never creates one."

Then run `grep -n -i "console" docs/conventions.md README.md` and correct every sentence that
says keys or tenants come _only_ from the console. The run is complete when no such sentence
remains; `issue-keys` is the second way.

- [ ] **Step 3: Backlog**

Delete the entry _There is no supported way to run the engine in a consumer's integration tests_. Add at the top:

```markdown
## Nothing runs the check on a pull request or a push to `main`

- Where: `.github/workflows/`, which holds only `release.yml`
- Found: 2026-10-02, while adding the release workflow
- Problem: CI runs `./run check` only when a version tag is pushed. A commit that breaks `main`
  is caught by whoever next runs the check locally, or by the next release.
- Impact: a release can be blocked by a failure introduced many commits earlier, and the rule
  that `main` always passes is enforced by habit alone.

## `./run smoke` cannot run against `./run up`

- Where: `scripts/smoke.ts`, `bootstrapKey()`; `docker-compose.yml`, the `console` service
- Found: 2026-10-02, while fixing the README's first run
- Problem: smoke issues its key through the console's forms at `CONSOLE_URL`. Under `./run up`
  the console binds `127.0.0.1` inside its container, so the published port reaches nothing and
  smoke fails before its first case. Run `./run up`, then `./run smoke`.
- Impact: the end-to-end check runs only against `./run dev`. Issuing its key with
  `issue-keys`, or through `./run key`, would let it run against both.
```

- [ ] **Step 4: Close the slice**

Change the spec's status line to `**Status:** implemented · **Date:** 2026-10-02`, adding an _As built_ note for any ruling that changed what the spec says. Then:

Run: `git mv docs/superpowers/plans/2026-10-02-consumer-harness.md docs/superpowers/plans/archive/ && ./run check`
Expected: passes.

```bash
git add -A README.md docs
git commit -m "docs: document the consumer test harness and archive its plan"
```
