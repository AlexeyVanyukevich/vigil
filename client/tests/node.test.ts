import { afterEach, describe, expect, it, vi } from 'vitest'
import { install, type Vigil, type VigilOptions } from '../src/node.js'

let installed: Vigil | undefined

afterEach(async () => {
  await installed?.close()
  installed = undefined
  vi.restoreAllMocks()
})

interface Sent {
  environment: string
  runtime: string
  events: Array<{
    type: string
    message: string
    count?: number
    context?: Record<string, unknown>
  }>
}

const BASE: VigilOptions = {
  url: 'https://vigil.example',
  key: 'vgl_abc',
  app: 'reference',
  environment: 'production',
  // Long enough that nothing flushes on its own; every test calls flush() when it means to.
  flushIntervalMs: 1_000_000,
  exitOnUncaught: false,
}

/** `undefined` included, so a case can unset one of `BASE`'s values and get the default. */
type Overrides = { [K in keyof VigilOptions]?: VigilOptions[K] | undefined }

function setup(overrides: Overrides = {}) {
  const batches: Sent[] = []
  const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
    batches.push(JSON.parse(init?.body as string) as Sent)
    return new Response(null, { status: 202 })
  })

  installed = install({
    ...BASE,
    fetch: fetchImpl as unknown as typeof fetch,
    ...overrides,
  } as VigilOptions)

  return { vigil: installed, batches, fetchImpl }
}

type Hook = 'uncaughtException' | 'unhandledRejection'
type Listener = (...args: unknown[]) => unknown

const listeners = (event: Hook) => process.listeners(event).length

/** vigil's listener: the last one added. */
const hook = (event: Hook) => process.listeners(event).at(-1) as Listener

/**
 * Every listener on `process`, by event. A vitest worker carries its own, so comparing the whole
 * picture is what shows `close` put back exactly what it found.
 */
const snapshot = () =>
  process.eventNames().map((name) => [name, [...process.listeners(name as Hook)]] as const)

/**
 * A vitest worker has an `uncaughtException` and an `unhandledRejection` listener of its own, and
 * vigil defers to any listener it finds — Node would not have exited with one present. These cases
 * need vigil to be alone, as it is in an application that has no handler.
 */
function aloneOnProcess(): void {
  const saved = (['uncaughtException', 'unhandledRejection'] as const).map(
    (event) => [event, process.listeners(event)] as const,
  )
  for (const [event] of saved) process.removeAllListeners(event)
  restoreListeners = () => {
    for (const [event, list] of saved) for (const listener of list) process.on(event, listener)
  }
}
let restoreListeners: (() => void) | undefined

/** Silences vigil's printing of a fatal error and records it, as Node's own stderr would. */
function captureStderr(order: string[] = []) {
  const written: string[] = []
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
    written.push(String(chunk))
    order.push('print')
    const done = rest.find((arg): arg is () => void => typeof arg === 'function')
    done?.()
    return true
  }) as typeof process.stderr.write)
  return written
}

function mockExit(order: string[] = []) {
  return vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    order.push(`exit ${code}`)
  }) as never)
}

