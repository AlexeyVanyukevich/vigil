import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyStatic from '@fastify/static'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import type { Kysely } from 'kysely'
import type { Config } from './config.js'
import type { Database } from './db/schema.js'
import { registerErrorHandler } from './shared/errors.js'
import { registerAuth } from './modules/auth/auth.routes.js'
import { registerIngest } from './modules/ingest/ingest.routes.js'

export interface AppDeps {
  config: Config
  db: Kysely<Database>
}

declare module 'fastify' {
  interface FastifyInstance {
    db: Kysely<Database>
    config: Config
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
  registerErrorHandler(app)

  app.get('/api/health', { config: { public: true } }, async () => ({ status: 'ok' }))

  await registerAuth(app)
  registerIngest(app)

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
    await app.register(fastifyStatic, { root, index: ['index.html'] })
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
