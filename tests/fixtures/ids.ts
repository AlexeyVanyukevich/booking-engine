import { randomUUID } from 'node:crypto'

/**
 * Node ships `crypto.randomUUID()`, so no dependency is needed. These wrappers exist to
 * name the intent: a test asserting a 404 should read "unknown id", not "random uuid".
 */

/** A syntactically valid UUID that is guaranteed not to exist in the database. */
export function unknownUuid(): string {
  return randomUUID()
}

/** A fresh UUID, for cases that need an identifier without caring which one. */
export function someUuid(): string {
  return randomUUID()
}

/** Values that must be rejected by the `format: 'uuid'` constraint on path parameters. */
export const MALFORMED_UUIDS = [
  'not-a-uuid',
  '123',
  '00000000-0000-0000-0000',
  '00000000-0000-0000-0000-00000000000g',
] as const
