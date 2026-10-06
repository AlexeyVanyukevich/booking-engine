export interface RecorderCase {
  name: string
  method: 'GET' | 'HEAD' | 'POST'
  url: string
  /** What the route declares: status → codes, or `null` for a success body. */
  declares: Record<number, string[] | null>
  /** Header names declared on each status. */
  declaredHeaders?: Record<number, string[]>
  reply: { status: number; error?: string; headers?: Record<string, string> }
  request?: { method: 'GET' | 'HEAD' | 'POST'; url: string }
  expected: string[]
}

export const recorderCases: RecorderCase[] = [
  {
    name: 'a declared success',
    method: 'GET',
    url: '/thing',
    declares: { 200: null },
    reply: { status: 200 },
    expected: [],
  },
  {
    name: 'an undeclared status',
    method: 'GET',
    url: '/thing',
    declares: { 200: null },
    reply: { status: 409, error: 'slot_unavailable' },
    expected: ['GET /thing answered 409, which it does not declare'],
  },
  {
    name: 'a code the status does not list',
    method: 'POST',
    url: '/thing',
    declares: { 409: ['slot_unavailable'] },
    reply: { status: 409, error: 'resource_inactive' },
    expected: ['POST /thing answered 409 resource_inactive; declares 409 as [slot_unavailable]'],
  },
  {
    name: 'a declared header missing from the reply',
    method: 'GET',
    url: '/thing',
    declares: { 429: ['rate_limited'] },
    declaredHeaders: { 429: ['retry-after'] },
    reply: { status: 429, error: 'rate_limited' },
    expected: ['GET /thing answered 429 without retry-after, which it declares'],
  },
  {
    name: 'a declared header present',
    method: 'GET',
    url: '/thing',
    declares: { 429: ['rate_limited'] },
    declaredHeaders: { 429: ['retry-after'] },
    reply: { status: 429, error: 'rate_limited', headers: { 'retry-after': '1' } },
    expected: [],
  },
  {
    name: 'a HEAD error, which carries no body to read a code from',
    method: 'GET',
    url: '/thing',
    declares: { 200: null, 409: ['slot_unavailable'] },
    request: { method: 'HEAD', url: '/thing' },
    reply: { status: 409, error: 'slot_unavailable' },
    expected: [],
  },
  {
    name: 'a path no route matches',
    method: 'GET',
    url: '/thing',
    declares: { 200: null },
    request: { method: 'GET', url: '/nothing-here' },
    reply: { status: 200 },
    expected: [],
  },
]
