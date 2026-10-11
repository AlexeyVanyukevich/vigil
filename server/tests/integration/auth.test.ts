import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, closeTestDb, getTestDb, resetDb } from './helpers.js'
import { PASSWORD } from './auth-helper.js'
import { hashPassword } from '../../src/modules/auth/password.js'
import { AuthService } from '../../src/modules/auth/auth.service.js'
import { hashToken, insertSession, mintToken } from '../../src/modules/auth/session.repository.js'

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

// Two attempts a minute, so the third from one client is the first refused. `inject` arrives
// from 127.0.0.1 unless `from` says otherwise: the proxy's address, in the cases that set
// TRUST_PROXY to it. What differs between clients is the `X-Forwarded-For` the proxy adds.
interface RateLimitCase {
  name: string
  trustProxy: string[]
  attempts: { from?: string; forwardedFor?: string; status: number }[]
}

const RATE_LIMIT_CASES: RateLimitCase[] = [
  {
    name: 'stops answering after too many attempts from one address',
    trustProxy: [],
    attempts: [{ status: 401 }, { status: 401 }, { status: 429 }],
  },
  // Unset, a forwarded address is not believed: behind a proxy, every client shares one budget.
  {
    name: 'counts by socket address, whatever is forwarded, with TRUST_PROXY unset',
    trustProxy: [],
    attempts: [
      { forwardedFor: '203.0.113.1', status: 401 },
      { forwardedFor: '203.0.113.2', status: 401 },
      { forwardedFor: '203.0.113.3', status: 429 },
    ],
  },
  {
    name: 'counts by forwarded address with TRUST_PROXY naming the proxy',
    trustProxy: ['127.0.0.1'],
    attempts: [
      { forwardedFor: '203.0.113.1', status: 401 },
      { forwardedFor: '203.0.113.1', status: 401 },
      { forwardedFor: '203.0.113.1', status: 429 },
      { forwardedFor: '203.0.113.2', status: 401 },
    ],
  },
  // A proxy appends the address it saw to whatever the client sent. Only the proxy is trusted,
  // so a client cannot buy a fresh budget by inventing the addresses before that one.
  {
    name: 'ignores addresses the client wrote before the proxy appended its own',
    trustProxy: ['loopback'],
    attempts: [
      { forwardedFor: '198.51.100.1, 203.0.113.1', status: 401 },
      { forwardedFor: '198.51.100.2, 203.0.113.1', status: 401 },
      { forwardedFor: '198.51.100.3, 203.0.113.1', status: 429 },
    ],
  },
  // A client that reaches the server around the proxy is not the proxy, and is not believed.
  {
    name: 'ignores a forwarded address from anyone but the proxy',
    trustProxy: ['127.0.0.1'],
    attempts: [
      { from: '192.0.2.9', forwardedFor: '203.0.113.1', status: 401 },
      { from: '192.0.2.9', forwardedFor: '203.0.113.2', status: 401 },
      { from: '192.0.2.9', forwardedFor: '203.0.113.3', status: 429 },
    ],
  },
]

describe('the login rate limit', () => {
  it.each(RATE_LIMIT_CASES)('$name', async ({ trustProxy, attempts }) => {
    const limited = await buildTestApp({ config: { loginAttemptsPerMinute: 2, trustProxy } })
    try {
      const statuses: number[] = []
      for (const { from, forwardedFor } of attempts) {
        const response = await limited.inject({
          method: 'POST',
          url: '/api/login',
          payload: { password: 'wrong' },
          ...(from === undefined ? {} : { remoteAddress: from }),
          ...(forwardedFor === undefined ? {} : { headers: { 'x-forwarded-for': forwardedFor } }),
        })
        statuses.push(response.statusCode)
      }
      expect(statuses).toEqual(attempts.map(({ status }) => status))
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
    // 401 from the key check, not from the cookie guard; the body says which.
    expect(response.statusCode).toBe(401)
    expect(response.json().message).toMatch(/ingest key/)
  })

  it('answers an unknown /api route with JSON rather than a page', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/nothing' })
    expect(response.statusCode).toBe(404)
    expect(response.json().error).toBe('not_found')
  })
})

