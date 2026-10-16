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
  // The plugin's own key generator groups IPv6 by /64, the ordinary size of one allocation; a
  // client holding a /64 would otherwise get a fresh count from each of its 2^64 addresses.
  {
    name: 'an IPv6 failure is counted by its /64',
    count: 'failure',
    request: { headers: {}, ip: '2001:db8::abcd' },
    expected: 'auth-failures:2001:db8::',
  },
  {
    name: 'another address in the same /64 shares that count',
    count: 'failure',
    request: { headers: {}, ip: '2001:db8::1' },
    expected: 'auth-failures:2001:db8::',
  },
  {
    name: 'the next /64 is another count',
    count: 'failure',
    request: { headers: {}, ip: '2001:db8:0:1::1' },
    expected: 'auth-failures:2001:db8:0:1::',
  },
  {
    name: 'an IPv4-mapped address is counted as its IPv4 form',
    count: 'failure',
    request: { headers: {}, ip: '::ffff:203.0.113.1' },
    expected: 'auth-failures:203.0.113.1',
  },
  {
    name: 'a keyless IPv6 request is counted by its /64',
    count: 'limiter',
    request: { headers: {}, ip: '2001:db8::abcd' },
    expected: 'address:2001:db8::',
  },
]
