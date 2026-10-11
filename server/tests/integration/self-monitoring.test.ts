import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, closeTestDb, getTestDb, resetDb } from './helpers.js'
import { signIn } from './auth-helper.js'
import { IngestService } from '../../src/modules/ingest/ingest.service.js'
import type { IngestBodyType } from '../../src/modules/ingest/ingest.schemas.js'
import {
  createSelfRecorder,
  STACK_TRUNCATION_MARKER,
  type SelfRecorder,
} from '../../src/self/record.js'

let app: FastifyInstance
let cookies: Record<string, string>

const db = () => getTestDb()

const CAPS = { maxStackBytes: 16_384, maxContextBytes: 8_192 }
const BOOM = 'Error: the database went away'

/** An error whose own fields make `JSON.stringify` throw: a cycle and a BigInt. */
function unserialisableError(): Error {
  const error = new Error('carries a cycle and a bigint')
  Object.assign(error, { self: error, big: 10n })
  return error
}

/** An error whose stack is over the ingest cap: the route would refuse it, the recorder cuts it. */
function oversizeError(): Error {
  const error = new Error('stack too large to store')
  error.stack = `Error: stack too large to store\n${'    at nowhere (x.js:1:1)\n'.repeat(1_000)}`
  return error
}

/** An error whose `message` getter throws, so the recorder's own write rejects before storing. */
function hostileError(): Error {
  const error = new Error()
  Object.defineProperty(error, 'message', {
    get() {
      throw new Error('a hostile getter')
    },
  })
  return error
}

/** More than `maxContextBytes` of context, which `IngestService.record()` refuses outright. */
const OVERSIZE_CONTEXT = { blob: 'x'.repeat(CAPS.maxContextBytes + 1) }

/**
 * Routes that throw, registered only in this suite: making a production route fail on demand
 * would mean shipping a way to make it fail.
 */
beforeAll(async () => {
  app = await buildTestApp({
    routes: (instance) => {
      instance.get('/api/boom', async () => {
        throw new Error('the database went away')
      })
      instance.get('/api/unserialisable', async () => {
        throw unserialisableError()
      })
      instance.get('/api/hostile', async () => {
        throw hostileError()
      })
      instance.get('/ingest/boom', async () => {
        throw new Error('ingest itself is broken')
      })
    },
  })
})
beforeEach(async () => {
  await resetDb()
  cookies = await signIn(app)
})
afterAll(async () => {
  await app.close()
  await closeTestDb()
})

const issues = () =>
  db()
    .selectFrom('issues')
    .innerJoin('apps', 'apps.id', 'issues.app_id')
    .select(['issues.title as title', 'apps.slug as slug', 'issues.occurrence_count as count'])
    .orderBy('issues.title')
    .execute()

const titles = async () => (await issues()).map((issue) => issue.title)

