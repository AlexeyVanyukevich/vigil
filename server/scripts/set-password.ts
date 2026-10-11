import { createInterface } from 'node:readline/promises'
import { createDb } from '../src/db/client.js'
import { hashPassword } from '../src/modules/auth/password.js'

const databaseUrl = process.env.DATABASE_URL?.trim()
if (databaseUrl === undefined || databaseUrl === '') throw new Error('DATABASE_URL is required')

async function readPassword(): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
    return Buffer.concat(chunks).toString('utf8').trim()
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await rl.question('New owner password (at least 12 characters): ')).trim()
  } finally {
    rl.close()
  }
}

const password = await readPassword()
const db = createDb(databaseUrl)
try {
  const hash = await hashPassword(password)
  const owner = await db.selectFrom('owners').select('id').executeTakeFirst()

  if (owner === undefined) {
    await db.insertInto('owners').values({ label: 'The owner', password_hash: hash }).execute()
  } else {
    await db
      .updateTable('owners')
      .set({ password_hash: hash, updated_at: new Date() })
      .where('id', '=', owner.id)
      .execute()
  }

  // Changing the password signs every device out: a password change that leaves live sessions
  // behind does not do the one thing it is usually reached for.
  await db.deleteFrom('sessions').execute()
  console.log('Password set. Every device has been signed out.')
} finally {
  await db.destroy()
}
