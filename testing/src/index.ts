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