// The recorder writes after the response is sent; poll rather than sleep a fixed amount, so the
// case is neither flaky nor slower than it has to be.
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await read()
    if (done(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return read()
}

/**
 * Proving that something was *not* recorded needs a point after which it would have been.
 * A known failure recorded after it is that point: its write was started later.
 */
async function recordSentinel(): Promise<void> {
  await app.inject({ method: 'GET', url: '/api/boom', cookies })
  await until(titles, (rows) => rows.includes(BOOM))
}

describe('vigil recording its own failures', () => {
  it('files an unhandled error under the vigil application', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/boom', cookies })
    expect(response.statusCode).toBe(500)
    // The owner is told nothing about the internals; the issue carries the detail.
    expect(response.json()).toEqual({ error: 'internal_error', message: 'Internal server error' })

    const [issue] = await until(issues, (rows) => rows.length >= 1)
    expect(issue?.slug).toBe('vigil')
    expect(issue?.title).toBe(BOOM)
  })

  it('groups its own repeats like anything else', async () => {
    await app.inject({ method: 'GET', url: '/api/boom', cookies })
    await app.inject({ method: 'GET', url: '/api/boom', cookies })
    const rows = await until(issues, (found) => found[0]?.count === 2)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.count).toBe(2)
  })

  // A guard that meant "one recording at a time, process-wide" would drop every failure that
  // lands while another is being written — which is when failures come in bunches.
  it('records failures that happen at the same time', async () => {
    await Promise.all(
      Array.from({ length: 5 }, () => app.inject({ method: 'GET', url: '/api/boom', cookies })),
    )
    const rows = await until(issues, (found) => found[0]?.count === 5)
    expect(rows[0]?.count).toBe(5)
  })

  // The matched route pattern, not the raw url: a query string can carry anything, and a
  // pattern groups `/api/issues/<id>` by route rather than by id.
  it('records the method, route and status as context, and nothing else', async () => {
    await app.inject({ method: 'GET', url: '/api/boom?token=secret', cookies })
    await until(issues, (rows) => rows.length >= 1)
    const event = await db().selectFrom('events').select('context').executeTakeFirstOrThrow()
    expect(event.context).toEqual({ method: 'GET', route: '/api/boom', status_code: 500 })
  })

  // An expected refusal is not a defect. Filing every 401 as an issue would bury the one thing
  // this table exists to surface.
  describe('does not record an error the caller caused', () => {
    const MISSING = '00000000-0000-4000-8000-000000000000'
    const cases: Array<{
      name: string
      method: 'GET' | 'PATCH'
      url: string
      signedIn: boolean
      payload?: string
      status: number
    }> = [
      {
        name: 'no session (AppError)',
        method: 'GET',
        url: '/api/issues',
        signedIn: false,
        status: 401,
      },
      {
        name: 'a malformed id (schema)',
        method: 'GET',
        url: '/api/issues/nonsense',
        signedIn: true,
        status: 400,
      },
      {
        name: 'an unknown issue (AppError)',
        method: 'GET',
        url: `/api/issues/${MISSING}`,
        signedIn: true,
        status: 404,
      },
      {
        name: 'a body that is not JSON (Fastify 4xx)',
        method: 'PATCH',
        url: `/api/issues/${MISSING}`,
        signedIn: true,
        payload: '{',
        status: 400,
      },
    ]

    it.each(cases)('$name', async ({ method, url, signedIn, payload, status }) => {
      const response = await app.inject({
        method,
        url,
        ...(signedIn ? { cookies } : {}),
        ...(payload === undefined
          ? {}
          : { payload, headers: { 'content-type': 'application/json' } }),
      })
      expect(response.statusCode).toBe(status)

      await recordSentinel()
      expect(await titles()).toEqual([BOOM])
    })
  })

  // The loop §13 exists to close: a failure in the ingest path must not generate an error about
  // the ingest path failing, forever. Decided by the matched route, so percent-encoding a letter
  // of the prefix does not walk around it.
  describe('does not file an issue about a failure in the ingest path itself', () => {
    it.each([
      { name: 'plain', url: '/ingest/boom' },
      { name: 'percent-encoded prefix', url: '/%69ngest/boom' },
    ])('$name', async ({ url }) => {
      const response = await app.inject({ method: 'GET', url })
      expect(response.statusCode).toBe(500)
      expect(response.json()).toEqual({ error: 'internal_error', message: 'Internal server error' })

      await recordSentinel()
      expect(await titles()).toEqual([BOOM])
    })
  })

  // If recording an error can throw, the error handler becomes the next thing to fail — while
  // it is already handling a failure.
  describe('never lets its own failure reach the response', () => {
    it('when the vigil application row is missing', async () => {
      await db().deleteFrom('apps').where('slug', '=', 'vigil').execute()
      const response = await app.inject({ method: 'GET', url: '/api/boom', cookies })
      expect(response.statusCode).toBe(500)
      expect(response.json()).toEqual({ error: 'internal_error', message: 'Internal server error' })
    })

    it('when the error carries fields JSON cannot serialise', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/unserialisable', cookies })
      expect(response.statusCode).toBe(500)
      expect(response.json()).toEqual({ error: 'internal_error', message: 'Internal server error' })

      // Recorded all the same, because the context is built from chosen fields, never the error.
      await until(titles, (rows) => rows.length >= 1)
      expect(await titles()).toEqual(['Error: carries a cycle and a bigint'])
      const event = await db().selectFrom('events').select('context').executeTakeFirstOrThrow()
      expect(event.context).toEqual({
        method: 'GET',
        route: '/api/unserialisable',
        status_code: 500,
      })
    })

    it('when the write itself is rejected', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/hostile', cookies })
      expect(response.statusCode).toBe(500)
      expect(response.json()).toEqual({ error: 'internal_error', message: 'Internal server error' })

      await recordSentinel()
      expect(await titles()).toEqual([BOOM])
    })
  })
})

