import { createHash, randomInt, timingSafeEqual } from 'node:crypto'

export const KEY_MARKER = 'bk_live_'
const PREFIX_LENGTH = 8
const SECRET_LENGTH = 43
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/**
 * `randomInt` rather than `randomBytes` and a modulo: a modulo over 256 is biased towards the
 * first 8 characters of a 62-character alphabet, and `randomInt` rejects out-of-range draws
 * for us. 43 base62 characters carry roughly 256 bits.
 */
function randomString(length: number): string {
  let out = ''
  for (let i = 0; i < length; i += 1) out += ALPHABET[randomInt(ALPHABET.length)]
  return out
}

/**
 * SHA-256 rather than argon2 or bcrypt. Those are slow on purpose because human passwords have
 * little entropy and must survive an offline attack; this secret has 256 bits from a CSPRNG and
 * there is no search to slow down. A per-request argon2 would add ~100ms to every call to the
 * engine to defend against an attack that cannot succeed either way.
 */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}

export function generateKey(): { key: string; prefix: string; hash: string } {
  const prefix = randomString(PREFIX_LENGTH)
  const secret = randomString(SECRET_LENGTH)
  return { key: `${KEY_MARKER}${prefix}${secret}`, prefix, hash: hashSecret(secret) }
}

// Anchored with \A and \z semantics: JavaScript's `$` also matches before a trailing newline,
// which would let `…secret\n` parse as a valid key.
const KEY_PATTERN = new RegExp(
  `^${KEY_MARKER}([A-Za-z0-9]{${PREFIX_LENGTH}})([A-Za-z0-9]{${SECRET_LENGTH}})$`,
)

export function parseKey(raw: string): { prefix: string; secret: string } | undefined {
  if (raw.includes('\n') || raw.includes('\r')) return undefined
  const match = KEY_PATTERN.exec(raw)
  if (match === null) return undefined
  return { prefix: match[1]!, secret: match[2]! }
}

/** Constant-time over the hex digests. A `===` here would leak the hash a byte at a time. */
export function verifySecret(secret: string, hash: string): boolean {
  // A stored hash is always 64 hex characters; anything else cannot match, and Buffer.from
  // silently truncates invalid hex rather than throwing, so the length check has to come first.
  if (!/^[0-9a-f]{64}$/.test(hash)) return false
  const expected = Buffer.from(hash, 'hex')
  const actual = Buffer.from(hashSecret(secret), 'hex')
  return timingSafeEqual(expected, actual)
}
