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

function isSensitiveKey(key: string): boolean {
  const flat = key.toLowerCase().replace(/[-_\s]/g, '')
  return ALWAYS_REDACTED.some((needle) => flat.includes(needle))
}

/**
 * The configured secrets worth matching: trimmed, and without the blank ones, which would
 * otherwise match every string there is. Tolerates a caller that passes something else.
 */
export function liveSecrets(secrets: readonly string[] | undefined): string[] {
  if (!Array.isArray(secrets)) return []
  return secrets
    .filter((secret): secret is string => typeof secret === 'string')
    .map((secret) => secret.trim())
    .filter((secret) => secret !== '')
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

  const scrub = (text: string): string =>
    live.some((secret) => text.includes(secret)) ? PLACEHOLDER : text

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
      if (object instanceof Error) return scrub(`${String(object.name)}: ${String(object.message)}`)
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
        for (let i = 0; i < kept; i += 1) items.push(walkProperty(object, i, depth))
        if (object.length > kept) items.push(`[${object.length - kept} more items]`)
        return items
      }

      const keys = Object.keys(object)
      const out: Record<string, unknown> = {}
      for (const key of keys.slice(0, MAX_ENTRIES)) {
        // Either shape makes Fastify refuse the whole batch with a 400, and a context holding a
        // parsed request body is all it takes to carry one.
        if (key === '__proto__' || (underConstructor && key === 'prototype')) continue
        out[scrub(key)] = isSensitiveKey(key)
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
    key: string | number,
    depth: number,
    underConstructor = false,
  ): unknown {
    let item: unknown
    try {
      item = (owner as Record<string | number, unknown>)[key]
    } catch {
      return '[unreadable]'
    }
    return walk(item, depth + 1, underConstructor)
  }

  return walk(value, 0, false)
}
