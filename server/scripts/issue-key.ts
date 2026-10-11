import { createDb } from '../src/db/client.js'
import { findAppBySlug } from '../src/modules/apps/app.repository.js'
import { insertKey, mintIngestKey } from '../src/modules/ingest/key.repository.js'

const databaseUrl = process.env.DATABASE_URL?.trim()
if (databaseUrl === undefined || databaseUrl === '') throw new Error('DATABASE_URL is required')

const slug = process.argv[2]
if (slug === undefined) {
  console.error('Usage: ./run key:issue <slug>')
  process.exit(1)
}

const db = createDb(databaseUrl)
try {
  const app = await findAppBySlug(db, slug)
  if (app === undefined) {
    console.error(
      `No application with the slug "${slug}". Add it first:  ./run app:add ${slug} <name>`,
    )
    process.exit(1)
  }

  const token = mintIngestKey()
  await insertKey(db, app.id, 'server', token)

  // Said plainly at the moment of creation, because only the digest is stored and there is no
  // second chance to read it.
  console.log('')
  console.log(`Server ingest key for ${app.slug}:`)
  console.log('')
  console.log(`  ${token}`)
  console.log('')
  console.log('This is shown once and cannot be recovered. Copy it now.')
  console.log('A lost key is reissued, never retrieved; revoke the old one when you do.')
} finally {
  await db.destroy()
}
