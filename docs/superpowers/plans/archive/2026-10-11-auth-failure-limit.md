# Failed authentication and unmatched paths are counted — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Count failed authentications per client address and refuse an address past its limit before any key lookup; count a valid key's requests to unmatched paths; let the operator name trusted proxies so the address counted is the client's.

**Architecture:** Two new settings in `src/config.ts`. Store keys for every count come from one pure module, `src/shared/rate-limit.ts`, each prefixed so a caller-written header cannot name another count's key. The failure count is a second limiter from `@fastify/rate-limit`'s own `createRateLimit()`, sharing the plugin's store, read and incremented by the authentication hook. The not-found handler opts in to the per-key limiter with `preHandler: app.rateLimit()`.

**Tech Stack:** Fastify 5, `@fastify/rate-limit` 11.2 (its `LocalStore` implements `read`), TypeBox, Vitest, Testcontainers.

**Spec:** [docs/superpowers/specs/2026-10-11-auth-failure-limit-design.md](../specs/2026-10-11-auth-failure-limit-design.md)

## Global Constraints

- `AUTH_FAILURES_PER_MINUTE`, default `30`; `TRUST_PROXY`, default empty.
- Every `401` counts as a failure; a `403` does not — the key was valid.
- The failure refusal is `429 rate_limited` with `Retry-After`, message "Too many failed authentications from this address", and **no** `x-ratelimit-*` header.
- Store keys: `key:<header>`, `address:<ip>`, `auth-failures:<ip>`.
- `TRUST_PROXY` accepts IPv4/IPv6 addresses, optionally `/prefix` within range; nothing else.
- `NodeNext`: every relative import in `src/` and `tests/` carries `.js`.
- Test data lives in datasets under `tests/fixtures/datasets/`, not in test bodies.
- Commits: `type(scope): subject`, ≤ 72 characters, **subject only — no body, no trailer**.
- Before every commit: `git branch --show-current` prints `fix/auth-failure-limit`, and `./run check` passes. If `helper.test.ts` fails on containers labelled `booking-engine-testing=true` that this run did not start (`docker ps --filter label=booking-engine-testing=true`), another project's suite is running: wait for it and re-run.
- A single test file runs with `npx vitest run <path>`; integration files need Docker.

## Review Focus

1. **A refused address is served again once its minute ends, and not a second before** — Task 3, the window cases (59 s refused, 60 s served).
2. **A valid key without the route's scope is not a failure** — its `403`s must not spend the address's budget. Task 3, the `narrow` row.
3. **A client behind a trusted proxy cannot choose its own address** by prepending to `X-Forwarded-For` — the rightmost untrusted entry is the client. Task 1, the chain row.
4. **A refused address still reaches public routes** — `/health` keeps answering `200`. Task 3, the `/health` row.
5. **`Retry-After` on any `429` is between 1 and 60** — never `0`, never past the window. Tasks 1 and 3, asserted by the scenario runner on every `429`.

Known and not tested, recorded in the backlog by Task 5: concurrent failures from one address all read the count before any of them increments it, so a burst of _n_ parallel requests can cost up to `max + n − 1` lookups.

---

### Task 1: `TRUST_PROXY` — the address counted is the client's

**Files:**

- Modify: `src/config.ts`, `src/app.ts` (the `Fastify({...})` options)
- Create: `tests/fixtures/datasets/trust-proxy.ts`
- Modify: `tests/unit/config.test.ts`, `tests/fixtures/datasets/rate-limit.ts`, `tests/integration/rate-limit.test.ts`, `tests/integration/helpers.ts`
- Modify: `docs/conventions.md` (configuration table), `.env.example`, `docker-compose.yml`

**Interfaces:**

- Produces: `AppConfig.trustProxy: string[]`. In `tests/fixtures/datasets/rate-limit.ts`: `ADDRESS_A`, `ADDRESS_B`, `CLIENT_X`, `CLIENT_Y` (strings), `interface LimitedRequest { caller; from?; path?; forwardedFor? }`, and `RateLimitScenario.config: Partial<AppConfig>` replacing `limit`.

- [ ] **Step 1: Write the configuration dataset**

Create `tests/fixtures/datasets/trust-proxy.ts`:

```ts
export interface AcceptedTrustProxy {
  name: string
  raw: string | undefined
  expected: string[]
}

export interface RefusedTrustProxy {
  name: string
  raw: string
}

export const acceptedTrustProxy: AcceptedTrustProxy[] = [
  { name: 'unset', raw: undefined, expected: [] },
  { name: 'empty', raw: '', expected: [] },
  { name: 'blank', raw: '   ', expected: [] },
  { name: 'one IPv4 address', raw: '10.0.0.1', expected: ['10.0.0.1'] },
  { name: 'an IPv4 CIDR', raw: '10.0.0.0/8', expected: ['10.0.0.0/8'] },
  { name: 'the widest IPv4 prefix', raw: '10.0.0.1/32', expected: ['10.0.0.1/32'] },
  { name: 'an IPv6 CIDR', raw: 'fd00::/8', expected: ['fd00::/8'] },
  { name: 'the widest IPv6 prefix', raw: '::1/128', expected: ['::1/128'] },
  {
    name: 'a list with spaces around its items',
    raw: '10.0.0.1, 192.168.0.0/16 ,::1',
    expected: ['10.0.0.1', '192.168.0.0/16', '::1'],
  },
]

export const refusedTrustProxy: RefusedTrustProxy[] = [
  { name: 'not an address', raw: 'not-an-ip' },
  { name: 'an IPv4 prefix past 32', raw: '10.0.0.1/33' },
  { name: 'an IPv6 prefix past 128', raw: '::1/129' },
  { name: 'a prefix that is not a number', raw: '10.0.0.0/x' },
  { name: 'two prefixes', raw: '10.0.0.0/8/8' },
  { name: 'an empty item in a list', raw: '10.0.0.1,,10.0.0.2' },
  // Fastify would accept it; the loader does not, so a typo cannot widen the trust.
  { name: 'a name Fastify understands', raw: 'loopback' },
]
```

