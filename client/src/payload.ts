import { liveSecrets, redact, scrubCredentials } from './redact.js'

/**
 * Exactly what `POST /ingest/events` accepts for one event. Kept in step with the server's
 * TypeBox schema by the integration test in Task 11, which posts this shape at a real server —
 * there is no shared type, by design (§3).
 */
export interface WireEvent {
  type: string
  message: string
  stack?: string
  occurred_at: string
  context?: Record<string, unknown>
  count?: number
  fingerprint?: string
}

/**
 * The server's defaults (§6), restated because this package imports nothing from `server/`. The
 * server refuses an event over any of them, and with it the whole batch the event arrived in,
 * so the client cuts to fit instead. The cut is deterministic, so a retried event still
 * fingerprints the same.
 */
export const LIMITS = {
  eventsPerBatch: 100,
  /** UTF-8 bytes, measured after the server swaps each U+0000 for a three-byte U+FFFD. */
  stackBytes: 16_384,
  /** UTF-8 bytes of `JSON.stringify(context)`. */
  contextBytes: 8_192,
  /** Characters, from here on; the server counts code points, which is never more. */
  messageLength: 4_000,
  typeLength: 200,
  fingerprintLength: 200,
} as const

/** Recognised in a context and lifted out as §7's escape hatch rather than sent as data. */
const FINGERPRINT_KEY = 'vigilFingerprint'

/** The last line of a stack cut to fit. Not shaped like a frame, so never parsed as one. */
const STACK_MARKER = '    … (truncated by vigil)'
/** The most of a long header a cut stack keeps before it starts giving up frames. */
const HEADER_FLOOR_BYTES = 1_024
const FRAME = /^\s+at /

const CONTEXT_MARKER_KEY = '[truncated]'
const TOO_LARGE = '[too large]'

const encoder = new TextEncoder()
const byteLength = (text: string): number => encoder.encode(text).length

function isError(value: unknown): value is Error {
  try {
    // The second test catches an Error made in another realm — a `vm` context, a worker.
    return value instanceof Error || Object.prototype.toString.call(value) === '[object Error]'
  } catch {
    return false
  }
}

/** Reads one property of something hostile, or `undefined` if reading it throws. */
function read(owner: object, key: string): { value: unknown } | undefined {
  try {
    return { value: (owner as Record<string, unknown>)[key] }
  } catch {
    return undefined
  }
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return String(value)
  } catch {
    return '[unreadable]'
  }
}

function describe(
  error: unknown,
  secrets: readonly string[],
): { type: string; message: string; stack?: string } {
  if (isError(error)) {
    // `name` and not `constructor.name`: a custom class that sets `name` is telling us what the
    // owner calls it, and that is the word they will recognise in the dashboard.
    const name = read(error, 'name')
    const message = read(error, 'message')
    const stack = read(error, 'stack')
    return {
      type: name === undefined ? 'Error' : asText(name.value),
      message: message === undefined ? '[unreadable]' : asText(message.value),
      ...(typeof stack?.value === 'string' ? { stack: stack.value } : {}),
    }
  }
  if (typeof error === 'string') return { type: 'Error', message: error }
  if (error === undefined) return { type: 'Error', message: 'undefined' }

  // A thrown object, number or symbol: all real, all still worth recording. Redacted before it
  // is rendered, because a thrown object carrying request headers is the context by another name.
  const scrubbed = redact(error, secrets)
  return {
    type: 'Error',
    message: typeof scrubbed === 'string' ? scrubbed : (JSON.stringify(scrubbed) ?? 'undefined'),
  }
}

/** Configured secrets replaced wherever they occur, then credentials recognised by shape. */
function scrubString(value: string, secrets: readonly string[]): string {
  let out = value
  for (const secret of secrets) out = out.split(secret).join('[redacted]')
  return scrubCredentials(out)
}

/** At most `max` UTF-16 units, never ending on the first half of a surrogate pair. */
function cutChars(value: string, max: number): string {
  if (value.length <= max) return value
  const code = value.charCodeAt(max - 1)
  return value.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max)
}

/** The longest prefix of `value` within `maxBytes` of UTF-8, never splitting a code point. */
function cutBytes(value: string, maxBytes: number): string {
  let used = 0
  let end = 0
  for (const char of value) {
    const point = char.codePointAt(0) ?? 0
    // A lone surrogate is encoded as U+FFFD, three bytes, like the rest of the range it sits in.
    const size = point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4
    if (used + size > maxBytes) break
    used += size
    end += char.length
  }
  return value.slice(0, end)
}

/**
 * `stack` cut to `LIMITS.stackBytes`, with `STACK_MARKER` as its last line. The frames are what
 * grouping and the culprit are read from, so they are kept first; the header — the message,
 * repeated — keeps at least `HEADER_FLOOR_BYTES` and otherwise gets what the frames leave. A long
 * message then costs header, not frames, and one throw site stays one issue however long its
 * message runs.
 */
