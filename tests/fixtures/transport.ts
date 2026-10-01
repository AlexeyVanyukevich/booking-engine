/**
 * The `Api` client works over any transport that looks like this. Two exist:
 *
 * - `injectTransport` — Fastify's `app.inject`, used by the integration tests. No socket.
 * - `httpTransport`   — real HTTP against a running engine, used by `./run smoke`.
 *
 * One client and one set of datasets then drive both, so a case added to a dataset is
 * automatically covered in the test suite *and* in the smoke run.
 */
export interface TransportRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  url: string
  payload?: unknown
  headers?: Record<string, string>
}

export interface TransportResponse {
  statusCode: number
  body: string
  json: () => any
}

export type Transport = (request: TransportRequest) => Promise<TransportResponse>

interface Injectable {
  inject: (request: TransportRequest) => Promise<TransportResponse>
}

export function injectTransport(app: Injectable): Transport {
  return (request) => app.inject(request)
}

/**
 * Adds `Authorization` to every request that does not already carry one.
 *
 * The header is fetched per request rather than captured once, because the key is reissued
 * after each truncation — a value captured at construction would name a tenant that no longer
 * exists. A request that sets its own header wins, so a case can still probe a wrong key.
 */
export function withAuthorization(
  transport: Transport,
  header: () => string | undefined,
): Transport {
  return (request) => {
    const authorization = header()
    if (authorization === undefined || request.headers?.authorization !== undefined) {
      return transport(request)
    }
    return transport({ ...request, headers: { authorization, ...request.headers } })
  }
}

export function httpTransport(baseUrl: string): Transport {
  return async ({ method, url, payload, headers }) => {
    const sendsBody = payload !== undefined
    const response = await fetch(`${baseUrl}${url}`, {
      method,
      headers: {
        ...(sendsBody ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: sendsBody ? (typeof payload === 'string' ? payload : JSON.stringify(payload)) : null,
    })

    const body = await response.text()
    return {
      statusCode: response.status,
      body,
      json: () => (body === '' ? undefined : JSON.parse(body)),
    }
  }
}
