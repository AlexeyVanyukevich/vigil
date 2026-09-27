import type { Kysely, Selectable } from 'kysely'
import type { Database, OwnersTable } from '../../db/schema.js'

export type Owner = Selectable<OwnersTable>

/**
 * Login asks for a password and no identifier, which identifies a person only while there is
 * exactly one owner. Two rows is not a login failure — it is that assumption expiring, and it
 * belongs in the log as a defect rather than being silently resolved by trying each hash.
 */
export async function theOnlyOwner(db: Kysely<Database>): Promise<Owner | undefined> {
  const owners = await db.selectFrom('owners').selectAll().limit(2).execute()
  if (owners.length > 1) {
    throw new Error('More than one owner exists, and login has no way to tell them apart')
  }
  return owners[0]
}
