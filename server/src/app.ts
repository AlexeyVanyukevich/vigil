import { existsSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyStatic from '@fastify/static'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import type { Kysely } from 'kysely'
import type { Config } from './config.js'
import type { Database } from './db/schema.js'
import { registerErrorHandler } from './shared/errors.js'
import { registerAuth } from './modules/auth/auth.routes.js'
import { registerIngest } from './modules/ingest/ingest.routes.js'
import { IngestService } from './modules/ingest/ingest.service.js'
import { createSelfRecorder, type SelfRecorder } from './self/record.js'
import { registerIssues } from './modules/issues/issue.routes.js'
import { registerApps } from './modules/apps/app.routes.js'

export interface AppDeps {
  config: Config
  db: Kysely<Database>
}

declare module 'fastify' {
  interface FastifyInstance {
    db: Kysely<Database>
    config: Config
    /** §13's recorder, exposed so whoever owns `db` can drain it before destroying `db`. */
    selfRecorder: SelfRecorder
  }
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: deps.config.logLevel,
      // An ingest key travels in this header on every report; a logged request from a debugging
      // session would outlive the key it belongs to.
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    ajv: { customOptions: { removeAdditional: false } },
  }).withTypeProvider<TypeBoxTypeProvider>()

  app.decorate('db', deps.db)
  app.decorate('config', deps.config)

  // One instance, one set of caps, shared by the route and by §13's self-recording.
  const ingest = new IngestService(deps.db, {
    maxStackBytes: deps.config.maxStackBytes,
    maxContextBytes: deps.config.maxContextBytes,
  })

  const selfRecorder = createSelfRecorder({
    db: deps.db,
    ingest,
    environment: process.env.NODE_ENV === 'production' ? 'production' : 'development',
    maxStackBytes: deps.config.maxStackBytes,
    log: app.log,
  })
  app.decorate('selfRecorder', selfRecorder)
  registerErrorHandler(app, selfRecorder)

  // A 500 answered just before close is still being written; close waits for it rather than
  // lose it. `drain()` never rejects, so a failed write cannot fail the close.
  app.addHook('onClose', async () => {
    await selfRecorder.drain()
  })

  app.get('/api/health', { config: { public: true } }, async () => ({ status: 'ok' }))

  await registerAuth(app)
  registerIngest(app, ingest)
  registerIssues(app)
  registerApps(app)

  await registerSpa(app)

  return app
}

/**
 * The dashboard is served by the same origin as the API: one deployable, no CORS, and the
 * session cookie needs no cross-site relaxation. Unknown paths fall through to index.html so a
 * client-side route survives a reload.
 */
async function registerSpa(app: FastifyInstance): Promise<void> {
  // `src/` under tsx, `dist/src/` once compiled. Both are checked rather than guessed at,
  // because guessing wrong shows an empty page in exactly one of the two environments.
  const root = [
    resolve(import.meta.dirname, '../public'),
    resolve(import.meta.dirname, '../../public'),
  ].find((candidate) => existsSync(join(candidate, 'index.html')))

  if (root !== undefined) {
    await app.register(fastifyStatic, {
      root,
      index: ['index.html'],
      // The page, at `/` and through the fallback below, is never stored. A copy kept in the
      // back-forward cache comes back painted with the session it was rendered for — after a
      // sign-out, the previous owner's issues — before any script can check. `no-store` keeps it
      // out (Chrome evicts such a page once a cookie changes, which signing out does). The hashed
      // assets beside it are safe to cache and keep the default.
      setHeaders: (reply, path) => {
        if (basename(path) === 'index.html') reply.header('cache-control', 'no-store')
      },
    })
  } else {
    // The API suites run without a build, and a missing bundle must not stop the server from
    // answering /api or /ingest.
    app.log.warn('no dashboard build to serve; run npm run --workspace web build')
  }

  app.setNotFoundHandler((request, reply) => {
    if (isApiOrIngestPath(request.url) || root === undefined) {
      return reply.status(404).send({ error: 'not_found', message: 'Route not found' })
    }
    return reply.sendFile('index.html')
  })
}

/**
 * A request that matched no route has no `routeOptions.url` to read, so the not-found handler
 * cannot lean on the matched-route trick `guard.ts` uses against percent-encoding — there is no
 * matched route. Decoding by hand instead: `/%61pi/nothing` must still get the API's JSON 404,
 * not the SPA's `index.html`, for the same reason a raw-url comparison is wrong in the guard.
 */
export function isApiOrIngestPath(rawUrl: string): boolean {
  const path = rawUrl.split('?')[0] ?? rawUrl
  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    // An invalid escape sequence decodes to nothing sensible; treat it as the literal path
    // rather than fail the request over a malformed query string.
    decoded = path
  }
  return decoded.startsWith('/api/') || decoded.startsWith('/ingest/')
}
