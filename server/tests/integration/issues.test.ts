import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, closeTestDb, getTestDb, resetDb } from './helpers.js'
import { signIn } from './auth-helper.js'
import { insertApp } from '../../src/modules/apps/app.repository.js'
import { insertKey, mintIngestKey } from '../../src/modules/ingest/key.repository.js'

let app: FastifyInstance
let cookies: Record<string, string>
let key: string
let otherKey: string

const db = () => getTestDb()

const STACK = `TypeError: boom
    at handleBooking (/app/src/bookings.js:42:17)
    at deeper (/app/node_modules/fastify/lib/handle.js:1:1)`

async function report(
  token: string,
  overrides: {
    message?: string
    environment?: string
    occurredAt?: Date
    count?: number
    fingerprint?: string
  } = {},
) {
  const response = await app.inject({
    method: 'POST',
    url: '/ingest/events',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      environment: overrides.environment ?? 'production',
      runtime: 'node',
      events: [
        {
          type: 'TypeError',
          message: overrides.message ?? 'boom',
          stack: STACK,
          occurred_at: (overrides.occurredAt ?? new Date()).toISOString(),
          ...(overrides.count === undefined ? {} : { count: overrides.count }),
          ...(overrides.fingerprint === undefined ? {} : { fingerprint: overrides.fingerprint }),
          context: { route: '/api/bookings' },
        },
      ],
    },
  })
  if (response.statusCode !== 202) throw new Error(`report failed: ${response.body}`)
}

// Every report shares STACK, and §7 groups by stack frames rather than by message, so two
// messages alone make one issue. A case that needs two issues names two groups explicitly.
const distinct = (message: string) => ({ message, fingerprint: message })

const list = (query = '') => app.inject({ method: 'GET', url: `/api/issues${query}`, cookies })

beforeAll(async () => {
  app = await buildTestApp()
})
beforeEach(async () => {
  await resetDb()
  cookies = await signIn(app)
  const reference = await insertApp(db(), 'reference', 'The reference application')
  const other = await insertApp(db(), 'other', 'Another application')
  key = mintIngestKey()
  otherKey = mintIngestKey()
  await insertKey(db(), reference.id, 'server', key)
  await insertKey(db(), other.id, 'server', otherKey)
})
afterAll(async () => {
  await app.close()
  await closeTestDb()
})

describe('the issues list', () => {
  it('needs a session', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/issues' })).statusCode).toBe(401)
  })

  it('names the application each issue belongs to', async () => {
    await report(key)
    const issues = list().then((r) => r.json().issues)
    expect((await issues)[0]).toMatchObject({
      app_slug: 'reference',
      app_name: 'The reference application',
      environment: 'production',
      title: 'TypeError: boom',
      culprit: 'handleBooking (/app/src/bookings.js)',
      status: 'open',
      occurrence_count: 1,
    })
  })

  it('shows one line for many occurrences', async () => {
    await report(key)
    await report(key)
    await report(key)
    const issues = (await list()).json().issues
    expect(issues).toHaveLength(1)
    expect(issues[0].occurrence_count).toBe(3)
  })

  it('sorts by last seen, newest first, by default', async () => {
    await report(key, { ...distinct('older'), occurredAt: new Date(Date.now() - 60_000) })
    await report(key, distinct('newer'))
    const titles = (await list()).json().issues.map((i: { title: string }) => i.title)
    expect(titles).toEqual(['TypeError: newer', 'TypeError: older'])
  })

  it('sorts by count when asked', async () => {
    await report(key, distinct('rare'))
    await report(key, { ...distinct('common'), count: 500 })
    const titles = (await list('?sort=count')).json().issues.map((i: { title: string }) => i.title)
    expect(titles).toEqual(['TypeError: common', 'TypeError: rare'])
  })

  it('filters by application', async () => {
    await report(key)
    await report(otherKey)
    const issues = (await list('?app=other')).json().issues
    expect(issues).toHaveLength(1)
    expect(issues[0].app_slug).toBe('other')
  })

  it('filters by environment', async () => {
    await report(key, { environment: 'production' })
    await report(key, { environment: 'development' })
    const issues = (await list('?environment=development')).json().issues
    expect(issues).toHaveLength(1)
    expect(issues[0].environment).toBe('development')
  })

  it('filters by status', async () => {
    await report(key, distinct('left open'))
    await report(key, distinct('resolved'))
    await db()
      .updateTable('issues')
      .set({ status: 'resolved' })
      .where('title', '=', 'TypeError: resolved')
      .execute()

    expect((await list('?status=open')).json().issues).toHaveLength(1)
    expect((await list('?status=resolved')).json().issues).toHaveLength(1)
    expect((await list()).json().issues).toHaveLength(2)
  })

  it('refuses a status it does not know rather than ignoring it', async () => {
    expect((await list('?status=snoozed')).statusCode).toBe(400)
  })

  it('serialises timestamps as ISO strings and the count as a number', async () => {
    await report(key)
    const issue = (await list()).json().issues[0]
    expect(issue.last_seen_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(typeof issue.occurrence_count).toBe('number')
  })

  // Postgres refuses U+0000 in text, and ingest stores it as U+FFFD. The filter has to meet the
  // stored value where it is, rather than hand Postgres a byte it answers with a 500.
  it('finds an environment ingest stored with a NUL in it', async () => {
    await report(key, { environment: 'dev\u0000box' })
    const response = await list('?environment=dev%00box')
    expect(response.statusCode).toBe(200)
    expect(response.json().issues).toHaveLength(1)
  })

  it('answers an app filter carrying a NUL with an empty list', async () => {
    await report(key)
    const response = await list('?app=%00')
    expect(response.statusCode).toBe(200)
    expect(response.json().issues).toEqual([])
  })
})