describe('captureError', () => {
  it('sends what was captured, with the environment and runtime', async () => {
    const { vigil, batches } = setup()
    vigil.captureError(new TypeError('boom'))
    await vigil.flush()

    expect(batches).toHaveLength(1)
    expect(batches[0]).toMatchObject({ environment: 'production', runtime: 'node' })
    expect(batches[0]!.events[0]).toMatchObject({ type: 'TypeError', message: 'boom' })
  })

  it('sends one batch for everything queued, not one request each', async () => {
    const { vigil, batches, fetchImpl } = setup()
    vigil.captureError(new Error('one'))
    vigil.captureError(new Error('two'))
    await vigil.flush()

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(batches[0]!.events).toHaveLength(2)
  })

  it('collapses a hot loop into one counted event', async () => {
    const { vigil, batches } = setup()
    for (let i = 0; i < 50_000; i += 1) vigil.captureError(new Error('boom'))
    await vigil.flush()

    expect(batches[0]!.events).toHaveLength(1)
    expect(batches[0]!.events[0]!.count).toBe(50_000)
  })

  it('scrubs the context before it leaves the process', async () => {
    const { vigil, batches } = setup({ secrets: ['bk_live_secret'] })
    vigil.captureError(new Error('failed calling engine'), {
      headers: { authorization: 'Bearer bk_live_secret' },
      url: 'https://engine.example/?key=bk_live_secret',
    })
    await vigil.flush()

    expect(JSON.stringify(batches[0])).not.toContain('bk_live_secret')
  })

  it('never sends the application name — the key decides which app this is', async () => {
    const { vigil, batches } = setup()
    vigil.captureError(new Error('boom'))
    await vigil.flush()
    expect(JSON.stringify(batches[0])).not.toContain('"app"')
    expect(JSON.stringify(batches[0])).not.toContain('reference')
  })

  it('sends nothing when there is nothing queued', async () => {
    const { vigil, fetchImpl } = setup()
    await vigil.flush()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  // Rule one of §8. If any of these throws, the monitor has broken the thing it watches.
  it('never throws into the host, whatever it is handed', async () => {
    const { vigil } = setup()
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic

    expect(() => vigil.captureError(new Error('fine'))).not.toThrow()
    expect(() => vigil.captureError('a string')).not.toThrow()
    expect(() => vigil.captureError(undefined)).not.toThrow()
    expect(() => vigil.captureError(new Error('x'), cyclic)).not.toThrow()
    expect(() =>
      vigil.captureError({
        toString() {
          throw new Error('nope')
        },
      }),
    ).not.toThrow()
  })

  it('never throws when the transport fails', async () => {
    const failing = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    const { vigil } = setup({ fetch: failing as unknown as typeof fetch })
    vigil.captureError(new Error('boom'))
    await expect(vigil.flush()).resolves.toBeUndefined()
  })

  // A vigil outage must never grow the host's heap.
  it('is bounded, and keeps the newest', async () => {
    const { vigil, batches } = setup({ maxQueue: 3 })
    for (let i = 0; i < 100; i += 1) vigil.captureError(new Error(`failure ${i}`))
    await vigil.flush()

    expect(batches[0]!.events).toHaveLength(3)
    expect(batches[0]!.events.map((e) => e.message)).toEqual([
      'failure 97',
      'failure 98',
      'failure 99',
    ])
  })

  it('logs once when it drops, and does not repeat it every event', async () => {
    const log = vi.fn()
    const { vigil } = setup({ maxQueue: 2, log })
    for (let i = 0; i < 50; i += 1) vigil.captureError(new Error(`failure ${i}`))
    expect(log.mock.calls.filter(([m]) => String(m).includes('dropped')).length).toBe(1)
  })

  it('logs dropping again only after a batch has been delivered in between', async () => {
    const log = vi.fn()
    const { vigil } = setup({ maxQueue: 2, log })
    const drops = () => log.mock.calls.filter(([m]) => String(m).includes('dropped')).length

    for (let i = 0; i < 5; i += 1) vigil.captureError(new Error(`first burst ${i}`))
    await vigil.flush()
    for (let i = 0; i < 5; i += 1) vigil.captureError(new Error(`second burst ${i}`))

    expect(drops()).toBe(2)
  })

  it('logs a transport failure once, not once per attempt', async () => {
    const log = vi.fn()
    const failing = vi.fn(async () => new Response('nope', { status: 500 }))
    const { vigil } = setup({ log, fetch: failing as unknown as typeof fetch })

    vigil.captureError(new Error('one'))
    await vigil.flush()
    vigil.captureError(new Error('two'))
    await vigil.flush()

    expect(log.mock.calls.filter(([m]) => String(m).includes('could not report')).length).toBe(1)
  })

  // `send` answers false when only some chunks of a large drain were accepted, so the line must
  // not claim that every event in the batch was lost.
  it('words a transport failure as not fully accepted, not as everything lost', async () => {
    const log = vi.fn()
    const failing = vi.fn(async () => new Response('nope', { status: 500 }))
    const { vigil } = setup({ log, fetch: failing as unknown as typeof fetch })

    vigil.captureError(new Error('one'))
    await vigil.flush()

    const line = String(log.mock.calls.find(([m]) => String(m).includes('could not report'))?.[0])
    expect(line).toContain('not fully accepted')
    expect(line).not.toMatch(/could not report 1 events?/)
  })

  it('logs a new outage once, after vigil recovered from the last one', async () => {
    const log = vi.fn()
    let status = 500
    const flaky = vi.fn(async () => new Response(null, { status }))
    const { vigil } = setup({ log, fetch: flaky as unknown as typeof fetch })
    const failures = () =>
      log.mock.calls.filter(([m]) => String(m).includes('could not report')).length

    for (const next of [500, 500, 202, 500, 500]) {
      status = next
      vigil.captureError(new Error(`at ${next}`))
      await vigil.flush()
    }

    expect(failures()).toBe(2)
  })

  it('names the application in its own log lines, as the local label', async () => {
    const log = vi.fn()
    const failing = vi.fn(async () => new Response(null, { status: 500 }))
    const { vigil } = setup({ log, fetch: failing as unknown as typeof fetch })
    vigil.captureError(new Error('one'))
    await vigil.flush()
    expect(String(log.mock.calls[0]?.[0])).toContain('reference')
  })

  it('never throws when its own log throws', async () => {
    const log = vi.fn(() => {
      throw new Error('the log is broken too')
    })
    const failing = vi.fn(async () => new Response(null, { status: 500 }))
    const { vigil } = setup({ maxQueue: 1, log, fetch: failing as unknown as typeof fetch })

    expect(() => {
      vigil.captureError(new Error('one'))
      vigil.captureError(new Error('two'))
    }).not.toThrow()
    await expect(vigil.flush()).resolves.toBeUndefined()
    expect(log).toHaveBeenCalled()
  })

  it('sends a flush called during another one as a second request, after the first', async () => {
    const order: string[] = []
    let release: () => void = () => {}
    const slow = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as Sent
      order.push(`start ${body.events[0]!.message}`)
      if (body.events[0]!.message === 'first') await new Promise<void>((r) => (release = r))
      order.push(`end ${body.events[0]!.message}`)
      return new Response(null, { status: 202 })
    })
    const { vigil } = setup({ fetch: slow as unknown as typeof fetch })

    vigil.captureError(new Error('first'))
    const one = vigil.flush()
    await vi.waitFor(() => expect(order).toEqual(['start first']))
    vigil.captureError(new Error('second'))
    const two = vigil.flush()
    const three = vigil.flush()
    release()
    await Promise.all([one, two, three])

    expect(order).toEqual(['start first', 'end first', 'start second', 'end second'])
  })
})

