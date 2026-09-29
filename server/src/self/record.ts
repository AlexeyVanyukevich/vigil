import { AsyncLocalStorage } from 'node:async_hooks'
import type { Kysely } from 'kysely'
import type { Database } from '../db/schema.js'
import { findAppBySlug } from '../modules/apps/app.repository.js'
import type { IngestService } from '../modules/ingest/ingest.service.js'
import { MAX_MESSAGE_LENGTH, MAX_TYPE_LENGTH } from '../modules/ingest/ingest.schemas.js'

export const VIGIL_SLUG = 'vigil'

export interface SelfRecorder {
  /** Returns nothing, never throws and never rejects. The caller is already handling a failure. */
  record(error: unknown, context: Record<string, unknown>): void
}

export interface SelfRecorderDeps {
  db: Kysely<Database>
  ingest: IngestService
  environment: string
  log: { warn(details: object, message: string): void }
}

/**
 * §13: vigil's own failures, written straight to its own database through `IngestService`, never
 * over HTTP. Reporting to its own ingest endpoint would make a failure in the ingest path produce
 * an error about the ingest path, which produces another.
 */
export function createSelfRecorder(deps: SelfRecorderDeps): SelfRecorder {
  // The write side of §13's loop: anything that reports a failure from inside our own write — a
  // query hook, a future change to the ingest service — must not start another write. Scoped to
  // the async context of the write rather than a process-wide flag, which would also drop every
  // unrelated failure that lands while one is being written: exactly when failures come in bunches.
  const writing = new AsyncLocalStorage<true>()

  async function write(error: unknown, context: Record<string, unknown>): Promise<void> {
    // Looked up on every write rather than cached: an unexpected 500 is rare, and a cached id
    // would outlive the row it names if the row were ever recreated.
    const app = await findAppBySlug(deps.db, VIGIL_SLUG)
    if (app === undefined) {
      // The seeded row is gone. An unrecordable error is still better handled than a handler
      // that throws.
      deps.log.warn({}, 'no vigil application row; own errors are not being recorded')
      return
    }

    const thrown = error instanceof Error ? error : new Error(String(error))
    const safe = serialisable(context)

    // This skips the route's schema, so the recorder holds itself to the same limits.
    await deps.ingest.record(app.id, {
      environment: deps.environment,
      runtime: 'node',
      events: [
        {
          type: (thrown.name || 'Error').slice(0, MAX_TYPE_LENGTH),
          message: thrown.message.slice(0, MAX_MESSAGE_LENGTH),
          ...(typeof thrown.stack === 'string' ? { stack: thrown.stack } : {}),
          occurred_at: new Date().toISOString(),
          ...(safe === undefined ? {} : { context: safe }),
        },
      ],
    })
  }

  return {
    record(error: unknown, context: Record<string, unknown>): void {
      if (writing.getStore() === true) return

      // Everything that can go wrong happens inside the async `write`, so it arrives here as a
      // rejection rather than a throw — `String()` on a hostile value, a getter on the error, the
      // database. Swallowed on purpose: this runs while the process is already answering a 500,
      // and throwing would replace one failure with two, or crash the process.
      writing
        .run(true, () => write(error, context))
        .catch((failure: unknown) => {
          try {
            deps.log.warn({ err: failure }, 'could not record our own error')
          } catch {
            // Nothing left to tell.
          }
        })
    },
  }
}

/**
 * In-process, a context is a live value, and `JSON.stringify` throws on a BigInt or a cycle, or
 * yields nothing for a `toJSON` returning `undefined`. The error is worth keeping without it, so a
 * context that does not survive a round trip is dropped rather than allowed to lose the event.
 */
function serialisable(context: Record<string, unknown>): Record<string, unknown> | undefined {
  try {
    const text = JSON.stringify(context) as string | undefined
    if (text === undefined) return undefined
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}
