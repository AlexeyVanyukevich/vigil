import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { send, type Batch } from '../src/transport.js'
import { toWireEvent, type WireEvent } from '../src/payload.js'
import { EventQueue } from '../src/queue.js'

const batch = {
  environment: 'production' as const,
  runtime: 'node' as const,
  events: [toWireEvent(new Error('boom'), undefined, [])],
}

const options = (fetchImpl: typeof globalThis.fetch) => ({
  url: 'https://vigil.example',
  key: 'vgl_abc',
  timeoutMs: 1_000,
  fetch: fetchImpl,
})

/** `count` events, each a different failure, so a queue would not collapse them. */
const distinct = (count: number): WireEvent[] =>
  Array.from({ length: count }, (_, i) => toWireEvent(new Error(`failure ${i}`), undefined, []))

const accepting = () => vi.fn(async () => new Response(null, { status: 202 }))

/** The parsed body of each call a stubbed fetch received. */
const bodies = (fetchImpl: ReturnType<typeof vi.fn>): Batch[] =>
  fetchImpl.mock.calls.map((call) => JSON.parse((call[1] as RequestInit).body as string) as Batch)

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('send', () => {
  it('posts the batch to the ingest endpoint with the key as a bearer token', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 202 }))
    expect(await send(options(fetchImpl as unknown as typeof fetch), batch)).toBe(true)

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://vigil.example/ingest/events')
    expect(init.method).toBe('POST')
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer vgl_abc')
    expect(new Headers(init.headers).get('content-type')).toBe('application/json')
    expect(JSON.parse(init.body as string)).toEqual(batch)
  })

  it('tolerates a base url with a trailing slash', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 202 }))
    await send(
      { ...options(fetchImpl as unknown as typeof fetch), url: 'https://vigil.example/' },
      batch,
    )
    expect((fetchImpl.mock.calls[0] as unknown[])[0]).toBe('https://vigil.example/ingest/events')
  })

  it('reports success for any 2xx', async () => {
    const accepted = vi.fn(async () => new Response(null, { status: 202 }))
    const ok = vi.fn(async () => new Response('{}', { status: 200 }))
    for (const impl of [accepted, ok]) {
      expect(await send(options(impl as unknown as typeof fetch), batch)).toBe(true)
    }
  })

  // A hung vigil must not hold a request — or a dying process — open indefinitely.
  it('gives up after the timeout', async () => {
    const hanging = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    )
    const started = Date.now()
    const result = await send(
      { ...options(hanging as unknown as typeof fetch), timeoutMs: 50 },
      batch,
    )
    expect(result).toBe(false)
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('sends nothing when the batch is empty', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 202 }))
    expect(
      await send(options(fetchImpl as unknown as typeof fetch), { ...batch, events: [] }),
    ).toBe(true)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

/**
 * Rule one of §8. Every row is a real thing vigil, the network or an injected fetch will do to a
 * client one day, and none of them may surface inside somebody else's error handler. A real
 * server produces most of these below; these are the ones only a stub can.
 */
const failures: Array<{ name: string; fetch: () => unknown }> = [
  {
    name: 'a refused connection',
    fetch: async () => {
      throw new TypeError('fetch failed')
    },
  },
  { name: 'a 401', fetch: async () => new Response('nope', { status: 401 }) },
  { name: 'a 500', fetch: async () => new Response('boom', { status: 500 }) },
  { name: 'a 413', fetch: async () => new Response('too big', { status: 413 }) },
  { name: 'a 400', fetch: async () => new Response('bad', { status: 400 }) },
  { name: 'a 3xx that was not followed', fetch: async () => new Response(null, { status: 304 }) },
  {
    name: 'a fetch that throws before returning a promise',
    fetch: () => {
      throw new TypeError('Failed to parse URL')
    },
  },
  {
    name: 'a fetch that rejects with nothing',
    fetch: () => Promise.reject(undefined),
  },
  { name: 'a fetch that returns undefined', fetch: () => undefined },
  { name: 'a fetch that resolves to null', fetch: async () => null },
  { name: 'a fetch that resolves to a string', fetch: async () => 'ok' },
  { name: 'an object that only says ok', fetch: async () => ({ ok: true }) },
  { name: 'a status that is a string', fetch: async () => ({ status: '202' }) },
  { name: 'a status that is not an integer', fetch: async () => ({ status: 202.5 }) },
  {
    name: 'a status getter that throws',
    fetch: async () => ({
      get status(): number {
        throw new Error('hostile')
      },
    }),
  },
  {
    name: 'a response that throws on every read',
    fetch: async () =>
      new Proxy(
        {},
        {
          get() {
            throw new Error('hostile')
          },
          getPrototypeOf() {
            throw new Error('hostile')
          },
        },
      ),
  },
  {
    name: 'a thenable whose then throws',
    fetch: () => ({
      then() {
        throw new Error('hostile')
      },
    }),
  },
]

