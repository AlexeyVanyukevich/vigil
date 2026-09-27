import { describe, expect, it } from 'vitest'
import {
  fingerprintOf,
  normalizeMessage,
  parseFrames,
  type Frame,
  type FingerprintInput,
} from '../../src/shared/fingerprint.js'

const STACK = `TypeError: Cannot read properties of undefined (reading 'id')
    at handleBooking (/app/src/modules/bookings/booking.service.js:42:17)
    at process (/app/node_modules/fastify/lib/handle.js:118:9)
    at async run (/app/src/app.js:12:3)`

// A dependency upgrade reshuffles the frames inside it. If those frames were in the hash, every
// issue in the project would split on `npm update`.
const STACK_WITH_UPGRADED_VENDOR_FRAME = STACK.replace(
  'fastify/lib/handle.js:118:9',
  'fastify/lib/route.js:9:1',
)

// The rule the whole design rests on: editing a file above a throw site must not split one issue
// into two.
const STACK_WITH_LINES_MOVED = STACK.replace(':42:17', ':71:9').replace(':12:3', ':30:3')

const STACK_THROWN_ELSEWHERE = STACK.replace('handleBooking', 'cancelBooking')

const VENDOR_ONLY_STACK_A = `Error: socket hang up
    at Socket.end (/app/node_modules/undici/lib/core.js:9:1)`
const VENDOR_ONLY_STACK_B = `Error: socket hang up
    at Pool.dispatch (/app/node_modules/undici/lib/pool.js:4:2)`

describe('parseFrames', () => {
  const CASES: { name: string; stack: string; expected: Frame[] }[] = [
    {
      name: 'reads the function and module, drops line/column, and marks a node_modules frame as vendor while stripping the async decoration',
      stack: STACK,
      expected: [
        {
          fn: 'handleBooking',
          module: '/app/src/modules/bookings/booking.service.js',
          vendor: false,
        },
        { fn: 'process', module: '/app/node_modules/fastify/lib/handle.js', vendor: true },
        { fn: 'run', module: '/app/src/app.js', vendor: false },
      ],
    },
    {
      name: 'strips a "new" decoration, which does not change which function it is',
      stack: '    at new Repository (/app/src/repo.js:1:1)',
      expected: [{ fn: 'Repository', module: '/app/src/repo.js', vendor: false }],
    },
    {
      name: 'reads a frame with no function name',
      stack: '    at /app/src/boot.js:9:1',
      expected: [{ fn: '<anonymous>', module: '/app/src/boot.js', vendor: false }],
    },
    {
      name: 'ignores the message line and a frame carrying no location',
      stack: 'Error: boom\n    at Object.<anonymous>',
      expected: [],
    },
    {
      name: 'reads a browser frame served over http',
      stack: '    at t.render (https://app.example/assets/index-a1b2.js:5:914)',
      expected: [
        { fn: 't.render', module: 'https://app.example/assets/index-a1b2.js', vendor: false },
      ],
    },
    {
      name: 'survives a stack it cannot parse at all',
      stack: 'something went wrong',
      expected: [],
    },
    {
      name: 'survives an empty stack',
      stack: '',
      expected: [],
    },
  ]

  it.each(CASES)('$name', ({ stack, expected }) => {
    expect(parseFrames(stack)).toEqual(expected)
  })
})

describe('normalizeMessage', () => {
  const CASES: { name: string; message: string; expected: string }[] = [
    {
      name: 'leaves a message with nothing variable in it alone',
      message: 'the engine did not answer',
      expected: 'the engine did not answer',
    },
    {
      name: 'replaces a uuid whole rather than digit by digit',
      message: 'booking 3f6a1c2e-9d4b-4f8a-8c1d-2b7e5a9f0c31 is gone',
      expected: 'booking <uuid> is gone',
    },
    {
      name: 'replaces a long hex run',
      message: 'token deadbeefdeadbeefcafe expired',
      expected: 'token <hex> expired',
    },
  ]

  it.each(CASES)('$name', ({ message, expected }) => {
    expect(normalizeMessage(message)).toBe(expected)
  })

  // Not a fixed expected string — the point is that two ids collapse to the same normalized
  // form, whatever placeholder text is used for a number.
  it('makes two messages differing only by an id into one', () => {
    expect(normalizeMessage('user 123 not found')).toBe(normalizeMessage('user 456 not found'))
  })
})

