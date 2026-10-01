import type { Api } from '../api.js'
import type { ResourcePayload } from '../resources.js'
import type { Transport } from '../transport.js'

/**
 * A case the smoke run could not execute — not a pass and not a failure. Some states the
 * engine can reach are out of reach over HTTP alone, and counting those as passes would
 * inflate the reported check count with checks that never ran.
 */
export interface Skipped {
  /** Why the case could not be executed, shown next to it in the output. */
  skipped: string
}

/** `null` passed, a `Skipped` never ran, and a string explains the mismatch. */
export type CaseResult = string | null | Skipped

export function skip(reason: string): Skipped {
  return { skipped: reason }
}

export function isSkipped(result: CaseResult): result is Skipped {
  return typeof result === 'object' && result !== null
}

/**
 * A suite pairs a dataset with the way to execute one of its cases. The smoke runner knows
 * nothing else: it iterates suites, so covering a new area means adding a suite file and one
 * line in `index.ts`, never touching the runner.
 */
export interface Suite<TCase> {
  /** Shown as a heading, and matched against the filter argument. */
  name: string
  cases: readonly TCase[]
  /** One line describing the case, shown per check. */
  describe: (testCase: TCase) => string
  run: (context: SuiteContext, testCase: TCase) => Promise<CaseResult>
}

/** One case of a suite with the case already applied: what the runner executes. */
export interface Check {
  describe: string
  run: (context: SuiteContext) => Promise<CaseResult>
}

/**
 * A suite with its case type sealed in. Suites over different case types cannot share one list
 * as `Suite<T>` — `T` is both read (`cases`) and written (`describe`, `run`), so no single `T`
 * fits them all short of `any`. The list holds what the runner needs instead: the name, and
 * each case bound to its own `describe` and `run`.
 */
export interface SealedSuite {
  name: string
  checks: readonly Check[]
}

export function seal<TCase>(suite: Suite<TCase>): SealedSuite {
  return {
    name: suite.name,
    checks: suite.cases.map((testCase) => ({
      describe: suite.describe(testCase),
      run: (context) => suite.run(context, testCase),
    })),
  }
}

export interface SuiteContext {
  api: Api
  /** The raw transport, for cases the typed client deliberately cannot express. */
  send: Transport
  /**
   * Creates a resource and records it for removal at the end of the run, so smoke against a
   * development database leaves nothing behind.
   */
  newResource: (payload: ResourcePayload) => Promise<string>
  /** Records an id created by other means for the same cleanup. */
  track: (id: string) => void
}

export interface Response {
  statusCode: number
  body: string
  json: () => any
}

export function expectStatus(response: Response, wanted: number): string | null {
  return response.statusCode === wanted
    ? null
    : `expected ${wanted}, got ${response.statusCode}: ${response.body.slice(0, 200)}`
}

export function expectError(response: Response, code: string): string | null {
  if (response.statusCode !== 400) {
    return `expected 400 ${code}, got ${response.statusCode}: ${response.body.slice(0, 200)}`
  }
  const actual = response.json()?.error
  return actual === code ? null : `expected error "${code}", got "${actual}"`
}

export function expectFields(response: Response, wanted: Record<string, unknown>): string | null {
  const body = response.json()
  for (const [field, value] of Object.entries(wanted)) {
    if (body[field] !== value) return `${field}: expected ${value}, got ${body[field]}`
  }
  return null
}

/** Helper for suites whose cases are labelled `intraday` or `day`. */
export type ResourceKind = 'intraday' | 'day'
