import type { FastifyError, FastifyInstance } from 'fastify'
import type { SelfRecorder } from '../self/record.js'

export abstract class AppError extends Error {
  abstract readonly statusCode: number
  abstract readonly code: string
  readonly details?: Record<string, unknown>

  constructor(message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = new.target.name
    if (details !== undefined) this.details = details
  }
}

export class ValidationError extends AppError {
  readonly statusCode = 400
  readonly code = 'validation_error'
}

export class NotFoundError extends AppError {
  readonly statusCode = 404
  readonly code = 'not_found'
}

export class ConflictError extends AppError {
  readonly statusCode = 409
  readonly code = 'conflict'
}

/**
 * §6: an oversize batch, stack or context is refused rather than truncated and kept. A stack
 * cut in half fingerprints differently from the same stack whole, which would split one issue
 * into two by payload size alone.
 */
export class PayloadTooLargeError extends AppError {
  readonly statusCode = 413
  readonly code = 'payload_too_large'
}

/**
 * `self` is optional: without a recorder the handler answers exactly as it always has, and with
 * one it answers the same way and records the unexpected failures besides.
 */
export function registerErrorHandler(app: FastifyInstance, self?: SelfRecorder): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof AppError) {
      void reply.status(error.statusCode).send({
        error: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      })
      return
    }
    if (error.validation) {
      void reply.status(400).send({
        error: 'validation_error',
        message: error.message,
        details: { issues: error.validation },
      })
      return
    }
    if (typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
      void reply.status(error.statusCode).send({ error: 'bad_request', message: error.message })
      return
    }
    request.log.error({ err: error }, 'unhandled error')
    void reply.status(500).send({ error: 'internal_error', message: 'Internal server error' })

    // Only here, and after the answer is on its way. An AppError, a schema rejection or any
    // other 4xx is the caller's doing, not a defect, and filing those would bury the one thing
    // the issue list exists to surface.
    //
    // A failure on an ingest route is skipped as well (§13): recording it would be vigil
    // reporting on the path that records reports. Judged by the matched route pattern, like the
    // /api guard, so a percent-encoded prefix does not walk around it.
    //
    // The context is built from chosen fields only, never the error or request themselves: an
    // error commonly carries a cycle back to a request or a socket.
    const route = request.routeOptions.url
    if (self !== undefined && !isIngestRoute(route)) {
      self.record(error, { method: request.method, route: route ?? null, status_code: 500 })
    }
  })

  // The not-found handler is set in app.ts instead: Fastify allows exactly one per instance,
  // and it has to answer JSON under /api and /ingest and the SPA's index.html everywhere else.
}

function isIngestRoute(matchedUrl: string | undefined): boolean {
  return matchedUrl === '/ingest' || matchedUrl?.startsWith('/ingest/') === true
}