describe('the periodic flush', () => {
  it('sends on its own without anyone calling flush', async () => {
    vi.useFakeTimers()
    try {
      const { vigil, fetchImpl } = setup({ flushIntervalMs: 100 })
      vigil.captureError(new Error('boom'))
      await vi.advanceTimersByTimeAsync(150)
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  // A five-second timer that keeps a finished script running is the monitor changing how the
  // host behaves, which is exactly what §8 forbids. `tests/node.process.test.ts` proves it on a
  // real process; this reads the timer's own state.
  it('does not keep an otherwise-idle process alive', () => {
    const interval = vi.spyOn(globalThis, 'setInterval')
    setup({ flushIntervalMs: 100 })

    expect(interval).toHaveBeenCalledTimes(1)
    const timer = interval.mock.results[0]!.value as NodeJS.Timeout
    expect(timer.hasRef()).toBe(false)
  })

  it('stops when closed', async () => {
    vi.useFakeTimers()
    try {
      const { vigil, fetchImpl } = setup({ flushIntervalMs: 100 })
      await vigil.close()
      installed = undefined
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(fetchImpl).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the process hooks', () => {
  afterEach(() => {
    restoreListeners?.()
    restoreListeners = undefined
  })

  it('hooks both, and close puts back exactly what it found', async () => {
    const before = snapshot()
    const counts = { u: listeners('uncaughtException'), r: listeners('unhandledRejection') }
    const { vigil } = setup()
    expect(listeners('uncaughtException')).toBe(counts.u + 1)
    expect(listeners('unhandledRejection')).toBe(counts.r + 1)

    await vigil.close()
    installed = undefined
    expect(snapshot()).toEqual(before)
  })

  it('reports an uncaught exception', async () => {
    const { batches } = setup()
    await hook('uncaughtException')(new Error('nobody caught this'))

    expect(batches[0]!.events[0]).toMatchObject({
      message: 'nobody caught this',
      context: { fatal: true },
    })
  })

  it('reports an unhandled rejection the host handles itself', async () => {
    // The vitest worker's own listener stands in for the host's.
    const { batches } = setup()
    await hook('unhandledRejection')(new Error('nobody awaited this'))

    expect(batches[0]!.events[0]).toMatchObject({
      message: 'nobody awaited this',
      context: { unhandledRejection: true },
    })
  })

  // §8: never keep a dying process alive. A monitor that nurses a corrupted process along is
  // worse than the crash it hid — so after flushing, Node does what it would have done.
  it('flushes, prints the error as Node would, then exits 1, when nothing else handles it', async () => {
    aloneOnProcess()
    const order: string[] = []
    const exit = mockExit(order)
    const printed = captureStderr(order)
    const { batches, fetchImpl } = setup({ exitOnUncaught: true })
    fetchImpl.mockImplementation(async (_url: string, init?: RequestInit) => {
      order.push('sent')
      batches.push(JSON.parse(init?.body as string) as Sent)
      return new Response(null, { status: 202 })
    })

    await hook('uncaughtException')(new Error('fatal'))

    expect(batches).toHaveLength(1)
    expect(exit).toHaveBeenCalledWith(1)
    expect(order).toEqual(['sent', 'print', 'exit 1'])
    expect(printed.join('')).toContain('Error: fatal')
    expect(printed.join('')).toContain('at ')
  })

  it('leaves the decision alone when the host said it would handle it', async () => {
    aloneOnProcess()
    const exit = mockExit()
    const printed = captureStderr()
    setup({ exitOnUncaught: false })

    await hook('uncaughtException')(new Error('fatal'))

    expect(exit).not.toHaveBeenCalled()
    expect(printed).toEqual([])
  })

  // With a handler of its own, Node would not have exited; vigil must not exit in its place.
  it.each(['before', 'after'] as const)(
    'leaves the decision to a host handler registered %s it, without being told',
    async (when) => {
      aloneOnProcess()
      const exit = mockExit()
      captureStderr()
      const hostHandler = vi.fn()
      if (when === 'before') process.on('uncaughtException', hostHandler)
      const { batches, vigil } = setup({ exitOnUncaught: true })
      const ours = process.listeners('uncaughtException').find((l) => l !== hostHandler) as Listener
      if (when === 'after') process.on('uncaughtException', hostHandler)

      try {
        await ours(new Error('fatal'))
        expect(exit).not.toHaveBeenCalled()
        expect(batches[0]!.events[0]).toMatchObject({ message: 'fatal' })
      } finally {
        await vigil.close()
        installed = undefined
        process.off('uncaughtException', hostHandler)
      }
    },
  )

  // A hung vigil must not stop a crashed process from exiting.
  it('exits anyway when the flush hangs past the fatal timeout', async () => {
    aloneOnProcess()
    const exit = mockExit()
    captureStderr()
    const hanging = vi.fn(() => new Promise<Response>(() => {}))
    setup({ exitOnUncaught: true, fatalFlushMs: 50, fetch: hanging as unknown as typeof fetch })

    const started = Date.now()
    await hook('uncaughtException')(new Error('fatal'))

    expect(exit).toHaveBeenCalledWith(1)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('exits even if reporting the exception throws outright', async () => {
    aloneOnProcess()
    const exit = mockExit()
    captureStderr()
    const exploding = vi.fn(() => {
      throw new Error('transport is broken')
    })
    setup({ exitOnUncaught: true, fetch: exploding as unknown as typeof fetch, log: () => {} })

    await expect(hook('uncaughtException')(new Error('fatal'))).resolves.toBeUndefined()
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('exits once for a second exception thrown while the first is being flushed', async () => {
    aloneOnProcess()
    const exit = mockExit()
    captureStderr()
    const { batches } = setup({ exitOnUncaught: true })

    const handler = hook('uncaughtException')
    await Promise.all([handler(new Error('first')), handler(new Error('second'))])

    expect(exit).toHaveBeenCalledTimes(1)
    expect(batches.flatMap((b) => b.events.map((e) => e.message))).toEqual(['first', 'second'])
  })

  // Node's default (`--unhandled-rejections=throw`) crashes on an unhandled rejection unless an
  // `unhandledRejection` listener exists. vigil's would stop that crash, so it raises the
  // rejection again — and reports it once, from the uncaught-exception hook it then reaches.
  it('raises an unhandled rejection as an uncaught exception, as Node would have', () => {
    aloneOnProcess()
    const { fetchImpl } = setup()
    const reason = new Error('nobody awaited this')

    expect(() => hook('unhandledRejection')(reason)).toThrow(reason)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('raises a rejection that is not an error the way Node does, wrapped', () => {
    aloneOnProcess()
    setup()

    let raised: unknown
    try {
      hook('unhandledRejection')('a plain string')
    } catch (error) {
      raised = error
    }

    expect(raised).toBeInstanceOf(Error)
    expect(raised).toMatchObject({
      name: 'UnhandledPromiseRejection',
      code: 'ERR_UNHANDLED_REJECTION',
    })
    expect((raised as Error).message).toContain('a plain string')
  })

  it('reports a re-raised rejection once, marked as a rejection', async () => {
    aloneOnProcess()
    mockExit()
    captureStderr()
    const { batches } = setup({ exitOnUncaught: true })
    const reason = new Error('nobody awaited this')

    let raised: unknown
    try {
      hook('unhandledRejection')(reason)
    } catch (error) {
      raised = error
    }
    await hook('uncaughtException')(raised, 'uncaughtException')

    expect(batches.flatMap((b) => b.events)).toEqual([
      expect.objectContaining({
        message: 'nobody awaited this',
        count: 1,
        context: { fatal: true, unhandledRejection: true },
      }),
    ])
  })
})

describe('install, called twice', () => {
  // Two sets of process listeners would report every crash twice and double the flush traffic.
  it('returns the client already installed and hooks nothing more', async () => {
    const log = vi.fn()
    const { vigil } = setup({ log })
    const counts = { u: listeners('uncaughtException'), r: listeners('unhandledRejection') }
    const interval = vi.spyOn(globalThis, 'setInterval')

    const again = install({ ...BASE, environment: 'staging', log })

    expect(again).toBe(vigil)
    expect(listeners('uncaughtException')).toBe(counts.u)
    expect(listeners('unhandledRejection')).toBe(counts.r)
    expect(interval).not.toHaveBeenCalled()
    expect(log.mock.calls.filter(([m]) => String(m).includes('already installed'))).toHaveLength(1)
  })

  it('installs afresh once the first has been closed', async () => {
    const { vigil } = setup()
    await vigil.close()
    installed = undefined

    const { vigil: second, batches } = setup({ environment: 'staging' })
    expect(second).not.toBe(vigil)
    second.captureError(new Error('boom'))
    await second.flush()
    expect(batches[0]!.environment).toBe('staging')
  })
})

describe('close', () => {
  it('flushes what is queued', async () => {
    const { vigil, batches } = setup()
    vigil.captureError(new Error('last words'))
    await vigil.close()
    installed = undefined
    expect(batches[0]!.events[0]!.message).toBe('last words')
  })

  it('is safe to call twice', async () => {
    const { vigil } = setup()
    await vigil.close()
    await expect(vigil.close()).resolves.toBeUndefined()
    installed = undefined
  })

  it('accepts a capture after closing without throwing or sending', async () => {
    const { vigil, fetchImpl } = setup()
    await vigil.close()
    installed = undefined
    expect(() => vigil.captureError(new Error('too late'))).not.toThrow()
    await vigil.flush()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

// Configuration arrives from environment variables, often unset outside production. A client
// that cannot report must say so once and leave the host exactly as it was — no listeners, no
// timer — rather than throw from the line that installs it.
describe('configuration it cannot report with', () => {
  const unusable: Array<{ name: string; options: unknown }> = [
    { name: 'no options at all', options: undefined },
    { name: 'a missing url', options: { ...BASE, url: undefined } },
    { name: 'a blank url', options: { ...BASE, url: '' } },
    { name: 'a url that is not one', options: { ...BASE, url: 'not a url' } },
    { name: 'a missing key', options: { ...BASE, key: undefined } },
    { name: 'a blank key', options: { ...BASE, key: '  ' } },
    { name: 'a blank environment', options: { ...BASE, environment: ' ' } },
    {
      name: 'an environment over 64 characters',
      options: { ...BASE, environment: 'e'.repeat(65) },
    },
    {
      name: 'options whose getters throw',
      options: new Proxy(
        {},
        {
          get() {
            throw new Error('hostile')
          },
        },
      ),
    },
  ]

  it.each(unusable)('$name: hooks nothing, sends nothing, throws nothing', async ({ options }) => {
    const before = snapshot()
    const interval = vi.spyOn(globalThis, 'setInterval')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    let vigil: Vigil | undefined
    expect(() => {
      vigil = install(options as VigilOptions)
    }).not.toThrow()
    installed = vigil

    expect(snapshot()).toEqual(before)
    expect(interval).not.toHaveBeenCalled()
    expect(() => vigil!.captureError(new Error('boom'))).not.toThrow()
    await expect(vigil!.flush()).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('reports through the log option when one is given', () => {
    const log = vi.fn()
    installed = install({ ...BASE, url: '', log })
    expect(log).toHaveBeenCalledTimes(1)
    expect(String(log.mock.calls[0]![0])).toContain('url')
  })

  it('leaves the host alone if setting up throws part way', () => {
    const before = snapshot()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const realOn = process.on.bind(process)
    let calls = 0
    // The first hook goes on; the second refuses. The first must not be left behind.
    vi.spyOn(process, 'on').mockImplementation(((event: Hook, listener: Listener) => {
      calls += 1
      if (calls === 2) throw new Error('process.on is broken')
      return realOn(event, listener)
    }) as typeof process.on)
    vi.useFakeTimers()
    try {
      expect(() => {
        installed = install(BASE)
      }).not.toThrow()

      expect(calls).toBe(2)
      expect(snapshot()).toEqual(before)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

// Numbers the host got wrong fall back to the defaults instead of reaching `setInterval` or the
// queue, where a NaN prints a warning on the host's stderr and a zero throws.
describe('numeric options it cannot use', () => {
  const rows: Array<{ name: string; options: Partial<VigilOptions> }> = [
    { name: 'maxQueue 0', options: { maxQueue: 0 } },
    { name: 'maxQueue 2.5', options: { maxQueue: 2.5 } },
    { name: 'maxQueue NaN', options: { maxQueue: Number.NaN } },
    { name: 'flushIntervalMs NaN', options: { flushIntervalMs: Number.NaN } },
    { name: 'flushIntervalMs -1', options: { flushIntervalMs: -1 } },
    { name: 'timeoutMs NaN', options: { timeoutMs: Number.NaN } },
    { name: 'fatalFlushMs -5', options: { fatalFlushMs: -5 } },
    { name: 'flushIntervalMs as text', options: { flushIntervalMs: '5000' as unknown as number } },
  ]

  it.each(rows)('$name: installs with the default, says so once', async ({ options }) => {
    const log = vi.fn()
    const interval = vi.spyOn(globalThis, 'setInterval')
    const warning = vi.spyOn(process, 'emitWarning')
    const sent: Sent[] = []
    // Slower than the 1 ms a bad timeout would become, well inside the 3,000 ms default.
    const slowish = vi.fn(async (_url: string, init?: RequestInit) => {
      sent.push(JSON.parse(init?.body as string) as Sent)
      await new Promise((r) => setTimeout(r, 20))
      return new Response(null, { status: 202 })
    })

    const { vigil } = setup({
      ...options,
      flushIntervalMs: options.flushIntervalMs,
      log,
      fetch: slowish as unknown as typeof fetch,
    })

    expect(interval.mock.calls[0]?.[1]).toBe(5_000)
    for (let i = 0; i < 150; i += 1) vigil.captureError(new Error(`failure ${i}`))
    await vigil.flush()

    expect(sent.flatMap((b) => b.events)).toHaveLength(100)
    expect(log.mock.calls.filter(([m]) => String(m).includes('could not report'))).toEqual([])
    expect(log.mock.calls.filter(([m]) => String(m).includes('using the default'))).toHaveLength(1)
    expect(warning).not.toHaveBeenCalled()
  })
})
