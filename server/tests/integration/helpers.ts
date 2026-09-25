import { inject } from 'vitest'
import { sql, type Kysely } from 'kysely'
import { createDb } from '../../src/db/client.js'
import type { Database } from '../../src/db/schema.js'

let cached: Kysely<Database> | undefined

export function getTestDb(): Kysely<Database> {
  cached ??= createDb(inject('databaseUrl'))
  return cached
}

export async function closeTestDb(): Promise<void> {
  await cached?.destroy()
  cached = undefined
}

/**
 * `apps` cascades to keys, issues and events, so truncating it clears most of the schema. The
 * `vigil` row is seeded by the migration and put back here: it is the app §13 writes to, a
 * state production can never be without, and one tests should not have to handle.
 */
export async function resetDb(): Promise<void> {
  await sql`truncate table events, issues, ingest_keys, apps, sessions, owners restart identity cascade`.execute(
    getTestDb(),
  )
  await getTestDb()
    .insertInto('apps')
    .values({ slug: 'vigil', name: 'Vigil itself' })
    .onConflict((oc) => oc.column('slug').doNothing())
    .execute()
}
