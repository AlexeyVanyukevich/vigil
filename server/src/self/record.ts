import { AsyncLocalStorage } from 'node:async_hooks'
import type { Kysely } from 'kysely'
import type { Database } from '../db/schema.js'
import { findAppBySlug } from '../modules/apps/app.repository.js'
import type { IngestService } from '../modules/ingest/ingest.service.js'
import { MAX_MESSAGE_LENGTH, MAX_TYPE_LENGTH } from '../modules/ingest/ingest.schemas.js'
import { byteLength } from '../shared/bytes.js'
import { replaceNul } from '../shared/nul.js'

export const VIGIL_SLUG = 'vigil'

/** The last line of a stack the recorder had to cut. Not shaped like a frame, so never parsed as one. */
export const STACK_TRUNCATION_MARKER = '    … (truncated by vigil)'

export interface SelfRecorder {
  /** Returns nothing, never throws and never rejects. The caller is already handling a failure. */
  record(error: unknown, context: Record<string, unknown>): void
}

export interface SelfRecorderDeps {
  db: Kysely<Database>
  ingest: IngestService
  environment: string
  /** The same cap `IngestService` enforces; the recorder cuts its own stack to fit it. */
  maxStackBytes: number
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
          // Cut rather than refused (ruling 29). §6 refuses to truncate so a retrying client
          // cannot split one issue in two; this is the only producer of `vigil` events, it never
          // retries, and the cut is deterministic, so the fingerprint is too. Refusing would drop
          // exactly the failure §13 exists to keep — and since a stack begins with its message,
          // one long message would be enough. NUL is replaced first because `record()` replaces
          // it before measuring, and U+FFFD costs three bytes where NUL cost one.
          ...(typeof thrown.stack === 'string'
            ? { stack: fitStack(replaceNul(thrown.stack), deps.maxStackBytes) }
            : {}),
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

/**
 * `stack` cut to at most `maxBytes` UTF-8 bytes — the unit the cap is measured in — at the last
 * whole line that fits, with `STACK_TRUNCATION_MARKER` as a final line inside the budget. A first
 * line too long to keep whole (a long message) is cut at a code point instead, since there is no
 * line boundary to cut at. Deterministic: the same stack always comes out the same.
 */
export function fitStack(stack: string, maxBytes: number): string {
  if (byteLength(stack) <= maxBytes) return stack

  const tail = `\n${STACK_TRUNCATION_MARKER}`
  const budget = maxBytes - byteLength(tail)
  if (budget <= 0) return cutToBytes(STACK_TRUNCATION_MARKER, maxBytes)

  const lines = stack.split('\n')
  const kept: string[] = []
  let used = 0
  for (const line of lines) {
    const cost = byteLength(line) + (kept.length === 0 ? 0 : 1)
    if (used + cost > budget) break
    kept.push(line)
    used += cost
  }
  if (kept.length === 0) kept.push(cutToBytes(lines[0] ?? '', budget))

  return `${kept.join('\n')}${tail}`
}

/** The longest prefix of `value` within `maxBytes`, never splitting a code point. */
function cutToBytes(value: string, maxBytes: number): string {
  let used = 0
  let end = 0
  for (const char of value) {
    const size = byteLength(char)
    if (used + size > maxBytes) break
    used += size
    end += char.length
  }
  return value.slice(0, end)
}