- [ ] **Step 2: Write the failing configuration tests**

In `tests/unit/config.test.ts`, add `trustProxy: []` as the last property of both `toEqual` objects in `describe('loadConfig')`, import the dataset, and append:

```ts
import { acceptedTrustProxy, refusedTrustProxy } from '../fixtures/datasets/trust-proxy.js'

describe('TRUST_PROXY', () => {
  it.each(acceptedTrustProxy)('accepts $name', ({ raw, expected }) => {
    const env = raw === undefined ? base : { ...base, TRUST_PROXY: raw }
    expect(loadConfig(env).trustProxy).toEqual(expected)
  })

  it.each(refusedTrustProxy)('refuses $name', ({ raw }) => {
    expect(() => loadConfig({ ...base, TRUST_PROXY: raw })).toThrow(/TRUST_PROXY/)
  })
})
```

(`base` is declared further up the file; place the block after it.)

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run tests/unit/config.test.ts`
Expected: FAIL — `trustProxy` is `undefined`, and the refusals do not throw.

- [ ] **Step 4: Implement the loader**

In `src/config.ts`, add `import { isIP } from 'node:net'` at the top, add to `AppConfig` after `rateLimitPerMinute`:

```ts
  /** Proxies whose `X-Forwarded-For` names the client. Empty: the socket peer is the client. */
  trustProxy: string[]
```

Add after `booleanFlag`:

```ts
/**
 * Addresses and CIDRs only. Fastify also accepts names such as `loopback`, but a list the
 * loader can check entry by entry is one a typo cannot widen.
 */
function proxyList(env: NodeJS.ProcessEnv, key: string): string[] {
  const raw = env[key]
  if (raw === undefined || raw.trim() === '') return []
  return raw.split(',').map((item) => {
    const entry = item.trim()
    if (!isProxyEntry(entry)) {
      throw new Error(`Invalid configuration: ${key} must list addresses or CIDRs, got "${entry}"`)
    }
    return entry
  })
}

function isProxyEntry(entry: string): boolean {
  const [address = '', prefix, ...rest] = entry.split('/')
  const family = isIP(address)
  if (family === 0 || rest.length > 0) return false
  if (prefix === undefined) return true
  if (!/^\d{1,3}$/.test(prefix)) return false
  return Number(prefix) <= (family === 4 ? 32 : 128)
}
```

And in `loadAppConfig`, after `rateLimitPerMinute`:

```ts
    trustProxy: proxyList(env, 'TRUST_PROXY'),
```

- [ ] **Step 5: Document the setting so the table test passes**

`tests/unit/documented-tables.test.ts` asserts the configuration table and `.env.example` against `loadAppConfig({})`; `String([])` is `''`, so the default cell is empty.

In `docs/conventions.md`, add after the `RATE_LIMIT_PER_MINUTE` row (Prettier pads the columns):

```markdown
| `TRUST_PROXY` | | Comma-separated addresses or CIDRs of the reverse proxies in front of the API. `X-Forwarded-For` from them names the client the rate limits count; empty, the socket peer is the client |
```

Append to `.env.example`:

```
TRUST_PROXY=
```

In `docker-compose.yml`, under the `app` service's `environment`, after `RATE_LIMIT_PER_MINUTE`:

```yaml
TRUST_PROXY: ${TRUST_PROXY:-}
```

In `tests/integration/helpers.ts`, `buildTestApp`, add after `rateLimitPerMinute: 100_000,`:

```ts
      trustProxy: [],
```

Run: `npx vitest run tests/unit/config.test.ts tests/unit/documented-tables.test.ts`
Expected: PASS

- [ ] **Step 6: Reshape the rate-limit dataset so a request can name its address**

In `tests/fixtures/datasets/rate-limit.ts`, add at the top:

```ts
import type { AppConfig } from '../../../src/config.js'

/**
 * Socket peers and forwarded clients, from the ranges RFC 5737 reserves for documentation, so
 * no row can be mistaken for a real host.
 */
export const ADDRESS_A = '203.0.113.1'
export const ADDRESS_B = '203.0.113.2'
export const CLIENT_X = '198.51.100.1'
export const CLIENT_Y = '198.51.100.2'

export interface LimitedRequest {
  caller: Caller
  /** The socket peer. Default `ADDRESS_A`. */
  from?: string
  /** Default `/resources`. */
  path?: string
  /** Sent as `X-Forwarded-For`. */
  forwardedFor?: string
}
```

Replace the `RateLimitScenario` interface with:

```ts
export interface RateLimitScenario {
  name: string
  /** Laid over `buildTestApp`'s defaults, which are high enough never to throttle. */
  config: Partial<AppConfig>
  /** A bare caller is a request from `ADDRESS_A` to `/resources`. */
  requests: Array<Caller | LimitedRequest>
  /** The status each request in `requests` answers, in the same order. */
  expected: number[]
}
```

In every existing row, replace `limit: N,` with `config: { rateLimitPerMinute: N },`. Then append these rows to `rateLimitScenarios`:

```ts
  {
    name: 'a public route called without a key is counted by address',
    config: { rateLimitPerMinute: 1 },
    requests: [
      { caller: 'anonymous', path: '/health' },
      { caller: 'anonymous', path: '/health', from: ADDRESS_B },
      { caller: 'anonymous', path: '/health' },
    ],
    expected: [200, 200, 429],
  },
  {
    name: 'X-Forwarded-For from an untrusted peer is ignored',
    config: { rateLimitPerMinute: 1 },
    requests: [
      { caller: 'anonymous', path: '/health', forwardedFor: CLIENT_X },
      { caller: 'anonymous', path: '/health', forwardedFor: CLIENT_Y },
    ],
    expected: [200, 429],
  },
  {
    name: "a trusted proxy's X-Forwarded-For names the client",
    config: { rateLimitPerMinute: 1, trustProxy: [ADDRESS_A] },
    requests: [
      { caller: 'anonymous', path: '/health', forwardedFor: CLIENT_X },
      { caller: 'anonymous', path: '/health', forwardedFor: CLIENT_Y },
      { caller: 'anonymous', path: '/health', forwardedFor: CLIENT_X },
    ],
    expected: [200, 200, 429],
  },
  // The client writes the left of the header and the proxy appends the right; only the rightmost
  // entry a trusted hop added can be believed.
  {
    name: 'a client behind a trusted proxy cannot choose its address',
    config: { rateLimitPerMinute: 1, trustProxy: [ADDRESS_A] },
    requests: [
      { caller: 'anonymous', path: '/health', forwardedFor: CLIENT_X },
      { caller: 'anonymous', path: '/health', forwardedFor: `${CLIENT_Y}, ${CLIENT_X}` },
    ],
    expected: [200, 429],
  },
