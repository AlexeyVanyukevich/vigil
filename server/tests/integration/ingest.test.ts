import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { sql } from 'kysely'
import { buildTestApp, closeTestDb, getTestDb, resetDb } from './helpers.js'
import { insertApp } from '../../src/modules/apps/app.repository.js'
import { insertKey, mintIngestKey } from '../../src/modules/ingest/key.repository.js'
import { IngestService } from '../../src/modules/ingest/ingest.service.js'
import type { IngestBodyType } from '../../src/modules/ingest/ingest.schemas.js'

let app: FastifyInstance
let appId: string
let otherAppId: string
let key: string
let otherKey: string

const db = () => getTestDb()

const CAPS = { maxStackBytes: 16_384, maxContextBytes: 8_192 }

const STACK = `TypeError: Cannot read properties of undefined (reading 'id')
    at handleBooking (/app/src/modules/bookings/booking.service.js:42:17)
    at process (/app/node_modules/fastify/lib/handle.js:118:9)`

// Deliberately looser than `IngestBodyType`: these fixtures are mutated in place by individual
// cases to build both valid batches and the malformed ones the wire-format tests expect a 400
// for, so every field but the three the happy path always sends is optional and an index
// signature lets a case attach a field the schema has never heard of.
interface EventInput {
  type: string
  message: string
  stack?: string
  occurred_at: string
  context?: Record<string, unknown>
  count?: number
  fingerprint?: string
  [key: string]: unknown
}

interface BatchInput {
  environment: string
  runtime: string
  events: EventInput[]
  [key: string]: unknown
}

function batch(overrides: Record<string, unknown> = {}): BatchInput {
  return {
    environment: 'production',
    runtime: 'node',
    events: [
      {
        type: 'TypeError',
        message: "Cannot read properties of undefined (reading 'id')",
        stack: STACK,
        occurred_at: new Date().toISOString(),
      },
    ],
    ...overrides,
  }
}

// `batch()` widened back to the strict wire type, for the concurrency tests that call
// `IngestService` directly and so skip Fastify's schema validation — they must hand it
// something already valid, which every default (unoverridden) `batch()` is.
const validBatch = (): IngestBodyType => batch() as IngestBodyType

// `null` (not `undefined`) means "send no Authorization header": a default parameter is applied
// whenever the argument is `undefined`, explicit or not, so `undefined` cannot double as that
// sentinel without silently falling back to `key`.
const post = (payload: object, token: string | null = key) =>
  app.inject({
    method: 'POST',
    url: '/ingest/events',
    ...(token === null ? {} : { headers: { authorization: `Bearer ${token}` } }),
    payload,
  })

beforeAll(async () => {
  app = await buildTestApp()
})
beforeEach(async () => {
  await resetDb()
  appId = (await insertApp(db(), 'reference', 'The reference application')).id
  otherAppId = (await insertApp(db(), 'other', 'Another application')).id
  key = mintIngestKey()
  otherKey = mintIngestKey()
  await insertKey(db(), appId, 'server', key)
  await insertKey(db(), otherAppId, 'server', otherKey)
})
afterAll(async () => {
  await app.close()
  await closeTestDb()
})

