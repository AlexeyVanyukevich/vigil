import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { collapseKey, toWireEvent, type WireEvent } from '../src/payload.js'

const SECRET = 'bk_live_secret'
const MARKER = '    … (truncated by vigil)'

const encoder = new TextEncoder()
const bytes = (text: string): number => encoder.encode(text).length

/**
 * What `POST /ingest/events` refuses, restated from `server/src/modules/ingest/ingest.schemas.ts`,
 * `ingest.service.ts` and the defaults in `config.ts`. Restated rather than imported: this
 * package imports nothing from `server/`. One refused event loses the whole batch it rides in.
 */
function wireProblems(event: WireEvent): string[] {
  const problems: string[] = []
  const fields = ['type', 'message', 'stack', 'occurred_at', 'context', 'count', 'fingerprint']
  for (const key of Object.keys(event)) if (!fields.includes(key)) problems.push(`field ${key}`)

  const codePoints = (text: string): number => [...text].length
  if (typeof event.type !== 'string' || !/\S/.test(event.type) || codePoints(event.type) > 200) {
    problems.push(`type ${JSON.stringify(event.type)}`)
  }
  if (typeof event.message !== 'string' || codePoints(event.message) > 4_000) {
    problems.push('message')
  }
  if (event.stack !== undefined) {
    // The server swaps U+0000 for U+FFFD, one byte for three, before it measures.
    if (typeof event.stack !== 'string' || bytes(event.stack.replace(/\0/g, '\uFFFD')) > 16_384) {
      problems.push('stack')
    }
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(event.occurred_at)) {
    problems.push('occurred_at')
  }
  if (event.context !== undefined) {
    const json = JSON.stringify(event.context)
    if (typeof event.context !== 'object' || Array.isArray(event.context)) problems.push('context')
    if (bytes(json) > 8_192) problems.push(`context is ${bytes(json)} bytes`)
    // Fastify refuses either shape with a 400.
    if (/"__proto__"\s*:|"constructor"\s*:\s*\{[^}]*"prototype"\s*:/.test(json)) {
      problems.push('context poisoning')
    }
  }
  if (event.fingerprint !== undefined) {
    if (typeof event.fingerprint !== 'string' || codePoints(event.fingerprint) > 200) {
      problems.push('fingerprint')
    }
  }
  return problems
}

function withStack(stack: string, message = 'boom'): Error {
  const error = new Error(message)
  error.stack = stack
  return error
}

function frames(count: number): string {
  return Array.from({ length: count }, (_, i) => `    at f${i} (/srv/app/src/f${i}.js:1:1)`).join(
    '\n',
  )
}

function withThrowingGetter(key: 'name' | 'message' | 'stack'): Error {
  const error = new Error('x')
  Object.defineProperty(error, key, {
    get() {
      throw new Error('getter exploded')
    },
  })
  return error
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

class EngineUnreachableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EngineUnreachableError'
  }
}

interface DescribeCase {
  name: string
  error: () => unknown
  expected: Partial<Record<keyof WireEvent, unknown>>
}

