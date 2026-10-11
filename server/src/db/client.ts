import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import type { Database } from './schema.js'

// Postgres returns int8 as a string to avoid losing precision. `occurrence_count` is a bigint
// and is read into arithmetic and into JSON; a string count is a bug waiting to be concatenated.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value))

/**
 * `onConnectionError` hears from a connection that fails, as every one does when Postgres
 * restarts. pg emits that as an `'error'` event on the client, and an event with no listener ends
 * the process. While the connection sits idle, pg-pool listens and re-emits it on the pool; while
 * a request holds it, nobody does, so a listener goes on each client as it connects. A query in
 * flight still rejects to its caller. The pool discards the failed connection and opens a fresh
 * one when next asked, so reporting is all there is to do. The server passes its logger; a
 * one-shot script may leave it out, since its next query would fail anyway.
 */
export function createDb(
  connectionString: string,
  onConnectionError?: (error: Error) => void,
): Kysely<Database> {
  const pool = new pg.Pool({ connectionString })
  if (onConnectionError !== undefined) {
    // An idle failure reaches both listeners with the same error; report it once.
    const reported = new WeakSet<Error>()
    const report = (error: Error): void => {
      if (reported.has(error)) return
      reported.add(error)
      onConnectionError(error)
    }
    pool.on('error', report)
    pool.on('connect', (client) => client.on('error', report))
  }
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
}
