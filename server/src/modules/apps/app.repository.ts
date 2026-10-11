import type { Kysely } from 'kysely'
import type { Database } from '../../db/schema.js'

export interface AppRow {
  id: string
  slug: string
  name: string
}

export async function listApps(db: Kysely<Database>): Promise<AppRow[]> {
  return db.selectFrom('apps').select(['id', 'slug', 'name']).orderBy('slug').execute()
}

export async function findAppBySlug(
  db: Kysely<Database>,
  slug: string,
): Promise<AppRow | undefined> {
  return db
    .selectFrom('apps')
    .select(['id', 'slug', 'name'])
    .where('slug', '=', slug)
    .executeTakeFirst()
}

export async function insertApp(db: Kysely<Database>, slug: string, name: string): Promise<AppRow> {
  return db
    .insertInto('apps')
    .values({ slug, name })
    .returning(['id', 'slug', 'name'])
    .executeTakeFirstOrThrow()
}