// A codebase that throws strings, or objects, still needs its failures recorded, and the
// alternative to handling each here is the monitor throwing while reporting somebody else's throw.
const describeCases: DescribeCase[] = [
  {
    name: 'carries the error type, message and stack',
    error: () => new TypeError('boom'),
    expected: {
      type: 'TypeError',
      message: 'boom',
      stack: expect.stringContaining('TypeError: boom'),
    },
  },
  {
    name: 'keeps a custom error class name, which is what the owner recognises',
    error: () => new EngineUnreachableError('no answer'),
    expected: { type: 'EngineUnreachableError', message: 'no answer' },
  },
  {
    name: 'recognises an Error from another realm',
    error: () => runInNewContext('new RangeError("elsewhere")') as unknown,
    expected: { type: 'RangeError', message: 'elsewhere' },
  },
  {
    name: 'accepts a thrown string',
    error: () => 'just a string',
    expected: { type: 'Error', message: 'just a string' },
  },
  {
    name: 'accepts a thrown undefined',
    error: () => undefined,
    expected: { type: 'Error', message: 'undefined' },
  },
  {
    name: 'accepts a thrown null',
    error: () => null,
    expected: { type: 'Error', message: 'null' },
  },
  { name: 'accepts a thrown number', error: () => 42, expected: { type: 'Error', message: '42' } },
  { name: 'accepts a thrown BigInt', error: () => 10n, expected: { type: 'Error', message: '10' } },
  {
    name: 'accepts a thrown symbol',
    error: () => Symbol('why'),
    expected: { type: 'Error', message: 'Symbol(why)' },
  },
  {
    name: 'accepts a thrown function',
    error: () => () => 1,
    expected: { type: 'Error', message: '[function]' },
  },
  {
    name: 'accepts a thrown object',
    error: () => ({ code: 'ECONNRESET' }),
    expected: { type: 'Error', message: '{"code":"ECONNRESET"}' },
  },
  {
    name: 'accepts a thrown object with no prototype',
    error: () => Object.assign(Object.create(null) as object, { code: 'ECONNRESET' }),
    expected: { type: 'Error', message: '{"code":"ECONNRESET"}' },
  },
  {
    name: 'accepts a thrown object that refers to itself',
    error: () => {
      const cyclic: Record<string, unknown> = { code: 'E' }
      cyclic.self = cyclic
      return cyclic
    },
    expected: { type: 'Error', message: '{"code":"E","self":"[circular]"}' },
  },
  {
    // Rendering a thrown object is a second way into the payload, and it is redacted too.
    name: 'redacts a thrown object before rendering it as the message',
    error: () => ({ headers: { authorization: 'Bearer sk_live_abc' } }),
    expected: { type: 'Error', message: '{"headers":{"authorization":"[redacted]"}}' },
  },
  {
    name: 'accepts a thrown proxy whose every trap throws',
    error: hostileProxy,
    expected: { type: 'Error', message: '[unreadable]' },
  },
  {
    name: 'falls back to Error for a blank name',
    error: () => Object.assign(new Error('x'), { name: '' }),
    expected: { type: 'Error' },
  },
  {
    name: 'falls back to Error for a name of only spaces, which the server refuses',
    error: () => Object.assign(new Error('x'), { name: '   ' }),
    expected: { type: 'Error' },
  },
  {
    name: 'renders a message that is not a string',
    error: () => Object.assign(new Error('x'), { message: { code: 1 } }),
    expected: { type: 'Error', message: '[object Object]' },
  },
  {
    name: 'survives a name getter that throws',
    error: () => withThrowingGetter('name'),
    expected: { type: 'Error', message: 'x' },
  },
  {
    name: 'survives a message getter that throws',
    error: () => withThrowingGetter('message'),
    expected: { type: 'Error', message: '[unreadable]' },
  },
  {
    name: 'survives a stack getter that throws',
    error: () => withThrowingGetter('stack'),
    expected: { type: 'Error', message: 'x', stack: undefined },
  },
  {
    name: 'drops a stack that is not a string',
    error: () => Object.assign(new Error('x'), { stack: 42 }),
    expected: { stack: undefined },
  },
]

interface ContextCase {
  name: string
  context: () => unknown
  expected: { context?: unknown; fingerprint?: string }
}

const contextCases: ContextCase[] = [
  {
    name: 'scrubs the context before it is ever queued',
    context: () => ({ headers: { cookie: 'session=xyz' } }),
    expected: { context: { headers: { cookie: '[redacted]' } } },
  },
  { name: 'omits the context entirely when there is none', context: () => undefined, expected: {} },
  { name: 'omits a context that is empty', context: () => ({}), expected: {} },
  { name: 'omits a null context', context: () => null, expected: {} },
  {
    // Consumed, not also sent as context: it is an instruction, not data about the failure.
    name: 'passes an explicit fingerprint through',
    context: () => ({ vigilFingerprint: 'checkout' }),
    expected: { fingerprint: 'checkout' },
  },
  {
    name: 'lifts the fingerprint out and keeps the rest of the context',
    context: () => ({ vigilFingerprint: 'checkout', route: '/pay' }),
    expected: { fingerprint: 'checkout', context: { route: '/pay' } },
  },
  {
    name: 'trims an explicit fingerprint',
    context: () => ({ vigilFingerprint: '  checkout  ' }),
    expected: { fingerprint: 'checkout' },
  },
  {
    name: 'ignores a blank fingerprint, and still does not send it as context',
    context: () => ({ vigilFingerprint: '   ' }),
    expected: {},
  },
  {
    name: 'ignores a fingerprint that is not a string',
    context: () => ({ vigilFingerprint: 42 }),
    expected: {},
  },
  {
    name: 'cuts a fingerprint to the 200 characters the server accepts',
    context: () => ({ vigilFingerprint: 'f'.repeat(500) }),
    expected: { fingerprint: 'f'.repeat(200) },
  },
  {
    name: 'does not take a fingerprint inherited through a __proto__ key',
    context: () => JSON.parse('{"__proto__": {"vigilFingerprint": "hijacked"}, "a": 1}') as unknown,
    expected: { context: { a: 1 } },
  },
  {
    name: 'loses only the one context property whose getter throws',
    context: () => {
      const context: Record<string, unknown> = { route: '/pay' }
      Object.defineProperty(context, 'broken', {
        enumerable: true,
        get() {
          throw new Error('no')
        },
      })
      return context
    },
    expected: { context: { route: '/pay', broken: '[unreadable]' } },
  },
  {
    name: 'keeps a context it cannot read as a value rather than dropping the event',
    context: hostileProxy,
    expected: { context: { value: '[unreadable]' } },
  },
  {
    name: 'makes a context with BigInt and a cycle serialisable',
    context: () => {
      const context: Record<string, unknown> = { total: 10n }
      context.self = context
      return context
    },
    expected: { context: { total: '10', self: '[circular]' } },
  },
]

