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