describe('issue detail', () => {
  const idOfFirst = async () => (await list()).json().issues[0].id as string

  it('returns the issue with its recent occurrences, newest first', async () => {
    await report(key, { occurredAt: new Date(Date.now() - 60_000) })
    await report(key)
    const response = await app.inject({
      method: 'GET',
      url: `/api/issues/${await idOfFirst()}`,
      cookies,
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.issue.title).toBe('TypeError: boom')
    expect(body.events).toHaveLength(2)
    expect(new Date(body.events[0].occurred_at).getTime()).toBeGreaterThan(
      new Date(body.events[1].occurred_at).getTime(),
    )
    expect(body.events[0].stack).toBe(STACK)
    expect(body.events[0].context).toEqual({ route: '/api/bookings' })
  })

  it('answers 404 for an id that is not there', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/issues/3f6a1c2e-9d4b-4f8a-8c1d-2b7e5a9f0c31',
      cookies,
    })
    expect(response.statusCode).toBe(404)
    expect(response.json().error).toBe('not_found')
  })

  it('answers 400 for an id that is not a uuid', async () => {
    expect(
      (await app.inject({ method: 'GET', url: '/api/issues/nonsense', cookies })).statusCode,
    ).toBe(400)
  })

  it('needs a session', async () => {
    await report(key)
    const id = await idOfFirst()
    expect((await app.inject({ method: 'GET', url: `/api/issues/${id}` })).statusCode).toBe(401)
  })
})