describe('send never rejects', () => {
  it.each(failures)('resolves false for $name', async ({ fetch: impl }) => {
    const fetchImpl = vi.fn(impl)
    await expect(send(options(fetchImpl as unknown as typeof fetch), batch)).resolves.toBe(false)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  // A body that cannot be serialised is still the host's data, in the host's error path.
  const unserialisable: Array<{ name: string; context: () => Record<string, unknown> }> = [
    { name: 'a BigInt', context: () => ({ total: 10n }) },
    {
      name: 'a cycle',
      context: () => {
        const self: Record<string, unknown> = {}
        self.self = self
        return self
      },
    },
    {
      name: 'a toJSON that throws',
      context: () => ({
        value: {
          toJSON() {
            throw new Error('hostile')
          },
        },
      }),
    },
  ]

  it.each(unserialisable)('resolves false, posting nothing, for $name', async ({ context }) => {
    const fetchImpl = accepting()
    const event: WireEvent = { ...batch.events[0]!, context: context() }
    await expect(
      send(options(fetchImpl as unknown as typeof fetch), { ...batch, events: [event] }),
    ).resolves.toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('resolves false when the options themselves are hostile', async () => {
    const hostile = {
      get url(): string {
        throw new Error('hostile')
      },
      key: 'vgl_abc',
      timeoutMs: 1_000,
    }
    await expect(send(hostile, batch)).resolves.toBe(false)
  })

  it('still sends when AbortController does not exist', async () => {
    vi.stubGlobal('AbortController', undefined)
    const fetchImpl = accepting()
    await expect(send(options(fetchImpl as unknown as typeof fetch), batch)).resolves.toBe(true)
  })

  // Not every fetch honours a signal. The timeout is a race, so one that ignores it is still
  // abandoned on time.
  it.each([
    { name: 'a fetch that ignores the abort signal', noAbortController: false },
    { name: 'no AbortController at all', noAbortController: true },
  ])('gives up on time with $name', async ({ noAbortController }) => {
    vi.useFakeTimers()
    if (noAbortController) vi.stubGlobal('AbortController', undefined)
    const deaf = vi.fn(() => new Promise<Response>(() => {}))

    let settled: boolean | undefined
    void send({ ...options(deaf as unknown as typeof fetch), timeoutMs: 3_000 }, batch).then(
      (result) => {
        settled = result
      },
    )

    await vi.advanceTimersByTimeAsync(2_999)
    expect(settled).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(false)
  })

  it('aborts the request it gave up on', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    const hanging = vi.fn((_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return new Promise<Response>(() => {})
    })
    const result = send({ ...options(hanging as unknown as typeof fetch), timeoutMs: 100 }, batch)
    await vi.advanceTimersByTimeAsync(100)
    expect(await result).toBe(false)
    expect(signal?.aborted).toBe(true)
  })

  // A rejection nobody handles is fatal under Node's default `--unhandled-rejections=throw`: the
  // fetch that loses the race to the timeout must still have somebody listening.
  it('leaves no unhandled rejection behind when the abandoned fetch fails later', async () => {
    vi.useFakeTimers()
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const late = vi.fn(
        () =>
          new Promise<Response>((_resolve, reject) => {
            setTimeout(() => reject(new Error('late')), 500)
          }),
      )
      const result = send({ ...options(late as unknown as typeof fetch), timeoutMs: 100 }, batch)
      await vi.advanceTimersByTimeAsync(100)
      expect(await result).toBe(false)
      await vi.advanceTimersByTimeAsync(1_000)
      vi.useRealTimers()
      await new Promise((resolve) => setImmediate(resolve))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  // A pending timer keeps an otherwise idle process alive for its whole duration.
  it.each([
    { name: 'on success', impl: async () => new Response(null, { status: 202 }) },
    { name: 'on failure', impl: async () => new Response(null, { status: 500 }) },
  ])('leaves no timer running $name', async ({ impl }) => {
    vi.useFakeTimers()
    await send({ ...options(vi.fn(impl) as unknown as typeof fetch), timeoutMs: 60_000 }, batch)
    expect(vi.getTimerCount()).toBe(0)
  })

  // Node prints a warning on the host's stderr for each of these, every time a timer is set.
  it.each([Number.NaN, -1, 0, Number.POSITIVE_INFINITY, 2 ** 40])(
    'sets no timer Node would warn about for a timeout of %s',
    async (timeoutMs) => {
      const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})
      await send({ ...options(accepting() as unknown as typeof fetch), timeoutMs }, batch)
      expect(warn).not.toHaveBeenCalled()
    },
  )
})

describe('send respects what the server will accept', () => {
  // The server refuses a batch of more than 100 events outright, and every event in it with it.
  const splits: Array<{ events: number; posts: number[] }> = [
    { events: 1, posts: [1] },
    { events: 99, posts: [99] },
    { events: 100, posts: [100] },
    { events: 101, posts: [100, 1] },
    { events: 250, posts: [100, 100, 50] },
  ]

  it.each(splits)('posts $events events as batches of $posts', async ({ events, posts }) => {
    const fetchImpl = accepting()
    const all = distinct(events)
    expect(
      await send(options(fetchImpl as unknown as typeof fetch), { ...batch, events: all }),
    ).toBe(true)

    const sent = bodies(fetchImpl)
    expect(sent.map((body) => body.events.length)).toEqual(posts)
    // In order, each once, and every batch a whole envelope of its own.
    expect(sent.flatMap((body) => body.events.map((e) => e.message))).toEqual(
      all.map((e) => e.message),
    )
    for (const body of sent)
      expect(Object.keys(body).sort()).toEqual(['environment', 'events', 'runtime'])
  })

  // Each batch is judged by the server on its own, so one that fails must not take the others
  // down with it — however it fails.
  const firstFails: Array<{ name: string; first: () => unknown }> = [
    { name: 'is refused', first: async () => new Response(null, { status: 400 }) },
    {
      name: 'fails at the network',
      first: async () => {
        throw new TypeError('fetch failed')
      },
    },
    { name: 'gets no response at all', first: async () => undefined },
    {
      name: 'gets a response whose status throws',
      first: async () => ({
        get status(): number {
          throw new Error('hostile')
        },
      }),
    },
  ]

  it.each(firstFails)(
    'still posts the other batches when the first $name, and reports false',
    async ({ first }) => {
      let call = 0
      const fetchImpl = vi.fn(() => {
        call += 1
        return call === 1 ? first() : Promise.resolve(new Response(null, { status: 202 }))
      })
      expect(
        await send(options(fetchImpl as unknown as typeof fetch), {
          ...batch,
          events: distinct(250),
        }),
      ).toBe(false)
      expect(fetchImpl).toHaveBeenCalledTimes(3)
    },
  )

  it('bounds the whole send by one timeout, however many batches it takes', async () => {
    vi.useFakeTimers()
    const deaf = vi.fn(() => new Promise<Response>(() => {}))
    let settled: boolean | undefined
    void send(
      { ...options(deaf as unknown as typeof fetch), timeoutMs: 1_000 },
      { ...batch, events: distinct(250) },
    ).then((result) => {
      settled = result
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(settled).toBe(false)
    expect(deaf).toHaveBeenCalledTimes(1)
  })

  // Slow but never hung, three requests of 600 ms each: a clock per request would let the send
  // run 1,800 ms on a 1,000 ms timeout, and a dying process wait that long.
  it('gives up at the timeout even when no single request is over it', async () => {
    vi.useFakeTimers()
    const slow = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          setTimeout(() => resolve(new Response(null, { status: 202 })), 600)
        }),
    )
    let settled: boolean | undefined
    void send(
      { ...options(slow as unknown as typeof fetch), timeoutMs: 1_000 },
      { ...batch, events: distinct(250) },
    ).then((result) => {
      settled = result
    })
    await vi.advanceTimersByTimeAsync(999)
    expect(settled).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(false)
    expect(slow).toHaveBeenCalledTimes(2)
  })

  // The server's schema is `additionalProperties: false` at both levels: one stray field loses
  // the batch. TypeScript lets an object with extra fields through a variable, so the transport
  // sends only what the schema names.
  it('sends only the fields the schema names, at either level', async () => {
    const fetchImpl = accepting()
    const stray = {
      ...batch,
      app: 'checkout',
      events: [{ ...batch.events[0]!, level: 'error', count: 3 } as WireEvent],
    }
    expect(await send(options(fetchImpl as unknown as typeof fetch), stray)).toBe(true)

    const [sent] = bodies(fetchImpl)
    expect(Object.keys(sent!).sort()).toEqual(['environment', 'events', 'runtime'])
    expect(Object.keys(sent!.events[0]!).sort()).toEqual([
      'count',
      'message',
      'occurred_at',
      'stack',
      'type',
    ])
  })
})

/**
 * What the ingest route refuses, restated from `server/src/modules/ingest/ingest.schemas.ts` at
 * the server's defaults — restated, not imported: this package imports nothing from `server/`.
 * The route answers 400 for any of these, and loses the whole batch.
 */
function refusal(raw: string): string | undefined {
  if (/"__proto__"\s*:/.test(raw)) return '__proto__'
  const body = JSON.parse(raw) as Record<string, unknown>
  const keys = Object.keys(body).sort().join(',')
  if (keys !== 'environment,events,runtime') return `top-level keys ${keys}`
  if (body.runtime !== 'node') return 'runtime'
  const events = body.events as Array<Record<string, unknown>>
  if (!Array.isArray(events) || events.length < 1 || events.length > 100) return 'events length'
  const fields = ['type', 'message', 'stack', 'occurred_at', 'context', 'count', 'fingerprint']
  for (const event of events) {
    for (const key of Object.keys(event)) if (!fields.includes(key)) return `event field ${key}`
    const count = event.count
    if (count !== undefined && (!Number.isInteger(count) || (count as number) < 1)) return 'count'
    if (typeof count === 'number' && count > 1_000_000) return 'count over the cap'
  }
  return undefined
}

describe('send against a real HTTP server', () => {
  interface Received {
    method: string | undefined
    url: string | undefined
    authorization: string | undefined
    contentType: string | undefined
    body: Batch
  }

  let server: Server
  let base: string
  let received: Received[] = []
  let aborted = 0
  let respond: (req: IncomingMessage, res: ServerResponse, raw: string) => void

  /** Answers like the ingest route: 202 when it would store the batch, 400 when it would not. */
  const strict = (_req: IncomingMessage, res: ServerResponse, raw: string) => {
    const reason = refusal(raw)
    res.writeHead(reason === undefined ? 202 : 400, { 'content-type': 'application/json' })
    res.end(JSON.stringify(reason === undefined ? { accepted: 1 } : { error: reason }))
  }

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = ''
      req.setEncoding('utf8')
      req.on('data', (chunk: string) => (raw += chunk))
      req.on('end', () => {
        received.push({
          method: req.method,
          url: req.url,
          authorization: req.headers.authorization,
          contentType: req.headers['content-type'],
          body: parsed(raw),
        })
        respond(req, res, raw)
      })
      // `close` on the response before it finished means the client walked away.
      res.on('close', () => {
        if (!res.writableFinished) aborted += 1
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(() => {
    received = []
    aborted = 0
    respond = strict
  })

  afterAll(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  /** A handler that throws here would take the test process down, not fail a test. */
  const parsed = (raw: string): Batch => {
    try {
      return JSON.parse(raw) as Batch
    } catch {
      return { environment: '[not json]', runtime: 'node', events: [] }
    }
  }

  const real = (timeoutMs = 2_000) => ({ url: base, key: 'vgl_real', timeoutMs })

  it('delivers the batch, as the server reads it off the wire', async () => {
    respond = strict
    expect(await send(real(), batch)).toBe(true)
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      method: 'POST',
      url: '/ingest/events',
      authorization: 'Bearer vgl_real',
      contentType: 'application/json',
      body: batch,
    })
  })

  const statuses: Array<{ status: number; expected: boolean }> = [
    { status: 200, expected: true },
    { status: 202, expected: true },
    { status: 204, expected: true },
    { status: 400, expected: false },
    { status: 401, expected: false },
    { status: 413, expected: false },
    { status: 500, expected: false },
    { status: 503, expected: false },
  ]

  it.each(statuses)('reads a $status as $expected', async ({ status, expected }) => {
    respond = (_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(status === 204 ? undefined : '{"error":"x"}')
    }
    await expect(send(real(), batch)).resolves.toBe(expected)
  })

  it('gives up on a server that never answers, and closes the request', async () => {
    respond = () => {}
    const started = Date.now()
    await expect(send(real(200), batch)).resolves.toBe(false)
    expect(Date.now() - started).toBeLessThan(1_500)
    // The server sees the connection go: the request is not left open behind the timeout.
    await vi.waitFor(() => expect(aborted).toBe(1))
  })

  const cutOff: Array<{ name: string; respond: (res: ServerResponse) => void; expected: boolean }> =
    [
      { name: 'before any response', respond: (res) => res.socket?.destroy(), expected: false },
      {
        name: 'halfway through the status line',
        respond: (res) => {
          res.socket?.write('HTTP/1.1 20')
          res.socket?.destroy()
        },
        expected: false,
      },
      {
        name: 'halfway through the headers',
        respond: (res) => {
          res.socket?.write('HTTP/1.1 202 Accepted\r\ncontent-length: 40\r\n')
          res.socket?.destroy()
        },
        expected: false,
      },
      // The route answers only once the batch is stored; the status is the answer, the body is
      // decoration, and a body cut short leaves no rejection for anyone to have to catch.
      {
        name: 'halfway through the body of a 202',
        respond: (res) => {
          res.socket?.write('HTTP/1.1 202 Accepted\r\ncontent-length: 40\r\n\r\n{"acc')
          res.socket?.destroy()
        },
        expected: true,
      },
    ]

  it.each(cutOff)('reads a connection closed $name as $expected', async (row) => {
    respond = (_req, res) => row.respond(res)
    await expect(send(real(), batch)).resolves.toBe(row.expected)
  })

  it('resolves false when nothing is listening', async () => {
    const closed = createServer()
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve))
    const { port } = closed.address() as AddressInfo
    await new Promise<void>((resolve) => closed.close(() => resolve()))

    await expect(
      send({ url: `http://127.0.0.1:${port}`, key: 'vgl_real', timeoutMs: 2_000 }, batch),
    ).resolves.toBe(false)
  })

  // The whole path §8 describes: a burst that would overflow one batch, and a hot loop that would
  // overflow a count, drained from the queue and sent to a server that refuses either.
  it('gets an overflowing queue past a server that refuses what the schema does', async () => {
    respond = strict
    const queue = new EventQueue(500)
    for (const event of distinct(250)) queue.add(event)
    const hot = toWireEvent(new Error('hot loop'), undefined, [])
    queue.add({ ...hot, count: 999_000 })
    for (let i = 0; i < 5_000; i += 1) queue.add(hot)

    const events = queue.drain()
    expect(events).toHaveLength(251)
    expect(await send(real(), { environment: 'production', runtime: 'node', events })).toBe(true)

    expect(received.map((r) => r.body.events.length)).toEqual([100, 100, 51])
    const last = received[2]!.body.events.at(-1)!
    expect([last.message, last.count]).toEqual(['hot loop', 1_000_000])
  })

  it('shows the strict server refusing what the transport is keeping from it', async () => {
    respond = strict
    const tooMany = JSON.stringify({ environment: 'p', runtime: 'node', events: distinct(101) })
    const stray = JSON.stringify({ ...batch, app: 'x' })
    const overCount = JSON.stringify({
      ...batch,
      events: [{ ...batch.events[0], count: 1_000_001 }],
    })
    for (const body of [tooMany, stray, overCount]) {
      const response = await fetch(`${base}/ingest/events`, { method: 'POST', body })
      expect(response.status).toBe(400)
    }
  })
})
