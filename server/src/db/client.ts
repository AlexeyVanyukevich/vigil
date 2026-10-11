import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import type { Database } from './schema.js'

// Postgres returns int8 as a string to avoid losing precision. `occurrence_count` is a bigint
// and is read into arithmetic and into JSON; a string count is a bug waiting to be concatenated.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value))

/**
 * `onIdleError` hears from a connection that fails while it sits idle in the pool, as every
 * idle one does when Postgres restarts. pg emits that on the pool, and an `'error'` event with no
 * listener ends the process. The pool has already discarded the connection and opens a fresh one
 * when next asked, so reporting it is all there is to do. The server passes its logger; a
 * one-shot script may leave it out, since its next query would fail anyway.
 */
export function createDb(
  connectionString: string,
  onIdleError?: (error: Error) => void,
): Kysely<Database> {
  const pool = new pg.Pool({ connectionString })
  if (onIdleError !== undefined) pool.on('error', onIdleError)
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
}
