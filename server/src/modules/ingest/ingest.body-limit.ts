import type { Config } from '../../config.js'
import {
  MAX_ENVIRONMENT_LENGTH,
  MAX_FINGERPRINT_LENGTH,
  MAX_MESSAGE_LENGTH,
  MAX_TYPE_LENGTH,
} from './ingest.schemas.js'

/** Structural JSON the schema doesn't cap directly: field names, punctuation, `occurred_at`. */
const PER_EVENT_OVERHEAD_BYTES = 512
const BATCH_OVERHEAD_BYTES = 1_024

// `stack` is guarded (`guardBytes`) against its *decoded* UTF-8 byte length, and `message`,
// `type`, `fingerprint` and `environment` are capped (the schema's `maxLength`) in *decoded*
// UTF-16 code units — none of those checks look at the escaped form the string actually took on
// the wire. `JSON.stringify` writes every control character in U+0000-001F other than
// `\b \f \n \r \t` as the six-byte escape `\u00xx`, so a string built entirely from such
// characters — one decoded byte/unit each — is six times its decoded size once it's actually on
// the wire. That dominates the plainer case (a quote or backslash, which only doubles), so 6 is
// the factor that has to relate each of these guards to what Fastify sees before the guard ever
// runs.
const CONTROL_CHARACTER_ESCAPE_FACTOR = 6

// `context`, unlike the fields above, is guarded against `JSON.stringify(event.context)` —
// already-escaped text that (give or take reserialization differences) is what actually appears
// on the wire for this field — so its guard needs no further escaping headroom. The factor here
// is just safety margin for those reserialization differences, not an escape-blowup allowance.
const CONTEXT_WIRE_FACTOR = 2

/**
 * Fastify's default `bodyLimit` is 1 MiB. A batch that is inside every §6 cap on its own terms
 * can still be several times that — 100 events at the 16 KB stack cap alone is already ~1.6 MB
 * — so the default silently turns a compliant batch into an unstated fourth cap. This derives
 * the limit from the same caps the schema and `IngestService` already enforce, with headroom
 * for JSON escaping, so the wire-size limit and the caps it stands in for cannot drift apart.
 *
 * Deliberately generous rather than exact — the guards inside the transaction (`guardBytes`,
 * the schema's own `maxLength`/`maxItems`) are what actually enforce §6; this only has to be
 * wide enough that a batch that would pass those never gets a Fastify 413 first. At the spec
 * defaults this comes to roughly 13.5 MB, which is affordable now that the key is checked
 * before the body is ever read (a keyless caller never causes it to be parsed at all).
 */
export function ingestBodyLimit(config: Config): number {
  const perEvent =
    CONTROL_CHARACTER_ESCAPE_FACTOR * config.maxStackBytes +
    CONTEXT_WIRE_FACTOR * config.maxContextBytes +
    CONTROL_CHARACTER_ESCAPE_FACTOR * MAX_MESSAGE_LENGTH +
    CONTROL_CHARACTER_ESCAPE_FACTOR * MAX_TYPE_LENGTH +
    CONTROL_CHARACTER_ESCAPE_FACTOR * MAX_FINGERPRINT_LENGTH +
    PER_EVENT_OVERHEAD_BYTES

  const envelope = CONTROL_CHARACTER_ESCAPE_FACTOR * MAX_ENVIRONMENT_LENGTH + BATCH_OVERHEAD_BYTES

  return config.maxEventsPerBatch * perEvent + envelope
}
