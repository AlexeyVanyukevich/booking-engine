import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Kysely } from 'kysely'
import { buildApp } from '../../src/app.js'
import { loadAppConfig, loadConfig } from '../../src/config.js'
import type { Database } from '../../src/db/schema.js'
import * as errors from '../../src/shared/errors.js'
import { SCOPES, type Scope } from '../../src/shared/scopes.js'
import { tableWithHeader, unwrap } from '../fixtures/markdown.js'

/**
 * The documents restate three things the code already states exactly once: which environment
 * variables exist and what they default to, which error codes the engine can emit, and which
 * endpoints it serves. Each of those tables is a copy, and two of them had drifted before these
 * tests existed — a missing `CONSOLE_PORT` row, four undocumented framework error codes.
 *
 * Prose that cannot be checked is proof-read by hand or not at all. These three can be checked,
 * so they are.
 */

const CONVENTIONS = '../../docs/conventions.md'
const README = '../../README.md'
const KIT_HTTP_RULE = '../../node_modules/dev-kit/rules/http.md'

function camelCase(variable: string): string {
  const [first, ...rest] = variable.toLowerCase().split('_')
  return first + rest.map((word) => word[0]!.toUpperCase() + word.slice(1)).join('')
}

describe('the configuration table in conventions.md', () => {
  const table = tableWithHeader(CONVENTIONS, 'Variable', 'Default', 'Meaning')
  const documented = new Map(table.rows.map((row) => [unwrap(row[0]!), unwrap(row[1]!)]))

  // Every default has one home, `loadAppConfig`. Reading it with an empty environment is what
  // the OpenAPI generator does for the same reason: it is the defaults, and nothing ambient.
  const defaults = loadAppConfig({})

  it('documents every variable the loader reads, and no others', () => {
    const documentedNames = [...documented.keys()].filter((name) => name !== 'DATABASE_URL')
    expect(documentedNames.map(camelCase).sort()).toEqual(Object.keys(defaults).sort())
  })

  it('states the connection string as required, and it is', () => {
    expect(documented.get('DATABASE_URL')).toBe('required')
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/)
    // Everything else has a default, which is what lets the generator build the app with none.
    expect(() => loadAppConfig({})).not.toThrow()
  })

  it('gives each variable the default the loader actually applies', () => {
    for (const [variable, documentedDefault] of documented) {
      if (variable === 'DATABASE_URL') continue
      const actual = defaults[camelCase(variable) as keyof typeof defaults]
      expect(String(actual), variable).toBe(documentedDefault)
    }
  })

  it('agrees with .env.example on names and values', () => {
    const example = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8')
    const entries = new Map(
      example
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('#'))
        .map((line) => {
          const index = line.indexOf('=')
          return [line.slice(0, index), line.slice(index + 1)] as const
        }),
    )

    expect([...entries.keys()].sort()).toEqual([...documented.keys()].sort())

    for (const [variable, value] of entries) {
      // The example carries a real connection string where the table says "required".
      if (variable === 'DATABASE_URL') continue
      expect(value, variable).toBe(documented.get(variable))
    }
  })
})

