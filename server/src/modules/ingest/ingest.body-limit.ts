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

// A JSON string can be up to twice as many *wire* bytes as its *decoded* length once every byte
// happens to be a quote or a backslash — each becomes a two-byte escape. `stack` and `context`
// are guarded by `guardBytes` against their decoded length, so this is the factor that relates
// that guard to what Fastify sees on the wire before it ever reaches the guard.
const JSON_ESCAPE_FACTOR = 2

// `message`, `type` and `fingerprint` are capped in *UTF-16 code units* (a JS string's
// `.length`), and a single code unit can take up to 3 bytes once encoded as UTF-8 on the wire
// (4 for a surrogate pair, but that is 2 code units for those same 4 bytes — 3 is the safe
// per-unit bound). Escaping is already covered by this multiplier: an escaped ASCII character
// (1 byte to begin with) becomes 2 bytes, which is still under a 3x allowance.
const UTF8_WORST_CASE_BYTES_PER_UTF16_UNIT = 3

/**
 * Fastify's default `bodyLimit` is 1 MiB. A batch that is inside every §6 cap on its own terms
 * can still be several times that — 100 events at the 16 KB stack cap alone is already ~1.6 MB
 * — so the default silently turns a compliant batch into an unstated fourth cap. This derives
 * the limit from the same caps the schema and `IngestService` already enforce, with headroom
 * for JSON escaping and UTF-8 expansion, so the wire-size limit and the caps it stands in for
 * cannot drift apart.
 *
 * Deliberately generous rather than exact — the guards inside the transaction (`guardBytes`,
 * the schema's own `maxLength`/`maxItems`) are what actually enforce §6; this only has to be
 * wide enough that a batch that would pass those never gets a Fastify 413 first.
 */
export function ingestBodyLimit(config: Config): number {
  const perEvent =
    JSON_ESCAPE_FACTOR * config.maxStackBytes +
    JSON_ESCAPE_FACTOR * config.maxContextBytes +
    UTF8_WORST_CASE_BYTES_PER_UTF16_UNIT * MAX_MESSAGE_LENGTH +
    UTF8_WORST_CASE_BYTES_PER_UTF16_UNIT * MAX_TYPE_LENGTH +
    UTF8_WORST_CASE_BYTES_PER_UTF16_UNIT * MAX_FINGERPRINT_LENGTH +
    PER_EVENT_OVERHEAD_BYTES

  const envelope =
    UTF8_WORST_CASE_BYTES_PER_UTF16_UNIT * MAX_ENVIRONMENT_LENGTH + BATCH_OVERHEAD_BYTES

  return config.maxEventsPerBatch * perEvent + envelope
}