function fitStack(stack: string): string {
  // The server swaps U+0000 for U+FFFD before it measures, and U+FFFD costs three bytes to
  // NUL's one; measuring the original would let a stack full of NULs through at triple size.
  const stored = stack.replace(/\0/g, '\uFFFD')
  if (byteLength(stored) <= LIMITS.stackBytes) return stored

  const lines = stored.split('\n')
  const firstFrame = lines.findIndex((line) => FRAME.test(line))
  const split = firstFrame === -1 ? lines.length : firstFrame
  const header = lines.slice(0, split).join('\n')
  const frames = lines.slice(split)

  const tail = `\n${STACK_MARKER}`
  const budget = LIMITS.stackBytes - byteLength(tail)
  const frameBudget = budget - Math.min(byteLength(header), HEADER_FLOOR_BYTES)

  const kept: string[] = []
  let used = 0
  for (const frame of frames) {
    const cost = byteLength(frame) + 1 // and the newline in front of it
    if (used + cost > frameBudget) break
    kept.push(frame)
    used += cost
  }

  return [cutBytes(header, budget - used), ...kept].join('\n') + tail
}

/**
 * `context` if its JSON fits `LIMITS.contextBytes`. Otherwise its entries in order, each kept
 * whole if it fits, else as `TOO_LARGE`, else left out, and a `CONTEXT_MARKER_KEY` saying the
 * context was cut. The small entries — the route, the user — are usually the useful ones.
 */
function fitContext(context: Record<string, unknown>): Record<string, unknown> | undefined {
  if (byteLength(JSON.stringify(context)) <= LIMITS.contextBytes) return context

  const entryBytes = (key: string, value: unknown): number =>
    byteLength(`${JSON.stringify(key)}:${JSON.stringify(value) ?? 'null'}`) + 1 // and a comma

  const out: Record<string, unknown> = {}
  let used = 2 + entryBytes(CONTEXT_MARKER_KEY, true) // the braces, and the marker
  for (const [key, value] of Object.entries(context)) {
    if (key === CONTEXT_MARKER_KEY) continue
    for (const candidate of [value, TOO_LARGE]) {
      const cost = entryBytes(key, candidate)
      if (used + cost <= LIMITS.contextBytes) {
        out[key] = candidate
        used += cost
        break
      }
    }
  }
  out[CONTEXT_MARKER_KEY] = true

  return byteLength(JSON.stringify(out)) <= LIMITS.contextBytes ? out : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The context, redacted, with §7's explicit fingerprint lifted out of it. Redacted first and
 * read second, so reading the fingerprint cannot run a getter the redactor has not already
 * survived — and cannot find one inherited through a `__proto__` key, which redaction drops.
 */
function splitContext(
  context: unknown,
  secrets: readonly string[],
): { context?: Record<string, unknown>; fingerprint?: string } {
  if (context === undefined || context === null) return {}

  const scrubbed = redact(context, secrets)
  const record = isRecord(scrubbed) ? scrubbed : { value: scrubbed }

  const fingerprint = Object.hasOwn(record, FINGERPRINT_KEY) ? record[FINGERPRINT_KEY] : undefined
  delete record[FINGERPRINT_KEY]

  const fitted = Object.keys(record).length === 0 ? undefined : fitContext(record)
  const trimmed = typeof fingerprint === 'string' ? fingerprint.trim() : ''

  return {
    ...(fitted === undefined ? {} : { context: fitted }),
    ...(trimmed === '' ? {} : { fingerprint: cutChars(trimmed, LIMITS.fingerprintLength) }),
  }
}

/**
 * Turns whatever was thrown into one event the server will accept, redacted before it is ever
 * queued. Never throws: it runs inside the host's error path, on whatever the host threw.
 */
export function toWireEvent(
  error: unknown,
  context: Record<string, unknown> | undefined,
  secrets: readonly string[],
): WireEvent {
  const occurredAt = new Date().toISOString()
  try {
    const live = liveSecrets(secrets)
    const described = describe(error, live)
    const split = splitContext(context, live)

    const type = cutChars(scrubString(described.type, live), LIMITS.typeLength)

    return {
      // The server refuses a blank type outright, and `name = ''` is a thing people write.
      type: /\S/.test(type) ? type : 'Error',
      // A secret in a message or a stack is the likeliest way one escapes. What is scrubbed:
      // each configured secret, verbatim; the value of an `authorization`, `cookie`,
      // `set-cookie`, `proxy-authorization` or `x-api-key` line; and a `Bearer` or `Basic`
      // credential. Not a secret URL-encoded or JSON-escaped, nor a credential in any other
      // shape. Scrubbed before the cut, so a cut cannot leave half a configured secret behind.
      message: cutChars(scrubString(described.message, live), LIMITS.messageLength),
      ...(described.stack === undefined
        ? {}
        : { stack: fitStack(scrubString(described.stack, live)) }),
      occurred_at: occurredAt,
      ...split,
    }
  } catch {
    // Nothing above should reach here. If something does, the host still does not hear of it.
    return {
      type: 'Error',
      message: '[vigil could not describe this error]',
      occurred_at: occurredAt,
    }
  }
}

/**
 * §8: a hot loop throwing the same error fifty thousand times sends one event with
 * `count: 50000`. This is the key those fifty thousand share.
 *
 * It is not the server's fingerprint and does not try to be — that lives in `server/` and this
 * package imports nothing from there. It only has to be conservative: two events with the same
 * key are certainly the same failure, and a key that splits too finely costs a few extra rows,
 * never a wrong grouping.
 */
export function collapseKey(event: WireEvent): string {
  if (event.fingerprint !== undefined) return `explicit:${event.fingerprint}`

  const firstFrame =
    event.stack
      ?.split('\n')
      .find((line) => line.trimStart().startsWith('at '))
      ?.trim() ?? ''

  return `${event.type}\n${event.message}\n${firstFrame}`
}
