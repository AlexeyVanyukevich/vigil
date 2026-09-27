import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, closeTestDb, getTestDb, resetDb } from './helpers.js'
import { PASSWORD } from './auth-helper.js'
import { hashPassword } from '../../src/modules/auth/password.js'

let app: FastifyInstance

beforeAll(async () => {
  app = await buildTestApp()
})
beforeEach(async () => {
  await resetDb()
  await getTestDb()
    .insertInto('owners')
    .values({ label: 'The owner', password_hash: await hashPassword(PASSWORD) })
    .execute()
})
afterAll(async () => {
  await app.close()
  await closeTestDb()
})

const login = (password = PASSWORD) =>
  app.inject({ method: 'POST', url: '/api/login', payload: { password } })

const sessionCookie = async () => {
  const cookie = (await login()).cookies.find((c) => c.name === 'session')
  if (cookie === undefined) throw new Error('no session cookie')
  return { session: cookie.value }
}

describe('login', () => {
  it('sets an httpOnly session cookie', async () => {
    const response = await login()
    expect(response.statusCode).toBe(204)
    const cookie = response.cookies.find((c) => c.name === 'session')
    expect(cookie?.httpOnly).toBe(true)
    expect(cookie?.sameSite?.toLowerCase()).toBe('lax')
    expect(cookie?.path).toBe('/')
  })

  it('refuses the wrong password', async () => {
    const wrong = await login('nope')
    expect(wrong.statusCode).toBe(401)
    expect(wrong.json()).toEqual({ error: 'unauthorized', message: 'Wrong password' })
  })

  it('stores only a hash of the token, never the token', async () => {
    const response = await login()
    const token = response.cookies.find((c) => c.name === 'session')!.value
    const rows = await getTestDb().selectFrom('sessions').select('token_hash').execute()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.token_hash).not.toBe(token)
  })

  // Whether this server has been configured at all is not something an attacker should be able
  // to read off the login form.
  it('answers a server with no owner exactly as it answers a wrong password', async () => {
    await getTestDb().deleteFrom('owners').execute()
    const response = await login()
    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({ error: 'unauthorized', message: 'Wrong password' })
  })

  // A password alone identifies nobody once there are two owners. The failure must be loud:
  // that error is the signal to add an identifier.
  it('refuses to guess when a second owner exists', async () => {
    await getTestDb()
      .insertInto('owners')
      .values({ label: 'A second owner', password_hash: await hashPassword('another password') })
      .execute()
    const response = await login()
    expect(response.statusCode).toBe(500)
    expect(await getTestDb().selectFrom('sessions').selectAll().execute()).toHaveLength(0)
  })

  it('rejects an unknown field rather than ignoring it', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { password: PASSWORD, admin: true },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('validation_error')
  })
})

describe('the login rate limit', () => {
  it('stops answering after too many attempts from one address', async () => {
    const limited = await buildTestApp({ config: { loginAttemptsPerMinute: 2 } })
    try {
      const attempt = () =>
        limited.inject({ method: 'POST', url: '/api/login', payload: { password: 'wrong' } })
      expect((await attempt()).statusCode).toBe(401)
      expect((await attempt()).statusCode).toBe(401)
      expect((await attempt()).statusCode).toBe(429)
    } finally {
      await limited.close()
    }
  })
})

describe('the guard', () => {
  it('refuses a protected route without a session', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/me' })).statusCode).toBe(401)
  })

  it('admits one with a session', async () => {
    const cookies = await sessionCookie()
    expect((await app.inject({ method: 'GET', url: '/api/me', cookies })).statusCode).toBe(200)
  })

  it('refuses a session that has been deleted — sign out everywhere works', async () => {
    const cookies = await sessionCookie()
    await getTestDb().deleteFrom('sessions').execute()
    expect((await app.inject({ method: 'GET', url: '/api/me', cookies })).statusCode).toBe(401)
  })

  it('refuses an expired session', async () => {
    const cookies = await sessionCookie()
    await getTestDb()
      .updateTable('sessions')
      .set({ expires_at: new Date(Date.now() - 1000) })
      .execute()
    expect((await app.inject({ method: 'GET', url: '/api/me', cookies })).statusCode).toBe(401)
  })

  it('leaves health public', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200)
  })

  // The whole point of the two-credential split: an application must never be asked for a
  // cookie, and the guard must not be what stands between it and the ingest endpoint.
  it('does not ask /ingest for a session — it answers on its own terms', async () => {
    const response = await app.inject({ method: 'POST', url: '/ingest/events', payload: {} })
    expect(response.statusCode).not.toBe(401)
    expect(response.statusCode).toBe(404)
  })

  it('answers an unknown /api route with JSON rather than a page', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/nothing' })
    expect(response.json().error).toBe('not_found')
  })
})

describe('the origin check', () => {
  it('refuses a write from a foreign origin', async () => {
    const cookies = await sessionCookie()
    const response = await app.inject({
      method: 'POST',
      url: '/api/logout',
      cookies,
      headers: { origin: 'https://evil.example', host: 'vigil.example' },
    })
    expect(response.statusCode).toBe(403)
  })

  it('allows one whose origin matches the host it was addressed to', async () => {
    const cookies = await sessionCookie()
    const response = await app.inject({
      method: 'POST',
      url: '/api/logout',
      cookies,
      headers: { origin: 'https://vigil.example', host: 'vigil.example' },
    })
    expect(response.statusCode).toBe(204)
  })

  // A server reporting from another host sends no Origin and must not be judged on one.
  it('does not apply to /ingest', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/ingest/events',
      headers: { origin: 'https://an-app.example', host: 'vigil.example' },
      payload: {},
    })
    expect(response.statusCode).not.toBe(403)
  })
})