```

- [ ] **Step 7: Teach the runner to send them**

In `tests/integration/rate-limit.test.ts`, import `ADDRESS_A` and `type LimitedRequest` from the dataset, and replace the body of the first `it.each`:

```ts
it.each(rateLimitScenarios)('$name', async ({ config, requests, expected }) => {
  const callers = await seedCallers()
  const app = await buildTestApp(config)
  try {
    const statuses: number[] = []
    for (const request of requests) {
      const spec: LimitedRequest = typeof request === 'string' ? { caller: request } : request
      const { caller, from = ADDRESS_A, path = '/resources', forwardedFor } = spec
      const response = await app.inject({
        method: 'GET',
        url: path,
        remoteAddress: from,
        headers: {
          ...callers[caller],
          ...(forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor }),
        },
      })
      statuses.push(response.statusCode)
      if (response.statusCode === 429) {
        expect(response.json()).toEqual({ error: 'rate_limited', message: expect.any(String) })
        expect(response.headers['retry-after']).toMatch(/^[1-9]\d*$/)
        expect(Number(response.headers['retry-after'])).toBeLessThanOrEqual(60)
      }
    }
    expect(statuses).toEqual(expected)
  } finally {
    await app.close()
  }
})
```

- [ ] **Step 8: Run it to see the trusted-proxy rows fail**

Run: `npx vitest run tests/integration/rate-limit.test.ts`
Expected: FAIL on "a trusted proxy's X-Forwarded-For names the client" (`[200, 429, 429]`); the other rows pass.

- [ ] **Step 9: Pass the list to Fastify**

In `src/app.ts`, in the `Fastify({...})` options after `ajv`:

```ts
    // The rate limits count by `request.ip`. Behind a reverse proxy that is the proxy, so every
    // caller would share one count; naming the proxy lets its `X-Forwarded-For` name the client.
    trustProxy: deps.config.trustProxy.length > 0 ? deps.config.trustProxy : false,
```

- [ ] **Step 10: Run the file again**

Run: `npx vitest run tests/integration/rate-limit.test.ts`
Expected: PASS

- [ ] **Step 11: Check and commit**

```bash
git branch --show-current   # fix/auth-failure-limit
./run check
git add src/config.ts src/app.ts tests/fixtures/datasets/trust-proxy.ts tests/fixtures/datasets/rate-limit.ts tests/unit/config.test.ts tests/integration/rate-limit.test.ts tests/integration/helpers.ts docs/conventions.md .env.example docker-compose.yml
git commit -m "feat(config): count the client behind a trusted proxy, not the proxy"
```

---

### Task 2: Store keys a caller cannot forge

**Files:**

- Create: `src/shared/rate-limit.ts`, `tests/fixtures/datasets/store-keys.ts`, `tests/unit/rate-limit.test.ts`
- Modify: `src/app.ts` (the `@fastify/rate-limit` registration)

**Interfaces:**

- Produces: `interface KeySource { headers: { authorization?: string | undefined }; ip: string }`, `limiterKey(request: KeySource): string`, `failureKey(request: KeySource): string` — Task 3 passes `failureKey` to `createRateLimit`.

- [ ] **Step 1: Write the dataset**

Create `tests/fixtures/datasets/store-keys.ts`:

```ts
import type { KeySource } from '../../../src/shared/rate-limit.js'

export interface StoreKeyCase {
  name: string
  /** Which count the key is for: the per-key limiter, or failed authentications. */
  count: 'limiter' | 'failure'
  request: KeySource
  expected: string
}

export const storeKeyCases: StoreKeyCase[] = [
  {
    name: 'a request with a credential is counted by it',
    count: 'limiter',
    request: { headers: { authorization: 'Bearer bk_live_abc' }, ip: '203.0.113.1' },
    expected: 'key:Bearer bk_live_abc',
  },
  {
    name: 'a request without one is counted by address',
    count: 'limiter',
    request: { headers: {}, ip: '203.0.113.1' },
    expected: 'address:203.0.113.1',
  },
  {
    name: 'an empty header is still a credential, not an address',
    count: 'limiter',
    request: { headers: { authorization: '' }, ip: '203.0.113.1' },
    expected: 'key:',
  },
  {
    name: 'a failed authentication is counted by address, whatever it sent',
    count: 'failure',
    request: { headers: { authorization: 'Bearer garbage' }, ip: '203.0.113.1' },
    expected: 'auth-failures:203.0.113.1',
  },
  {
    name: 'a header spelling a failure key stays a credential',
    count: 'limiter',
    request: { headers: { authorization: 'auth-failures:203.0.113.1' }, ip: '198.51.100.1' },
    expected: 'key:auth-failures:203.0.113.1',
  },
  {
    name: 'a header spelling an address key stays a credential',
    count: 'limiter',
    request: { headers: { authorization: 'address:203.0.113.1' }, ip: '198.51.100.1' },
    expected: 'key:address:203.0.113.1',
  },
]
```

- [ ] **Step 2: Write the failing test**

Create `tests/unit/rate-limit.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { failureKey, limiterKey } from '../../src/shared/rate-limit.js'
import { storeKeyCases, type StoreKeyCase } from '../fixtures/datasets/store-keys.js'

