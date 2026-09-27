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
  // Both hooks below also bail out on `request.is404`: Fastify folds every onRequest hook
  // registered on this instance into the 404 context as well, so without the check a signed-out
  // visitor hitting a route that never existed sees 401 instead of 404 — a route's existence
  // must not depend on whether the caller is signed in.
  app.addHook('onRequest', async (request) => {
    if (!request.url.startsWith('/api/') || request.is404) return
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
    if (!request.url.startsWith('/api/') || request.is404) return
    if (request.routeOptions.config?.public === true) return

    const token = request.cookies.session
    if (token === undefined) throw new UnauthorizedError('Sign in first')

    const session = await service.resolve(token)
    if (session === undefined) throw new UnauthorizedError('Sign in first')

    request.sessionId = session.id
  })
}
