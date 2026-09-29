import { describe, expect, it } from 'vitest'
import { replaceNul } from '../../src/shared/nul.js'

interface Case {
  name: string
  input: unknown
  output: unknown
}

const CASES: Case[] = [
  { name: 'leaves a string with no NUL unchanged', input: 'plain', output: 'plain' },
  {
    name: 'replaces every NUL in a string',
    input: '\u0000a\u0000\u0000b',
    output: '\uFFFDa\uFFFD\uFFFDb',
  },
  // Only U+0000 is refused by Postgres; the other control characters store fine.
  { name: 'replaces nothing but NUL', input: '\u0001\u001f', output: '\u0001\u001f' },
  { name: 'leaves a number unchanged', input: 42, output: 42 },
  { name: 'leaves null unchanged', input: null, output: null },
  { name: 'leaves a boolean unchanged', input: true, output: true },
  { name: 'replaces strings inside an array', input: ['a\u0000', 1], output: ['a\uFFFD', 1] },
  { name: 'replaces in an object value', input: { k: 'v\u0000' }, output: { k: 'v\uFFFD' } },
  { name: 'replaces in an object key', input: { 'k\u0000': 'v' }, output: { 'k\uFFFD': 'v' } },
  {
    name: 'replaces in keys and values at any depth',
    input: { a: [{ 'b\u0000': { c: ['\u0000'] } }] },
    output: { a: [{ 'b\uFFFD': { c: ['\uFFFD'] } }] },
  },
]

describe('replaceNul', () => {
  it.each(CASES)('$name', ({ input, output }) => {
    expect(replaceNul(input)).toEqual(output)
  })

  it('leaves its input untouched', () => {
    const input = { 'k\u0000': ['v\u0000'] }
    replaceNul(input)
    expect(input).toEqual({ 'k\u0000': ['v\u0000'] })
  })

  it('keeps the type of a string it is given', () => {
    const replaced: string = replaceNul('a\u0000')
    expect(replaced).toBe('a\uFFFD')
  })
})