describe('the key', () => {
  it('is required', async () => {
    expect((await post(batch(), null)).statusCode).toBe(401)
  })

  it('must be one that exists', async () => {
    expect((await post(batch(), mintIngestKey())).statusCode).toBe(401)
  })

  it('must not be revoked', async () => {
    await db().updateTable('ingest_keys').set({ revoked_at: new Date() }).execute()
    expect((await post(batch())).statusCode).toBe(401)
  })

  it('is not read from a query string or a body field', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/ingest/events?key=${key}`,
      payload: batch(),
    })
    expect(response.statusCode).toBe(401)
  })

  // The property the trust boundary rests on: a key leaked from the least important
  // application must not become a way to forge events for the most important one.
  it('decides which application the events belong to, whatever the body claims', async () => {
    const response = await post({ ...batch(), app_id: otherAppId })
    // `additionalProperties: false` refuses the field outright rather than ignoring it.
    expect(response.statusCode).toBe(400)

    await post(batch())
    const issues = await db().selectFrom('issues').select('app_id').execute()
    expect(issues).toHaveLength(1)
    expect(issues[0]!.app_id).toBe(appId)
  })

  it('stamps last_used_at on the key that was presented', async () => {
    await post(batch())
    const rows = await db().selectFrom('ingest_keys').select(['app_id', 'last_used_at']).execute()
    const mine = rows.find((r) => r.app_id === appId)
    const theirs = rows.find((r) => r.app_id === otherAppId)
    expect(mine?.last_used_at).not.toBeNull()
    expect(theirs?.last_used_at).toBeNull()
  })

  // The key check must run before Fastify validates the body against the schema — a caller who
  // has proven nothing about who they are must not learn anything about the shape it expects,
  // and must not be answered with the wrong error code depending on which came first.
  it('wins over a body-shape complaint when no key is presented at all', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/%69ngest/events',
      payload: { not: 'a valid batch' },
    })
    expect(response.statusCode).toBe(401)
  })

  it('wins over the handler when no key is presented, even with a valid body', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/%69ngest/events',
      payload: batch(),
    })
    expect(response.statusCode).toBe(401)
  })
})

describe('storing a batch', () => {
  it('answers 202 as soon as it is stored', async () => {
    const response = await post(batch())
    expect(response.statusCode).toBe(202)
    expect(response.json()).toEqual({ accepted: 1 })
  })

  it('creates the issue and its first event', async () => {
    await post(batch())
    const issue = await db().selectFrom('issues').selectAll().executeTakeFirstOrThrow()
    expect(issue.title).toBe("TypeError: Cannot read properties of undefined (reading 'id')")
    expect(issue.culprit).toBe('handleBooking (/app/src/modules/bookings/booking.service.js)')
    expect(issue.runtime).toBe('node')
    expect(issue.environment).toBe('production')
    expect(issue.status).toBe('open')
    expect(issue.occurrence_count).toBe(1)

    const event = await db().selectFrom('events').selectAll().executeTakeFirstOrThrow()
    expect(event.issue_id).toBe(issue.id)
    expect(event.stack).toBe(STACK)
    expect(event.count).toBe(1)
  })

  // Ten thousand failures are one line, not ten thousand. Everything else rests on this.
  it('groups repeats into one issue and counts them', async () => {
    await post(batch())
    await post(batch())
    await post(batch())

    expect(await db().selectFrom('issues').selectAll().execute()).toHaveLength(1)
    const issue = await db().selectFrom('issues').selectAll().executeTakeFirstOrThrow()
    expect(issue.occurrence_count).toBe(3)
    expect(await db().selectFrom('events').selectAll().execute()).toHaveLength(3)
  })

  it('adds a client-side collapse to the count as a whole', async () => {
    const collapsed = batch()
    collapsed.events[0]!.count = 50_000
    await post(collapsed)

    const issue = await db().selectFrom('issues').selectAll().executeTakeFirstOrThrow()
    expect(issue.occurrence_count).toBe(50_000)
    // One row standing for fifty thousand throws, which is the point of §8's local collapse.
    expect(await db().selectFrom('events').selectAll().execute()).toHaveLength(1)
  })

  it('keeps a developer machine and production apart', async () => {
    await post(batch())
    await post(batch({ environment: 'development' }))
    const issues = await db()
      .selectFrom('issues')
      .select('environment')
      .orderBy('environment')
      .execute()
    expect(issues.map((i) => i.environment)).toEqual(['development', 'production'])
  })

  it('keeps two applications apart even for an identical error', async () => {
    await post(batch())
    await post(batch(), otherKey)
    expect(await db().selectFrom('issues').selectAll().execute()).toHaveLength(2)
  })

  it('stores every event in a batch and reports how many it took', async () => {
    const many = batch()
    many.events = Array.from({ length: 5 }, (_, i) => ({
      type: 'Error',
      message: `failure ${i}`,
      stack: STACK.replace('handleBooking', `handler${i}`),
      occurred_at: new Date().toISOString(),
    }))
    const response = await post(many)
    expect(response.json()).toEqual({ accepted: 5 })
    expect(await db().selectFrom('issues').selectAll().execute()).toHaveLength(5)
  })

  it('keeps when it happened apart from when it landed', async () => {
    const late = batch()
    const happened = new Date(Date.now() - 3_600_000)
    late.events[0]!.occurred_at = happened.toISOString()
    await post(late)

    const event = await db().selectFrom('events').selectAll().executeTakeFirstOrThrow()
    expect(event.occurred_at.getTime()).toBe(happened.getTime())
    expect(event.received_at.getTime()).toBeGreaterThan(event.occurred_at.getTime())
  })

  // An offline queue replaying an hour late must not drag `last_seen_at` backwards and make a
  // live issue look stale.
  it('never moves last_seen_at backwards', async () => {
    await post(batch())
    const before = (
      await db().selectFrom('issues').select('last_seen_at').executeTakeFirstOrThrow()
    ).last_seen_at

    const late = batch()
    late.events[0]!.occurred_at = new Date(Date.now() - 86_400_000).toISOString()
    await post(late)

    const after = (await db().selectFrom('issues').select('last_seen_at').executeTakeFirstOrThrow())
      .last_seen_at
    expect(after.getTime()).toBe(before.getTime())
  })

  it('stores a context as json', async () => {
    const withContext = batch()
    withContext.events[0]!.context = { route: '/api/bookings', method: 'POST' }
    await post(withContext)
    const event = await db().selectFrom('events').select('context').executeTakeFirstOrThrow()
    expect(event.context).toEqual({ route: '/api/bookings', method: 'POST' })
  })

  // Nothing but the 8 KB cap limits how deep a context nests. `JSON.stringify` and `jsonb` take
  // this depth in their stride, so anything that walks the context recursively is the weak link.
  it('stores a context nested thousands deep, within the cap', async () => {
    let nested: unknown = 0
    for (let depth = 0; depth < 4_000; depth++) nested = [nested]
    const deep = batch()
    deep.events[0]!.context = { k: nested }

    const response = await post(deep)
    expect(response.statusCode).toBe(202)

    const event = await db().selectFrom('events').select('context').executeTakeFirstOrThrow()
    expect(JSON.stringify(event.context)).toBe(JSON.stringify({ k: nested }))
  })

  // §13 records vigil's own failures by calling the service in-process, with real JavaScript
  // values rather than parsed JSON, so a context is stored as `JSON.stringify` would write it.
  it('stores a Date in a context passed in-process as its ISO string', async () => {
    const at = new Date('2026-09-05T12:34:56.789Z')
    const withDate = validBatch()
    withDate.events[0]!.context = { at, nested: [{ at }] }

    await new IngestService(db(), CAPS).record(appId, withDate)

    const event = await db().selectFrom('events').select('context').executeTakeFirstOrThrow()
    expect(event.context).toEqual({ at: at.toISOString(), nested: [{ at: at.toISOString() }] })
  })

  it('accepts an error with no stack at all', async () => {
    const stackless = batch()
    delete (stackless.events[0] as Record<string, unknown>).stack
    const response = await post(stackless)
    expect(response.statusCode).toBe(202)
    const issue = await db().selectFrom('issues').selectAll().executeTakeFirstOrThrow()
    expect(issue.culprit).toBeNull()
  })
})

// Postgres refuses U+0000 in both `text` and `jsonb`. Without replacing it, one event carrying
// binary garbage fails the whole batch with a 500 — and a client retrying on 5xx resends that
// batch forever. Replaced, not refused: refusing would throw away the error report itself.
interface NulCase {
  where: string
  patch: Partial<EventInput>
  column: 'stack' | 'message' | 'context'
  stored: unknown
}

const NUL_CASES: NulCase[] = [
  {
    where: 'the stack',
    patch: { stack: `${STACK}\n\u0000garbage` },
    column: 'stack',
    stored: `${STACK}\n\uFFFDgarbage`,
  },
  {
    where: 'the message',
    patch: { message: 'bad \u0000 byte' },
    column: 'message',
    stored: 'bad \uFFFD byte',
  },
  {
    where: 'a context value',
    patch: { context: { body: 'a\u0000b', nested: [{ deeper: '\u0000' }] } },
    column: 'context',
    stored: { body: 'a\uFFFDb', nested: [{ deeper: '\uFFFD' }] },
  },
  {
    where: 'a context key',
    patch: { context: { 'k\u0000': 1, nested: { 'x\u0000y': true } } },
    column: 'context',
    stored: { 'k\uFFFD': 1, nested: { 'x\uFFFDy': true } },
  },
]

// Each of these decides the fingerprint of a stackless event.
interface GroupingCase {
  where: string
  patch: (text: string) => Partial<EventInput>
}

const GROUPING_CASES: GroupingCase[] = [
  { where: 'the type', patch: (text) => ({ type: `Error${text}` }) },
  { where: 'the message', patch: (text) => ({ message: `bad ${text} byte` }) },
  { where: 'the fingerprint', patch: (text) => ({ fingerprint: `checkout${text}` }) },
]

describe('a NUL byte', () => {
  it.each(NUL_CASES)(
    'in $where is stored as U+FFFD rather than failing the batch',
    async ({ patch, column, stored }) => {
      const poisoned = batch()
      Object.assign(poisoned.events[0]!, patch)

      const response = await post(poisoned)
      expect(response.statusCode).toBe(202)

      const event = await db().selectFrom('events').selectAll().executeTakeFirstOrThrow()
      expect(event[column]).toEqual(stored)
    },
  )

  // Grouping must see the text that is stored. Otherwise two issues would carry the same stored
  // text, split by a difference nobody can see on the dashboard.
  it.each(GROUPING_CASES)('in $where groups with the U+FFFD it is stored as', async ({ patch }) => {
    for (const text of ['\u0000', '\uFFFD']) {
      const event = batch()
      Object.assign(event.events[0]!, patch(text))
      delete (event.events[0] as Record<string, unknown>).stack
      expect((await post(event)).statusCode).toBe(202)
    }

    expect(await db().selectFrom('issues').selectAll().execute()).toHaveLength(1)
  })
})

describe('a backslash followed by the text u0000', () => {
  // Serialised, this is `\\u0000`: an escaped backslash, then plain text. It carries no NUL,
  // and replacing inside the serialised context must not mistake it for one.
  it('is stored unchanged', async () => {
    const context = { path: 'C:\\u0000dir', nested: [{ 'key\\u0000': 'x\\\\u0000' }] }
    const literal = batch()
    literal.events[0]!.context = context

    expect((await post(literal)).statusCode).toBe(202)

    const event = await db().selectFrom('events').select('context').executeTakeFirstOrThrow()
    expect(event.context).toEqual(context)
  })
})

describe('regression', () => {
  it('reopens a resolved issue and stamps when', async () => {
    await post(batch())
    await db().updateTable('issues').set({ status: 'resolved' }).execute()

    await post(batch())

    const issue = await db().selectFrom('issues').selectAll().executeTakeFirstOrThrow()
    expect(issue.status).toBe('open')
    expect(issue.reopened_at).not.toBeNull()
    expect(issue.occurrence_count).toBe(2)
  })

  // An ignored issue is one the owner has decided not to hear about. A new occurrence must not
  // undo that decision — otherwise `ignored` means nothing.
  it('leaves an ignored issue ignored', async () => {
    await post(batch())
    await db().updateTable('issues').set({ status: 'ignored' }).execute()

    await post(batch())

    const issue = await db().selectFrom('issues').selectAll().executeTakeFirstOrThrow()
    expect(issue.status).toBe('ignored')
    expect(issue.reopened_at).toBeNull()
    // Still counted, so the dashboard can show that a muted issue is still happening.
    expect(issue.occurrence_count).toBe(2)
  })

  it('does not stamp reopened_at on an issue that was never resolved', async () => {
    await post(batch())
    await post(batch())
    const issue = await db().selectFrom('issues').select('reopened_at').executeTakeFirstOrThrow()
    expect(issue.reopened_at).toBeNull()
  })
})

describe('the hard caps', () => {
  // Fastify's own default `bodyLimit` (1 MiB) is a fourth, unstated cap. Pins the derivation in
  // `ingest.body-limit.ts`, not just "some generous number": every field that can drive up the
  // *wire* size is built at its real cap out of the character that is worst-case for it. `stack`,
  // `message`, `type`, `fingerprint` and `environment` are all guarded against their *decoded*
  // size, and JSON.stringify writes a control character (one decoded byte/unit) as the six-byte
  // `\u00xx` escape — a control character at the cap, not an ordinary ASCII one, is what actually
  // stresses the limit. A weaker escape factor than 6 here would answer 413, not 202.
  it('accepts a batch at every cap, built from the worst-case escaping character', async () => {
    const worstCase = '\u0001'
    const stack = worstCase.repeat(16_000) // under the 16,384-byte guardBytes cap
    const message = worstCase.repeat(4_000) // at MAX_MESSAGE_LENGTH
    const type = worstCase.repeat(200) // at MAX_TYPE_LENGTH — still matches NonBlankString's \S
    const fingerprint = worstCase.repeat(200) // at MAX_FINGERPRINT_LENGTH

    const events = Array.from({ length: 100 }, () => ({
      type,
      message,
      stack,
      occurred_at: new Date().toISOString(),
      fingerprint,
    }))
    const response = await post(batch({ environment: worstCase.repeat(64), events }))
    expect(response.statusCode).toBe(202)
    expect(response.json()).toEqual({ accepted: 100 })
  })

  // The same, with each field at its cap in the escaping that is worst for how its cap is
  // measured. The schema's `maxLength` counts code points, so an astral character is one unit of
  // `message`'s cap — and Python's `json.dumps` writes it as a surrogate pair, `😀`,
  // twelve bytes. `stack` and `context` are byte caps, and any one byte can arrive as `\u00XX`,
  // six. Written by hand, since `JSON.stringify` escapes neither.
  it('accepts a batch at every cap, with every character written as an escape', async () => {
    const escaped = (value: string) =>
      `"${Array.from({ length: value.length }, (_, i) => `\\u${value.charCodeAt(i).toString(16).padStart(4, '0')}`).join('')}"`

    const astral = '\u{1F600}'
    const context = { k: 'a'.repeat(8_192 - '{"k":""}'.length) } // at the 8,192-byte cap
    const event = [
      `{"type":${escaped(astral.repeat(200))}`, // at MAX_TYPE_LENGTH
      `"message":${escaped(astral.repeat(4_000))}`, // at MAX_MESSAGE_LENGTH
      `"stack":${escaped('a'.repeat(16_384))}`, // at the 16,384-byte cap
      `"occurred_at":"${new Date().toISOString()}"`,
      `"fingerprint":${escaped(astral.repeat(200))}`, // at MAX_FINGERPRINT_LENGTH
      `"context":{${escaped('k')}:${escaped(context.k)}}}`,
    ].join(',')
    const payload = `{"environment":${escaped(astral.repeat(64))},"runtime":"node","events":[${Array.from({ length: 100 }, () => event).join(',')}]}`

    const response = await app.inject({
      method: 'POST',
      url: '/ingest/events',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      payload,
    })
    expect(response.statusCode).toBe(202)
    expect(response.json()).toEqual({ accepted: 100 })

    const stored = await db().selectFrom('events').select('message').executeTakeFirstOrThrow()
    expect(stored.message).toBe(astral.repeat(4_000))
  })

  it('refuses a batch over the event limit', async () => {
    const capped = await buildTestApp({ config: { maxEventsPerBatch: 2 } })
    try {
      const many = batch()
      many.events = Array.from({ length: 3 }, () => ({
        type: 'Error',
        message: 'too many',
        occurred_at: new Date().toISOString(),
      }))
      const response = await capped.inject({
        method: 'POST',
        url: '/ingest/events',
        headers: { authorization: `Bearer ${key}` },
        payload: many,
      })
      expect(response.statusCode).toBe(400)
      expect(response.json().error).toBe('validation_error')
    } finally {
      await capped.close()
    }
  })

  it('refuses an empty batch', async () => {
    expect((await post(batch({ events: [] }))).statusCode).toBe(400)
  })

  // Rejected, not truncated and kept: a stack cut in half fingerprints differently from the
  // same stack whole, which would split one issue into two by payload size alone.
  it('refuses an oversize stack rather than trimming it', async () => {
    const capped = await buildTestApp({ config: { maxStackBytes: 64 } })
    try {
      const big = batch()
      big.events[0]!.stack = 'at x (/a.js:1:1)\n'.repeat(50)
      const response = await capped.inject({
        method: 'POST',
        url: '/ingest/events',
        headers: { authorization: `Bearer ${key}` },
        payload: big,
      })
      expect(response.statusCode).toBe(413)
      expect(response.json().error).toBe('payload_too_large')
      expect(await db().selectFrom('events').selectAll().execute()).toHaveLength(0)
    } finally {
      await capped.close()
    }
  })

  it('refuses an oversize context', async () => {
    const capped = await buildTestApp({ config: { maxContextBytes: 64 } })
    try {
      const big = batch()
      big.events[0]!.context = { blob: 'x'.repeat(500) }
      const response = await capped.inject({
        method: 'POST',
        url: '/ingest/events',
        headers: { authorization: `Bearer ${key}` },
        payload: big,
      })
      expect(response.statusCode).toBe(413)
    } finally {
      await capped.close()
    }
  })

  // A batch is one unit. Half-storing it would leave the client unable to tell what to resend.
  it('stores nothing at all when one event in a batch is refused', async () => {
    const capped = await buildTestApp({ config: { maxStackBytes: 64 } })
    try {
      const mixed = batch()
      mixed.events = [
        { type: 'Error', message: 'fine', occurred_at: new Date().toISOString() },
        {
          type: 'Error',
          message: 'too big',
          stack: 'at x (/a.js:1:1)\n'.repeat(50),
          occurred_at: new Date().toISOString(),
        },
      ]
      const response = await capped.inject({
        method: 'POST',
        url: '/ingest/events',
        headers: { authorization: `Bearer ${key}` },
        payload: mixed,
      })
      expect(response.statusCode).toBe(413)
      expect(await db().selectFrom('issues').selectAll().execute()).toHaveLength(0)
      expect(await db().selectFrom('events').selectAll().execute()).toHaveLength(0)
    } finally {
      await capped.close()
    }
  })
})

describe('the wire format', () => {
  it('rejects an unknown field rather than ignoring it', async () => {
    const response = await post({ ...batch(), severity: 'critical' })
    expect(response.statusCode).toBe(400)
  })

  it('rejects an unknown field inside an event', async () => {
    const odd = batch()
    ;(odd.events[0] as Record<string, unknown>).release = 'v2'
    expect((await post(odd)).statusCode).toBe(400)
  })

  it('requires an environment', async () => {
    const response = await post(batch({ environment: '   ' }))
    expect(response.statusCode).toBe(400)
  })

  it('requires a runtime it knows', async () => {
    expect((await post(batch({ runtime: 'deno' }))).statusCode).toBe(400)
  })

  it('requires occurred_at to be a timestamp', async () => {
    const bad = batch()
    bad.events[0]!.occurred_at = 'yesterday'
    expect((await post(bad)).statusCode).toBe(400)
  })

  it('honours an explicit fingerprint', async () => {
    const a = batch()
    a.events[0]!.fingerprint = 'checkout'
    const b = batch({
      events: [
        {
          type: 'RangeError',
          message: 'different',
          occurred_at: new Date().toISOString(),
          fingerprint: 'checkout',
        },
      ],
    })
    await post(a)
    await post(b)
    expect(await db().selectFrom('issues').selectAll().execute()).toHaveLength(1)
  })
})

describe('concurrency', () => {
  it('collapses N concurrent reports of a brand-new fingerprint into one issue', async () => {
    const service = new IngestService(db(), CAPS)
    const N = 8

    await Promise.all(Array.from({ length: N }, () => service.record(appId, validBatch())))

    const issues = await db().selectFrom('issues').selectAll().execute()
    expect(issues).toHaveLength(1)
    expect(issues[0]!.occurrence_count).toBe(N)
    expect(await db().selectFrom('events').selectAll().execute()).toHaveLength(N)
  })

  /**
   * Polls until `expected` backends are queued on a lock. `fileParallelism: false` keeps other
   * test files out of this database, so every waiter counted is one this test started.
   */
  async function waitForLockWaiters(expected: number, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const { rows } = await sql<{ waiting: number }>`
        select count(*)::int as waiting from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
      `.execute(db())
      const waiting = rows[0]?.waiting ?? 0
      if (waiting >= expected) return
      if (Date.now() > deadline) {
        throw new Error(
          `${waiting} of ${expected} backends were waiting on a lock after ${timeoutMs}ms`,
        )
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  /**
   * A local, low-latency Postgres gives concurrent calls nothing to contend over: each runs
   * start-to-finish before the next issues its first query, and a lock is never held by more
   * than one of them at once. So this app's issue rows are locked from a transaction of its own,
   * `contend` is started, and the rows are released only once `waiters` backends are queued
   * behind them — the contenders then really do overlap.
   */
  async function raceBehindLock<T>(contend: () => Promise<T>, waiters: number): Promise<T> {
    const holder = await db().startTransaction().execute()
    let committed = false
    try {
      await holder
        .selectFrom('issues')
        .select('id')
        .where('app_id', '=', appId)
        .forUpdate()
        .execute()

      const pending = contend()
      // Handled from the start. A rejection while the test is still waiting below would
      // otherwise have no handler yet and be reported as unhandled; `await pending` still
      // rethrows it.
      pending.catch(() => {})

      await waitForLockWaiters(waiters)
      await holder.commit().execute()
      committed = true

      return await pending
    } finally {
      // Only a holder still open: rolling back a committed one throws, and that error would
      // replace the failure that brought us here.
      if (!committed) await holder.rollback().execute()
    }
  }

  it('reopens a resolved issue exactly once under N concurrent reports', async () => {
    const service = new IngestService(db(), CAPS)
    await service.record(appId, validBatch())
    await db().updateTable('issues').set({ status: 'resolved' }).execute()

    const N = 8
    const results = await raceBehindLock(
      () => Promise.all(Array.from({ length: N }, () => service.record(appId, validBatch()))),
      N,
    )

    // Only whichever of the N transactions is the first to lock the row finds it `resolved`;
    // every other one, once it gets the lock (once the holder has released it), finds the
    // first's `open` already committed. Without the lock, all N read `resolved`.
    const regressedCount = results.flat().filter((r) => r.regressed).length
    expect(regressedCount).toBe(1)

    const issue = await db().selectFrom('issues').selectAll().executeTakeFirstOrThrow()
    expect(issue.status).toBe('open')
    expect(issue.reopened_at).not.toBeNull()
    expect(issue.occurrence_count).toBe(N + 1)
  })

  // The upsert takes a row lock (`SELECT ... FOR UPDATE`) per event. Were they taken in the
  // order the batch lists them, two processes reporting the same two issues in opposite orders
  // would each hold one lock and wait on the other's — a textbook deadlock, which Postgres
  // resolves by aborting one with 40P01. That failure must not reach the client as a lost batch.
  it('does not deadlock when two concurrent batches list the same two issues in opposite order', async () => {
    const eventA = {
      type: 'Error',
      message: 'a',
      occurred_at: new Date().toISOString(),
      fingerprint: 'deadlock-a',
    }
    const eventB = {
      type: 'Error',
      message: 'b',
      occurred_at: new Date().toISOString(),
      fingerprint: 'deadlock-b',
    }

    // Both issues must already exist before the race: a deadlock needs two transactions each
    // already holding one row's lock and blocking on the other's, which only happens on the
    // *update* path — inserting a brand-new fingerprint never contends for another
    // transaction's row.
    await post(batch({ events: [eventA] }))
    await post(batch({ events: [eventB] }))

    // Both batches queue behind the held rows. Released together, each would take its first
    // row at once in batch order and then block on the other's — so only a fixed lock order
    // answers 202 twice.
    const [resAB, resBA] = await raceBehindLock(
      () =>
        Promise.all([
          post(batch({ events: [eventA, eventB] })),
          post(batch({ events: [eventB, eventA] })),
        ]),
      2,
    )
    expect(resAB.statusCode).toBe(202)
    expect(resBA.statusCode).toBe(202)
  })
})
