const NUL = /\u0000/g
const REPLACEMENT_CHARACTER = '\uFFFD'

// The two escapes `JSON.stringify` writes that Postgres's `jsonb` refuses:
// - U+0000, which it always writes as `\u0000`, never raw;
// - an unpaired surrogate, which since ES2019 it writes as `\udXXX` in lowercase hex. A valid pair
//   is written as the character itself and never escaped, so every surrogate escape in its output
//   is a lone one, and Postgres refuses each ("Unicode low surrogate must follow a high
//   surrogate").
// Such text is an escape only after an even run of backslashes, zero included; after an odd run,
// the backslash before `u` is itself escaped and what follows is plain text. The lookbehind
// anchors the run at its first backslash, so the count cannot start midway through a longer one.
const REFUSED_ESCAPE = /(?<!\\)((?:\\\\)*)\\u(?:0000|d[89a-f][0-9a-f]{2})/g
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
 * `JSON.stringify`, with every U+0000 and every unpaired surrogate in a key or a string value
 * written as U+FFFD instead. Postgres's `jsonb` refuses both escapes, and one refused context
 * would fail the whole batch it arrived in.
 *
 * Done on the serialised text rather than by walking the value, so it has no depth limit of its
 * own, and `Date` and `toJSON` come out as `JSON.stringify` writes them. Each replacement is the
 * same length as the escape it replaces, so the result costs exactly as many bytes as
 * `JSON.stringify`'s.
 */
export function stringifyWithoutNulOrLoneSurrogate(value: Record<string, unknown>): string {
  return JSON.stringify(value).replace(REFUSED_ESCAPE, ESCAPED_REPLACEMENT)
}
