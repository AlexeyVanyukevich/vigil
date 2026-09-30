import { describe, expect, it } from 'vitest'
import { redact } from '../src/redact.js'

interface Case {
  name: string
  /** A function so each run gets a fresh value: several cases are cyclic or stateful. */
  input: () => unknown
  secrets?: readonly string[]
  expected: unknown
}

/** `{ nested: { nested: … leaf } }`, `levels` deep, built without recursion. */
function nest(levels: number, leaf: unknown): unknown {
  let node = leaf
  for (let i = 0; i < levels; i += 1) node = { nested: node }
  return node
}

function throwingGetter(): Record<string, unknown> {
  const node: Record<string, unknown> = { route: '/api/bookings' }
  Object.defineProperty(node, 'broken', {
    enumerable: true,
    get() {
      throw new Error('getter exploded')
    },
  })
  return node
}

function hostileProxy(): object {
  const trap = () => {
    throw new Error('trap exploded')
  }
  return new Proxy(
    {},
    { ownKeys: trap, get: trap, getPrototypeOf: trap, has: trap, getOwnPropertyDescriptor: trap },
  )
}

function revokedProxy(): object {
  const { proxy, revoke } = Proxy.revocable({}, {})
  revoke()
  return proxy
}

const keyCases: Case[] = [
  {
    name: 'removes the headers a stack trace most often carries',
    input: () => ({
      authorization: 'Bearer sk_live_abc',
      cookie: 'session=xyz',
      'set-cookie': 'session=xyz',
      route: '/api/bookings',
    }),
    expected: {
      authorization: '[redacted]',
      cookie: '[redacted]',
      'set-cookie': '[redacted]',
      route: '/api/bookings',
    },
  },
  {
    name: 'matches a key however it is cased or spelled',
    input: () => ({
      Authorization: 'a',
      AUTHORIZATION: 'b',
      apiKey: 'c',
      api_key: 'd',
      accessToken: 'e',
      'X-API-KEY': 'f',
      'Proxy-Authorization': 'g',
      Password: 'h',
      client_secret: 'i',
      'Set-Cookie': 'j',
    }),
    expected: {
      Authorization: '[redacted]',
      AUTHORIZATION: '[redacted]',
      apiKey: '[redacted]',
      api_key: '[redacted]',
      accessToken: '[redacted]',
      'X-API-KEY': '[redacted]',
      'Proxy-Authorization': '[redacted]',
      Password: '[redacted]',
      client_secret: '[redacted]',
      'Set-Cookie': '[redacted]',
    },
  },
  {
    name: 'redacts a sensitive key whole, whatever its value is',
    input: () => ({ password: { old: 'a', new: 'b' }, token: 42 }),
    expected: { password: '[redacted]', token: '[redacted]' },
  },
  {
    name: 'reaches into nested objects and arrays',
    input: () => ({
      request: { headers: { cookie: 'session=xyz', accept: 'json' } },
      attempts: [{ authorization: 'Bearer x' }, 'plain'],
    }),
    expected: {
      request: { headers: { cookie: '[redacted]', accept: 'json' } },
      attempts: [{ authorization: '[redacted]' }, 'plain'],
    },
  },
]

