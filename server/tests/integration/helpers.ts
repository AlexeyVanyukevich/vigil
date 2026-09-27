import { inject } from 'vitest'
import { sql, type Kysely } from 'kysely'
import type { FastifyInstance } from 'fastify'
import { createDb } from '../../src/db/client.js'
import type { Database } from '../../src/db/schema.js'
import { buildApp } from '../../src/app.js'
import type { Config } from '../../src/config.js'

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

/** Built the way `server.ts` builds it, against the one Testcontainers database. */
export async function buildTestApp(
  overrides: { config?: Partial<Config> } = {},
): Promise<FastifyInstance> {
  const config: Config = {
    databaseUrl: inject('databaseUrl'),
    port: 0,
    sessionTtlDays: 30,
    // High enough that a suite signing in on nearly every case does not race the limit.
    // `auth.test.ts` builds its own app with a low one to prove the limit still bites.
    loginAttemptsPerMinute: 1_000,
    logLevel: 'silent',
    maxEventsPerBatch: 100,
    maxStackBytes: 16_384,
    maxContextBytes: 8_192,
    ...overrides.config,
  }

  const app = await buildApp({ config, db: getTestDb() })
  await app.ready()
  return app
}