describe('resolving and ignoring', () => {
  const idOfFirst = async () => (await list()).json().issues[0].id as string

  it('resolves an issue', async () => {
    await report(key)
    const id = await idOfFirst()
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/issues/${id}`,
      cookies,
      payload: { status: 'resolved' },
    })
    expect(response.statusCode).toBe(204)
    const issue = await db().selectFrom('issues').select('status').executeTakeFirstOrThrow()
    expect(issue.status).toBe('resolved')
  })

  it('ignores one, and unmutes it again', async () => {
    await report(key)
    const id = await idOfFirst()
    const patch = (status: string) =>
      app.inject({ method: 'PATCH', url: `/api/issues/${id}`, cookies, payload: { status } })

    expect((await patch('ignored')).statusCode).toBe(204)
    expect(
      (await db().selectFrom('issues').select('status').executeTakeFirstOrThrow()).status,
    ).toBe('ignored')
    expect((await patch('open')).statusCode).toBe(204)
    expect(
      (await db().selectFrom('issues').select('status').executeTakeFirstOrThrow()).status,
    ).toBe('open')
  })

  it('refuses a status outside the three', async () => {
    await report(key)
    const id = await idOfFirst()
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/issues/${id}`,
      cookies,
      payload: { status: 'snoozed' },
    })
    expect(response.statusCode).toBe(400)
  })

  it('answers 404 for an issue that is not there', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/issues/3f6a1c2e-9d4b-4f8a-8c1d-2b7e5a9f0c31',
      cookies,
      payload: { status: 'resolved' },
    })
    expect(response.statusCode).toBe(404)
  })

  it('needs a session', async () => {
    await report(key)
    const id = await idOfFirst()
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/issues/${id}`,
      payload: { status: 'resolved' },
    })
    expect(response.statusCode).toBe(401)
  })
})

describe('the applications list', () => {
  it('lists them for the filter', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/apps', cookies })
    expect(response.statusCode).toBe(200)
    expect(response.json().apps.map((a: { slug: string }) => a.slug)).toEqual([
      'other',
      'reference',
      'vigil',
    ])
  })

  it('needs a session', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/apps' })).statusCode).toBe(401)
  })
})

// find-my-way percent-decodes the path before matching a route, so `/%61pi/issues` reaches the
// `/api/issues` handler. The guard decides on the matched route pattern, so each of these must
// still be refused without a session — and must never answer 200.
describe('the guard against a percent-encoded path', () => {
  const ID = '3f6a1c2e-9d4b-4f8a-8c1d-2b7e5a9f0c31'
  const cases: { method: 'GET' | 'PATCH'; url: string; payload?: object; refusals: number[] }[] = [
    { method: 'GET', url: '/%61pi/issues', refusals: [401] },
    { method: 'GET', url: `/%61pi/issues/${ID}`, refusals: [401] },
    // 403 is as good as 401 here: the origin check runs first when an Origin header is sent.
    {
      method: 'PATCH',
      url: `/%61pi/issues/${ID}`,
      payload: { status: 'resolved' },
      refusals: [401, 403],
    },
    { method: 'GET', url: '/%61pi/apps', refusals: [401] },
  ]

  it.each(cases)(
    'refuses a signed-out $method $url',
    async ({ method, url, payload, refusals }) => {
      const response = await app.inject({ method, url, ...(payload ? { payload } : {}) })
      expect(response.statusCode).not.toBe(200)
      expect(refusals).toContain(response.statusCode)
    },
  )
})

// A caller's mistake is a 400, never a Postgres error surfacing as a 500.
describe('malformed input', () => {
  const ID = '3f6a1c2e-9d4b-4f8a-8c1d-2b7e5a9f0c31'
  const cases: { name: string; method: 'GET' | 'PATCH'; url: string; payload?: object }[] = [
    { name: 'an unknown sort', method: 'GET', url: '/api/issues?sort=newest' },
    { name: 'a limit of zero', method: 'GET', url: '/api/issues?limit=0' },
    { name: 'a limit above the cap', method: 'GET', url: '/api/issues?limit=201' },
    { name: 'a limit that is not a number', method: 'GET', url: '/api/issues?limit=lots' },
    { name: 'a fractional limit', method: 'GET', url: '/api/issues?limit=1.5' },
    { name: 'an unknown query parameter', method: 'GET', url: '/api/issues?page=2' },
    { name: 'an overlong app slug', method: 'GET', url: `/api/issues?app=${'a'.repeat(65)}` },
    {
      name: 'an overlong environment',
      method: 'GET',
      url: `/api/issues?environment=${'e'.repeat(65)}`,
    },
    { name: 'a uuid with a trailing character', method: 'GET', url: `/api/issues/${ID}x` },
    // ajv-formats' `uuid` accepts this RFC 4122 URN form; Postgres's uuid input does not.
    { name: 'a uuid in its urn form', method: 'GET', url: `/api/issues/urn:uuid:${ID}` },
    {
      name: 'a malformed id on PATCH',
      method: 'PATCH',
      url: '/api/issues/nonsense',
      payload: { status: 'resolved' },
    },
    {
      name: 'a urn id on PATCH',
      method: 'PATCH',
      url: `/api/issues/urn:uuid:${ID}`,
      payload: { status: 'resolved' },
    },
    {
      name: 'an extra body field',
      method: 'PATCH',
      url: `/api/issues/${ID}`,
      payload: { status: 'resolved', title: 'x' },
    },
    { name: 'a body without a status', method: 'PATCH', url: `/api/issues/${ID}`, payload: {} },
    {
      name: 'a status that is not a string',
      method: 'PATCH',
      url: `/api/issues/${ID}`,
      payload: { status: 1 },
    },
  ]

  it.each(cases)('answers 400 to $name', async ({ method, url, payload }) => {
    const response = await app.inject({ method, url, cookies, ...(payload ? { payload } : {}) })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('validation_error')
  })
})
