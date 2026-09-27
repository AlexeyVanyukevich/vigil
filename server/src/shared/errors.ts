import type { FastifyError, FastifyInstance } from 'fastify'

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

export function registerErrorHandler(app: FastifyInstance): void {
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
  })

  // The not-found handler is set in app.ts instead: Fastify allows exactly one per instance,
  // and it has to answer JSON under /api and /ingest and the SPA's index.html everywhere else.
}