// The governing invariant of the reference application: its third-party API key never leaves
// its server. A stack trace or a captured context is a plausible way for it to escape, and
// scrubbing happens here so the secret never crosses the wire — not even to vigil.
const secretCases: Case[] = [
  {
    name: 'removes a configured secret wherever its value appears',
    input: () => ({ url: 'https://engine.example/?key=bk_live_secret', note: 'fine' }),
    secrets: ['bk_live_secret'],
    expected: { url: '[redacted]', note: 'fine' },
  },
  {
    name: 'removes a configured secret from a string deep inside an array',
    input: () => ({ calls: [['GET', 'https://engine.example/?key=bk_live_secret']] }),
    secrets: ['bk_live_secret'],
    expected: { calls: [['GET', '[redacted]']] },
  },
  {
    // Not `bk_live_secret` here: that key contains `secret` and would be redacted by name.
    name: 'removes a configured secret used as a key',
    input: () => ({ bk_live_9f8e7d: 1, other: 2 }),
    secrets: ['bk_live_9f8e7d'],
    expected: { '[redacted]': 1, other: 2 },
  },
  {
    name: 'removes a configured secret carried by an Error in the context',
    input: () => ({ cause: new Error('rejected key bk_live_secret') }),
    secrets: ['bk_live_secret'],
    expected: { cause: '[redacted]' },
  },
  {
    name: 'removes a configured secret carried by a symbol description',
    input: () => ({ tag: Symbol('bk_live_secret') }),
    secrets: ['bk_live_secret'],
    expected: { tag: '[redacted]' },
  },
  {
    name: 'removes a configured secret from what toJSON renders',
    input: () => ({ endpoint: new URL('https://engine.example/?key=bk_live_secret') }),
    secrets: ['bk_live_secret'],
    expected: { endpoint: '[redacted]' },
  },
  {
    name: 'matches a configured secret with the whitespace around it trimmed',
    input: () => ({ url: '?key=bk_live_secret' }),
    secrets: ['  bk_live_secret\n'],
    expected: { url: '[redacted]' },
  },
  {
    name: 'ignores a blank configured secret rather than redacting everything',
    input: () => ({ note: 'fine' }),
    secrets: ['', '   '],
    expected: { note: 'fine' },
  },
]

const primitiveCases: Case[] = [
  { name: 'leaves a string alone', input: () => 'plain', expected: 'plain' },
  { name: 'leaves a number alone', input: () => 42, expected: 42 },
  { name: 'leaves a boolean alone', input: () => false, expected: false },
  { name: 'leaves null alone', input: () => null, expected: null },
  { name: 'leaves undefined alone', input: () => undefined, expected: undefined },
]

const renderCases: Case[] = [
  {
    name: 'renders a value it cannot serialise rather than failing on it',
    input: () => ({ when: new Date(0), how: () => 1, big: 10n, tag: Symbol('t') }),
    expected: {
      when: '1970-01-01T00:00:00.000Z',
      how: '[function]',
      big: '10',
      tag: 'Symbol(t)',
    },
  },
  {
    name: 'renders an invalid Date, whose toISOString throws',
    input: () => ({ when: new Date(Number.NaN) }),
    expected: { when: 'Invalid Date' },
  },
  {
    name: 'renders an Error by its name and message',
    input: () => ({ cause: new RangeError('out of range') }),
    expected: { cause: 'RangeError: out of range' },
  },
  {
    name: 'describes binary data rather than walking every byte',
    input: () => ({ body: new Uint8Array(3), raw: new ArrayBuffer(5) }),
    expected: { body: '[binary 3 bytes]', raw: '[binary 5 bytes]' },
  },
  {
    name: 'uses toJSON where a value defines one',
    input: () => ({ endpoint: new URL('https://engine.example/a') }),
    expected: { endpoint: 'https://engine.example/a' },
  },
  {
    name: 'walks an object with no prototype',
    input: () => Object.assign(Object.create(null) as object, { code: 'ECONNRESET' }),
    expected: { code: 'ECONNRESET' },
  },
]

