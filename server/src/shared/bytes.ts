import { PayloadTooLargeError } from './errors.js'

/**
 * The §6 caps are byte caps, and a JavaScript string's `length` is neither bytes nor
 * characters. A stack full of non-ASCII identifiers measures shorter by `length` than it costs
 * to store, and measuring that way would let it through.
 */
export function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

export function guardBytes(value: string, limit: number, what: string): void {
  const size = byteLength(value)
  if (size > limit) {
    throw new PayloadTooLargeError(`This ${what} is ${size} bytes; the limit is ${limit}`, {
      what,
      size,
      limit,
    })
  }
}
