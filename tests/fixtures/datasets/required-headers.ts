/** One response's `headers` as `@fastify/swagger` writes them, and as the lift must leave them. */
export interface LiftCase {
  name: string
  headers: Record<string, unknown> | undefined
  expected: Record<string, unknown> | undefined
}

export const liftCases: LiftCase[] = [
  {
    name: 'moves required from the schema onto the header',
    headers: {
      'x-ratelimit-limit': { schema: { type: 'integer', required: true }, description: 'Limit' },
    },
    expected: {
      'x-ratelimit-limit': { schema: { type: 'integer' }, description: 'Limit', required: true },
    },
  },
  {
    name: 'leaves a header with no required as it is',
    headers: { 'x-ratelimit-limit': { schema: { type: 'integer' }, description: 'Limit' } },
    expected: { 'x-ratelimit-limit': { schema: { type: 'integer' }, description: 'Limit' } },
  },
  {
    name: 'lifts each header of a response on its own',
    headers: {
      'retry-after': { schema: { type: 'integer', required: true }, description: 'Wait' },
      'x-ratelimit-limit': { schema: { type: 'integer' }, description: 'Limit' },
    },
    expected: {
      'retry-after': { schema: { type: 'integer' }, description: 'Wait', required: true },
      'x-ratelimit-limit': { schema: { type: 'integer' }, description: 'Limit' },
    },
  },
  {
    name: 'leaves a response with no headers as it is',
    headers: undefined,
    expected: undefined,
  },
]