// Rule one of §8: never throw into the host. These are the inputs that break a naive walker.
const hostileCases: Case[] = [
  {
    // A request object referring to its own response is ordinary, not exotic.
    name: 'survives a cycle',
    input: () => {
      const cyclic: Record<string, unknown> = { name: 'root' }
      cyclic.self = cyclic
      return cyclic
    },
    expected: { name: 'root', self: '[circular]' },
  },
  {
    name: 'stops at a sane depth rather than walking a huge graph',
    input: () => nest(50, { end: true }),
    expected: nest(12, '[deep]'),
  },
  {
    // Deep enough that walking it all recursively overflows the stack.
    name: 'keeps its shape at a depth that would overflow a recursive walker',
    input: () => nest(100_000, { end: true }),
    expected: nest(12, '[deep]'),
  },
  {
    name: 'loses only the one property whose getter throws',
    input: throwingGetter,
    expected: { route: '/api/bookings', broken: '[unreadable]' },
  },
  {
    name: 'survives a proxy whose every trap throws',
    input: () => ({ ok: 1, trap: hostileProxy() }),
    expected: { ok: 1, trap: '[unreadable]' },
  },
  {
    name: 'survives a revoked proxy',
    input: () => ({ ok: 1, gone: revokedProxy() }),
    expected: { ok: 1, gone: '[unreadable]' },
  },
  {
    name: 'survives a toJSON that throws',
    input: () => ({
      ok: 1,
      odd: {
        toJSON() {
          throw new Error('no')
        },
      },
    }),
    expected: { ok: 1, odd: '[unreadable]' },
  },
  {
    name: 'survives an Error whose message getter throws',
    input: () => {
      const error = new Error('x')
      Object.defineProperty(error, 'message', {
        get() {
          throw new Error('no')
        },
      })
      return { cause: error }
    },
    expected: { cause: '[unreadable]' },
  },
  {
    name: 'survives being handed a hostile value at the top',
    input: hostileProxy,
    expected: '[unreadable]',
  },
]

// Fastify refuses a body carrying either shape with a 400, and the batch it arrived in — up to
// a hundred other events — is lost with it. A context holding a parsed request body is enough.
const poisonCases: Case[] = [
  {
    name: 'drops a __proto__ key',
    input: () => JSON.parse('{"__proto__": {"admin": true}, "route": "/a"}') as unknown,
    expected: { route: '/a' },
  },
  {
    name: 'drops a prototype key inside a constructor key',
    input: () => ({ body: { constructor: { prototype: { admin: true }, name: 'x' } } }),
    expected: { body: { constructor: { name: 'x' } } },
  },
]

