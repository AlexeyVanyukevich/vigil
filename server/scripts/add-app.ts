import { createDb } from '../src/db/client.js'
import { findAppBySlug, insertApp } from '../src/modules/apps/app.repository.js'

const databaseUrl = process.env.DATABASE_URL?.trim()
if (databaseUrl === undefined || databaseUrl === '') throw new Error('DATABASE_URL is required')

const [slug, ...rest] = process.argv.slice(2)
const name = rest.join(' ').trim()

if (slug === undefined || name === '') {
  console.error('Usage: ./run app:add <slug> <name>')
  console.error('Example: ./run app:add reference The reference application')
  process.exit(1)
}

const db = createDb(databaseUrl)
try {
  if ((await findAppBySlug(db, slug)) !== undefined) {
    console.error(`An application with the slug "${slug}" already exists.`)
    process.exit(1)
  }
  const app = await insertApp(db, slug, name)
  console.log(`Added ${app.slug} (${app.name}).`)
  console.log(`Issue it a key next:  ./run key:issue ${app.slug}`)
} finally {
  await db.destroy()
}
