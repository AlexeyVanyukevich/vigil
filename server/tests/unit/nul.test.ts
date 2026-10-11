import { describe, expect, it } from 'vitest'
import { replaceNul, stringifyWithoutNulOrLoneSurrogate } from '../../src/shared/nul.js'

interface StringCase {
  name: string
  input: string
  output: string
}

const STRING_CASES: StringCase[] = [
  { name: 'leaves a string with no NUL unchanged', input: 'plain', output: 'plain' },
  {
    name: 'replaces every NUL in a string',
    input: '\u0000a\u0000\u0000b',
    output: '\uFFFDa\uFFFD\uFFFDb',
  },
  // Only U+0000 is refused by Postgres; the other control characters store fine.
  { name: 'replaces nothing but NUL', input: '\u0001\u001f', output: '\u0001\u001f' },
]

describe('replaceNul', () => {
  it.each(STRING_CASES)('$name', ({ input, output }) => {
    expect(replaceNul(input)).toBe(output)
  })
})

interface ValueCase {
  name: string
  input: Record<string, unknown>
  /** What the returned JSON parses back to. */
  output: Record<string, unknown>
}

const VALUE_CASES: ValueCase[] = [
  { name: 'leaves a value with no NUL unchanged', input: { a: [1, 'b'] }, output: { a: [1, 'b'] } },
  { name: 'replaces in an object value', input: { k: 'v\u0000' }, output: { k: 'v\uFFFD' } },
  { name: 'replaces in an object key', input: { 'k\u0000': 'v' }, output: { 'k\uFFFD': 'v' } },
  {
    name: 'replaces in keys and values at any depth',
    input: { a: [{ 'b\u0000': { c: ['\u0000\u0000'] } }] },
    output: { a: [{ 'b\uFFFD': { c: ['\uFFFD\uFFFD'] } }] },
  },
  { name: 'replaces nothing but NUL', input: { v: '\u0001\u001f' }, output: { v: '\u0001\u001f' } },
  // The escape `\u0000` is real only after an even run of backslashes. After an odd run, the
  // backslash before `u0000` is itself escaped, and what follows is plain text.
  {
    name: 'leaves a backslash followed by the text u0000 unchanged',
    input: { v: '\\u0000' },
    output: { v: '\\u0000' },
  },
  {
    name: 'leaves two backslashes followed by the text u0000 unchanged',
    input: { v: '\\\\u0000' },
    output: { v: '\\\\u0000' },
  },
  { name: 'replaces a NUL after a backslash', input: { v: '\\\u0000' }, output: { v: '\\\uFFFD' } },
  {
    name: 'replaces a NUL after two backslashes',
    input: { v: '\\\\\u0000' },
    output: { v: '\\\\\uFFFD' },
  },
  // JSON.stringify's own conversions still apply, since it does the serialising.
  {
    name: 'writes a Date as its ISO string',
    input: { at: new Date('2026-09-05T12:34:56.789Z') },
    output: { at: '2026-09-05T12:34:56.789Z' },
  },
  { name: 'honours toJSON', input: { v: { toJSON: () => 'x\u0000' } }, output: { v: 'x\uFFFD' } },
  // `JSON.stringify` escapes an unpaired surrogate as `\udXXX`, which Postgres's `jsonb` refuses
  // as it refuses `\u0000`. A valid pair is written as itself, never escaped.
  {
    name: 'replaces a lone high surrogate in a value',
    input: { v: 'smile \ud83d' },
    output: { v: 'smile \uFFFD' },
  },
  {
    name: 'replaces a lone low surrogate in a key',
    input: { 'k\ude00': 1 },
    output: { 'k\uFFFD': 1 },
  },
  {
    name: 'replaces a low surrogate before its high, as two lone ones',
    input: { v: '\ude00\ud83d' },
    output: { v: '\uFFFD\uFFFD' },
  },
  {
    name: 'replaces a lone surrogate at either end of the surrogate range',
    input: { v: '\ud800', w: '\udfff' },
    output: { v: '\uFFFD', w: '\uFFFD' },
  },
  {
    name: 'keeps a valid surrogate pair',
    input: { v: 'smile \uD83D\uDE00' },
    output: { v: 'smile \uD83D\uDE00' },
  },
  {
    name: 'keeps a pair beside a lone surrogate',
    input: { v: '\uD83D\uDE00\ud83d\uD83D\uDE00' },
    output: { v: '\uD83D\uDE00\uFFFD\uD83D\uDE00' },
  },
  {
    name: 'leaves a backslash followed by the text ud83d unchanged',
    input: { v: '\\ud83d', 'k\\udc00': 'x\\\\ud83d' },
    output: { v: '\\ud83d', 'k\\udc00': 'x\\\\ud83d' },
  },
  {
    name: 'replaces a lone surrogate after a backslash',
    input: { v: '\\\ud83d' },
    output: { v: '\\\uFFFD' },
  },
  {
    name: 'leaves code points beside the surrogate range unchanged',
    input: { v: '\ud7ff\ue000' },
    output: { v: '\ud7ff\ue000' },
  },
]

describe('stringifyWithoutNulOrLoneSurrogate', () => {
  it.each(VALUE_CASES)('$name', ({ input, output }) => {
    expect(JSON.parse(stringifyWithoutNulOrLoneSurrogate(input))).toEqual(output)
  })

  // The context cap is measured on this output, so it must cost exactly what `JSON.stringify`
  // does: a caller measuring either sees the same number.
  it.each(VALUE_CASES)('keeps the byte length of JSON.stringify when it $name', ({ input }) => {
    expect(Buffer.byteLength(stringifyWithoutNulOrLoneSurrogate(input))).toBe(
      Buffer.byteLength(JSON.stringify(input)),
    )
  })

  it('handles nesting deeper than a recursive walk could', () => {
    let nested: unknown = '\u0000'
    for (let depth = 0; depth < 100_000; depth++) nested = [nested]
    const json = stringifyWithoutNulOrLoneSurrogate({ k: nested })
    expect(json).toBe(`{"k":${'['.repeat(100_000)}"\\ufffd"${']'.repeat(100_000)}}`)
  })
})
