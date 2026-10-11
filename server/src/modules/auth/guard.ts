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

/**
 * `startsWith('/api/')` alone misses the exact route `/api` (no trailing slash) — nothing
 * registers one today, but a plugin that mounted at that exact prefix would silently skip both
 * guard hooks below. Cheap to close now, before anything relies on the gap.
 */
export function isApiRoute(matchedUrl: string | undefined): boolean {
  return matchedUrl === '/api' || matchedUrl?.startsWith('/api/') === true
}

export function registerGuard(app: FastifyInstance, service: AuthService): void {
  app.decorateRequest('sessionId', '')

  // Compared against the host the request was addressed to rather than a configured origin, so
  // the check needs no setting and works on an ephemeral test port. Behind a reverse proxy it
  // works only while the proxy passes `Host` through unchanged: one that rewrites it to its
  // upstream's address (nginx's default) makes every write from the dashboard look foreign.
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
    if (!isApiRoute(request.routeOptions.url)) return
    if (request.method === 'GET' || request.method === 'HEAD') return
    const origin = request.headers.origin
    if (origin === undefined) return
    const host = request.headers.host

    // An `Origin` the `URL` constructor cannot parse — the literal `null` a browser sends for an
    // opaque origin, for instance — is not one that can be shown to match `host`; treated as
    // foreign rather than left to throw and turn a forged request into a 500.
    let originHost: string | undefined
    try {
      originHost = new URL(origin).host
    } catch {
      originHost = undefined
    }

    if (host === undefined || originHost === undefined || originHost !== host) {
      throw new ForbiddenOriginError('This request did not come from the dashboard')
    }
  })

  app.addHook('onRequest', async (request) => {
    // Only the API is guarded. The SPA's own HTML and bundle must load without a session — the
    // page is what shows the login form — and `/ingest/*` authenticates with a key instead.
    if (!isApiRoute(request.routeOptions.url)) return
    if (request.routeOptions.config?.public === true) return

    const token = request.cookies.session
    if (token === undefined) throw new UnauthorizedError('Sign in first')

    const session = await service.resolve(token)
    if (session === undefined) throw new UnauthorizedError('Sign in first')

    request.sessionId = session.id
  })
}
