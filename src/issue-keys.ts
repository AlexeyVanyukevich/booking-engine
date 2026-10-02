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
    err(`${explain(error)}\n`)
    return 1
  }
}

/** An engine refusal is a message for the operator; anything else keeps its stack. */
function explain(error: unknown): string {
  if (error instanceof AppError) return error.message
  if (error instanceof Error) return error.stack ?? error.message
  return String(error)
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
