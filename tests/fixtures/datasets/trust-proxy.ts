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
