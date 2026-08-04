/**
 * Every endpoint that takes a resource id must answer 404 when it does not exist — not 500,
 * and not 200 with an empty body. `{id}` is substituted with a syntactically valid UUID that
 * is guaranteed to be absent.
 */
export interface NotFoundCase {
  name: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  body?: unknown
  /** Some endpoints answer 404 only after their query string validates. */
  query?: string
}

export const notFoundCases: NotFoundCase[] = [
  { name: 'read a resource', method: 'GET', path: '/resources/{id}' },
  {
    name: 'patch a resource',
    method: 'PATCH',
    path: '/resources/{id}',
    body: { is_active: false },
  },
  { name: 'delete a resource', method: 'DELETE', path: '/resources/{id}' },
  { name: 'read a schedule', method: 'GET', path: '/resources/{id}/schedule' },
  { name: 'replace a schedule', method: 'PUT', path: '/resources/{id}/schedule', body: [] },
  {
    name: 'list exceptions',
    method: 'GET',
    path: '/resources/{id}/exceptions',
    query: '?from=2026-07-01&to=2026-08-01',
  },
  {
    name: 'put an exception',
    method: 'PUT',
    path: '/resources/{id}/exceptions/2026-07-20',
    body: { start_time: null, end_time: null },
  },
  {
    name: 'delete an exception',
    method: 'DELETE',
    path: '/resources/{id}/exceptions/2026-07-20',
  },
  {
    name: 'compute availability',
    method: 'GET',
    path: '/resources/{id}/availability',
    query: '?from=2026-07-20&to=2026-07-21',
  },
]

/** Paths that must answer 404 regardless of any resource. */
export const unknownRoutes = ['/nope', '/resources/x/y/z', '/health/deep'] as const
