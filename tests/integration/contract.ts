import type { FastifyInstance } from 'fastify'
import { isDocsRoute } from '../../src/shared/auth.js'

/**
 * Every reply the integration suite receives, checked against the route's own response schema —
 * the object the OpenAPI document is generated from, so the two cannot disagree. A status the
 * route does not declare, a code its status does not list, or a declared header the reply lacks
 * is recorded here; `contract.setup.ts` fails the test that drew it.
 *
 * Only replies to documented operations are checked: an unmatched path, the docs tree and hidden
 * routes are no operation in the document.
 */

interface DeclaredResponse {
  properties?: { error?: { enum?: readonly string[] } }
  headers?: Record<string, unknown>
}

const mismatches: string[] = []

/** Returns what has been recorded since the last call, and forgets it. */
export function takeContractMismatches(): string[] {
  return mismatches.splice(0)
}

function errorCodeOf(payload: unknown): string | undefined {
  if (typeof payload !== 'string') return undefined
  try {
    const body: unknown = JSON.parse(payload)
    if (typeof body !== 'object' || body === null || !('error' in body)) return undefined
    return typeof body.error === 'string' ? body.error : undefined
  } catch {
    return undefined
  }
}

export function recordContract(app: FastifyInstance): void {
  app.addHook('onSend', async (request, reply, payload) => {
    const url = request.routeOptions.url
    const schema = request.routeOptions.schema as
      { hide?: boolean; response?: Record<string, DeclaredResponse> } | undefined
    if (url === undefined || isDocsRoute(url) || schema === undefined || schema.hide === true) {
      return payload
    }

    const where = `${request.method} ${url}`
    const status = reply.statusCode
    const declared = schema.response?.[String(status)]
    if (declared === undefined) {
      mismatches.push(`${where} answered ${status}, which it does not declare`)
      return payload
    }

    const codes = declared.properties?.error?.enum
    // A HEAD reply carries no body, so there is no code to read.
    if (codes !== undefined && request.method !== 'HEAD') {
      const code = errorCodeOf(payload)
      if (code === undefined || !codes.includes(code)) {
        mismatches.push(
          `${where} answered ${status} ${code ?? '(no code)'}; declares ${status} as [${codes.join(', ')}]`,
        )
      }
    }

    for (const header of Object.keys(declared.headers ?? {})) {
      if (reply.getHeader(header) === undefined) {
        mismatches.push(`${where} answered ${status} without ${header}, which it declares`)
      }
    }
    return payload
  })
}
