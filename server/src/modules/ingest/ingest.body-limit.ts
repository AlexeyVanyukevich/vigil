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

// Every cap below is checked against the *decoded* string, and a JSON string can spell any
// character as an escape. What matters is the most wire bytes one unit of a cap can cost.
//
// `message`, `type`, `fingerprint` and `environment` are capped by the schema's `maxLength`,
// which AJV counts in code points, not UTF-16 code units: an astral character is one unit. An
// encoder that escapes everything outside ASCII — Python's `json.dumps` by default — writes one
// as a surrogate pair, `\ud83d\ude00`: twelve bytes for one unit of the cap.
const CODE_POINT_ESCAPE_FACTOR = 12

// `stack` is guarded by its UTF-8 byte length and `context` by the byte length of
// `JSON.stringify(context)`. Any single byte of either can arrive as the six-byte `\u00XX` — an
// ASCII character escaped needlessly, or a control character escaped because it must be — and
// no character costs more per byte: an astral character is four UTF-8 bytes for twelve on the
// wire, a BMP one two or three bytes for six.
const BYTE_ESCAPE_FACTOR = 6

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
 * defaults this comes to 20,078,592 bytes (about 19.1 MiB), which is affordable now that the
 * key is checked before the body is ever read (a keyless caller never causes it to be parsed at
 * all).
 */
export function ingestBodyLimit(config: Config): number {
  const perEvent =
    BYTE_ESCAPE_FACTOR * config.maxStackBytes +
    BYTE_ESCAPE_FACTOR * config.maxContextBytes +
    CODE_POINT_ESCAPE_FACTOR * MAX_MESSAGE_LENGTH +
    CODE_POINT_ESCAPE_FACTOR * MAX_TYPE_LENGTH +
    CODE_POINT_ESCAPE_FACTOR * MAX_FINGERPRINT_LENGTH +
    PER_EVENT_OVERHEAD_BYTES

  const envelope = CODE_POINT_ESCAPE_FACTOR * MAX_ENVIRONMENT_LENGTH + BATCH_OVERHEAD_BYTES

  return config.maxEventsPerBatch * perEvent + envelope
}
