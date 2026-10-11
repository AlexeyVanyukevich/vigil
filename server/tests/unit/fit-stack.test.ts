import { describe, expect, it } from 'vitest'
import { fitStack, STACK_TRUNCATION_MARKER as MARKER } from '../../src/self/record.js'

const bytes = (value: string) => Buffer.byteLength(value, 'utf8')
const TAIL = `\n${MARKER}`

describe('fitStack', () => {
  const cases: Array<{ name: string; stack: string; max: number; expected: string }> = [
    {
      name: 'a stack that fits is left alone',
      stack: 'Error: a\n    at f',
      max: 100,
      expected: 'Error: a\n    at f',
    },
    {
      name: 'exactly at the cap is left alone',
      stack: 'x'.repeat(50),
      max: 50,
      expected: 'x'.repeat(50),
    },
    {
      name: 'cut at the last whole line that fits with the marker',
      stack: `Error: e\n${'a'.repeat(10)}\n${'b'.repeat(10)}\n${'c'.repeat(100)}`,
      max: bytes(`Error: e\n${'a'.repeat(10)}\n${'b'.repeat(10)}${TAIL}`),
      expected: `Error: e\n${'a'.repeat(10)}\n${'b'.repeat(10)}${TAIL}`,
    },
    {
      // 36 code units against a 39-byte cap, but 71 bytes: measured in code units, it would
      // appear to fit and be passed through whole.
      name: 'measured in UTF-8 bytes, not code units',
      stack: `${'é'.repeat(5)}\n${'é'.repeat(30)}`,
      max: bytes(`${'é'.repeat(5)}${TAIL}`),
      expected: `${'é'.repeat(5)}${TAIL}`,
    },
    {
      // No line boundary to cut at: the first line is cut at a code point instead.
      name: 'a first line longer than the cap is cut at a code point',
      stack: `Error: ${'é'.repeat(100)}\n    at f`,
      max: bytes(`Error: ${'é'.repeat(3)}${TAIL}`) + 1,
      expected: `Error: ${'é'.repeat(3)}${TAIL}`,
    },
    {
      name: 'a surrogate pair is never split',
      stack: `${'😀'.repeat(10)}\n    at f`,
      max: bytes(`😀😀${TAIL}`) + 3,
      expected: `😀😀${TAIL}`,
    },
  ]

  it.each(cases)('$name', ({ stack, max, expected }) => {
    const fitted = fitStack(stack, max)
    expect(fitted).toBe(expected)
    expect(bytes(fitted)).toBeLessThanOrEqual(max)
  })

  it('cuts the same stack the same way every time', () => {
    const stack = `Error: e\n${'    at somewhere (file.js:1:1)\n'.repeat(1_000)}`
    expect(fitStack(stack, 16_384)).toBe(fitStack(stack, 16_384))
  })
})
