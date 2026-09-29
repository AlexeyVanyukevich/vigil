const NUL = /\u0000/g
const REPLACEMENT_CHARACTER = '\uFFFD'

// `JSON.stringify` writes U+0000 as the escape `\u0000` and never raw. That text is an escape
// only after an even run of backslashes, zero included; after an odd run, the backslash before
// `u0000` is itself escaped and what follows is plain text. The lookbehind anchors the run at
// its first backslash, so the count cannot start midway through a longer one.
const ESCAPED_NUL = /(?<!\\)((?:\\\\)*)\\u0000/g
// Six characters, like the escape it replaces.
const ESCAPED_REPLACEMENT = '$1\\ufffd'

/**
 * Postgres refuses U+0000 in both `text` and `jsonb`, so a string carrying one cannot be stored
 * as it is. Replaced rather than refused: an error message full of binary garbage is still an
 * error report, and refusing it would discard exactly what a monitor most needs to keep.
 */
export function replaceNul(value: string): string {
  return value.replace(NUL, REPLACEMENT_CHARACTER)
}

/**
 * `JSON.stringify`, with every U+0000 in a key or a string value written as U+FFFD instead.
 *
 * Done on the serialised text rather than by walking the value, so it has no depth limit of its
 * own, and `Date` and `toJSON` come out as `JSON.stringify` writes them. The replacement is the
 * same length as the escape, so the result costs exactly as many bytes as `JSON.stringify`'s.
 */
export function stringifyWithoutNul(value: Record<string, unknown>): string {
  return JSON.stringify(value).replace(ESCAPED_NUL, ESCAPED_REPLACEMENT)
}