const keyFor = ({ count, request }: StoreKeyCase): string =>
  count === 'limiter' ? limiterKey(request) : failureKey(request)

describe('rate-limit store keys', () => {
  it.each(storeKeyCases)('$name', (row) => {
    expect(keyFor(row)).toBe(row.expected)
  })

  // The rows that spell another count's key in a header are what make this more than a
  // restatement: without the prefixes, two of them would collide.
  it('gives no two rows the same key', () => {
    const keys = storeKeyCases.map(keyFor)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
```

- [ ] **Step 3: Run it to see it fail**

Run: `npx vitest run tests/unit/rate-limit.test.ts`
Expected: FAIL — cannot resolve `../../src/shared/rate-limit.js`.

- [ ] **Step 4: Implement**

Create `src/shared/rate-limit.ts`:

```ts
/**
 * The two fields of a request a store key is built from. A `FastifyRequest` satisfies it, and
 * a test can pass a plain object.
 */
export interface KeySource {
  headers: { authorization?: string | undefined }
  ip: string
}

/**
 * Every count shares the limiter's store, and the caller writes the `Authorization` header. A
 * prefix only the engine writes is what stops a header from naming another count's key:
 * without it, `Authorization: auth-failures:203.0.113.1` on a public route would spend that
 * address's failure budget.
 */
export function limiterKey(request: KeySource): string {
  const header = request.headers.authorization
  return header === undefined ? `address:${request.ip}` : `key:${header}`
}

/** Failed authentications are counted by address: the credential sent is the failure. */
export function failureKey(request: KeySource): string {
  return `auth-failures:${request.ip}`
}
```

In `src/app.ts`, import `{ limiterKey } from './shared/rate-limit.js'`, set `keyGenerator: limiterKey,` in the `fastifyRateLimit` registration, and in the comment above it replace "What is counted is keyed on the raw header, or on the address for a public route called without one." with "What is counted is keyed on the header, or on the address for a public route called without one — see `limiterKey` for why each key is prefixed."

- [ ] **Step 5: Run the unit test and the rate-limit suite**

Run: `npx vitest run tests/unit/rate-limit.test.ts tests/integration/rate-limit.test.ts`
Expected: PASS

- [ ] **Step 6: Check and commit**

```bash
git branch --show-current   # fix/auth-failure-limit
./run check
git add src/shared/rate-limit.ts src/app.ts tests/fixtures/datasets/store-keys.ts tests/unit/rate-limit.test.ts
git commit -m "refactor(rate-limit): prefix each store key with what it counts"
```

---

### Task 3: Refuse an address that keeps failing authentication

**Files:**

- Modify: `src/config.ts`, `src/shared/auth.ts`, `src/shared/errors.ts` (`RateLimitedError.meaning`), `src/shared/responses.ts` (`LIMITER_REACH`), `src/app.ts` (`openapiDocument` description)
- Modify: `tests/unit/config.test.ts`, `tests/fixtures/datasets/rate-limit.ts`, `tests/integration/rate-limit.test.ts`, `tests/fixtures/datasets/response-rules.ts`, `tests/fixtures/datasets/documented-headers.ts`, `tests/integration/openapi.test.ts`, `tests/integration/helpers.ts`, `tests/ui/global-setup.ts`
- Modify: `docs/conventions.md` (configuration table, error table), `.env.example`, `docker-compose.yml`, `openapi.json` (regenerated)

**Interfaces:**

- Consumes: `failureKey` from Task 2; `LimitedRequest`, `ADDRESS_A`, `ADDRESS_B` from Task 1.
- Produces: `AppConfig.authFailuresPerMinute: number`; `Caller` gains `'unknown' | 'narrow' | 'forged'`; `CountedReplyCase` gains `config?: Partial<AppConfig>` and `before?: Caller[]` — Task 4 adds a row using neither.

- [ ] **Step 1: Write the failing configuration tests**

In `tests/unit/config.test.ts`: add `authFailuresPerMinute: 30` after `rateLimitPerMinute: 600` in both `toEqual` objects; in the test "defaults the console port and the per-key rate limit" add `expect(config.authFailuresPerMinute).toBe(30)`; in "reads the console port and the rate limit from the environment" add `AUTH_FAILURES_PER_MINUTE: '5'` to the environment and `expect(config.authFailuresPerMinute).toBe(5)`; and add two rows to the `rejects %s=%s` table:

```ts
  ['AUTH_FAILURES_PER_MINUTE', '0'],
  ['AUTH_FAILURES_PER_MINUTE', 'many'],
```

- [ ] **Step 2: Write the failing integration rows**

In `tests/fixtures/datasets/rate-limit.ts`, widen `Caller`:

```ts
/**
 * Who sends a request. `first` and `second` are two keys on one tenant, which is what shows the
 * per-key limit is counted per key and not per tenant. `narrow` is a valid key without
 * `resources.read`. `malformed` could never have been issued; `unknown` is well formed and was
 * not. `forged` spells the failure key of `ADDRESS_A` in its header.
 */
export type Caller =
  'first' | 'second' | 'narrow' | 'malformed' | 'unknown' | 'anonymous' | 'forged'
```

Delete the comment beginning "Authentication is an application-level `onRequest` hook…" and the two rows "a malformed key is rejected without being counted" and "a request with no key is rejected without being counted". Append:

```ts
  {
    name: 'a malformed key is refused once its address has failed too often',
    config: { authFailuresPerMinute: 2 },
    requests: ['malformed', 'malformed', 'malformed'],
    expected: [401, 401, 429],
  },
  {
    name: 'a well-formed key never issued is refused the same way',
    config: { authFailuresPerMinute: 2 },
    requests: ['unknown', 'unknown', 'unknown'],
    expected: [401, 401, 429],
  },
  {
    name: 'a request with no key is refused the same way',
    config: { authFailuresPerMinute: 2 },
    requests: ['anonymous', 'anonymous', 'anonymous'],
    expected: [401, 401, 429],
  },
  {
    name: 'an unmatched path without a key counts as a failure',
    config: { authFailuresPerMinute: 2 },
    requests: [
      { caller: 'anonymous', path: '/nope' },
      { caller: 'anonymous', path: '/nope' },
      { caller: 'anonymous', path: '/nope' },
    ],
    expected: [401, 401, 429],
  },
  {
    name: 'a refused address is refused a valid key too',
    config: { authFailuresPerMinute: 2 },
    requests: ['malformed', 'malformed', 'first'],
    expected: [401, 401, 429],
  },
  {
    name: 'the same valid key from another address is served',
    config: { authFailuresPerMinute: 2 },
    requests: ['malformed', 'malformed', { caller: 'first', from: ADDRESS_B }],
    expected: [401, 401, 200],
  },
  {
    name: "one address's failures leave another's count untouched",
    config: { authFailuresPerMinute: 2 },
    requests: ['malformed', 'malformed', { caller: 'malformed', from: ADDRESS_B }],
    expected: [401, 401, 401],
  },
  {
    name: "a valid key's requests add nothing to the failure count",
    config: { authFailuresPerMinute: 2 },
    requests: ['first', 'first', 'first', 'malformed', 'malformed', 'malformed'],
    expected: [200, 200, 200, 401, 401, 429],
  },
  {
    name: 'a valid key without the scope is not a failure',
    config: { authFailuresPerMinute: 1 },
    requests: ['narrow', 'narrow', 'malformed'],
    expected: [403, 403, 401],
  },
  {
    name: 'a refused address still reaches a public route',
    config: { authFailuresPerMinute: 1 },
    requests: ['malformed', { caller: 'anonymous', path: '/health' }, 'first'],
    expected: [401, 200, 429],
  },
  {
    name: "a header spelling an address's failure key does not spend it",
    config: { authFailuresPerMinute: 1 },
    requests: [
      { caller: 'forged', path: '/health' },
      { caller: 'forged', path: '/health' },
      'first',
    ],
    expected: [200, 200, 200],
  },
  {
    name: 'behind a trusted proxy, failures are counted per client',
    config: { authFailuresPerMinute: 1, trustProxy: [ADDRESS_A] },
    requests: [
      { caller: 'malformed', forwardedFor: CLIENT_X },
      { caller: 'first', forwardedFor: CLIENT_Y },
      { caller: 'first', forwardedFor: CLIENT_X },
    ],
    expected: [401, 200, 429],
  },
```

Append the window cases and their type:

```ts
export interface FailureWindowCase {
  name: string
  /** Seconds after the failure that used the address's budget up. */
  waitSeconds: number
  /** What a valid key from that address answers then. */
  expected: number
}

/** The budget is one failure; the window is the plugin's minute. */
export const failureWindowCases: FailureWindowCase[] = [
  { name: 'a second before the minute ends it is still refused', waitSeconds: 59, expected: 429 },
  { name: 'once the minute ends it is served again', waitSeconds: 60, expected: 200 },
]
```

Widen `CountedReplyCase`:

```ts
  /** Laid over `buildTestApp`'s defaults. */
  config?: Partial<AppConfig>
  /** Sent from the same address first, their answers ignored. */
  before?: Caller[]
```

and append to `countedReplyCases`:

```ts
  // The per-key headers describe a key's budget; this refusal is of an address.
  {
    name: 'a refusal of an address that failed authentication',
    caller: 'first',
    before: ['malformed'],
    config: { authFailuresPerMinute: 1 },
    method: 'GET',
    url: '/resources',
    status: 429,
    counted: false,
  },
```

- [ ] **Step 3: Teach the suite the new callers, the window and the warm-up**

In `tests/integration/rate-limit.test.ts`, add `import { generateKey } from '../../src/modules/tenants/api-key.js'` and `vi`, `afterEach` from `vitest`; import `ADDRESS_A`, `failureWindowCases` from the dataset. Replace `seedCallers`:

```ts
async function seedCallers(): Promise<Record<Caller, Record<string, string>>> {
  const { tenantId, authHeader } = await seedTenant()
  const service = new TenantService(new TenantRepository(getTestDb()))
  const { secret } = await service.issueKey(tenantId, 'second', [...SCOPES])
  const narrow = await service.issueKey(tenantId, 'narrow', ['bookings.read'])
  return {
    first: authHeader,
    second: { authorization: `Bearer ${secret}` },
    narrow: { authorization: `Bearer ${narrow.secret}` },
    malformed: { authorization: 'Bearer garbage' },
    unknown: { authorization: `Bearer ${generateKey().key}` },
    anonymous: {},
    forged: { authorization: `auth-failures:${ADDRESS_A}` },
  }
}
```

Replace the body of the `countedReplyCases` test:

```ts
it.each(countedReplyCases)(
  '$name',
  async ({ caller, method, url, status, counted, config = {}, before = [] }) => {
    const callers = await seedCallers()
    const app = await buildTestApp(config)
    try {
      for (const earlier of before) {
        await app.inject({ method, url, remoteAddress: ADDRESS_A, headers: callers[earlier] })
      }
      const response = await app.inject({
        method,
        url,
        remoteAddress: ADDRESS_A,
        headers: callers[caller],
      })
      expect(response.statusCode).toBe(status)
      for (const header of LIMITER_HEADER_NAMES) {
        expect(response.headers[header] !== undefined, header).toBe(counted)
      }
    } finally {
      await app.close()
    }
  },
)
```

Append:

```ts
describe('the failure window', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  // Only `Date` is faked: the plugin's store reads `Date.now()`, and the database driver and
  // Fastify keep their real timers.
  it.each(failureWindowCases)('$name', async ({ waitSeconds, expected }) => {
    const callers = await seedCallers()
    const app = await buildTestApp({ authFailuresPerMinute: 1 })
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const send = (caller: Caller) =>
        app.inject({
          method: 'GET',
          url: '/resources',
          remoteAddress: ADDRESS_A,
          headers: callers[caller],
        })
      expect((await send('malformed')).statusCode).toBe(401)
      vi.setSystemTime(Date.now() + waitSeconds * 1000)
      expect((await send('first')).statusCode).toBe(expected)
    } finally {
      await app.close()
    }
  })
})
```

In `tests/integration/helpers.ts`, `buildTestApp`, add after `rateLimitPerMinute: 100_000,`:

```ts
      // The same, for suites that send bad keys on purpose; the count itself is asserted in
      // tests/integration/rate-limit.test.ts.
      authFailuresPerMinute: 100_000,
```

In `tests/ui/global-setup.ts`, add to the `loadConfig` environment after `RATE_LIMIT_PER_MINUTE`:

```ts
    AUTH_FAILURES_PER_MINUTE: '100000',
```

- [ ] **Step 4: Run them to see them fail**

Run: `npx vitest run tests/unit/config.test.ts tests/integration/rate-limit.test.ts`
Expected: FAIL — Vitest does not type-check, so the failures are at run time: `authFailuresPerMinute` is `undefined` in the configuration tests, the failure rows answer `401` where `429` is expected, and "a refusal of an address that failed authentication" answers `200`.

- [ ] **Step 5: Add the setting**

In `src/config.ts`, add to `AppConfig` after `rateLimitPerMinute`:

```ts
authFailuresPerMinute: number
```

and to `loadAppConfig` after `rateLimitPerMinute`:

```ts
    authFailuresPerMinute: positiveInt(env, 'AUTH_FAILURES_PER_MINUTE', 30),
```

In `docs/conventions.md`, add after the `RATE_LIMIT_PER_MINUTE` row:

```markdown
| `AUTH_FAILURES_PER_MINUTE` | `30` | Failed authentications one client address may make per minute, per API process; past it every request from that address that needs a key is answered `429 rate_limited` before the key is looked up |
```

Add `AUTH_FAILURES_PER_MINUTE=30` to `.env.example` after `RATE_LIMIT_PER_MINUTE`, and to `docker-compose.yml` after the `RATE_LIMIT_PER_MINUTE` line:

```yaml
AUTH_FAILURES_PER_MINUTE: ${AUTH_FAILURES_PER_MINUTE:-30}
```

- [ ] **Step 6: Count failures in the authentication hook**

In `src/shared/auth.ts`, change the imports to:

```ts
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { ForbiddenScopeError, RateLimitedError, UnauthorizedError } from './errors.js'
import { failureKey } from './rate-limit.js'
```

In `registerAuth`, before the `onRequest` hook, add:

```ts
/**
 * Failed authentications, counted per address. Authentication runs before the per-key limiter,
 * so without this a caller holding no credential could make the engine look a key up once per
 * request, without limit. Only failures count, so a consumer's valid traffic never spends this
 * budget; every kind of failure counts alike, as every kind answers alike. It shares the
 * limiter's store, which is why its key is prefixed.
 */
const failures = app.createRateLimit({
  max: app.config.authFailuresPerMinute,
  keyGenerator: failureKey,
})

async function failed(request: FastifyRequest): Promise<UnauthorizedError> {
  await failures(request)
  // One message for every failure, so a caller cannot tell "no such key" from "wrong secret"
  // and turn prefix enumeration into a probe.
  return new UnauthorizedError('A valid API key is required')
}
```

Change the hook's signature to `async (request, reply) =>` and replace everything from `const header = request.headers.authorization` through `if (resolved === undefined) throw …` with:

```ts
// Read before anything else, so a refused address costs no lookup. `remaining`, not the
// plugin's `isExceeded`: a read never takes the count past `max`, so `isExceeded` would let
// one more failure through to the database.
const seen = await failures(request, { increment: false })
if (!seen.isAllowed && seen.remaining === 0) {
  void reply.header('retry-after', String(seen.ttlInSeconds))
  throw new RateLimitedError('Too many failed authentications from this address')
}

const header = request.headers.authorization
const match = header === undefined ? null : BEARER.exec(header)
if (match === null) throw await failed(request)

const resolved = await service.authenticate(match[1]!)
if (resolved === undefined) throw await failed(request)
```

- [ ] **Step 7: Describe the refusal**

In `src/shared/errors.ts`, `RateLimitedError`:

```ts
  readonly meaning =
    'The per-key limit for this minute is used up, or this address has failed authentication too often; carries `Retry-After`'
```

In `docs/conventions.md`'s error table, replace the `rate_limited` row's meaning with the same text (`tests/unit/documented-tables.test.ts` asserts them equal; Prettier re-pads the table).

In `src/shared/responses.ts`, replace the `LIMITER_REACH` comment and table:

```ts
/**
 * Where a code is answered relative to the limiter. Authentication is an application-level
 * `onRequest` hook and the limiter a route-level one, which Fastify runs after it, so what
 * authentication throws is answered before the request is counted. `internal_error` comes from
 * either side: a failing key lookup, or a failing handler. `rate_limited` too: the limiter's own
 * refusal is counted, and authentication's refusal of an address that keeps failing is not.
 * Every other code, and every success, is answered after.
 */
const LIMITER_REACH: Record<string, 'before' | 'either'> = {
  unauthorized: 'before',
  forbidden_scope: 'before',
  internal_error: 'either',
  rate_limited: 'either',
}
```

A public route's `429` can only come from the limiter, so there the three are in fact always present; it declares them without `required` all the same, because `LIMITER_REACH` is per code, not per route. True, and weaker than it could be — the spec chose one rule for `429`.

- [ ] **Step 8: Update the header expectations**

In `tests/fixtures/datasets/response-rules.ts`: rename the row "the limiter's refusal carries retry-after and the three" to "a refusal carries retry-after, and the three only when the limiter wrote it", and replace every `429: { 'retry-after': true, ...COUNTED }` — five occurrences — with `429: { 'retry-after': true, ...SOMETIMES_COUNTED }`.

In `tests/fixtures/datasets/documented-headers.ts`, replace both `429` rows' `headers` with `{ 'retry-after': true, ...SOMETIMES_COUNTED }`.

- [ ] **Step 9: State the rule in the document**

In `src/app.ts`, `openapiDocument`, replace the last paragraph passed to `md(...)` with:

```ts
        'Every reply the rate limiter has counted carries `x-ratelimit-limit`, `x-ratelimit-remaining` and `x-ratelimit-reset`, so a caller can pace itself before it is refused. A `401` or `403` is answered before the request is counted and carries none of them; a `500` carries them only when the failure came after it.',
        `An address that fails authentication ${config.authFailuresPerMinute} times in a minute is refused \`429\` with \`Retry-After\` and none of the three, whatever key it sends next, until the minute ends.`,
```

In `tests/integration/openapi.test.ts`, add `'fails authentication'` to the list of phrases in "states the conventions a caller cannot guess".

Run: `./run openapi`

- [ ] **Step 10: Run the affected files**

Run: `npx vitest run tests/unit tests/integration/rate-limit.test.ts tests/integration/openapi.test.ts tests/integration/shared-responses.test.ts tests/integration/auth.test.ts`
Expected: PASS

- [ ] **Step 11: Check and commit**

```bash
git branch --show-current   # fix/auth-failure-limit
./run check
git add src/config.ts src/shared/auth.ts src/shared/errors.ts src/shared/responses.ts src/app.ts openapi.json tests/unit/config.test.ts tests/fixtures/datasets/rate-limit.ts tests/integration/rate-limit.test.ts tests/fixtures/datasets/response-rules.ts tests/fixtures/datasets/documented-headers.ts tests/integration/openapi.test.ts tests/integration/helpers.ts tests/ui/global-setup.ts docs/conventions.md .env.example docker-compose.yml
git commit -m "fix(auth): refuse an address that keeps failing authentication"
```

---

### Task 4: Count a valid key's requests to unmatched paths

**Files:**

- Modify: `src/shared/errors.ts` (`registerErrorHandler`), `src/app.ts` (registration order)
- Modify: `tests/fixtures/datasets/rate-limit.ts`, `docs/backlog.md`

**Interfaces:**

- Consumes: the `RateLimitScenario` and `CountedReplyCase` shapes from Tasks 1 and 3.

- [ ] **Step 1: Write the failing rows**

Append to `rateLimitScenarios`:

```ts
  {
    name: 'a valid key is counted on an unmatched path',
    config: { rateLimitPerMinute: 1 },
    requests: [
      { caller: 'first', path: '/nope' },
      { caller: 'first', path: '/nope' },
    ],
    expected: [404, 429],
  },
  {
    name: 'an unmatched path spends the same budget as a route',
    config: { rateLimitPerMinute: 2 },
    requests: [{ caller: 'first', path: '/nope' }, 'first', 'first'],
    expected: [404, 200, 429],
  },
```

and to `countedReplyCases`:

```ts
  {
    name: 'an unmatched path with a valid key',
    caller: 'first',
    method: 'GET',
    url: '/nope',
    status: 404,
    counted: true,
  },
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/integration/rate-limit.test.ts`
Expected: FAIL — the unmatched rows answer `[404, 404]` and `[404, 200, 200]`, and the `404` carries no limiter header.

- [ ] **Step 3: Count the not-found handler**

In `src/shared/errors.ts`, replace the `setNotFoundHandler` call:

```ts
// An unmatched path has no route, so no route hook, and the limiter never sees it unless the
// handler opts in. Authentication has already run, so only a valid key arrives here, and it is
// counted like any other request that key sends. Needs `@fastify/rate-limit` registered first.
app.setNotFoundHandler({ preHandler: app.rateLimit() }, (_request, reply) => {
  void reply.status(404).send({ error: 'not_found', message: 'Route not found' })
})
```

In `src/app.ts`, move `registerErrorHandler(app)` from before the limiter to directly after `await app.register(fastifyRateLimit, {...})`, with:

```ts
// After the limiter: the not-found handler counts through its `rateLimit()` decorator. Routes
// register later, so every one still inherits this error handler.
registerErrorHandler(app)
```

- [ ] **Step 4: Run the suite**

Run: `npx vitest run tests/integration/rate-limit.test.ts tests/integration/error-handler.test.ts`
Expected: PASS

- [ ] **Step 5: Delete the fixed backlog entry**

In `docs/backlog.md`, delete the whole entry "Requests the limiter never sees: rejected keys and unmatched paths". The fix is complete with this commit.

- [ ] **Step 6: Check and commit**

```bash
git branch --show-current   # fix/auth-failure-limit
./run check
git add src/shared/errors.ts src/app.ts tests/fixtures/datasets/rate-limit.ts docs/backlog.md
git commit -m "fix(rate-limit): count a valid key's requests to unmatched paths"
```

---

### Task 5: Documents, backlog, and the plan archived

**Files:**

- Modify: `docs/conventions.md`, `docs/architecture.md`, `README.md`, `docs/backlog.md`, `docs/superpowers/specs/2026-10-11-auth-failure-limit-design.md` (status line only)
- Move: this plan to `docs/superpowers/plans/archive/`

- [ ] **Step 1: `docs/conventions.md`**

In "Authentication and scopes", after the paragraph ending "…cannot quietly admit any key.", add:

```markdown
Failed authentication is counted per client address, at `AUTH_FAILURES_PER_MINUTE`. Every
`401` counts alike; a `403` does not, because the key was valid. Once an address has used its
budget, every request from it that needs a key is answered `429 rate_limited` with
`Retry-After` before the key is looked up — a valid key included, since telling it is valid
would take the lookup the refusal exists to save — until the minute ends. Public routes are not
affected. The count lives in the rate limiter's store, under a prefix no header can spell, so a
caller cannot spend another address's budget.

Behind a reverse proxy every caller arrives from the proxy's address, and would share one
count. `TRUST_PROXY` names the proxies whose `X-Forwarded-For` is believed; the client is the
rightmost entry a trusted hop did not add, so a client cannot choose its address by writing
the header itself.
```

In "Documentation is generated, never written twice", replace the sentence beginning "`@fastify/rate-limit` writes `x-ratelimit-limit`…" through "…declares them without `required`." with:

```markdown
`@fastify/rate-limit` writes `x-ratelimit-limit`, `x-ratelimit-remaining` and
`x-ratelimit-reset` on every request it counts — unmatched paths included, through the
not-found handler — and it counts after authentication, so every success and every error
status declares the three as required, with four exceptions. `401` and `403` are answered
before the count and declare none. `500` — answered before the count by a failing key lookup,
after it by a failing handler — and `429` — the limiter's own refusal carries them,
authentication's refusal of an address does not — declare them without `required`.
```

- [ ] **Step 2: `docs/architecture.md`**

After the sentence ending "…the rules are in [conventions.md](conventions.md#authentication-and-scopes)." (line 34–35), add:

```markdown
Authentication runs before the per-key rate limiter, so a rejected key is never counted
against a key; failed authentications are counted per client address instead, and an address
past `AUTH_FAILURES_PER_MINUTE` is refused before its key is looked up.
```

- [ ] **Step 3: `README.md`**

As the last subsection of `## Running` — after `### The console`, before `## Testing against the engine` — add:

```markdown
### Behind a reverse proxy

Both rate limits count by client address, and behind a proxy every request arrives from the
proxy. Set `TRUST_PROXY` to the proxy's address or CIDR — a comma-separated list for several
hops — and its `X-Forwarded-For` names the client. Left empty, one caller sending bad keys
would have every caller behind the same proxy refused for up to a minute.
```

- [ ] **Step 4: `docs/backlog.md`**

Add at the top, newest first:

```markdown
## Concurrent failed authentications can pass the address's limit

- Where: `src/shared/auth.ts`, the `onRequest` hook — the failure count is read, then the key
  looked up, then the count incremented
- Found: 2026-10-11, while planning the failed-authentication limit
- Problem: _n_ requests from one address sent at once all read the count before any of them
  increments it, so each reaches the key lookup. Send 100 bad keys in parallel with
  `AUTH_FAILURES_PER_MINUTE=30`: up to 100 lookups run, not 30.
- Impact: the bound is `max + n − 1` per burst, not `max`. Sequential traffic is held exactly.
  Incrementing before the lookup and refunding on success would close it; the plugin's store has
  no decrement.

## The test helper cannot raise the failed-authentication limit

- Where: `testing/src/index.ts`, `EngineOptions`
- Found: 2026-10-11, while planning the failed-authentication limit
- Problem: the helper passes `RATE_LIMIT_PER_MINUTE` through but not `AUTH_FAILURES_PER_MINUTE`.
  Every request a consumer's suite sends reaches the API container from one address, so a suite
  sending more than 30 bad keys a minute gets `429` where it expects `401`.
- Impact: a consumer testing its own handling of a rejected key many times in one file is
  throttled, with no option to say otherwise. An `authFailuresPerMinute` option, passed as the
  variable, would close it.

## A public route's count can be reset by changing the header

- Where: `src/shared/rate-limit.ts`, `limiterKey()`
- Found: 2026-10-11, while designing the failed-authentication limit
- Problem: a request carrying an `Authorization` header is counted by it, even on a public route
  that never reads it. A caller sending `GET /health` with a different made-up header each time
  gets a fresh count each time and is never refused.
- Impact: low — `/health` is cheap, and the plugin's in-memory store holds at most 5 000 keys,
  so the rotation cannot grow memory. Counting public routes by address alone would close it.
```

- [ ] **Step 5: Mark the spec implemented**

In `docs/superpowers/specs/2026-10-11-auth-failure-limit-design.md`, change `**Status:** approved` to `**Status:** implemented`.

- [ ] **Step 6: Archive this plan**

```bash
git mv docs/superpowers/plans/2026-10-11-auth-failure-limit.md docs/superpowers/plans/archive/
```

- [ ] **Step 7: Check and commit**

```bash
git branch --show-current   # fix/auth-failure-limit
./run check
git add docs/conventions.md docs/architecture.md README.md docs/backlog.md docs/superpowers/specs/2026-10-11-auth-failure-limit-design.md docs/superpowers/plans
git commit -m "docs: record how failed authentication is counted, and archive the plan"
```