describe('the self recorder, called directly', () => {
  function recorderWith(ingest: IngestService = new IngestService(db(), CAPS)) {
    const warnings: string[] = []
    const recorder = createSelfRecorder({
      db: db(),
      ingest,
      environment: 'test',
      maxStackBytes: CAPS.maxStackBytes,
      log: {
        warn: (_details, message) => {
          warnings.push(message)
        },
      },
    })
    return { recorder, warnings }
  }

  // Task 6's finding: in-process, a context is a real value, and `JSON.stringify` throws on
  // these. The error is still worth keeping without its context.
  describe('keeps the error when its context cannot be serialised', () => {
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    it.each([
      { name: 'a BigInt', context: { big: 10n } },
      { name: 'a circular reference', context: cycle },
      { name: 'a toJSON returning undefined', context: { toJSON: () => undefined } },
    ])('$name', async ({ name, context }) => {
      const { recorder, warnings } = recorderWith()
      expect(() => recorder.record(new Error(name), context)).not.toThrow()

      await until(titles, (rows) => rows.length >= 1)
      expect(await titles()).toEqual([`Error: ${name}`])
      const event = await db().selectFrom('events').select('context').executeTakeFirstOrThrow()
      expect(event.context).toBeNull()
      expect(warnings).toEqual([])
    })
  })

  it('logs a rejected write once and swallows it', async () => {
    const { recorder, warnings } = recorderWith()
    expect(() => recorder.record(new Error('context too large'), OVERSIZE_CONTEXT)).not.toThrow()

    await until(
      async () => warnings,
      (seen) => seen.length >= 1,
    )
    expect(warnings).toEqual(['could not record our own error'])
    expect(await issues()).toHaveLength(0)
  })

  it('logs and skips when the vigil application row is missing', async () => {
    await db().deleteFrom('apps').where('slug', '=', 'vigil').execute()
    const { recorder, warnings } = recorderWith()
    expect(() => recorder.record(new Error('nowhere to put this'), {})).not.toThrow()

    await until(
      async () => warnings,
      (seen) => seen.length >= 1,
    )
    expect(warnings).toEqual(['no vigil application row; own errors are not being recorded'])
  })

  it('records something thrown that is not an Error', async () => {
    const { recorder } = recorderWith()
    recorder.record('a bare string', {})
    await until(titles, (rows) => rows.length >= 1)
    expect(await titles()).toEqual(['Error: a bare string'])
  })

  // The other half of §13's loop: anything that reports a failure from *inside* the recorder's
  // own write must not start another write. Here the ingest service itself reports one, as a
  // hook on a failing query might.
  it('refuses to record from inside its own write', async () => {
    class ReportingIngest extends IngestService {
      recorder: SelfRecorder | undefined
      private reported = false

      override async record(appId: string, body: IngestBodyType) {
        if (!this.reported) {
          this.reported = true
          this.recorder?.record(new Error('raised while recording'), {})
        }
        return super.record(appId, body)
      }
    }
    const ingest = new ReportingIngest(db(), CAPS)
    const { recorder } = recorderWith(ingest)
    ingest.recorder = recorder

    recorder.record(new Error('the original'), {})
    await until(titles, (rows) => rows.includes('Error: the original'))
    // A later write, so a nested one — had it started — would have landed first.
    recorder.record(new Error('sentinel'), {})
    await until(titles, (rows) => rows.includes('Error: sentinel'))

    expect(await titles()).toEqual(['Error: sentinel', 'Error: the original'])
  })

  // Ruling 29: §6 refuses to truncate so a retrying client cannot split one issue in two. The
  // recorder is the only producer of `vigil` events and never retries, and dropping the event
  // would defeat §13, so vigil's own stack is cut to fit instead.
  describe('keeps an error whose stack is over the cap, cut to fit', () => {
    const stored = () =>
      db().selectFrom('events').select(['stack', 'message']).executeTakeFirstOrThrow()

    it('a stack of many frames', async () => {
      const { recorder, warnings } = recorderWith()
      recorder.record(oversizeError(), {})
      await until(titles, (rows) => rows.length >= 1)

      expect(await titles()).toEqual(['Error: stack too large to store'])
      const { stack } = await stored()
      expect(Buffer.byteLength(stack ?? '', 'utf8')).toBeLessThanOrEqual(CAPS.maxStackBytes)
      expect(stack?.endsWith(`\n${STACK_TRUNCATION_MARKER}`)).toBe(true)
      expect(warnings).toEqual([])
    })

    // The stack begins with the message, so a long message alone overflows it. Two bytes a
    // character, so a cut measured in code units would think this fits and lose the event.
    it('a message long enough to overflow the stack on its own', async () => {
      const { recorder, warnings } = recorderWith()
      recorder.record(new Error('é'.repeat(10_000)), {})
      await until(issues, (rows) => rows.length >= 1)

      const { stack } = await stored()
      expect(Buffer.byteLength(stack ?? '', 'utf8')).toBeLessThanOrEqual(CAPS.maxStackBytes)
      expect(stack?.endsWith(STACK_TRUNCATION_MARKER)).toBe(true)
      expect(warnings).toEqual([])
    })

    // `record()` stores each NUL as U+FFFD, three bytes where it was one, and measures after.
    // A stack cut before that replacement would triple past the cap and be refused.
    it('a stack full of NUL bytes', async () => {
      const error = new Error('binary in the stack')
      error.stack = `Error: binary in the stack\n${`${'\u0000'.repeat(100)}\n`.repeat(200)}`
      const { recorder, warnings } = recorderWith()
      recorder.record(error, {})
      await until(issues, (rows) => rows.length >= 1)

      const { stack } = await stored()
      expect(Buffer.byteLength(stack ?? '', 'utf8')).toBeLessThanOrEqual(CAPS.maxStackBytes)
      expect(warnings).toEqual([])
    })

    it('the same oversized error twice, as one issue', async () => {
      const { recorder } = recorderWith()
      recorder.record(oversizeError(), {})
      recorder.record(oversizeError(), {})
      const rows = await until(issues, (found) => found[0]?.count === 2)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.count).toBe(2)
    })
  })

  // Ruling 29: a write started by one case must not land in the next case's database, and one
  // in flight at shutdown must not be lost.
  describe('drain', () => {
    it('waits for every write in flight', async () => {
      const { recorder } = recorderWith()
      recorder.record(new Error('first in flight'), {})
      recorder.record(new Error('second in flight'), {})
      await recorder.drain()
      // No polling: once drained, both are stored. Events, not titles: thrown from the same
      // place, the two group into one issue.
      const events = await db().selectFrom('events').select('message').orderBy('message').execute()
      expect(events.map((event) => event.message)).toEqual(['first in flight', 'second in flight'])
    })

    it('settles, never rejects, when a write in flight fails', async () => {
      const { recorder, warnings } = recorderWith()
      recorder.record(new Error('context too large'), OVERSIZE_CONTEXT)
      recorder.record(hostileError(), {})
      await expect(recorder.drain()).resolves.toBeUndefined()
      expect(warnings).toEqual(['could not record our own error', 'could not record our own error'])
    })
  })
})

describe('closing the app', () => {
  it('waits for its own writes before it finishes', async () => {
    const closing = await buildTestApp({
      routes: (instance) => {
        instance.get('/api/boom', async () => {
          throw new Error('the database went away')
        })
      },
    })
    const response = await closing.inject({ method: 'GET', url: '/api/boom', cookies })
    expect(response.statusCode).toBe(500)
    await closing.close()
    // No polling: close does not return while the write is still in flight.
    expect(await titles()).toEqual([BOOM])
  })

  it('still closes when a write in flight fails', async () => {
    const closing = await buildTestApp({
      routes: (instance) => {
        instance.get('/api/hostile', async () => {
          throw hostileError()
        })
      },
    })
    await closing.inject({ method: 'GET', url: '/api/hostile', cookies })
    await expect(closing.close()).resolves.toBeUndefined()
  })
})
