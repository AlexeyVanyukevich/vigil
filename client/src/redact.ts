/**
 * Matched as substrings of a key, lowercased with separators removed, so `Authorization`,
 * `api_key`, `apiKey` and `X-API-KEY` are all caught by one entry.
 */
export const ALWAYS_REDACTED: readonly string[] = [
  'authorization',
  'cookie',
  'setcookie',
  'proxyauthorization',
  'apikey',
  'password',
  'token',
  'secret',
]

const PLACEHOLDER = '[redacted]'

/** Bounds the recursion, so a deeply nested context cannot overflow the host's stack. */
const MAX_DEPTH = 12
/** Per array or object. The context that reaches the wire is 8 KB at most anyway. */
const MAX_ENTRIES = 100
/** Objects visited in one call. The host's error path pays for every one of them. */
const MAX_OBJECTS = 1_000
/** Per string, in UTF-16 units. A longer one is cut, and says how much was cut. */
const MAX_STRING = 4_096
/**
 * Characters scanned in one call. Objects are counted by `MAX_OBJECTS`, but a string is not an
 * object, and one shared string referenced from thousands of places is scanned at every one.
 */
const MAX_SCANNED = 256 * 1_024

function isSensitiveKey(key: string): boolean {
  const flat = key.toLowerCase().replace(/[-_\s]/g, '')
  return ALWAYS_REDACTED.some((needle) => flat.includes(needle))
}

/** The characters RFC 9110 allows in a header name. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/**
 * A string shaped like a header name that `ALWAYS_REDACTED` would redact as a key. In an array
 * it says the element after it is that header's value: `rawHeaders` is `[name, value, …]`, and
 * a header list is `[name, value]` tuples, and neither gives the value a key of its own.
 */
function isCredentialName(value: string): boolean {
  if (value.length > 128) return false
  const name = value.trim()
  return HEADER_NAME.test(name) && isSensitiveKey(name)
}

/** Headers whose value is a credential, as they are written in raw HTTP or printed objects. */
const CREDENTIAL_HEADERS = [
  'proxy-authorization',
  'authorization',
  'set-cookie',
  'cookie',
  'x-api-key',
]

/**
 * One such header and the rest of its line: a raw head (`Cookie: sid=1\r\n`), a printed object
 * (`{ cookie: 'sid=1' }`) or JSON (`"cookie":"sid=1"`). Everything after the colon to the end of
 * the line goes, since where the value stops cannot be told in general. A value already
 * redacted is skipped, so text rendered from a redacted object keeps the rest of its line.
 */
const CREDENTIAL_LINE = new RegExp(
  `(^|[^A-Za-z0-9-])(["']?)(${CREDENTIAL_HEADERS.join('|')})\\2([ \\t]*:[ \\t]*)` +
    `(?!["']?\\[redacted\\])[^\\r\\n]*`,
  'gim',
)

/** An RFC 6750 bearer token or an RFC 7617 basic credential, wherever it is written. */
const CREDENTIAL_SCHEME = /\b(bearer|basic)([ \t]+)[A-Za-z0-9\-._~+/]+=*/gi

/**
 * Credentials that need no configuration to recognise: the value of a sensitive header line,
 * and a `Bearer` or `Basic` credential in free text. A secret the redactor cannot recognise by
 * shape has to be configured.
 */
export function scrubCredentials(text: string): string {
  return text
    .replace(CREDENTIAL_LINE, `$1$2$3$2$4${PLACEHOLDER}`)
    .replace(CREDENTIAL_SCHEME, `$1$2${PLACEHOLDER}`)
}

/** At most `max` UTF-16 units, never ending on the first half of a surrogate pair. */
export function cutChars(value: string, max: number): string {
  if (value.length <= max) return value
  const code = value.charCodeAt(max - 1)
  return value.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max)
}

/** One property of something hostile, or `undefined` if reading it throws. */
function read(owner: object, key: string | number): { value: unknown } | undefined {
  try {
    return { value: (owner as Record<string | number, unknown>)[key] }
  } catch {
    return undefined
  }
}

/**
 * The configured secrets worth matching: trimmed, and without the blank ones, which would
 * otherwise match every string there is. Tolerates a caller that passes something else.
 *
 * Longest first, so a secret that contains another is replaced before the shorter one can cut
 * it and leave its tail behind.
 */
export function liveSecrets(secrets: readonly string[] | undefined): string[] {
  if (!Array.isArray(secrets)) return []
  return secrets
    .filter((secret): secret is string => typeof secret === 'string')
    .map((secret) => secret.trim())
    .filter((secret) => secret !== '')
    .sort((a, b) => b.length - a.length)
}

