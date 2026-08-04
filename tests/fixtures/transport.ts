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

export function httpTransport(baseUrl: string): Transport {
  return async ({ method, url, payload, headers }) => {
    const sendsBody = payload !== undefined
    const response = await fetch(`${baseUrl}${url}`, {
      method,
      headers: {
        ...(sendsBody ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: sendsBody
        ? typeof payload === 'string'
          ? payload
          : JSON.stringify(payload)
        : undefined,
    })

    const body = await response.text()
    return {
      statusCode: response.status,
      body,
      json: () => (body === '' ? undefined : JSON.parse(body)),
    }
  }
}
