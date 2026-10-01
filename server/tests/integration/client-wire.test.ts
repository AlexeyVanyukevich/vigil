import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, closeTestDb, getTestDb, resetDb } from './helpers.js'
import { insertApp } from '../../src/modules/apps/app.repository.js'
import { insertKey, mintIngestKey } from '../../src/modules/ingest/key.repository.js'
import { install, type Vigil, type VigilOptions } from '../../../client/src/node.js'

// `client/` and `server/` share no types by design (§3), so this is what keeps the two shapes in
// step: the client's real payload — built by `toWireEvent`, queued, sent by `send` with fetch —
// against the real endpoint and a real key. A field renamed on one side only fails here.
//
// The one file in `server/` that reaches into `client/`, and only in a test. `server/src` never
// does.

let app: FastifyInstance
let key: string

const db = () => getTestDb()

beforeAll(async () => {
  app = await buildTestApp()
  // A real port: the client posts with fetch, not with app.inject.
  await app.listen({ port: 0, host: '127.0.0.1' })
})
beforeEach(async () => {
  await resetDb()
  const reference = await insertApp(db(), 'reference', 'The reference application')
  key = mintIngestKey()
  await insertKey(db(), reference.id, 'server', key)
})
afterAll(async () => {
  await app.close()
  await closeTestDb()
})

const vigilUrl = () => {
  const address = app.server.address()
  if (address === null || typeof address === 'string') throw new Error('not listening on a port')
  return `http://127.0.0.1:${address.port}`
}

/** Installs the client, lets `act` report through it, flushes, and always uninstalls. */
async function report(act: (vigil: Vigil) => void, options: Partial<VigilOptions> = {}) {
  const vigil = install({
    url: vigilUrl(),
    key,
    app: 'reference',
    environment: 'production',
    flushIntervalMs: 1_000_000,
    exitOnUncaught: false,
    ...options,
  })
  try {
    act(vigil)
    await vigil.flush()
  } finally {
    await vigil.close()
  }
}

describe('the published client against the real endpoint', () => {
  it('reports an error the server accepts, groups and stores', async () => {
    await report((vigil) => {
      vigil.captureError(new TypeError('the client and the server agree'), { route: '/x' })
    })

    const issue = await db().selectFrom('issues').selectAll().executeTakeFirstOrThrow()
    expect(issue.title).toBe('TypeError: the client and the server agree')
    expect(issue.runtime).toBe('node')
    expect(issue.environment).toBe('production')
    expect(issue.culprit).not.toBeNull()

    const event = await db().selectFrom('events').selectAll().executeTakeFirstOrThrow()
    expect(event.message).toBe('the client and the server agree')
    expect(event.stack).toContain('client-wire.test.ts')
    expect(event.context).toMatchObject({ route: '/x' })
    expect(event.count).toBe(1)
  })

  it('sends a collapsed run the server stores as one event standing for the run', async () => {
    await report((vigil) => {
      for (let i = 0; i < 1_000; i += 1) vigil.captureError(new Error('hot loop'))
    })

    const issue = await db().selectFrom('issues').selectAll().executeTakeFirstOrThrow()
    expect(issue.occurrence_count).toBe(1_000)
    const events = await db().selectFrom('events').selectAll().execute()
    expect(events).toHaveLength(1)
    expect(events[0]!.count).toBe(1_000)
  })

  // The redaction promise is only worth anything if it survives the round trip.
  it('never lets a credential header or a configured secret reach the database', async () => {
    await report(
      (vigil) => {
        vigil.captureError(new Error('calling engine with bk_live_secret'), {
          headers: {
            authorization: 'Bearer tok_bearer_7f3',
            cookie: 'sid=sess_cookie_42',
            'x-engine-key': 'bk_live_secret',
            accept: 'application/json',
          },
        })
      },
      { secrets: ['bk_live_secret'] },
    )

    const rows = JSON.stringify([
      await db().selectFrom('events').selectAll().execute(),
      await db().selectFrom('issues').selectAll().execute(),
    ])
    for (const secret of ['bk_live_secret', 'tok_bearer_7f3', 'sess_cookie_42']) {
      expect(rows).not.toContain(secret)
    }

    // Scrubbed, not dropped: the event is still there, and so is what was safe to keep.
    const event = await db().selectFrom('events').selectAll().executeTakeFirstOrThrow()
    expect(event.context).toMatchObject({ headers: { accept: 'application/json' } })
  })

  // The server refuses a batch over 100 events outright, and every event in it with it.
  it('splits a drain of more than 100 events into batches the server accepts', async () => {
    const posts = vi.fn(globalThis.fetch)

    await report(
      (vigil) => {
        for (let i = 0; i < 250; i += 1) vigil.captureError(new Error(`distinct failure ${i}`))
      },
      { maxQueue: 250, fetch: posts },
    )

    expect(posts).toHaveBeenCalledTimes(3)
    const events = await db().selectFrom('events').select('message').execute()
    expect(events).toHaveLength(250)
    expect(new Set(events.map((e) => e.message)).size).toBe(250)
    const issues = await db().selectFrom('issues').select('occurrence_count').execute()
    expect(issues.reduce((sum, i) => sum + i.occurrence_count, 0)).toBe(250)
  })

  it('is refused by the server when its key is revoked, and does not throw', async () => {
    await db().updateTable('ingest_keys').set({ revoked_at: new Date() }).execute()
    const log = vi.fn()

    await expect(
      report((vigil) => vigil.captureError(new Error('into the void')), { log }),
    ).resolves.toBeUndefined()

    expect(await db().selectFrom('events').selectAll().execute()).toHaveLength(0)
    expect(log.mock.calls.filter(([m]) => String(m).includes('could not report'))).toHaveLength(1)
  })
})
