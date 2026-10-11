import { describe, expect, it } from 'vitest'
import { byteLength, guardBytes } from '../../src/shared/bytes.js'
import { PayloadTooLargeError } from '../../src/shared/errors.js'

describe('byteLength', () => {
  // The caps in §6 are byte caps. A stack full of non-ASCII identifiers is longer in bytes than
  // in characters, and measuring characters would let it through.
  it('counts bytes, not characters', () => {
    expect(byteLength('abc')).toBe(3)
    expect(byteLength('дом')).toBe(6)
    expect(byteLength('🙂')).toBe(4)
  })
})

describe('guardBytes', () => {
  it('passes a value at exactly the limit', () => {
    expect(() => guardBytes('abcd', 4, 'stack')).not.toThrow()
  })

  it('refuses one byte over, and names what was too big', () => {
    expect(() => guardBytes('abcde', 4, 'stack')).toThrow(PayloadTooLargeError)
    expect(() => guardBytes('abcde', 4, 'stack')).toThrow(/stack/)
  })

  // §6: rejected, not truncated and kept. A stack cut in half fingerprints differently from
  // the same stack whole, which would split one issue into two by payload size alone.
  it('answers 413 rather than trimming', () => {
    try {
      guardBytes('abcde', 4, 'stack')
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as PayloadTooLargeError).statusCode).toBe(413)
      expect((error as PayloadTooLargeError).code).toBe('payload_too_large')
    }
  })
})