interface SecretCase {
  name: string
  error: () => unknown
  context?: Record<string, unknown>
  /** `[SECRET]` unless a row names its own. */
  secrets?: readonly string[]
  expected: Partial<Record<keyof WireEvent, unknown>>
}

// A secret in a message or a stack is the likeliest way one escapes: `connect ECONNREFUSED` is
// harmless, `Bearer sk_live_…` in a fetch error is not.
const secretCases: SecretCase[] = [
  {
    name: 'scrubs a configured secret out of the message and the stack',
    error: () => new Error(`calling engine with key ${SECRET}`),
    expected: {
      message: 'calling engine with key [redacted]',
      stack: expect.stringContaining('Error: calling engine with key [redacted]'),
    },
  },
  {
    name: 'scrubs a configured secret out of the type',
    error: () => Object.assign(new Error('x'), { name: `Failed${SECRET}` }),
    expected: { type: 'Failed[redacted]' },
  },
  {
    name: 'scrubs a configured secret out of a thrown string',
    error: () => `bad key ${SECRET}`,
    expected: { message: 'bad key [redacted]' },
  },
  {
    name: 'scrubs a configured secret out of a thrown object',
    error: () => ({ url: `https://engine.example/?key=${SECRET}` }),
    expected: { message: '{"url":"[redacted]"}' },
  },
  {
    name: 'scrubs a configured secret out of the context',
    error: () => new Error('x'),
    context: { url: `https://engine.example/?key=${SECRET}` },
    expected: { context: { url: '[redacted]' } },
  },
  {
    name: 'scrubs a configured secret out of the fingerprint',
    error: () => new Error('x'),
    context: { vigilFingerprint: `engine-${SECRET}` },
    expected: { fingerprint: '[redacted]' },
  },
  {
    name: 'scrubs a Bearer credential out of the message and the stack',
    error: () => new Error('engine refused Bearer sk_live_abc123'),
    secrets: [],
    expected: {
      message: 'engine refused Bearer [redacted]',
      stack: expect.stringContaining('Error: engine refused Bearer [redacted]'),
    },
  },
  {
    name: 'scrubs a Basic credential out of the message',
    error: () => new Error('proxy refused Basic dXNlcjpwYXNz'),
    secrets: [],
    expected: { message: 'proxy refused Basic [redacted]' },
  },
  {
    name: 'scrubs a raw header line out of a multi-line message',
    error: () => new Error('upstream failed\ncookie: sid=abc123\nhost: a'),
    secrets: [],
    expected: { message: 'upstream failed\ncookie: [redacted]\nhost: a' },
  },
  {
    // A newline may separate a scheme from its credential, but the next line of a stack is a
    // frame, and a frame whose `at` became `[redacted]` is no longer read as one.
    name: 'leaves the first frame alone after a message that ends in a scheme name',
    error: () => new Error('auth scheme was basic'),
    secrets: [],
    expected: { stack: expect.stringMatching(/^Error: auth scheme was basic\n {4}at /) },
  },
  {
    // Replaced in list order, the shorter secret would cut the longer one and leave its tail.
    name: 'scrubs overlapping configured secrets whole, whichever is listed first',
    error: () => new Error('key=bk_live_9f8e7d6c'),
    secrets: ['bk_live', 'bk_live_9f8e7d6c'],
    expected: { message: 'key=[redacted]' },
  },
]

interface CapCase {
  name: string
  error: () => unknown
  context?: () => Record<string, unknown>
  expected: (event: WireEvent) => void
}

const longHeader = `Error: ${'m'.repeat(40_000)}`

