import type { FastifyInstance } from 'fastify'
import { AppError } from '../../shared/errors.js'
import type { AuthService } from './auth.service.js'

export class UnauthorizedError extends AppError {
  readonly statusCode = 401
  readonly code = 'unauthorized'
}

export class ForbiddenOriginError extends AppError {
  readonly statusCode = 403
  readonly code = 'forbidden_origin'
}

declare module 'fastify' {
  interface FastifyRequest {
    sessionId: string
  }
  interface FastifyContextConfig {
    public?: true
  }
}

export function registerGuard(app: FastifyInstance, service: AuthService): void {
  app.decorateRequest('sessionId', '')

  // Compared against the host the request was addressed to rather than a configured origin, so
  // the check keeps working behind a proxy and on an ephemeral test port.
  //
  // Scoped to /api/ deliberately. `/ingest/*` carries a bearer key and no cookie, so it has no
  // CSRF exposure to defend; applying this here would reject a browser's report out of hand and
  // pre-empt the origin policy Slice 4 gives ingest of its own.
  //
  // Filtered on `request.routeOptions.url` — the *matched* route pattern — rather than the raw
  // `request.url`. find-my-way percent-decodes the path before matching it to a route, so
  // `/%61pi/me` matches the `/api/me` route while its raw url does not start with `/api/`; a
  // filter on the raw url is a guard an attacker can walk around one encoded letter at a time.
  // `routeOptions.url` is `undefined` when nothing matched (`request.is404`), so an unrouted
  // path is naturally skipped without a separate check.
  app.addHook('onRequest', async (request) => {
    if (request.routeOptions.url?.startsWith('/api/') !== true) return
    if (request.method === 'GET' || request.method === 'HEAD') return
    const origin = request.headers.origin
    if (origin === undefined) return
    const host = request.headers.host
    if (host === undefined || new URL(origin).host !== host) {
      throw new ForbiddenOriginError('This request did not come from the dashboard')
    }
  })

  app.addHook('onRequest', async (request) => {
    // Only the API is guarded. The SPA's own HTML and bundle must load without a session — the
    // page is what shows the login form — and `/ingest/*` authenticates with a key instead.
    if (request.routeOptions.url?.startsWith('/api/') !== true) return
    if (request.routeOptions.config?.public === true) return

    const token = request.cookies.session
    if (token === undefined) throw new UnauthorizedError('Sign in first')

    const session = await service.resolve(token)
    if (session === undefined) throw new UnauthorizedError('Sign in first')

    request.sessionId = session.id
  })
}