describe('the error table in conventions.md', () => {
  const table = tableWithHeader(CONVENTIONS, 'Code', 'Status', 'Meaning')
  const documented = new Set(table.rows.map((row) => `${unwrap(row[0]!)} ${unwrap(row[1]!)}`))

  /**
   * Every code the engine can put in an `error` field: one per `AppError` subclass, plus the
   * framework 4xx translations, plus the one the handler builds directly.
   * `FALLBACK_CLIENT_ERROR_CODE` is absent on purpose — it has no fixed status, so it is
   * documented in prose instead, which the last case here asserts.
   */
  function emitted(): Map<string, { status: number; meaning: string }> {
    const codes = new Map<string, { status: number; meaning: string }>()

    for (const exported of Object.values(errors)) {
      if (typeof exported !== 'function') continue
      if (!(exported.prototype instanceof errors.AppError)) continue
      const instance = new (exported as new (message: string) => errors.AppError)('probe')
      codes.set(instance.code, { status: instance.statusCode, meaning: instance.meaning })
    }

    for (const [status, description] of Object.entries(errors.CLIENT_ERRORS)) {
      codes.set(description.code, { status: Number(status), meaning: description.meaning })
    }

    codes.set(errors.INTERNAL_ERROR.code, { status: 500, meaning: errors.INTERNAL_ERROR.meaning })
    return codes
  }

  const pairs = (codes: Map<string, { status: number }>) =>
    [...codes].map(([code, { status }]) => `${code} ${status}`)

  it('documents every code the engine can emit, at the status it emits it', () => {
    expect([...documented].sort()).toEqual(pairs(emitted()).sort())
  })

  /**
   * The meaning is stated once, on the class, and read from there by the OpenAPI document; this
   * column is the copy, so it is held equal rather than proof-read.
   */
  it('gives every code the meaning the code states', () => {
    const meanings = new Map(table.rows.map((row) => [unwrap(row[0]!), row[2]!]))
    for (const [code, { meaning }] of emitted()) {
      expect(meanings.get(code), code).toBe(meaning)
    }
  })

  it('explains the fallback code, which has no status of its own', () => {
    const prose = readFileSync(new URL(CONVENTIONS, import.meta.url), 'utf8')
    expect(prose).toContain(`\`${errors.FALLBACK_CLIENT_ERROR_CODE}\``)
    expect(documented.has(`${errors.FALLBACK_CLIENT_ERROR_CODE} 400`)).toBe(false)
  })

  /**
   * CLAUDE.md imports the shared `http.md` rule, whose own table is loaded beside this one. A
   * shared code the engine never emits is a standing instruction an agent will follow, so each
   * must be listed as a departure with what the engine answers instead — and only those, so a
   * departure the engine later closes cannot linger as a stale row.
   */
  it('lists every shared code the engine does not emit as a departure, and nothing else', () => {
    const shared = tableWithHeader(KIT_HTTP_RULE, 'Code', 'Status', 'Meaning').rows.map((row) =>
      unwrap(row[0]!),
    )
    const emittedCodes = new Set(emitted().keys())
    emittedCodes.add(errors.FALLBACK_CLIENT_ERROR_CODE)

    const departures = tableWithHeader(CONVENTIONS, 'Shared code', 'Shared status', 'This engine')
    const listed = departures.rows.map((row) => unwrap(row[0]!))

    expect(listed.sort()).toEqual(shared.filter((code) => !emittedCodes.has(code)).sort())
  })
})

describe('the scope table in conventions.md', () => {
  const table = tableWithHeader(CONVENTIONS, 'Scope', 'Routes')
  const documented = table.rows.map((row) => unwrap(row[0]!))

  /**
   * The Routes column stays prose — "`POST` / `PATCH` / `DELETE /resources`", "every
   * `POST /bookings/:id/...`" — because spelling all twenty out would make it unreadable for
   * the person it is written for. So the routes themselves are not diffed here; that a route
   * requires the scope it claims to is asserted by TC-SCP-03 in `auth.test.ts`, against the
   * running engine.
   *
   * What is checked is the vocabulary: a scope the routes require and the table omits, a
   * scope documented that no route uses, and drift from `SCOPES`.
   */
  async function scopesInUse(): Promise<Set<string>> {
    const app = await buildApp({
      config: { ...loadAppConfig({}), logLevel: 'silent' },
      // No handler runs while routes register, so no query is built and nothing is
      // dereferenced — the same reason the OpenAPI generator needs no connection.
      db: {} as Kysely<Database>,
    })
    try {
      await app.ready()
      return new Set(
        app.routeAuthorizations
          .map((route) => route.scope)
          .filter((scope): scope is Scope => scope !== undefined),
      )
    } finally {
      await app.close()
    }
  }

  it('documents every scope the routes require, and no scope nothing requires', async () => {
    expect(documented.sort()).toEqual([...(await scopesInUse())].sort())
  })

  it('agrees with the scope vocabulary', () => {
    expect(documented.sort()).toEqual([...SCOPES].sort())
  })
})

describe('the endpoint table in README.md', () => {
  const table = tableWithHeader(README, 'Method', 'Path', 'Purpose')

  it('lists exactly the operations the committed document describes', () => {
    const listed = table.rows
      .map((row) => {
        const path = unwrap(row[1]!)
          .split('?')[0]!
          .replace(/:(\w+)/g, '{$1}')
        return `${row[0]!.toUpperCase()} ${path}`
      })
      .sort()

    const document = JSON.parse(
      readFileSync(new URL('../../openapi.json', import.meta.url), 'utf8'),
    ) as { paths: Record<string, Record<string, unknown>> }

    const served = Object.entries(document.paths)
      .flatMap(([path, operations]) =>
        Object.keys(operations).map((method) => `${method.toUpperCase()} ${path}`),
      )
      .sort()

    expect(listed).toEqual(served)
  })
})
