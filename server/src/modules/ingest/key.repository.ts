import { createHash, randomBytes } from 'node:crypto'
import { sql, type Kysely } from 'kysely'
import type { Database } from '../../db/schema.js'

/**
 * A prefix so a key found in a log or a config file is recognisable as vigil's, and 256 bits
 * from a CSPRNG because that is the whole of its strength. There is no entropy problem to
 * stretch here, which is why the digest below is SHA-256 and not argon2.
 */
export function mintIngestKey(): string {
  return `vgl_${randomBytes(32).toString('base64url')}`
}

export function hashIngestKey(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export interface LiveKey {
  id: string
  appId: string
  /** Carried so a log line can name the application without a second query. */
  appSlug: string
  kind: 'server' | 'browser'
}

export async function findLiveKey(
  db: Kysely<Database>,
  token: string,
): Promise<LiveKey | undefined> {
  // Looked up by digest, which is why the digest is directly indexable. A revoked key is
  // resolved to nothing rather than deleted, so the row remains as a record it existed.
  const row = await db
    .selectFrom('ingest_keys')
    .innerJoin('apps', 'apps.id', 'ingest_keys.app_id')
    .select([
      'ingest_keys.id as id',
      'ingest_keys.app_id as app_id',
      'ingest_keys.kind as kind',
      'apps.slug as slug',
    ])
    .where('ingest_keys.token_sha256', '=', hashIngestKey(token))
    .where('ingest_keys.revoked_at', 'is', null)
    .executeTakeFirst()

  return row === undefined
    ? undefined
    : { id: row.id, appId: row.app_id, appSlug: row.slug, kind: row.kind }
}

/**
 * Lazily, at most once an hour, in one statement with no read first. Ingest is the busiest path
 * in the system; a write on every report would make a column nobody reads more than once a day
 * the most-written thing in the database.
 */
export async function touchKey(db: Kysely<Database>, id: string): Promise<void> {
  await sql`
    update ingest_keys
       set last_used_at = now()
     where id = ${id}
       and (last_used_at is null or last_used_at < now() - interval '1 hour')
  `.execute(db)
}

export async function insertKey(
  db: Kysely<Database>,
  appId: string,
  kind: 'server' | 'browser',
  token: string,
): Promise<string> {
  const row = await db
    .insertInto('ingest_keys')
    .values({ app_id: appId, kind, token_sha256: hashIngestKey(token) })
    .returning('id')
    .executeTakeFirstOrThrow()
  return row.id
}
