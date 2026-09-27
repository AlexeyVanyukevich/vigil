import { createDb } from '../src/db/client.js'

const databaseUrl = process.env.DATABASE_URL?.trim()
if (databaseUrl === undefined || databaseUrl === '') throw new Error('DATABASE_URL is required')

const db = createDb(databaseUrl)
try {
  const owners = await db.selectFrom('owners').select('id').limit(1).execute()
  // The seeded `vigil` row is not an application anyone has connected, so it does not count.
  const apps = await db
    .selectFrom('apps')
    .select('id')
    .where('slug', '!=', 'vigil')
    .limit(1)
    .execute()
  console.log(
    `owner=${owners.length > 0 ? 'present' : 'missing'} apps=${apps.length > 0 ? 'present' : 'missing'}`,
  )
} finally {
  await db.destroy()
}
