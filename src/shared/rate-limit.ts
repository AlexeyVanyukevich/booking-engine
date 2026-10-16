import { normalizeIP } from '@fastify/rate-limit'

/**
 * The two fields of a request a store key is built from. A `FastifyRequest` satisfies it, and
 * a test can pass a plain object.
 */
export interface KeySource {
  headers: { authorization?: string | undefined }
  ip: string
}

/**
 * The per-key limiter counts requests with a credential and keyless calls to public routes in
 * one store, and the caller writes the `Authorization` header. The prefixes keep the two
 * apart: without them, `Authorization: 203.0.113.2` on `GET /health` would spend the count of
 * a keyless caller at that address.
 */
export function limiterKey(request: KeySource): string {
  const header = request.headers.authorization
  return header === undefined ? `address:${clientOf(request)}` : `key:${header}`
}

/**
 * Failed authentications are counted by address: the credential sent is the failure. The count
 * lives in a child store of its own, so its prefix only matters to a custom store whose
 * children share keys.
 */
export function failureKey(request: KeySource): string {
  return `auth-failures:${clientOf(request)}`
}

/**
 * The address a count belongs to, as the plugin's own key generator would have it: an IPv6
 * address by its /64, the ordinary size of one allocation, and an IPv4-mapped one as IPv4.
 * Counted raw, a client holding a /64 would get a fresh budget from each of its addresses.
 */
function clientOf(request: KeySource): string {
  return normalizeIP(request.ip)
}
