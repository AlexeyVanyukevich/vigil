import type { FastifyInstance } from 'fastify'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import { UnauthorizedError } from '../auth/guard.js'
import { findLiveKey, touchKey, type LiveKey } from './key.repository.js'
import { IngestBody } from './ingest.schemas.js'
import { IngestService } from './ingest.service.js'

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by this route's own `onRequest` hook once the key has been resolved. */
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

  app.post(
    '/ingest/events',
    {
      schema: { body: IngestBody(app.config.maxEventsPerBatch) },
      // A route-level hook, not a global one filtered by url: it runs only for a request
      // already matched to *this* route, so it needs no url-prefix check and no `is404`
      // bail-out. And `onRequest`, not `preValidation`: this check needs only the headers, and
      // running it any later would have a keyless caller pay for a body parse — and risk a
      // 400/413/415 from the schema or the size limit — before ever reaching the 401 that
      // should have ended the request first.
      onRequest: async (request) => {
        // Only from the header. Never a query string, never a body field: an application
        // identifier the sender controls is an application identifier an attacker controls.
        const header = request.headers.authorization
        const token = header?.startsWith('Bearer ') === true ? header.slice(7).trim() : undefined
        if (token === undefined || token === '') {
          throw new UnauthorizedError('An ingest key is required')
        }

        const key = await findLiveKey(app.db, token)
        if (key === undefined) throw new UnauthorizedError('This ingest key is not valid')

        request.ingestKey = key
      },
    },
    async (request, reply) => {
      // Set by the `onRequest` hook above; the explicit check (rather than a `!` assertion)
      // keeps this handler correct even if the hook above it is ever changed to skip resolving
      // a key under some condition.
      const key = request.ingestKey
      if (key === undefined) throw new UnauthorizedError('An ingest key is required')

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
