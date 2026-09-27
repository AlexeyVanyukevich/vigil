import type { FastifyInstance } from 'fastify'
import { getTestDb } from './helpers.js'
import { hashPassword } from '../../src/modules/auth/password.js'

export const PASSWORD = 'correct horse battery staple'

/**
 * Seeds the owner and signs in, so every suite that is not about authentication says `cookies`
 * and nothing more.
 */
export async function signIn(app: FastifyInstance): Promise<Record<string, string>> {
  await getTestDb()
    .insertInto('owners')
    .values({ label: 'The owner', password_hash: await hashPassword(PASSWORD) })
    .execute()

  const response = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { password: PASSWORD },
  })
  const cookie = response.cookies.find((c) => c.name === 'session')
  if (cookie === undefined) throw new Error(`Could not sign in: ${response.statusCode}`)
  return { session: cookie.value }
}