// Caps are enforced by refusing the batch, not by cutting it, so the client has to cut: one
// oversized event would cost every event travelling with it. The cut is deterministic, so a
// retried event fingerprints the same.
const capCases: CapCase[] = [
  {
    name: 'cuts a message to the 4,000 characters the server accepts',
    error: () => new Error('a'.repeat(10_000)),
    expected: (event) => expect(event.message).toBe('a'.repeat(4_000)),
  },
  {
    name: 'never cuts a message between the two halves of a surrogate pair',
    error: () => new Error(`${'a'.repeat(3_999)}😀b`),
    expected: (event) => expect(event.message).toBe('a'.repeat(3_999)),
  },
  {
    name: 'cuts a type to the 200 characters the server accepts',
    error: () => Object.assign(new Error('x'), { name: 'T'.repeat(500) }),
    expected: (event) => expect(event.type).toBe('T'.repeat(200)),
  },
  {
    name: 'leaves a stack at exactly the cap alone',
    error: () => {
      const head = `Error: boom\n${frames(1)}\n`
      return withStack(head + 'x'.repeat(16_384 - bytes(head)))
    },
    expected: (event) => expect(bytes(event.stack ?? '')).toBe(16_384),
  },
  {
    name: 'cuts a stack of many frames, keeping the header and the top frames',
    error: () => withStack(`Error: boom\n${frames(1_000)}`),
    expected: (event) => {
      const lines = (event.stack ?? '').split('\n')
      expect(lines[0]).toBe('Error: boom')
      expect(lines[1]).toBe('    at f0 (/srv/app/src/f0.js:1:1)')
      expect(lines.at(-1)).toBe(MARKER)
    },
  },
  {
    // Grouping and the culprit are read from the frames. Cutting them for a long message would
    // file one throw site under several issues, depending on how long its message ran.
    name: 'keeps every frame when it is the message that makes the stack too long',
    error: () => withStack(`${longHeader}\n${frames(10)}`),
    expected: (event) => {
      expect(event.stack).toContain(frames(10))
      expect(event.stack?.startsWith('Error: mmm')).toBe(true)
    },
  },
  {
    name: 'cuts a stack with no frames at all',
    error: () => withStack(longHeader),
    expected: (event) => expect(event.stack?.endsWith(MARKER)).toBe(true),
  },
  {
    name: 'cuts a stack by its UTF-8 bytes, not its length, and never inside a character',
    error: () => withStack(`Error: ${'ж'.repeat(10_000)}\n${frames(3)}`),
    expected: (event) => {
      expect(event.stack).not.toContain('\uFFFD')
      expect(event.stack).toContain(frames(3))
    },
  },
  {
    name: 'counts a NUL at the three bytes the server will store it as',
    error: () => withStack(`Error: boom\n${frames(1)}\n${'\0'.repeat(16_000)}`),
    expected: (event) => expect(event.stack).not.toContain('\0'),
  },
  {
    name: 'leaves a context at exactly the cap alone',
    error: () => new Error('x'),
    // `{"a":"…","b":"…"}` is fifteen bytes of punctuation around the padding. Two strings,
    // since the redactor cuts any one string at 4,096 characters before the context is sized.
    context: () => ({ a: 'x'.repeat(4_096), b: 'x'.repeat(8_192 - 15 - 4_096) }),
    expected: (event) =>
      expect(event.context).toEqual({ a: 'x'.repeat(4_096), b: 'x'.repeat(4_081) }),
  },
  {
    name: 'keeps the small context entries and marks the one too large to send',
    error: () => new Error('x'),
    context: () => ({
      route: '/pay',
      body: { p1: 'x'.repeat(4_000), p2: 'x'.repeat(4_000), p3: 'x'.repeat(4_000) },
      user: 'u1',
    }),
    expected: (event) =>
      expect(event.context).toEqual({
        route: '/pay',
        body: '[too large]',
        user: 'u1',
        '[truncated]': true,
      }),
  },
  {
    name: 'keeps as many entries as fit when many small ones add up past the cap',
    error: () => new Error('x'),
    context: () =>
      Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, 'v'.repeat(100)])),
    expected: (event) => {
      expect(event.context?.k0).toBe('v'.repeat(100))
      expect(event.context?.['[truncated]']).toBe(true)
    },
  },
]

const everyInput: Array<{ name: string; error: () => unknown; context?: () => unknown }> = [
  ...describeCases,
  ...contextCases.map((row) => ({ ...row, error: () => new Error('x') })),
  ...secretCases.map((row) => ({ ...row, context: () => row.context })),
  ...capCases,
]

/** The fields `expected` names, so `stack: undefined` means absent rather than present-and-undefined. */
function pick(event: WireEvent, expected: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.keys(expected).map((key) => [key, event[key as keyof WireEvent]]),
  )
}

