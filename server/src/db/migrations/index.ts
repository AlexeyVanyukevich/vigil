import type { Migration } from 'kysely/migration'
import * as initial from './001_initial.js'

/**
 * Migrations are listed explicitly instead of being discovered from disk: Kysely's
 * FileMigrationProvider imports files at runtime, which fails wherever the runtime cannot load
 * TypeScript directly — Vitest's global setup, plain `node` on the sources — and forces a build
 * step before migrating. A static map works everywhere and makes the order visible in review.
 *
 * Keys are the names Kysely records in `kysely_migration`; they are applied in lexicographic
 * order, so keep the numeric prefix.
 */
export const migrations: Record<string, Migration> = {
  '001_initial': initial,
}