// A credential carried where no key names it. `IncomingMessage.rawHeaders` is a flat
// `[name, value, …]` array, a header list is `[name, value]` tuples, and a sent response or an
// outbound request keeps its whole head as one string in `_header`.
const credentialCases: Case[] = [
  {
    name: 'redacts the value after a sensitive name in a flat header array',
    input: () => ({
      rawHeaders: ['Host', 'example.com', 'Authorization', 'Bearer x', 'Cookie', 'sid=1'],
    }),
    expected: {
      rawHeaders: ['Host', 'example.com', 'Authorization', '[redacted]', 'Cookie', '[redacted]'],
    },
  },
  {
    name: 'redacts the value in a [name, value] header tuple',
    input: () => [
      ['set-cookie', 'sid=1'],
      ['accept', 'json'],
    ],
    expected: [
      ['set-cookie', '[redacted]'],
      ['accept', 'json'],
    ],
  },
  {
    name: 'matches a header name however it is cased or padded',
    input: () => [' X-API-KEY ', 'k1', 'PROXY-AUTHORIZATION', 'Basic abc'],
    expected: [' X-API-KEY ', '[redacted]', 'PROXY-AUTHORIZATION', '[redacted]'],
  },
  {
    // Whether an element is a name is decided from what it was, not from what it became. Read
    // as a value only, `password` would let a real name after it pass — see `Vary` below. The
    // price is one redacted element too many, never one too few.
    name: 'reads every element as a possible name, even one it redacted as a value',
    input: () => ['x-auth-token', 'password', 'host', 'example.com'],
    expected: ['x-auth-token', '[redacted]', '[redacted]', 'example.com'],
  },
  {
    name: 'still redacts a Set-Cookie that follows Vary: Cookie',
    input: () => ['Vary', 'Cookie', 'Set-Cookie', 'sid=LEAKME123'],
    expected: ['Vary', 'Cookie', '[redacted]', '[redacted]'],
  },
  {
    name: 'still redacts an Authorization that follows a header listing it',
    input: () => ['Access-Control-Request-Headers', 'authorization', 'Authorization', 'Token abc'],
    expected: ['Access-Control-Request-Headers', 'authorization', '[redacted]', '[redacted]'],
  },
  {
    name: 'leaves an array without header names alone',
    input: () => ['GET', '/api/bookings', 'accept', 'json'],
    expected: ['GET', '/api/bookings', 'accept', 'json'],
  },
  {
    name: 'redacts the value of each sensitive line in a raw HTTP head',
    input: () =>
      'GET / HTTP/1.1\r\nHost: a\r\nAuthorization: Bearer x\r\ncookie: sid=1\r\nSet-Cookie: s=2\r\n\r\n',
    expected:
      'GET / HTTP/1.1\r\nHost: a\r\nAuthorization: [redacted]\r\ncookie: [redacted]\r\nSet-Cookie: [redacted]\r\n\r\n',
  },
  {
    name: 'redacts a sensitive header inside printed or serialised text',
    input: () => `failed { cookie: 'sid=1' } and {"x-api-key":"k1"}`,
    expected: `failed { cookie: [redacted]`,
  },
  {
    name: 'redacts a Bearer credential in free text',
    input: () => 'engine said no to Bearer eyJhbGciOi.J9.abc-_ today',
    expected: 'engine said no to Bearer [redacted] today',
  },
  {
    name: 'redacts a Basic credential in free text',
    input: () => 'retrying with basic dXNlcjpwYXNz== once',
    expected: 'retrying with basic [redacted] once',
  },
  {
    name: 'redacts a Bearer credential on the line after the scheme',
    input: () => 'Bearer\ntok_9a8b7c6d',
    expected: 'Bearer\n[redacted]',
  },
  {
    name: 'redacts a Bearer credential after a colon',
    input: () => 'Bearer: tok_9a8b7c6d',
    expected: 'Bearer: [redacted]',
  },
  {
    name: 'redacts a quoted Bearer or Basic credential',
    input: () => `Bearer "tok_9a8b7c6d" and Basic 'dXNlcjpwYXNz'`,
    expected: `Bearer "[redacted]" and Basic '[redacted]'`,
  },
  {
    name: 'leaves text that only mentions a header alone',
    input: () => 'the cookie jar is empty',
    expected: 'the cookie jar is empty',
  },
]

// Strings are cut at 4,096 characters. The context that reaches the wire is 8 KB at most, and
// scanning a longer string only costs the host time on every throw.
const lengthCases: Case[] = [
  {
    name: 'keeps a string at the cap whole',
    input: () => 'x'.repeat(4_096),
    expected: 'x'.repeat(4_096),
  },
  {
    name: 'cuts a longer string and says how much it cut',
    input: () => 'x'.repeat(5_000),
    expected: `${'x'.repeat(4_096)}… (904 more characters)`,
  },
  {
    // Cut first and scanned second, only `bk_` would be left, and nothing would match it.
    name: 'still finds a configured secret that straddles the cut',
    input: () => `${'a'.repeat(4_093)}bk_live_secret tail`,
    secrets: ['bk_live_secret'],
    expected: '[redacted]',
  },
  {
    name: 'does not redact a string for a secret wholly past the cut',
    input: () => `${'a'.repeat(4_096)}bk_live_secret`,
    secrets: ['bk_live_secret'],
    expected: `${'a'.repeat(4_096)}… (14 more characters)`,
  },
  {
    name: 'never cuts a string between the two halves of a surrogate pair',
    input: () => `${'a'.repeat(4_095)}😀b`,
    expected: `${'a'.repeat(4_095)}… (3 more characters)`,
  },
  {
    name: 'cuts a long key the same way',
    input: () => ({ ['k'.repeat(5_000)]: 1 }),
    expected: { [`${'k'.repeat(4_096)}… (904 more characters)`]: 1 },
  },
]

const allCases = [
  ...keyCases,
  ...secretCases,
  ...primitiveCases,
  ...renderCases,
  ...hostileCases,
  ...poisonCases,
  ...credentialCases,
  ...lengthCases,
]