describe('fingerprintOf', () => {
  const base: FingerprintInput = {
    type: 'TypeError',
    message: 'Cannot read properties of undefined',
    stack: STACK,
  }
  const vendorOnlyA: FingerprintInput = {
    type: 'Error',
    message: 'socket hang up',
    stack: VENDOR_ONLY_STACK_A,
  }
  const vendorOnlyB: FingerprintInput = {
    type: 'Error',
    message: 'socket hang up',
    stack: VENDOR_ONLY_STACK_B,
  }

  it('is a sha256 hex digest', () => {
    expect(fingerprintOf(base).fingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  const RELATION_CASES: {
    name: string
    a: FingerprintInput
    b: FingerprintInput
    relation: 'same' | 'different'
  }[] = [
    {
      name: 'does not change when a line above the throw site moves',
      a: base,
      b: { ...base, stack: STACK_WITH_LINES_MOVED },
      relation: 'same',
    },
    {
      name: 'does not change when the message carries a different id',
      a: { ...base, message: 'user 1 missing' },
      b: { ...base, message: 'user 2 missing' },
      relation: 'same',
    },
    {
      name: 'changes when the error type changes',
      a: base,
      b: { ...base, type: 'RangeError' },
      relation: 'different',
    },
    {
      name: 'changes when the throw moves to a different function',
      a: base,
      b: { ...base, stack: STACK_THROWN_ELSEWHERE },
      relation: 'different',
    },
    {
      name: 'ignores a change confined to node_modules',
      a: base,
      b: { ...base, stack: STACK_WITH_UPGRADED_VENDOR_FRAME },
      relation: 'same',
    },
    {
      // An error thrown entirely inside a dependency has no owner frame to fall back on.
      // Dropping every frame would hash nothing but the type, merging unrelated library
      // failures into one — so distinct vendor-only stacks must still produce distinct
      // fingerprints.
      name: 'uses vendor frames when there is no owner frame at all',
      a: vendorOnlyA,
      b: vendorOnlyB,
      relation: 'different',
    },
    {
      name: 'falls back to the normalized message and collapses two different ids',
      a: { type: 'Error', message: 'user 1 not found' },
      b: { type: 'Error', message: 'user 2 not found' },
      relation: 'same',
    },
    {
      name: 'falls back to the normalized message but keeps unrelated messages apart',
      a: { type: 'Error', message: 'user 1 not found' },
      b: { type: 'Error', message: 'house 1 not found' },
      relation: 'different',
    },
    {
      name: 'lets an explicit fingerprint override everything',
      a: { ...base, fingerprint: 'checkout-flow' },
      b: { type: 'RangeError', message: 'other', fingerprint: 'checkout-flow' },
      relation: 'same',
    },
    {
      name: 'an explicit fingerprint differs from the computed one for the same input',
      a: { ...base, fingerprint: 'checkout-flow' },
      b: base,
      relation: 'different',
    },
    {
      name: 'treats a blank explicit fingerprint as absent',
      a: { ...base, fingerprint: '   ' },
      b: base,
      relation: 'same',
    },
    {
      // An explicit fingerprint is caller-chosen text. It must not be able to collide with a
      // computed one by being crafted to look like the hashed body.
      name: 'cannot be made to collide with a computed fingerprint',
      a: { type: 'Error', message: 'x', fingerprint: 'Error\nx' },
      b: { type: 'Error', message: 'x' },
      relation: 'different',
    },
    {
      name: 'is stable across calls',
      a: base,
      b: base,
      relation: 'same',
    },
  ]

  it.each(RELATION_CASES)('$name', ({ a, b, relation }) => {
    const same = fingerprintOf(a).fingerprint === fingerprintOf(b).fingerprint
    expect(same).toBe(relation === 'same')
  })

  const CULPRIT_CASES: { name: string; input: FingerprintInput; expected: string | null }[] = [
    {
      name: 'names the owner code as the culprit, not the library below it',
      input: base,
      expected: 'handleBooking (/app/src/modules/bookings/booking.service.js)',
    },
    {
      name: 'uses a vendor frame as the culprit when there is no owner frame at all',
      input: vendorOnlyA,
      expected: 'Socket.end (/app/node_modules/undici/lib/core.js)',
    },
    {
      name: 'has no culprit with no usable stack',
      input: { type: 'Error', message: 'user 1 not found' },
      expected: null,
    },
    {
      // Still reported, so the dashboard can show where a hand-grouped issue came from.
      name: 'still names the culprit when an explicit fingerprint overrides the hash',
      input: { ...base, fingerprint: 'checkout-flow' },
      expected: 'handleBooking (/app/src/modules/bookings/booking.service.js)',
    },
  ]

  it.each(CULPRIT_CASES)('$name', ({ input, expected }) => {
    expect(fingerprintOf(input).culprit).toBe(expected)
  })
})