describe('toWireEvent', () => {
  it.each(describeCases)('$name', ({ error, expected }) => {
    const event = toWireEvent(error(), undefined, [])
    expect(pick(event, expected)).toEqual(expected)
  })

  it.each(contextCases)('$name', ({ context, expected }) => {
    const event = toWireEvent(new Error('x'), context() as Record<string, unknown>, [])
    expect(event.context).toEqual(expected.context)
    expect(event.fingerprint).toBe(expected.fingerprint)
  })

  it.each(secretCases)('$name', ({ error, context, secrets = [SECRET], expected }) => {
    const event = toWireEvent(error(), context, secrets)
    expect(event).toMatchObject(expected)
    for (const secret of secrets) expect(JSON.stringify(event)).not.toContain(secret)
  })

  it.each(capCases)('$name', ({ error, context, expected }) => {
    expected(toWireEvent(error(), context?.(), []))
  })

  // Whatever it is handed, what comes out is an event the server accepts: never an exception in
  // the host's error path, and never a payload that costs the rest of its batch a 400 or a 413.
  it.each(everyInput)('$name: produces an event the server accepts', ({ error, context }) => {
    const event = toWireEvent(error(), context?.() as Record<string, unknown> | undefined, [SECRET])
    expect(wireProblems(event)).toEqual([])
    expect(() => JSON.stringify(event)).not.toThrow()
  })

  it('stamps the moment it was built', () => {
    const before = Date.now()
    const at = Date.parse(toWireEvent(new Error('x'), undefined, []).occurred_at)
    expect(at).toBeGreaterThanOrEqual(before)
    expect(at).toBeLessThanOrEqual(Date.now())
  })

  it('survives secrets that are not a list of strings', () => {
    const secrets = [42, null, SECRET] as unknown as string[]
    expect(toWireEvent(new Error(SECRET), undefined, secrets).message).toBe('[redacted]')
    expect(() =>
      toWireEvent(new Error('x'), undefined, 'nope' as unknown as string[]),
    ).not.toThrow()
  })
})

interface CollapseCase {
  name: string
  a: Partial<WireEvent>
  b: Partial<WireEvent>
  same: boolean
}

const collapseCases: CollapseCase[] = [
  {
    name: 'is the same for two throws of the same error at the same place',
    a: { stack: 'Error: boom\n    at f (/a.js:1:1)' },
    b: { stack: 'Error: boom\n    at f (/a.js:1:1)' },
    same: true,
  },
  {
    name: 'differs when the message differs',
    a: { message: 'one' },
    b: { message: 'two' },
    same: false,
  },
  {
    name: 'differs when the type differs',
    a: { type: 'TypeError' },
    b: { type: 'RangeError' },
    same: false,
  },
  {
    name: 'differs when the throw site differs',
    a: { stack: 'Error: boom\n    at f (/a.js:1:1)' },
    b: { stack: 'Error: boom\n    at g (/b.js:1:1)' },
    same: false,
  },
  {
    name: 'ignores frames below the throw site',
    a: { stack: 'Error: boom\n    at f (/a.js:1:1)\n    at g (/b.js:1:1)' },
    b: { stack: 'Error: boom\n    at f (/a.js:1:1)\n    at h (/c.js:1:1)' },
    same: true,
  },
  {
    name: 'ignores the timestamp, which is what makes collapsing possible',
    a: { occurred_at: '2026-09-07T10:00:00.000Z' },
    b: { occurred_at: '2026-09-07T11:00:00.000Z' },
    same: true,
  },
  {
    name: 'never collapses two explicitly fingerprinted events into one another',
    a: { fingerprint: 'a' },
    b: { fingerprint: 'b' },
    same: false,
  },
  {
    name: 'collapses two events with the same explicit fingerprint whatever else differs',
    a: { fingerprint: 'a', message: 'one' },
    b: { fingerprint: 'a', message: 'two' },
    same: true,
  },
]

describe('collapseKey', () => {
  const event = (over: Partial<WireEvent>): WireEvent => ({
    ...toWireEvent(new Error('boom'), undefined, []),
    ...over,
  })

  it.each(collapseCases)('$name', ({ a, b, same }) => {
    const keys = [collapseKey(event(a)), collapseKey(event(b))]
    if (same) expect(keys[0]).toBe(keys[1])
    else expect(keys[0]).not.toBe(keys[1])
  })

  it('works with no stack at all', () => {
    const { stack: _stack, ...stackless } = toWireEvent(new Error('boom'), undefined, [])
    expect(() => collapseKey(stackless)).not.toThrow()
  })
})
