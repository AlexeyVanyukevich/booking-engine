import type { Migration } from 'kysely/migration'
import * as bookings from './002_bookings.js'
import * as initial from './001_initial.js'
import * as tenancy from './003_tenancy.js'

/**
 * Migrations are listed explicitly instead of being discovered from disk. Kysely's
 * FileMigrationProvider imports files at runtime, which fails wherever the runtime cannot
 * load TypeScript directly (Vitest's global setup, plain `node` on the sources) and forces
 * a build step before migrating. A static map works everywhere and makes the order of
 * application visible in review.
 *
 * Keys are the migration names Kysely records in `kysely_migration`; they are applied in
 * lexicographic order, so keep the numeric prefix.
 */
export const migrations: Record<string, Migration> = {
  '001_initial': initial,
  '002_bookings': bookings,
  '003_tenancy': tenancy,
}
