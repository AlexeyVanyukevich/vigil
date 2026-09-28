import type { FastifyInstance } from 'fastify'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import { UnauthorizedError } from '../auth/guard.js'
import { findLiveKey, touchKey, type LiveKey } from './key.repository.js'
import { IngestBody } from './ingest.schemas.js'
import { IngestService } from './ingest.service.js'

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the `preValidation` hook below once the key has been resolved. */
    ingestKey?: LiveKey
  }
}

/**
 * Not under `/api`, and deliberately so: the guard in `modules/auth/guard.ts` protects `/api`
 * with a cookie, and an application must never be asked for one. This route authenticates on
 * its own terms, with a bearer key, per request, holding no session.
 */
export function registerIngest(instance: FastifyInstance): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>()
  const service = new IngestService(app.db, {
    maxStackBytes: app.config.maxStackBytes,
    maxContextBytes: app.config.maxContextBytes,
  })

  app.decorateRequest('ingestKey', undefined)

  // In `preValidation` rather than in the handler: Fastify checks the body schema before a
  // handler ever runs, and a caller with no key must not learn the shape of the payload it
  // rejects with a 400 before it has even proven it may write here. The key check is the trust
  // boundary and must win.
  app.addHook('preValidation', async (request) => {
    // Fastify folds every hook registered on this instance into the 404 context too, so without
    // this check a POST to a path under `/ingest/` that was never routed would answer 401
    // instead of 404 — a route's existence must not depend on whether the caller holds a key.
    if (!request.url.startsWith('/ingest/') || request.is404) return

    // Only from the header. Never a query string, never a body field: an application
    // identifier the sender controls is an application identifier an attacker controls.
    const header = request.headers.authorization
    const token = header?.startsWith('Bearer ') === true ? header.slice(7).trim() : undefined
    if (token === undefined || token === '')
      throw new UnauthorizedError('An ingest key is required')

    const key = await findLiveKey(app.db, token)
    if (key === undefined) throw new UnauthorizedError('This ingest key is not valid')

    request.ingestKey = key
  })

  app.post(
    '/ingest/events',
    { schema: { body: IngestBody(app.config.maxEventsPerBatch) } },
    async (request, reply) => {
      // Set by the hook above, which runs on every request to this path before the handler.
      const key = request.ingestKey!

      // Slice 4 puts the browser policy — origin allowlist, rate limit, quota, extension
      // filtering — behind `key.kind === 'browser'` here. Slice 1 issues only server keys.

      const recorded = await service.record(key.appId, request.body)

      // Best effort: a failed timestamp write must not turn a stored batch into an error the
      // client will retry. Awaited (unlike the batch itself, which is already durable) so the
      // key's `last_used_at` is consistent for whoever reads it as soon as this answers.
      await touchKey(app.db, key.id).catch(() => {})

      // Answered as soon as it is stored (§6). Slice 2 queues outbox rows from `recorded`
      // before this line; nothing is ever delivered inline.
      void reply.status(202).send({ accepted: recorded.length })
    },
  )
}
