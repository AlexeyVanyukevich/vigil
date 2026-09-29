const NUL = /\u0000/g
const REPLACEMENT_CHARACTER = '\uFFFD'

/**
 * Postgres refuses U+0000 in both `text` and `jsonb`, so a string carrying one cannot be stored
 * as it is. Replaced rather than refused: an error message full of binary garbage is still an
 * error report, and refusing it would discard exactly what a monitor most needs to keep.
 *
 * Walks arrays and plain objects, keys included, and returns a copy; anything that is not a
 * string, an array or an object comes back as it went in.
 */
export function replaceNul<T>(value: T): T
export function replaceNul(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(NUL, REPLACEMENT_CHARACTER)
  if (Array.isArray(value)) return value.map((item: unknown) => replaceNul(item))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [replaceNul(key), replaceNul(item as unknown)]),
    )
  }
  return value
}