/**
 * Scrubs before anything is queued, so a secret never crosses the wire — not even to vigil.
 *
 * Never throws: rule one of §8 is that the monitor must not damage its host, and a context it
 * cannot walk is not a reason to raise an exception inside somebody else's error handler. What
 * it returns is plain JSON data — strings, finite or non-finite numbers, booleans, null, arrays
 * and objects — so `JSON.stringify` cannot throw on it either.
 */
export function redact(value: unknown, secrets: readonly string[] = []): unknown {
  const live = liveSecrets(secrets)
  const seen = new WeakSet<object>()
  let budget = MAX_OBJECTS
  let scanBudget = MAX_SCANNED
  // `live` is sorted longest first.
  const overhang = Math.max((live[0]?.length ?? 0) - 1, 0)

  function scrub(text: string): string {
    if (scanBudget <= 0) return '[truncated]'
    const long = text.length > MAX_STRING
    // Scanned past the cut by one secret's length less one, so a secret that starts before the
    // cut is seen whole. Cut first, it would be half a secret, and half a secret matches nothing.
    const scanned = long ? text.slice(0, MAX_STRING + overhang) : text
    scanBudget -= scanned.length
    if (live.some((secret) => scanned.includes(secret))) return PLACEHOLDER
    if (!long) return scrubCredentials(text)
    // A credential pattern cut short still matches what is left of it, so it is applied after.
    const kept = cutChars(text, MAX_STRING)
    return `${scrubCredentials(kept)}… (${text.length - kept.length} more characters)`
  }

  /** Enough of `text` for `scrub` to judge and cut, without copying the rest. */
  const head = (text: string): string =>
    text.length > MAX_STRING + overhang ? text.slice(0, MAX_STRING + overhang) : text

  function walk(node: unknown, depth: number, underConstructor: boolean): unknown {
    try {
      if (node === null || node === undefined) return node

      switch (typeof node) {
        case 'string':
          return scrub(node)
        case 'number':
        case 'boolean':
          return node
        case 'bigint':
          return node.toString()
        case 'function':
          return '[function]'
        case 'symbol':
          return scrub(node.toString())
      }

      const object = node as object
      if (budget <= 0) return '[truncated]'
      budget -= 1

      if (object instanceof Date) {
        return Number.isNaN(object.getTime()) ? 'Invalid Date' : object.toISOString()
      }
      if (object instanceof Error) {
        return scrub(`${head(String(object.name))}: ${head(String(object.message))}`)
      }
      if (ArrayBuffer.isView(object) || object instanceof ArrayBuffer) {
        return `[binary ${object.byteLength} bytes]`
      }

      if (depth >= MAX_DEPTH) return '[deep]'
      if (seen.has(object)) return '[circular]'
      seen.add(object)

      const toJSON: unknown = (object as { toJSON?: unknown }).toJSON
      if (typeof toJSON === 'function') {
        return walk(toJSON.call(object) as unknown, depth + 1, false)
      }

      if (Array.isArray(object)) {
        const items: unknown[] = []
        const kept = Math.min(object.length, MAX_ENTRIES)
        let credentialValue = false
        for (let i = 0; i < kept; i += 1) {
          if (credentialValue) {
            // Not read as a name in its turn: a redacted value is not the next header's name.
            items.push(PLACEHOLDER)
            credentialValue = false
            continue
          }
          const item = read(object, i)
          items.push(item === undefined ? '[unreadable]' : walk(item.value, depth + 1, false))
          credentialValue = typeof item?.value === 'string' && isCredentialName(item.value)
        }
        if (object.length > kept) items.push(`[${object.length - kept} more items]`)
        return items
      }

      const keys = Object.keys(object)
      const out: Record<string, unknown> = {}
      for (const key of keys.slice(0, MAX_ENTRIES)) {
        // Either shape makes Fastify refuse the whole batch with a 400, and a context holding a
        // parsed request body is all it takes to carry one.
        if (key === '__proto__' || (underConstructor && key === 'prototype')) continue
        out[scrub(key)] = isSensitiveKey(head(key))
          ? PLACEHOLDER
          : walkProperty(object, key, depth, key === 'constructor')
      }
      if (keys.length > MAX_ENTRIES) out['[more keys]'] = keys.length - MAX_ENTRIES
      return out
    } catch {
      // A getter that throws, an exotic proxy: whatever it was, the host does not hear about it.
      return '[unreadable]'
    }
  }

  function walkProperty(
    owner: object,
    key: string,
    depth: number,
    underConstructor: boolean,
  ): unknown {
    const item = read(owner, key)
    return item === undefined ? '[unreadable]' : walk(item.value, depth + 1, underConstructor)
  }

  return walk(value, 0, false)
}