describe('redact', () => {
  it.each(allCases)('$name', ({ input, secrets, expected }) => {
    expect(redact(input(), secrets)).toEqual(expected)
  })

  it.each(allCases)('$name, and comes out JSON-serialisable', ({ input, secrets }) => {
    const json = JSON.stringify(redact(input(), secrets)) ?? ''
    expect(json).not.toMatch(/"__proto__"\s*:/)
    expect(json).not.toMatch(/"constructor"\s*:\s*\{[^}]*"prototype"\s*:/)
  })

  // Assigning a `__proto__` key sets the prototype instead, so it never shows in the JSON — but
  // everything read from the result afterwards would inherit from the attacker's object.
  it.each(poisonCases)('$name, leaving the prototype of what it returns alone', ({ input }) => {
    expect(Object.getPrototypeOf(redact(input()))).toBe(Object.prototype)
  })

  it('does not mutate what it was given', () => {
    const original = { authorization: 'Bearer x', nested: { cookie: 'y' } }
    redact(original)
    expect(original).toEqual({ authorization: 'Bearer x', nested: { cookie: 'y' } })
  })

  it('keeps the first hundred items of a long array and counts the rest', () => {
    const scrubbed = redact(Array.from({ length: 1_000 }, (_, i) => i)) as unknown[]
    expect(scrubbed).toHaveLength(101)
    expect(scrubbed[99]).toBe(99)
    expect(scrubbed[100]).toBe('[900 more items]')
  })

  it('keeps the first hundred keys of a wide object and counts the rest', () => {
    const wide = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`k${i}`, i]))
    const scrubbed = redact(wide) as Record<string, unknown>
    expect(Object.keys(scrubbed)).toHaveLength(101)
    expect(scrubbed.k99).toBe(99)
    expect(scrubbed['[more keys]']).toBe(50)
  })

  // Every object costs a visit, and the host's error path pays for each one. A context that
  // reaches a large graph within the depth bound is cut off rather than walked to the end.
  it('stops after a bounded number of objects', () => {
    const graph = Array.from({ length: 20 }, () => Array.from({ length: 99 }, (_, i) => ({ i })))
    const scrubbed = redact(graph) as unknown[]
    expect(scrubbed[0]).toEqual(graph[0])
    expect(scrubbed[19]).toBe('[truncated]')
  })

  // Objects are counted, and strings were not: a shared string is scanned again at every place
  // it is referenced. One call reads a bounded number of characters, and then stops.
  it('stops after a bounded number of characters', () => {
    const scrubbed = redact(Array.from({ length: 99 }, () => 'x'.repeat(5_000))) as unknown[]
    expect(scrubbed[0]).toBe(`${'x'.repeat(4_096)}… (904 more characters)`)
    expect(scrubbed[98]).toBe('[truncated]')
  })

  // `toWireEvent` runs on every throw, before collapsing, so a hot loop pays this every time.
  // The bound is generous so it does not flake; the input took eleven seconds before the fix.
  it('redacts a huge string shared by thousands of leaves in bounded time', () => {
    const huge = 'x'.repeat(1_000_000)
    const graph = Array.from({ length: 50 }, () => Array<string>(99).fill(huge))
    const started = performance.now()
    redact({ graph }, ['bk_live_secret'])
    expect(performance.now() - started).toBeLessThan(1_500)
  })

  // A key is checked against `ALWAYS_REDACTED` on every object that has it, and lowercasing a
  // whole huge key each time costs seconds. Only the part that could be sent is examined.
  it('redacts a huge key shared by hundreds of objects in bounded time', () => {
    const key = 'k'.repeat(20_000_000)
    const graph = Array.from({ length: 9 }, () => Array.from({ length: 99 }, () => ({ [key]: 1 })))
    const started = performance.now()
    redact(graph, ['bk_live_secret'])
    expect(performance.now() - started).toBeLessThan(1_500)
  })
})