// find-my-way percent-decodes the path before matching it to a route, so a guard that compares
// against the raw `request.url` can be walked around by encoding a single letter of it.
describe('the guard against a percent-encoded path', () => {
  it('still refuses /%61pi/me without a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/%61pi/me' })
    expect(response.statusCode).toBe(401)
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

  // A browser sends the literal header value `null` for an opaque origin (a sandboxed iframe, a
  // redirect from a data: URL, ...). `new URL('null')` throws, and an unhandled throw here would
  // answer 500 instead of refusing the request outright.
  it('refuses an origin the URL constructor cannot parse, rather than erroring', async () => {
    const cookies = await sessionCookie()
    const response = await app.inject({
      method: 'POST',
      url: '/api/logout',
      cookies,
      headers: { origin: 'null', host: 'vigil.example' },
    })
    expect(response.statusCode).toBe(403)
  })
})

describe('the session slide', () => {
  const TTL_DAYS = 30
  const HOUR_MS = 3_600_000

  /** A session whose `last_seen_at` is the real wall-clock time, as `insertSession` leaves it. */
  async function seedSession(): Promise<{ token: string; expiresAt: Date }> {
    const owner = await getTestDb().selectFrom('owners').select('id').executeTakeFirstOrThrow()
    const token = mintToken()
    const expiresAt = new Date(Date.now() + TTL_DAYS * 24 * HOUR_MS)
    await insertSession(getTestDb(), owner.id, token, expiresAt)
    return { token, expiresAt }
  }

  async function sessionRow(token: string) {
    return getTestDb()
      .selectFrom('sessions')
      .select(['expires_at', 'last_seen_at'])
      .where('token_hash', '=', hashToken(token))
      .executeTakeFirstOrThrow()
  }

  it('does not move last_seen_at or expires_at within the hour', async () => {
    const { token, expiresAt } = await seedSession()
    const before = await sessionRow(token)

    // 30 minutes past the seeded last_seen_at: inside the once-an-hour window.
    const clock = () => Date.now() + 30 * 60_000
    await new AuthService(getTestDb(), TTL_DAYS, clock).resolve(token)

    const after = await sessionRow(token)
    expect(new Date(after.last_seen_at).getTime()).toBe(new Date(before.last_seen_at).getTime())
    expect(new Date(after.expires_at).getTime()).toBe(expiresAt.getTime())
  })

  it('moves both after the hour', async () => {
    const { token } = await seedSession()
    const before = await sessionRow(token)

    // 61 minutes past the seeded last_seen_at: just outside the window.
    const clockMs = Date.now() + 61 * 60_000
    await new AuthService(getTestDb(), TTL_DAYS, () => clockMs).resolve(token)

    const after = await sessionRow(token)
    expect(new Date(after.last_seen_at).getTime()).toBeGreaterThan(
      new Date(before.last_seen_at).getTime(),
    )
    expect(new Date(after.expires_at).getTime()).toBe(clockMs + TTL_DAYS * 24 * HOUR_MS)
  })

  it('slides expires_at to now plus the TTL, not the old expiry plus the TTL again', async () => {
    const { token, expiresAt: originalExpiry } = await seedSession()

    // Far enough past the original expiry that reapplying the TTL to *it*, rather than to now,
    // would land on a visibly different timestamp — the two formulas cannot coincide by luck.
    const clockMs = originalExpiry.getTime() + 10 * HOUR_MS
    await new AuthService(getTestDb(), TTL_DAYS, () => clockMs).resolve(token)

    const after = await sessionRow(token)
    expect(new Date(after.expires_at).getTime()).toBe(clockMs + TTL_DAYS * 24 * HOUR_MS)
    expect(new Date(after.expires_at).getTime()).not.toBe(
      originalExpiry.getTime() + TTL_DAYS * 24 * HOUR_MS,
    )
  })
})
