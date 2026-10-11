import { fileURLToPath } from 'node:url'
import type { Kysely } from 'kysely'
import { Migrator } from 'kysely/migration'
import { createDb } from './client.js'
import { migrations } from './migrations/index.js'
import type { Database } from './schema.js'

export async function runMigrations(db: Kysely<Database>): Promise<void> {
  const migrator = new Migrator({ db, provider: { getMigrations: async () => migrations } })

  const { error, results } = await migrator.migrateToLatest()

  for (const result of results ?? []) {
    if (result.status === 'Error') {
      throw new Error(`Migration "${result.migrationName}" failed`)
    }
  }

  if (error) throw error
}

// Executed only when run directly: `npm run migrate`.
//
// DATABASE_URL alone, deliberately not the whole validated config: creating tables is the first
// step of a fresh install, and it must not be blocked on settings that are not needed yet.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const databaseUrl = process.env.DATABASE_URL?.trim()
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error('DATABASE_URL is required to run migrations')
  }

  const db = createDb(databaseUrl)
  try {
    await runMigrations(db)
    console.log('migrations applied')
  } finally {
    await db.destroy()
  }
}
