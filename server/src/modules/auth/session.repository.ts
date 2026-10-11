import { createHash, randomBytes } from 'node:crypto'
import type { Kysely } from 'kysely'
import type { Database } from '../../db/schema.js'

export interface Session {
  id: string
  ownerId: string
  expiresAt: Date
  lastSeenAt: Date
}

/**
 * Only ever the hash reaches the database. A leaked backup then contains nothing that can be
 * presented as a live session — the same reason ingest keys are stored digested.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function mintToken(): string {
  return randomBytes(32).toString('base64url')
}

export async function insertSession(
  db: Kysely<Database>,
  ownerId: string,
  token: string,
  expiresAt: Date,
): Promise<void> {
  await db
    .insertInto('sessions')
    .values({ owner_id: ownerId, token_hash: hashToken(token), expires_at: expiresAt })
    .execute()
}

export async function findLiveSession(
  db: Kysely<Database>,
  token: string,
): Promise<Session | undefined> {
  const row = await db
    .selectFrom('sessions')
    .select(['id', 'owner_id', 'expires_at', 'last_seen_at'])
    .where('token_hash', '=', hashToken(token))
    .where('expires_at', '>', new Date())
    .executeTakeFirst()

  return row === undefined
    ? undefined
    : {
        id: row.id,
        ownerId: row.owner_id,
        expiresAt: row.expires_at,
        lastSeenAt: row.last_seen_at,
      }
}

export async function slideSession(
  db: Kysely<Database>,
  id: string,
  expiresAt: Date,
): Promise<void> {
  await db
    .updateTable('sessions')
    .set({ expires_at: expiresAt, last_seen_at: new Date() })
    .where('id', '=', id)
    .execute()
}

export async function deleteSession(db: Kysely<Database>, id: string): Promise<void> {
  await db.deleteFrom('sessions').where('id', '=', id).execute()
}
