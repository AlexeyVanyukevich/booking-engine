import { randomBytes } from 'node:crypto'

/**
 * Holds a freshly issued secret between the POST that created it and the redirect that shows
 * it, then forgets it.
 *
 * Two requirements turn out to be the same requirement: the key must be displayed exactly
 * once, and reloading must not issue a second key. Rendering the secret in the POST response
 * satisfies the first and breaks the second, because F5 re-submits the form. POST, redirect,
 * GET with a one-shot store satisfies both, and "reload and the secret is gone" falls out of
 * the mechanism instead of being a rule the page has to remember to obey.
 *
 * In memory because the console is one process on one machine. Two would need a table with a
 * TTL — recorded here so the reason is not rediscovered.
 */
export class SecretFlash {
  private readonly entries = new Map<string, { secret: string; expiresAt: number }>()

  constructor(private readonly ttlMs = 60_000) {}

  put(secret: string): string {
    const id = randomBytes(16).toString('hex')
    this.entries.set(id, { secret, expiresAt: Date.now() + this.ttlMs })
    return id
  }

  take(id: string): string | undefined {
    this.sweep()
    const entry = this.entries.get(id)
    if (entry === undefined) return undefined
    this.entries.delete(id)
    return entry.secret
  }

  /** On access, so there is no timer to leak and nothing to unref at shutdown. */
  private sweep(): void {
    const now = Date.now()
    for (const [id, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(id)
  }
}
